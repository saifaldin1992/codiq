/**
 * D-46 — the job that releases a reservation whose order was abandoned.
 *
 * Scope, exactly: `status = 'active'` AND `expires_at <= now` AND the order is
 * STILL `new`. Owner decision 8. Any other order status is out of scope at any
 * age — a `processing` order has been acknowledged by a human and quietly
 * un-reserving his stock is a worse bug than the one this fixes.
 *
 * ── THE LOAD-BEARING FORK (ق-140, and it is the whole correctness of this file)
 *
 * Read `return-inspection.service.ts` before touching the release below. A
 * storefront reservation is written ACTIVE at checkout and stock is decremented
 * ONLY at completion (`settleStorefrontReservations`, the
 * decrement-only-at-completion invariant). So for every row this job can ever
 * touch — active, on an order still in `new` — THE STOCK WAS NEVER DEDUCTED.
 * The units are sitting in `stockQuantity` right now, merely hidden behind the
 * reservation, because every availability sum in the codebase subtracts
 * SUM(active reservations): the storefront listing, the product page, the
 * checkout guard and the POS till's sellable slice.
 *
 * Therefore the release is a STATUS FLIP AND NOTHING ELSE. It must NOT
 * increment `stockQuantity`. Incrementing here would mint inventory the
 * merchant does not own — phantom stock, once per abandoned order, compounding
 * forever and undetectable until a physical count. This is the same trap RI-1
 * documented for the refused-COD path, and it is inverted just as easily.
 *
 * ── WHY A MOVEMENT ROW WITH `delta: 0`
 *
 * Owner decision 8 requires the release to write its own `inventory_movement`
 * «so the stock trail stays honest». Honest here means: an automatic actor
 * changed what this variant can sell, at this moment, for this reason — and
 * `delta` is 0 BECAUSE of the fork above, not because the row is a placeholder.
 * A non-zero delta would be a lie about physical stock; no row at all would
 * leave the merchant unable to explain why a product became buyable again
 * overnight. Zero is the true number, and writing it down is the point.
 * (RI-1's active-restock path writes no movement because a HUMAN performed it
 * and can be asked; this one has no human to ask.)
 *
 * ── IDEMPOTENCE, AND THE HUMAN CANCELLING IN THE SAME MINUTE
 *
 * The ق-140 idiom: a guarded `updateMany` inside the transaction whose affected
 * count decides the outcome. A merchant cancelling the order runs
 * `settleStorefrontReservations`, which flips the same rows `active →
 * released` under the same predicate. Both writers contend on one column, the
 * loser matches zero rows, and only the winner writes the movement. Exactly one
 * release, whichever order they arrive in — and running this job twice is the
 * same race against itself.
 *
 * The `FOR UPDATE` on the order closes the narrower hole the count alone
 * cannot: `new → processing` does NOT touch reservations, so without the lock a
 * transition landing between the scan and the flip would let this job release a
 * reservation on an order that had just left `new`. The lock is taken on
 * `store_orders` FIRST, which is the order `updateOrderStatus` already acquires
 * (it updates the order row before calling into the reservations), so the two
 * writers serialize rather than deadlock.
 *
 * Runs as an interval in the standalone worker process, never in an HTTP path
 * (ADR-004).
 */
import { prisma } from "../db/prisma.js";
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";

export const RESERVATION_EXPIRY_INTERVAL_MS = 15 * 60 * 1000;
const RESERVATION_EXPIRY_BATCH_SIZE = 200;
/** A pass drains at most this many batches; the rest waits for the next interval. */
const MAX_BATCHES_PER_PASS = 20;

/** The `release_reason` stamped on an automatic release. Grep-able on purpose. */
export const RESERVATION_EXPIRY_RELEASE_REASON = "expired";
/** The `inventory_movements.reason` for the trail row. Sibling of 'storefront_cod_completed'. */
export const RESERVATION_EXPIRY_MOVEMENT_REASON = "storefront_reservation_expired";

export interface ReservationExpiryResult {
  released: number;
  /**
   * Rows that stopped being releasable between the scan and the guarded flip —
   * a merchant cancelled the order, or moved it on, in that window. Not an
   * error: it is the race resolving correctly, and it is counted so a test can
   * prove exactly one release happened.
   */
  skipped: number;
}

type Candidate = {
  id: string;
  storeId: string;
  orderId: string;
  productId: string;
  variantId: string;
};

async function candidates(now: Date, batchSize: number): Promise<Candidate[]> {
  return prisma.inventoryReservation.findMany({
    where: {
      status: "active",
      expiresAt: { lte: now },
      // The whole of owner decision 8's «and ONLY for new». Restated inside the
      // transaction under a row lock, because a filter read outside one is a
      // hint, not a guarantee.
      order: { status: "new" },
    },
    select: { id: true, storeId: true, orderId: true, productId: true, variantId: true },
    // Oldest first: the longest-pinned stock is the sale the merchant lost
    // furthest back, and a stable total order keeps repeated passes deterministic.
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: batchSize,
  });
}

/**
 * One reservation, one transaction. `true` when this call is the one that
 * released it; `false` when somebody else got there first — which is a correct
 * outcome, not a failure.
 */
async function releaseOne(candidate: Candidate, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // Lock the order BEFORE the reservation — the same acquisition order
    // updateOrderStatus uses — then re-read the status under that lock. A
    // transition that has already committed is visible here; one still running
    // blocks until it commits and is then visible too. Either way the `new`
    // test below is a fact for the life of this transaction.
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM store_orders
       WHERE id = ${candidate.orderId}::uuid AND store_id = ${candidate.storeId}::uuid
       FOR UPDATE`;
    if (locked[0]?.status !== "new") return false;

    // THE GUARDED FLIP (ق-140). The count decides everything below it: a
    // concurrent cancel that already flipped this row matches zero here, and
    // the movement — the only other write — never happens.
    const released = await tx.inventoryReservation.updateMany({
      where: { id: candidate.id, storeId: candidate.storeId, status: "active", expiresAt: { lte: now } },
      data: {
        status: "released",
        releaseReason: RESERVATION_EXPIRY_RELEASE_REASON,
        releasedAt: now,
      },
    });
    if (released.count !== 1) return false;

    // delta 0 — see the header. The units never left stockQuantity, so the
    // honest trail entry says availability changed and stock did not.
    await tx.inventoryMovement.create({
      data: {
        storeId: candidate.storeId,
        productId: candidate.productId,
        variantId: candidate.variantId,
        delta: 0,
        reason: RESERVATION_EXPIRY_MOVEMENT_REASON,
      },
    });
    return true;
  });
}

/**
 * One sweep. `now` is injected so tests drive the job directly (`now: +73h`)
 * exactly as they drive the trash purge and the abandoned-cart scanner.
 */
export async function releaseExpiredReservations(
  options: { now?: Date; batchSize?: number } = {},
): Promise<ReservationExpiryResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? RESERVATION_EXPIRY_BATCH_SIZE;
  const outcome: ReservationExpiryResult = { released: 0, skipped: 0 };

  for (let pass = 0; pass < MAX_BATCHES_PER_PASS; pass += 1) {
    const pending = await candidates(now, batchSize);
    if (!pending.length) break;
    let releasedThisPass = 0;
    for (const candidate of pending) {
      // ح-4's lesson: one row failing for an unforeseen reason must not cost
      // the sweep the rest of its tail. Every release is its own transaction,
      // so a rollback here loses nothing but this row's turn.
      try {
        if (await releaseOne(candidate, now)) {
          outcome.released += 1;
          releasedThisPass += 1;
        } else {
          outcome.skipped += 1;
        }
      } catch (error) {
        outcome.skipped += 1;
        logger.error("job.row_failed", { job: "reservation-expiry", reservationId: candidate.id, err: error });
      }
    }
    // A short batch means the backlog is drained. A full batch that released
    // NOTHING means every candidate is being refused — re-scanning would return
    // the same rows forever, so stop instead of spinning.
    if (pending.length < batchSize || releasedThisPass === 0) break;
  }
  return outcome;
}

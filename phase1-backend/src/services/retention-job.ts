/**
 * D-39 — the operational retention sweep.
 *
 * Shaped after the PG-2 trash purge (`soft-delete/purge-job.ts`) and running
 * beside it as another interval in the standalone worker process, never in an
 * HTTP path (ADR-004). It differs from that job in exactly one way, and the
 * difference is why it is a separate file: the purge deletes ONE MERCHANT-OWNED
 * ROW PER TRANSACTION so it can write an audit event for each and name a
 * foreign-key refusal as an outcome. These rows are nobody's property — a spent
 * rate-limit counter, a session revoked last quarter, a delivered notification —
 * so they go in bulk, and the audit trail they would write is precisely the
 * trail owner decision 7 said never to keep.
 *
 * Three properties, all structural rather than hoped-for:
 *
 *  1. BATCHED, ALWAYS. Every statement is `DELETE … WHERE <key> IN (SELECT <key>
 *     … LIMIT n)`. There is no code path that can emit an unbounded DELETE, so
 *     the first sweep over a year of accumulated rows cannot take a lock the
 *     live storefront is waiting behind. A pass is additionally capped at
 *     MAX_BATCHES_PER_TABLE, so a huge backlog drains over several passes
 *     instead of monopolising one.
 *  2. IDEMPOTENT. Every predicate is a fact about the row's own age and state,
 *     never a cursor or a marker column. Running the sweep twice, or twice
 *     concurrently, deletes the same set and then nothing.
 *  3. CONTAINED. One table's failure is logged and the sweep moves on. A
 *     foreign key added two years from now that refuses a cart must not cost
 *     the other seven tables their cleanup — the same lesson ح-4 taught the
 *     purge job when one bad row abandoned the whole blocked tail.
 *
 * The windows themselves are NOT here. They are in `retention.ts`, one line
 * each, so changing a number never means reading this file.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { RETENTION_DAYS, retentionCutoff } from "./retention.js";
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";

export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 500;
/** A pass deletes at most this many batches per table; the rest waits for the next interval. */
const MAX_BATCHES_PER_TABLE = 40;

export interface RetentionResult {
  deleted: number;
  byTable: Record<string, number>;
  /** Tables whose sweep threw. Named, logged, and survived — never fatal. */
  failed: string[];
}

interface Sweep {
  readonly table: string;
  readonly retentionDays: number;
  /** Deletes at most `limit` rows older than `cutoff`; returns how many went. */
  deleteBatch(cutoff: Date, limit: number): Promise<number>;
}

/**
 * All five of them (`platform_staff_sessions` landed 2026-09-03 and made the
 * register's «4 جداول sessions» stale the day it was written). Identical shape,
 * identical predicate — so they are generated rather than copied five times,
 * and a SIXTH identity kind is one line here instead of a forgotten table.
 *
 * The clock is «whichever death came first»: a revoked session is dead from
 * `revoked_at`, an abandoned one from `expires_at`. Neither is a live session —
 * `requireSession` rejects both — so this deletes nothing anyone can still use.
 */
const SESSION_TABLES = [
  "platform_owner_sessions",
  "merchant_sessions",
  "customer_sessions",
  "staff_sessions",
  "platform_staff_sessions",
  "shopper_sessions",
] as const;

function sessionSweep(table: string): Sweep {
  const relation = Prisma.raw(table);
  return {
    table,
    retentionDays: RETENTION_DAYS.sessions,
    deleteBatch: (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM ${relation} WHERE id IN (
        SELECT id FROM ${relation}
        WHERE revoked_at <= ${cutoff} OR expires_at <= ${cutoff}
        LIMIT ${limit}
      )`,
  };
}

const SWEEPS: readonly Sweep[] = [
  {
    // No `id` and no `store_id` — the primary key is (scope, key_hash), which is
    // structural (D-39 notes the missing store_id) and perfectly fine to batch
    // on: Postgres takes a row-value list in `IN` just as happily as a scalar.
    table: "storefront_rate_limits",
    retentionDays: RETENTION_DAYS.storefrontRateLimits,
    deleteBatch: (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM storefront_rate_limits WHERE (scope, key_hash) IN (
        SELECT scope, key_hash FROM storefront_rate_limits
        WHERE updated_at <= ${cutoff}
        LIMIT ${limit}
      )`,
  },
  ...SESSION_TABLES.map(sessionSweep),
  {
    table: "shopper_otp_challenges",
    retentionDays: RETENTION_DAYS.shopperOtpChallenges,
    deleteBatch: (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM shopper_otp_challenges WHERE id IN (
        SELECT id FROM shopper_otp_challenges WHERE created_at <= ${cutoff} LIMIT ${limit}
      )`,
  },
  {
    // `updated_at` rather than `sent_at`: a `skipped` row never had a send, and
    // `@updatedAt` stamps the moment the row reached its terminal state for all
    // three statuses alike. Nothing updates a settled outbox row afterwards.
    table: "notification_outbox (sent/skipped)",
    retentionDays: RETENTION_DAYS.notificationOutboxSettled,
    deleteBatch: (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM notification_outbox WHERE id IN (
        SELECT id FROM notification_outbox
        WHERE status IN ('sent', 'skipped') AND updated_at <= ${cutoff}
        LIMIT ${limit}
      )`,
  },
  {
    // A year, because a dead letter is the record of a message that never
    // reached a customer — the thing a merchant asks about months later.
    table: "notification_outbox (dead_letter)",
    retentionDays: RETENTION_DAYS.notificationOutboxDeadLetter,
    deleteBatch: (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM notification_outbox WHERE id IN (
        SELECT id FROM notification_outbox
        WHERE status = 'dead_letter' AND updated_at <= ${cutoff}
        LIMIT ${limit}
      )`,
  },
  {
    // GUEST carts only, and only those whose own `expires_at` fell due 30 days
    // ago. A customer cart has no expiry and is his saved basket; a `merged`
    // cart is the trail of a guest who signed in; a `converted` cart is an
    // order's provenance. All three are excluded by the status/owner filter.
    //
    // The NOT EXISTS is not decoration. `merged_into_cart_id` is a RESTRICT
    // self-reference, so one cart pointed at by another would raise 23503 and
    // poison EVERY batch on this table forever — a sweep that logs an error
    // every six hours and never makes progress. Today a merge target is always
    // a customer cart, so the clause matches nothing; it costs one index probe
    // and it means a future merge direction cannot break this job silently.
    table: "shopping_carts (guest)",
    retentionDays: RETENTION_DAYS.guestCarts,
    deleteBatch: (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM shopping_carts WHERE id IN (
        SELECT id FROM shopping_carts cart
        WHERE cart.owner_kind = 'guest'
          AND cart.status IN ('active', 'expired')
          AND cart.expires_at <= ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM shopping_carts child WHERE child.merged_into_cart_id = cart.id
          )
        LIMIT ${limit}
      )`,
  },
  {
    // The checkout idempotency ledger. Deleting a row means a replay of that
    // Idempotency-Key would mint a SECOND order instead of returning the first,
    // which is why this window is the longest of the short ones: 90 days is far
    // past any client that could still be retrying.
    table: "checkout_requests",
    retentionDays: RETENTION_DAYS.checkoutRequests,
    deleteBatch: (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM checkout_requests WHERE id IN (
        SELECT id FROM checkout_requests
        WHERE created_at <= ${cutoff}
        LIMIT ${limit}
      )`,
  },
  // ───────────────────────────────────────────────────────────────────────────
  // STOP. The next sweep you are about to add is probably one of the five
  // tables in `NEVER_AUTO_DELETED` (retention.ts) — ledger_entries,
  // platform_audit_events, store_audit_events, order_status_events,
  // inventory_movements. None of them may ever appear in this array. The money,
  // the audit trails and the stock history are archived, never swept; the
  // reasoning is written out in full beside that constant.
  // ───────────────────────────────────────────────────────────────────────────
];

/**
 * One pass over every operational table. `now` is injected so the tests drive
 * the job directly (`now: +400d`) exactly as they drive the trash purge and the
 * abandoned-cart scanner.
 */
export async function sweepOperationalRetention(
  options: { now?: Date; batchSize?: number } = {}
): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const outcome: RetentionResult = { deleted: 0, byTable: {}, failed: [] };

  for (const sweep of SWEEPS) {
    const cutoff = retentionCutoff(now, sweep.retentionDays);
    let removed = 0;
    try {
      for (let pass = 0; pass < MAX_BATCHES_PER_TABLE; pass += 1) {
        const count = await sweep.deleteBatch(cutoff, batchSize);
        removed += count;
        // A short batch means the tail is reached. A full one means there is
        // more, and the next `LIMIT` picks it up — never a bigger DELETE.
        if (count < batchSize) break;
      }
    } catch (error) {
      outcome.failed.push(sweep.table);
      logger.error("job.table_failed", { job: "retention", table: sweep.table, err: error });
    }
    if (removed > 0) outcome.byTable[sweep.table] = removed;
    outcome.deleted += removed;
  }
  return outcome;
}

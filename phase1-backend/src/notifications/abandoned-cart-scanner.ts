/**
 * codiq phase 20B-2 — abandoned-cart scanner (D-24).
 *
 * Runs INSIDE the standalone worker process (worker-entry.ts) as a second
 * overlap-guarded interval — never inside an HTTP request path (ADR-004), and
 * with zero involvement in checkout. Each pass:
 *
 *   1. loads the stores whose master notification switch AND abandonedCart
 *      opt-in are both on (default OFF — approved decision §8.7);
 *   2. finds, in ONE query across those stores, the active CUSTOMER-owned carts
 *      with items, a known customer email, last activity older than that
 *      store's window (12h default, 1–72 configurable — §8.6), and no
 *      cart.abandoned outbox row yet;
 *   3. INSERTs one outbox row per cart with dedupeKey `cart_abandoned:{cartId}`
 *      AND stamps `shopping_carts.abandoned_notified_at`, in one transaction.
 *
 * "One message per cart, forever" (§8.6) is structural — but 19-د had to move
 * WHERE it is structural. Both dedupe mechanisms used to be the outbox row
 * itself, and the retention sweep hard-deletes settled outbox rows at 90 days
 * while a customer-owned cart is never swept and never expires. So the shopper
 * was mailed on day 0, the record of it was deleted on day 90, and the next
 * fifteen-minute pass mailed him again — «forever» meant «every 90 days», and
 * the module said otherwise in its own header. The stamp lives on the CART now,
 * which is what the guarantee is about and which outlives any retention number;
 * the UNIQUE(store_id, dedupe_key) stays as the second line. Guests are NEVER
 * messaged — the ownerKind/customer-email filters exclude them structurally,
 * and the merchant UI says so honestly.
 *
 * Delivery itself stays with the untouched phase-15 outbox worker; tests drive
 * scanAbandonedCarts directly, exactly as they drive processOutboxBatch.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { normalizeAbandonedCartSettings } from "../services/abandoned-cart.service.js";
import { LIVE } from "../services/soft-delete/constants.js";
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";

export const ABANDONED_CART_SCAN_INTERVAL_MS = 15 * 60 * 1000;
const SCAN_BATCH_SIZE = 200;

/**
 * 19-د: a concurrent scan already claimed this cart. Counted as a duplicate,
 * exactly like the P2002 the unique dedupe key raises — it is the same fact
 * arriving through the stamp instead of through the outbox row.
 */
class AlreadyNotifiedError extends Error {}

export interface AbandonedCartScanResult {
  eligibleStores: number;
  candidates: number;
  enqueued: number;
  duplicates: number;
}

export async function scanAbandonedCarts(
  options: { now?: Date } = {}
): Promise<AbandonedCartScanResult> {
  const now = options.now ?? new Date();
  const result: AbandonedCartScanResult = {
    eligibleStores: 0,
    candidates: 0,
    enqueued: 0,
    duplicates: 0,
  };

  // PG-3: a marketing cap of 0 means the store sends no marketing, so nothing is
  // enqueued for it in the first place. Letting the row through and refusing it
  // at send time would be a queue that grows forever and drains never — the
  // opposite of «disabled», and the one case where deferral does not resolve
  // itself.
  const settingsRows = await prisma.notificationSettings.findMany({
    where: { isEnabled: true, marketingDailyCap: { gt: 0 } },
    select: {
      storeId: true,
      configuration: true,
      store: {
        select: {
          name: true,
          slug: true,
          isActive: true,
          merchant: { select: { isActive: true } },
        },
      },
    },
  });
  const eligibleStores = settingsRows
    .map((row) => ({
      storeId: row.storeId,
      store: row.store,
      settings: normalizeAbandonedCartSettings(row.configuration),
    }))
    .filter((row) => row.settings.enabled && row.store.isActive && row.store.merchant.isActive);
  result.eligibleStores = eligibleStores.length;
  if (!eligibleStores.length) return result;

  // Recovery coupons ride the message ONLY while still active in their own store.
  const couponIds = eligibleStores
    .map((row) => row.settings.recoveryCouponId)
    .filter((id): id is string => Boolean(id));
  const coupons = couponIds.length
    ? await prisma.coupon.findMany({
        where: { id: { in: couponIds }, isActive: true, ...LIVE },
        select: { id: true, storeId: true, code: true },
      })
    : [];
  const couponByStore = new Map(
    eligibleStores.map((row) => {
      const coupon = coupons.find(
        (candidate) =>
          candidate.id === row.settings.recoveryCouponId && candidate.storeId === row.storeId
      );
      return [row.storeId, coupon?.code ?? null] as const;
    })
  );
  const storeById = new Map(eligibleStores.map((row) => [row.storeId, row]));

  // ONE candidate query across every eligible store; each store contributes its
  // own cutoff. The relation filters keep guests (no customer, no email) out
  // structurally, and carts already messaged are skipped before any insert —
  // the dedupe key below stays as the race-proof second line.
  const candidates = await prisma.shoppingCart.findMany({
    where: {
      status: "active",
      ownerKind: "customer",
      customerId: { not: null },
      items: { some: {} },
      customer: { email: { not: null } },
      // 19-د: the stamp on the CART, not the presence of an outbox row.
      //
      // Both dedupe mechanisms used to BE the outbox row — this filter and the
      // UNIQUE(store_id, dedupe_key) below it — and the retention sweep deletes
      // settled outbox rows at 90 days. A customer-owned cart is never swept and
      // never expires, so the same cart came back as a candidate on the next
      // pass after its record was deleted, and the shopper was mailed again.
      // Every 90 days, forever. See the migration for the arithmetic.
      abandonedNotifiedAt: null,
      OR: eligibleStores.map((row) => ({
        storeId: row.storeId,
        lastActivityAt: { lt: new Date(now.valueOf() - row.settings.windowHours * 60 * 60 * 1000) },
      })),
    },
    select: {
      id: true,
      storeId: true,
      lastActivityAt: true,
      customer: { select: { fullName: true, email: true } },
      items: { select: { quantity: true, priceSnapshotIqd: true } },
    },
    orderBy: [{ lastActivityAt: "asc" }, { id: "asc" }],
    take: SCAN_BATCH_SIZE,
  });
  result.candidates = candidates.length;

  for (const cart of candidates) {
    const store = storeById.get(cart.storeId);
    if (!store || !cart.customer?.email) continue;
    const itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    const totalIqd = cart.items.reduce(
      (sum, item) => sum + item.quantity * item.priceSnapshotIqd,
      0
    );
    const couponCode = couponByStore.get(cart.storeId) ?? null;
    try {
      // 19-د: the message and the CART'S OWN record of it commit together.
      //
      // Two writes that must not come apart: an outbox row with no stamp is a
      // shopper who gets a second message in ninety days, and a stamp with no
      // row is a shopper who never gets the first one. The transaction is what
      // makes the guarantee structural on something that outlives retention,
      // which is what the module header above has always claimed it is.
      //
      // The guarded updateMany, not a plain update: it is also the race lock. A
      // concurrent scan that reached this cart first has already cleared the
      // stamp's null, so the loser writes nothing and rolls the outbox row back
      // rather than enqueueing a duplicate. The UNIQUE(store_id, dedupe_key)
      // below stays as the second line, unchanged.
      await prisma.$transaction(async (tx) => {
        await tx.notificationOutbox.create({
          data: {
            storeId: cart.storeId,
            eventType: "cart.abandoned",
            cartId: cart.id,
            recipientKind: "customer",
            channel: "email",
            recipient: cart.customer!.email!,
            dedupeKey: `cart_abandoned:${cart.id}`,
            payload: {
              storeName: store.store.name,
              storeSlug: store.store.slug,
              customerName: cart.customer!.fullName,
              itemCount,
              totalIqd,
              cartUrl: `/store/${encodeURIComponent(store.store.slug)}/cart`,
              ...(couponCode ? { couponCode } : {}),
            },
          },
        });
        const stamped = await tx.shoppingCart.updateMany({
          where: { id: cart.id, abandonedNotifiedAt: null },
          data: { abandonedNotifiedAt: now },
        });
        if (stamped.count !== 1) throw new AlreadyNotifiedError();
      });
      result.enqueued += 1;
    } catch (error) {
      if (
        error instanceof AlreadyNotifiedError ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      ) {
        result.duplicates += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

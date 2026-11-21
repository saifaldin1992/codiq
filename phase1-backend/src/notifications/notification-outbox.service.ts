/**
 * codiq phase 15 — transactional notification outbox.
 * Every enqueue helper takes the SAME Prisma transaction client as the business
 * event, so a committed order always has its notification row and a rolled-back
 * operation never leaves one behind. Merchant-directed events honor the store's
 * notification preferences; customer-directed events require the master switch
 * plus a known address. Payloads carry display-safe snapshots only.
 */
import { Prisma } from "@prisma/client";
import { signalOutboxWork } from "../jobs/outbox-signal.js";
import { prisma } from "../db/prisma.js";

export type OutboxWriter = Prisma.TransactionClient | typeof prisma;

export interface NotificationPreferences {
  orderCreated: boolean;
  orderStatusChanged: boolean;
  lowStock: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  orderCreated: true,
  orderStatusChanged: true,
  lowStock: true,
};

export function normalizePreferences(configuration: unknown): NotificationPreferences {
  const raw = (configuration ?? {}) as Record<string, unknown>;
  const stored = (raw.preferences ?? {}) as Record<string, unknown>;
  return {
    orderCreated: stored.orderCreated !== false,
    orderStatusChanged: stored.orderStatusChanged !== false,
    lowStock: stored.lowStock !== false,
  };
}

/**
 * CD-1b — the «مندوبك في الطريق» toggle.
 *
 * It lives in configuration.courierDispatch, NOT inside the `preferences` trio:
 * the phase-15 contract pins that object to exactly {orderCreated,
 * orderStatusChanged, lowStock} and asserts it with a strict deepEqual, so
 * adding a fourth key there would break an existing suite. This follows the
 * same precedent 20B-2 set for configuration.abandonedCart.
 *
 * Unlike the 20B-2 marketing opt-in, this one defaults ON: it is a transactional
 * service message about an order the customer already placed, matching the
 * default-on behavior of every other phase-15 order notification.
 */
export interface CourierDispatchSettings {
  enabled: boolean;
}

export const COURIER_DISPATCHED_EVENT_TYPE = "order.courier_dispatched";

export function normalizeCourierDispatchSettings(configuration: unknown): CourierDispatchSettings {
  const raw = (configuration ?? {}) as Record<string, unknown>;
  const stored = (raw.courierDispatch ?? {}) as Record<string, unknown>;
  return { enabled: stored.enabled !== false };
}

export interface StoreNotificationPolicy {
  enabled: boolean;
  preferences: NotificationPreferences;
  courierDispatch: CourierDispatchSettings;
  merchantEmail: string;
  storeName: string;
  storeSlug: string;
}

export async function storeNotificationPolicy(
  tx: OutboxWriter,
  storeId: string
): Promise<StoreNotificationPolicy | null> {
  const store = await tx.store.findUnique({
    where: { id: storeId },
    select: {
      name: true,
      slug: true,
      merchant: { select: { email: true } },
      notificationSettings: { select: { isEnabled: true, configuration: true } },
    },
  });
  if (!store) return null;
  return {
    enabled: store.notificationSettings?.isEnabled === true,
    preferences: normalizePreferences(store.notificationSettings?.configuration),
    courierDispatch: normalizeCourierDispatchSettings(store.notificationSettings?.configuration),
    merchantEmail: store.merchant.email,
    storeName: store.name,
    storeSlug: store.slug,
  };
}

export async function enqueueOrderCreated(
  tx: OutboxWriter,
  input: {
    storeId: string;
    orderId: string;
    orderNumber: string;
    totalIqd: number;
    customerName: string;
    customerEmail: string | null;
  }
) {
  const policy = await storeNotificationPolicy(tx, input.storeId);
  if (!policy || !policy.enabled) return;
  const payload = {
    orderNumber: input.orderNumber,
    totalIqd: input.totalIqd,
    customerName: input.customerName,
    storeName: policy.storeName,
  };
  if (policy.preferences.orderCreated) {
    await tx.notificationOutbox.create({
      data: {
        storeId: input.storeId,
        eventType: "order.created",
        orderId: input.orderId,
        recipientKind: "merchant",
        channel: "email",
        recipient: policy.merchantEmail,
        payload,
      },
    });
    signalOutboxWork();
  }
  if (input.customerEmail) {
    await tx.notificationOutbox.create({
      data: {
        storeId: input.storeId,
        eventType: "order.created",
        orderId: input.orderId,
        recipientKind: "customer",
        channel: "email",
        recipient: input.customerEmail,
        payload,
      },
    });
    signalOutboxWork();
  }
}

export async function enqueueOrderStatusChanged(
  tx: OutboxWriter,
  input: {
    storeId: string;
    orderId: string;
    orderNumber: string;
    fromStatus: string;
    toStatus: string;
    customerEmail: string | null;
    /**
     * ق-214 — WHO moved the order. A merchant does not need an email telling him
     * what he himself just did, and sending one is not free: the operational
     * channel has a per-recipient daily ceiling (19-د) that exists to protect a
     * SHOPPER from a store, and the merchant's own copies were spending it. Seven
     * statuses per order meant the ceiling was reached in about three days' work,
     * after which the message that actually matters — «طلب جديد», the trigger for
     * the COD confirmation call — was deferred to tomorrow.
     *
     * So the merchant copy is for the transitions he did NOT make: the shopper's
     * self-cancellation, an expiry sweep, a platform actor. `undefined` keeps the
     * old behaviour for callers that do not know the actor.
     */
    actorKind?: string | null;
  }
) {
  const policy = await storeNotificationPolicy(tx, input.storeId);
  if (!policy || !policy.enabled) return;
  const payload = {
    orderNumber: input.orderNumber,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    storeName: policy.storeName,
  };
  const movedByTheShop = input.actorKind === "merchant" || input.actorKind === "staff";
  if (policy.preferences.orderStatusChanged && !movedByTheShop) {
    await tx.notificationOutbox.create({
      data: {
        storeId: input.storeId,
        eventType: "order.status_changed",
        orderId: input.orderId,
        recipientKind: "merchant",
        channel: "email",
        recipient: policy.merchantEmail,
        payload,
      },
    });
    signalOutboxWork();
  }
  if (input.customerEmail) {
    await tx.notificationOutbox.create({
      data: {
        storeId: input.storeId,
        eventType: "order.status_changed",
        orderId: input.orderId,
        recipientKind: "customer",
        channel: "email",
        recipient: input.customerEmail,
        payload,
      },
    });
    signalOutboxWork();
  }
}

/**
 * CD-1b — «مندوبك في الطريق». Enqueued from INSIDE the order-transition
 * transaction (same writer as enqueueOrderStatusChanged), so the message
 * commits with the transition or not at all.
 *
 * Customer-directed only: no merchant copy, and the row is skipped honestly
 * when the order carries no customer email — exactly like the phase-15
 * customer branches, which is why a guest/email-less order simply produces
 * nothing rather than a dead row.
 *
 * dedupeKey `courier_dispatched:{orderId}` + UNIQUE(store_id, dedupe_key) make
 * "one courier notice per order, forever" structural. The pre-check is the
 * primary guard so the common repeat path never raises a constraint violation
 * inside the caller's transaction; the P2002 swallow mirrors
 * enqueueLowStockIfCrossed as the race-proof second line.
 */
export async function enqueueCourierDispatched(
  tx: OutboxWriter,
  input: {
    storeId: string;
    orderId: string;
    orderNumber: string;
    customerEmail: string | null;
  }
) {
  const policy = await storeNotificationPolicy(tx, input.storeId);
  if (!policy || !policy.enabled || !policy.courierDispatch.enabled) return;
  if (!input.customerEmail) return;
  const dedupeKey = `courier_dispatched:${input.orderId}`;
  const existing = await tx.notificationOutbox.findFirst({
    where: { storeId: input.storeId, dedupeKey },
    select: { id: true },
  });
  if (existing) return;
  try {
    await tx.notificationOutbox.create({
      data: {
        storeId: input.storeId,
        eventType: COURIER_DISPATCHED_EVENT_TYPE,
        orderId: input.orderId,
        recipientKind: "customer",
        channel: "email",
        recipient: input.customerEmail,
        dedupeKey,
        payload: {
          orderNumber: input.orderNumber,
          storeName: policy.storeName,
          storeSlug: policy.storeSlug,
          trackingUrl: `/store/${encodeURIComponent(policy.storeSlug)}/track`,
        },
      },
    });
    signalOutboxWork();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
}

/**
 * Fires only when the stock level CROSSES the threshold downwards, so repeated
 * writes while the variant stays low do not spam the merchant. The dedupe key
 * additionally guards the same crossing against double-insert races.
 * Phase 20A: stock lives on product variants, so the crossing is evaluated with
 * variant numbers and deduped per variant; the payload's productName carries the
 * variant label (and the SKU is the variant SKU) while the outbox row keeps the
 * parent productId column for existing consumers.
 */
export async function enqueueLowStockIfCrossed(
  tx: OutboxWriter,
  input: {
    storeId: string;
    productId: string;
    variantId: string;
    productName: string;
    variantName?: string | null;
    sku: string;
    previousQuantity: number;
    stockQuantity: number;
    lowStockThreshold: number;
  }
) {
  if (input.lowStockThreshold <= 0) return;
  const wasLow = input.previousQuantity <= input.lowStockThreshold;
  const isLow = input.stockQuantity <= input.lowStockThreshold;
  if (wasLow || !isLow) return;
  const policy = await storeNotificationPolicy(tx, input.storeId);
  if (!policy || !policy.enabled || !policy.preferences.lowStock) return;
  const displayName =
    input.variantName && input.variantName !== input.productName
      ? `${input.productName} (${input.variantName})`
      : input.productName;
  /**
   * ق-234 — `skipDuplicates`, NOT a try/catch on P2002.
   *
   * This is the SAME lesson `loyalty.service.ts:298-304` already paid for, and
   * this call site never learned it: catching a unique violation inside a
   * PostgreSQL transaction does not work. The failed INSERT aborts the whole
   * transaction, so `return` hands control back to a transaction that is already
   * dead, and every statement after it dies with 25P02.
   *
   * And this runs INSIDE the order-transition transaction. The dedupe key is
   * `low_stock:<variant>:<quantity>`, so the second time a variant sells down to
   * a quantity it has already alerted on — the ordinary rhythm of a shop that
   * restocks — the collision took the entire completion down with it. A COD
   * order that cannot be completed is the platform's core function failing, and
   * the swallow was written to provide idempotency: it produced the exact
   * opposite.
   *
   * `createMany` with `skipDuplicates` never raises, so the transaction is never
   * poisoned and the notification is simply not queued twice — which is what
   * «already alerted» should have meant all along.
   */
  await tx.notificationOutbox.createMany({
    data: [
      {
        storeId: input.storeId,
        eventType: "low_stock",
        productId: input.productId,
        recipientKind: "merchant",
        channel: "email",
        recipient: policy.merchantEmail,
        dedupeKey: `low_stock:${input.variantId}:${input.stockQuantity}`,
        payload: {
          productName: displayName,
          sku: input.sku,
          variantId: input.variantId,
          variantName: input.variantName ?? input.productName,
          stockQuantity: input.stockQuantity,
          lowStockThreshold: input.lowStockThreshold,
          storeName: policy.storeName,
        },
      },
    ],
    skipDuplicates: true,
  });
  signalOutboxWork();
}

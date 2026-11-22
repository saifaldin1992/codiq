/**
 * codiq PG-1 «إلغاء الطلب من الزبون» — customer self-cancellation.
 *
 * A customer can call off an order they just placed, for as long as the store
 * has not started working on it. This saves the merchant a phone call and, more
 * importantly, prevents the far more expensive outcome: a courier arriving at a
 * door where nobody intends to pay.
 *
 * The cancellation goes through transitionOrderStatus — the SAME state machine
 * the merchant dashboard drives — rather than writing `cancelled` directly. That
 * is load-bearing, not stylistic: the transition is what releases the inventory
 * reservations, writes the status event, and enqueues the notification, all in
 * one transaction. A parallel write path would silently skip every one of them
 * and leave stock reserved for an order that no longer exists.
 *
 * Two boundaries, deliberately different:
 *   - a customer session from another store is refused at the route guard (403),
 *     consistent with every other storefront route;
 *   - another customer's order inside the right store is a plain 404 — never
 *     403 — so the endpoint cannot be used to discover which order ids exist.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { transitionOrderStatus } from "./order-lifecycle.service.js";

/** The only status a customer may cancel from. Past it, the store has committed work. */
const SELF_CANCELLABLE_STATUS = "new";
const MAX_REASON_LENGTH = 500;

function cancellationReason(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "INVALID_CANCELLATION_REASON", "السبب نص غير فارغ.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, "INVALID_CANCELLATION_REASON", `السبب حتى ${MAX_REASON_LENGTH} حرف.`);
  }
  return trimmed;
}

export async function cancelOwnOrder(storeId: string, customerId: string, orderId: string, body: { reason?: unknown }) {
  const reason = cancellationReason(body?.reason);
  // Ownership and store scope in one predicate: a miss on any of the three is
  // indistinguishable from an order that was never created.
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId, customerId },
    select: { id: true, status: true, version: true },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");
  if (order.status !== SELF_CANCELLABLE_STATUS) {
    throw new HttpError(409, "ORDER_NOT_CANCELLABLE", "قبل المتجر هذا الطلب، فلم يعد إلغاؤه من هنا ممكناً. تواصل مع المتجر.");
  }

  // The version read above is what the transition checks against. If the store
  // moves the order between these two statements, the optimistic check fails and
  // the customer is told the store already started — which is exactly true.
  try {
    const transitioned = await transitionOrderStatus(storeId, { kind: "customer", id: customerId }, orderId, {
      toStatus: "cancelled",
      expectedVersion: order.version,
      note: reason,
    });
    // transitionOrderStatus answers with the MERCHANT projection — it carries the
    // merchant's business identity and the store's internal fields. A shopper
    // gets only what a shopper needs to see their own order change state.
    return {
      order: {
        id: transitioned.id,
        orderNumber: transitioned.orderNumber,
        status: transitioned.status,
        version: transitioned.version,
        statusUpdatedAt: transitioned.statusUpdatedAt,
      },
    };
  } catch (error) {
    if (error instanceof HttpError && error.code === "ORDER_VERSION_CONFLICT") {
      throw new HttpError(409, "ORDER_NOT_CANCELLABLE", "قبل المتجر هذا الطلب، فلم يعد إلغاؤه من هنا ممكناً. تواصل مع المتجر.");
    }
    throw error;
  }
}

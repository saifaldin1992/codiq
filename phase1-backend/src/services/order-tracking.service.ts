/**
 * codiq CD-1a — «أين طلبي؟» public order tracking, WITHOUT a customer login.
 *
 * The whole feature is one read behind two secrets the customer already has:
 * the order number AND the recipient phone. Everything about the design is
 * defensive:
 *
 *  - The lookup is a single equality match on (store_id, order_number,
 *    recipient_phone). A wrong phone, a wrong order number, a foreign store's
 *    order, and a phone that is not even valid E.164 all produce the SAME
 *    generic 404 with the SAME message — the endpoint is never an oracle for
 *    "does this order number exist".
 *  - The projection is a deliberate ALLOW-LIST (see ORDER_TRACKING_KEYS): order
 *    number, status, a status timeline reduced to {toStatus, createdAt}, item
 *    count, total, governorate, createdAt. No customer name, no email, no phone,
 *    no address lines, no notes, no actor, no internal ids. The cd1 integration
 *    suite asserts the EXACT key sets, so widening this projection is a
 *    deliberate, test-visible act.
 *  - Rate limiting happens in the route on the existing storefront limiter
 *    (scope `order_track`, 10 attempts / 10 min, keyed on slug + phone), so
 *    guessing order numbers against one phone is bounded.
 */
import { HttpError } from "../auth/auth.errors.js";
import { toE164 } from "../auth/identity.js";
import { prisma } from "../db/prisma.js";

/** Attempts per 10-minute window, per (store slug, phone). */
export const ORDER_TRACK_RATE_LIMIT = 10;
/** Per-IP ceiling for the unauthenticated tracking form (all phones combined). */
export const ORDER_TRACK_IP_RATE_LIMIT = 60;

/** The exact, complete public projection. Exported for the cd1 assertions. */
export const ORDER_TRACKING_KEYS = ["orderNumber", "status", "statusTimeline", "itemCount", "totalIqd", "governorate", "createdAt"] as const;
export const ORDER_TRACKING_TIMELINE_KEYS = ["toStatus", "createdAt"] as const;

export interface OrderTrackingQuery {
  orderNumber: string;
  /** null when the supplied phone is not valid E.164 — treated as "no match". */
  phoneNormalized: string | null;
  /** Stable per-phone limiter key; derived from the raw input so a malformed phone is still bounded. */
  rateLimitKey: string;
}

export interface OrderTrackingView {
  orderNumber: string;
  status: string;
  statusTimeline: Array<{ toStatus: string; createdAt: Date }>;
  itemCount: number;
  totalIqd: number;
  governorate: string | null;
  createdAt: Date;
}

/**
 * Phone normalization for the PUBLIC form. Deliberately does NOT reuse
 * normalizePhone(): that helper throws a 400 INVALID_PHONE, which would let a
 * caller distinguish "bad format" from "no such order". Here an unusable phone
 * simply becomes null and falls through to the same generic 404.
 *
 * P27-12: the body moved to identity.ts as toE164() so the merchant paths can
 * share it. The CONTRACT here is unchanged and must stay unchanged — returning
 * null instead of throwing is an anti-enumeration guarantee, not a style choice.
 */
const normalizeTrackingPhone = toE164;

/**
 * Shape validation only — the two fields must be present, textual, and of sane
 * length. Anything beyond that (a phone that does not parse, an order number
 * that does not exist) is a lookup miss, never a distinct error.
 */
export function orderTrackingQuery(body: Record<string, unknown>): OrderTrackingQuery {
  const rawOrderNumber = typeof body.orderNumber === "string" ? body.orderNumber.trim() : "";
  const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!rawOrderNumber || rawOrderNumber.length > 120 || !rawPhone || rawPhone.length > 40) {
    throw new HttpError(400, "INVALID_TRACKING_REQUEST", "orderNumber and phone are required.");
  }
  const phoneNormalized = normalizeTrackingPhone(rawPhone);
  // An unparsable phone must NOT become the bucket key: it is attacker-chosen
  // free text, and every distinct value would leave a permanent row behind.
  return { orderNumber: rawOrderNumber, phoneNormalized, rateLimitKey: `order_track:${phoneNormalized ?? "unparsed"}` };
}

function notFound(): never {
  // ONE message for every miss. Do not specialize this — it is the anti-enumeration guarantee.
  throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found.");
}

export async function trackPublicOrder(storeId: string, query: OrderTrackingQuery): Promise<OrderTrackingView> {
  if (!query.phoneNormalized) notFound();
  const order = await prisma.storeOrder.findFirst({
    where: { storeId, orderNumber: query.orderNumber, recipientPhone: query.phoneNormalized },
    select: {
      orderNumber: true,
      status: true,
      totalIqd: true,
      shippingGovernorate: true,
      createdAt: true,
      items: { select: { quantity: true } },
      // Public timeline: the transition and when it happened. NEVER actorKind,
      // actorId, note, or fromStatus — those are merchant-internal.
      statusEvents: { select: { toStatus: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) notFound();
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    statusTimeline: order.statusEvents.map((event) => ({ toStatus: event.toStatus, createdAt: event.createdAt })),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    totalIqd: order.totalIqd,
    governorate: order.shippingGovernorate,
    createdAt: order.createdAt,
  };
}

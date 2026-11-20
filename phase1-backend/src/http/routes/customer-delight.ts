/**
 * codiq CD-1 «حزمة تدليل الزبون» — customer-delight routes.
 *
 * Registered AFTER every pre-existing module (see app.ts), so the legacy global
 * route-registration order is untouched. Both endpoints are POSTs and therefore
 * both carry requireTrustedWriteOrigin, the storefront CSRF guard.
 *
 * CD-1a  POST /store/:storeSlug/orders/track
 *        PUBLIC — no session at all. Guarded by (order number + recipient
 *        phone) plus a dedicated rate-limit scope. Returns the minimal
 *        projection defined in order-tracking.service.ts and a generic 404 for
 *        every miss.
 *
 * CD-1c  POST /store/:storeSlug/account/orders/:orderId/reorder
 *        requireStorefrontCustomer (session + store boundary) and ownership
 *        inside the service, so a foreign or cross-store order is a plain 404.
 *
 * PG-1   POST /store/:storeSlug/account/orders/:orderId/cancel
 *        Same guard and same ownership rule. The cancellation itself runs
 *        through the merchant state machine so reservations, status events and
 *        notifications all happen exactly as they do for a merchant cancel.
 *
 * PHASE 19-ج — WHY THESE TWO KEEP THEIR LEGACY ENTRY. They were reviewed and
 * left alone on purpose; they are not an oversight to be swept up later.
 *
 * Every shape refusal on both routes already answers a NAMED code that
 * `client/src/lib/storefront-api.ts` translates for the shopper:
 * INVALID_TRACKING_REQUEST → «أدخل رقم الطلب ورقم الهاتف المستخدم عند الطلب.»
 * and INVALID_CANCELLATION_REASON → «سبب الإلغاء طويل جدًا — اختصره في 500
 * حرف.». A stable machine code plus a translated sentence is exactly the shape
 * phase 22 needs; replacing it with the platform's generic shape error would
 * hand the storefront a server-rendered message keyed to nothing — moving this
 * surface AWAY from translatable, on the two routes shoppers meet first.
 *
 * The tracking route has a second reason: its refusal set is an anti-enumeration
 * design (see order-tracking.service.ts). Every miss is one 404 and every
 * malformed request one 400, deliberately, and changing what that endpoint can
 * answer is not a side effect of a validation sweep.
 *
 * The bounds themselves (an order number ≤ 120, a phone ≤ 40, a reason ≤ 500)
 * live in the two services beside the codes that report them.
 */
import type { Express } from "express";
import { cancelOwnOrder } from "../../services/order-self-cancel.service.js";
import { ORDER_TRACK_IP_RATE_LIMIT, ORDER_TRACK_RATE_LIMIT, orderTrackingQuery, trackPublicOrder } from "../../services/order-tracking.service.js";
import { reorderIntoCart } from "../../services/storefront.service.js";
import { asyncRoute, limitStorefrontWrite, requireStorefrontCustomer, requireTrustedWriteOrigin, resolveStorefrontStore } from "../shared.js";

import { clientIp } from "../client-ip.js";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
export function registerCustomerDelightRoutes(app: Express) {
  app.post("/store/:storeSlug/orders/track", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    await assertCapabilityAvailable("cx.tracking", store);
    // IP bucket FIRST: this is the only unauthenticated route in the codebase,
    // so malformed bodies get throttled too, and varying the phone can no longer
    // hand an attacker an unlimited budget against one order number.
    await limitStorefrontWrite(request, "order_track_ip", `ip:${clientIp(request)}`, ORDER_TRACK_IP_RATE_LIMIT);
    const query = orderTrackingQuery(request.body ?? {});
    // Then the per-phone bucket (limitStorefrontWrite prefixes the slug and
    // hashes the whole key), bounding order-number guessing against one phone.
    await limitStorefrontWrite(request, "order_track", query.rateLimitKey, ORDER_TRACK_RATE_LIMIT);
    response.status(200).json({ order: await trackPublicOrder(store.id, query) });
  }));

  app.post("/store/:storeSlug/account/orders/:orderId/reorder", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, customer } = await requireStorefrontCustomer(request);
    await assertCapabilityAvailable("cx.reorder", store);
    await limitStorefrontWrite(request, "cart_write", customer.id, 60);
    response.status(200).json(await reorderIntoCart(store.id, customer.id, request.params.orderId));
  }));

  app.post("/store/:storeSlug/account/orders/:orderId/cancel", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, customer } = await requireStorefrontCustomer(request);
    // Its own bucket, and a tight one: cancelling is rare and irreversible, so a
    // script hammering it is never legitimate traffic.
    await limitStorefrontWrite(request, "order_self_cancel", customer.id, 20);
    response.status(200).json(await cancelOwnOrder(store.id, customer.id, request.params.orderId, request.body ?? {}));
  }));
}

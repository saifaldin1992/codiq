/**
 * codiq PG-1 — customer self-cancellation.
 *
 * The feature exists to stop a courier from driving to a door where nobody
 * intends to pay, so the tests are about the boundaries around that button
 * rather than the happy path alone:
 *
 *   1. a customer cancels their own `new` order; the order lands on `cancelled`,
 *      the status event records actorKind `customer`, and the optional reason is
 *      stored as the event note;
 *   2. the inventory reservation is RELEASED — the proof that the cancellation
 *      went through the shared state machine and not a parallel write;
 *   3. the same order cannot be cancelled twice;
 *   4. once the store moves the order to `processing`, self-cancellation is
 *      refused with 409 ORDER_NOT_CANCELLABLE — and the order is untouched;
 *   5. every later status is refused the same way;
 *   6. another customer's order in the SAME store answers 404, never 403, so
 *      the endpoint cannot enumerate order ids;
 *   7. a session from another store is refused at the store boundary with 403;
 *   8. an anonymous request is 401;
 *   9. an over-long reason is rejected before anything is written;
 *  10. the merchant's own cancel path still works and still writes actorKind
 *      `merchant`, so widening the actor type did not disturb it.
 *
 * storefront_rate_limits is cleared before every write, as in the CD-1 suite.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `pg1-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "pg1-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

let customerPhoneSuffix = 0;
async function registerCustomer(slug, fullName) {
  customerPhoneSuffix += 1;
  const phone = `+96477066${String(customerPhoneSuffix).padStart(5, "0")}`;
  const registered = await request(`/store/${slug}/account/register`, { method: "POST", body: { phone, password: "Pg1CustomerPass2026!", fullName } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const address = await request(`/store/${slug}/account/addresses`, { method: "POST", token: registered.payload.accessToken, body: { recipientName: fullName, fullAddress: "شارع الإلغاء 1", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  return { token: registered.payload.accessToken, addressId: address.payload.address.id, phone };
}

let checkoutKeySuffix = 0;
async function placeOrder(slug, customer, productId, quantity = 2) {
  const added = await request(`/store/${slug}/cart/items`, { method: "POST", token: customer.token, body: { productId, quantity } });
  assert.equal(added.status, 200, JSON.stringify(added.payload));
  checkoutKeySuffix += 1;
  const result = await request(`/store/${slug}/checkout`, { method: "POST", token: customer.token, headers: { "idempotency-key": `pg1-checkout-${String(checkoutKeySuffix).padStart(4, "0")}` }, body: { cartVersion: added.payload.cart.version, addressId: customer.addressId, paymentMethodCode: "cod" } });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  return result.payload.order;
}

function cancelPath(slug, orderId) { return `/store/${slug}/account/orders/${orderId}/cancel`; }

const summary = {};

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE");

  // ---------------------------------------------------------------- fixtures
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100782801", email: `${testId}.merchant-a@codiq.test`, password: "Pg1MerchantPass2026!", businessName: "متجر الإلغاء ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100782802", email: `${testId}.merchant-b@codiq.test`, password: "Pg1MerchantPass2026!", businessName: "متجر الإلغاء باء" });
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر الإلغاء ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر الإلغاء باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  await prisma.deliveryRate.create({ data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  await prisma.deliveryRate.create({ data: { storeId: storeB.id, governorate: "Baghdad", amountIqd: 2000, isEnabled: true } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-a@codiq.test`, password: "Pg1MerchantPass2026!" } });
  assert.equal(loginA.status, 200);
  const tokenA = loginA.payload.accessToken;

  const widget = await prisma.product.create({ data: { storeId: storeA.id, sku: "PG1-WIDGET", name: "منتج الإلغاء", priceIqd: 5000, stockQuantity: 40, lowStockThreshold: 0 } });
  const widgetVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: widget.id, isDefault: true } });
  const productB = await prisma.product.create({ data: { storeId: storeB.id, sku: "PG1-B", name: "منتج متجر باء", priceIqd: 4000, stockQuantity: 20, lowStockThreshold: 0 } });

  const buyer = await registerCustomer(storeA.slug, "زبونة الإلغاء");

  // ق-214 needs the store's messaging switched ON to have anything to assert:
  // `enqueueOrderStatusChanged` writes nothing at all for a store that never
  // enabled it, which is every store by default (ق-208's rule).
  await prisma.notificationSettings.upsert({ where: { storeId: storeA.id }, update: { isEnabled: true }, create: { storeId: storeA.id, isEnabled: true } });

  // --- 1/2. the happy path, and the reservation release that proves the route ---
  const order = await placeOrder(storeA.slug, buyer, widget.id, 3);
  const reservedBefore = await prisma.inventoryReservation.aggregate({ where: { storeId: storeA.id, variantId: widgetVariant.id, status: "active" }, _sum: { quantity: true } });
  assert.equal(reservedBefore._sum.quantity, 3, "checkout reserves the ordered quantity");

  const cancelled = await request(cancelPath(storeA.slug, order.id), { method: "POST", token: buyer.token, body: { reason: "طلبت المقاس الخطأ" } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.order.status, "cancelled");

  const cancelEvent = await prisma.orderStatusEvent.findFirstOrThrow({ where: { storeId: storeA.id, orderId: order.id, toStatus: "cancelled" } });
  assert.equal(cancelEvent.fromStatus, "new");

  // ق-214 — THE MERCHANT IS TOLD ABOUT WHAT HE DID NOT DO.
  //
  // The merchant's copy of a status change is now enqueued only when somebody
  // ELSE moved the order, because his own copies were spending the per-recipient
  // operational ceiling that exists to protect a shopper from a store — and the
  // message that then got deferred to tomorrow was «طلب جديد», the trigger for
  // the COD confirmation call. A shopper cancelling his own order is exactly the
  // case the merchant must hear about, and this asserts it still reaches him.
  const cancelNotices = await prisma.notificationOutbox.findMany({
    where: { storeId: storeA.id, orderId: order.id, eventType: "order.status_changed" },
    select: { recipientKind: true },
  });
  assert.ok(cancelNotices.some((row) => row.recipientKind === "merchant"), `ق-214: the shopper's own cancellation still notifies the shop — ${JSON.stringify(cancelNotices)}`);
  assert.equal(cancelEvent.actorKind, "customer", "the history names the customer, not the merchant");
  assert.equal(cancelEvent.note, "طلبت المقاس الخطأ", "the reason is kept as the event note");

  const reservedAfter = await prisma.inventoryReservation.aggregate({ where: { storeId: storeA.id, variantId: widgetVariant.id, status: "active" }, _sum: { quantity: true } });
  assert.equal(reservedAfter._sum.quantity ?? 0, 0, "the reservation is released — the cancellation ran through the shared state machine");
  summary.selfCancel = { status: "cancelled", actorKind: cancelEvent.actorKind, reservationReleased: true };

  // --- 3. a second cancel of the same order is refused, not silently repeated ---
  const twice = await request(cancelPath(storeA.slug, order.id), { method: "POST", token: buyer.token });
  assert.equal(twice.status, 409);
  assert.equal(twice.payload.error.code, "ORDER_NOT_CANCELLABLE");
  const cancelEvents = await prisma.orderStatusEvent.count({ where: { storeId: storeA.id, orderId: order.id, toStatus: "cancelled" } });
  assert.equal(cancelEvents, 1, "no duplicate cancellation event");

  // --- 4/5. once the store has taken the order, the button is closed ---
  const accepted = await placeOrder(storeA.slug, buyer, widget.id, 1);
  const toProcessing = await request(`/merchant/stores/${storeA.slug}/orders/${accepted.id}/status`, { method: "POST", token: tokenA, body: { toStatus: "processing", expectedVersion: 1 } });
  assert.equal(toProcessing.status, 200, JSON.stringify(toProcessing.payload));
  const tooLate = await request(cancelPath(storeA.slug, accepted.id), { method: "POST", token: buyer.token });
  assert.equal(tooLate.status, 409);
  assert.equal(tooLate.payload.error.code, "ORDER_NOT_CANCELLABLE");
  const stillProcessing = await prisma.storeOrder.findUniqueOrThrow({ where: { id: accepted.id }, select: { status: true, version: true } });
  assert.equal(stillProcessing.status, "processing", "the refused cancel left the order exactly as it was");
  assert.equal(stillProcessing.version, toProcessing.payload.order.version, "the refused cancel did not bump the version");

  const laterStatuses = [];
  for (const [toStatus, expectedVersion] of [["preparation", 2], ["out_for_delivery", 3]]) {
    const moved = await request(`/merchant/stores/${storeA.slug}/orders/${accepted.id}/status`, { method: "POST", token: tokenA, body: { toStatus, expectedVersion } });
    assert.equal(moved.status, 200, JSON.stringify(moved.payload));
    const refused = await request(cancelPath(storeA.slug, accepted.id), { method: "POST", token: buyer.token });
    assert.equal(refused.status, 409, `self-cancel must stay closed at ${toStatus}`);
    assert.equal(refused.payload.error.code, "ORDER_NOT_CANCELLABLE");
    laterStatuses.push(toStatus);
  }
  summary.closedAfterAcceptance = { refusedAt: ["processing", ...laterStatuses], code: "ORDER_NOT_CANCELLABLE" };

  // --- 6/7/8. the three boundaries ---
  const stranger = await registerCustomer(storeA.slug, "زبونة غريبة");
  const strangerOrder = await placeOrder(storeA.slug, stranger, widget.id, 1);
  const foreignOrder = await request(cancelPath(storeA.slug, strangerOrder.id), { method: "POST", token: buyer.token });
  assert.equal(foreignOrder.status, 404, "another customer's order is not even acknowledged");
  assert.equal(foreignOrder.payload.error.code, "RESOURCE_NOT_FOUND");
  const strangerOrderIntact = await prisma.storeOrder.findUniqueOrThrow({ where: { id: strangerOrder.id }, select: { status: true } });
  assert.equal(strangerOrderIntact.status, "new", "the refused attempt did not touch the real owner's order");

  const buyerB = await registerCustomer(storeB.slug, "زبونة باء");
  const orderB = await placeOrder(storeB.slug, buyerB, productB.id, 1);
  const crossStoreOrder = await request(cancelPath(storeB.slug, order.id), { method: "POST", token: buyerB.token });
  assert.equal(crossStoreOrder.status, 404, "store A's order is invisible from store B");
  const crossStoreSession = await request(cancelPath(storeA.slug, orderB.id), { method: "POST", token: buyerB.token });
  assert.equal(crossStoreSession.status, 403, "a store B session is refused at the store A boundary");
  assert.equal(crossStoreSession.payload.error.code, "STORE_BOUNDARY_DENIED");

  const anonymous = await request(cancelPath(storeA.slug, strangerOrder.id), { method: "POST" });
  assert.equal(anonymous.status, 401, "cancelling always requires a customer session");
  summary.guards = { foreignCustomer: 404, crossStoreOrder: 404, crossStoreSession: 403, anonymous: 401 };

  // --- 9. a reason longer than the cap is rejected before anything is written ---
  const longReason = await request(cancelPath(storeA.slug, strangerOrder.id), { method: "POST", token: stranger.token, body: { reason: "ط".repeat(501) } });
  assert.equal(longReason.status, 400);
  assert.equal(longReason.payload.error.code, "INVALID_CANCELLATION_REASON");
  const untouched = await prisma.storeOrder.findUniqueOrThrow({ where: { id: strangerOrder.id }, select: { status: true } });
  assert.equal(untouched.status, "new", "a rejected reason leaves the order alone");
  // The cap itself is inclusive.
  const atCap = await request(cancelPath(storeA.slug, strangerOrder.id), { method: "POST", token: stranger.token, body: { reason: "ط".repeat(500) } });
  assert.equal(atCap.status, 200, JSON.stringify(atCap.payload));
  summary.reason = { over: 400, atCap: 200 };

  // --- 10. widening the actor type left the merchant path alone ---
  const merchantCancelled = await placeOrder(storeA.slug, buyer, widget.id, 1);
  const byMerchant = await request(`/merchant/stores/${storeA.slug}/orders/${merchantCancelled.id}/status`, { method: "POST", token: tokenA, body: { toStatus: "cancelled", expectedVersion: 1, note: "نفد المخزون" } });
  assert.equal(byMerchant.status, 200, JSON.stringify(byMerchant.payload));
  const merchantEvent = await prisma.orderStatusEvent.findFirstOrThrow({ where: { storeId: storeA.id, orderId: merchantCancelled.id, toStatus: "cancelled" } });
  assert.equal(merchantEvent.actorKind, "merchant", "a merchant cancel is still recorded as a merchant cancel");
  summary.merchantPathIntact = { actorKind: merchantEvent.actorKind };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

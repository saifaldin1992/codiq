/**
 * Marketplace M5 — one cart across stores, paid one store at a time through
 * that store's own checkout. Over HTTP, with real orders.
 *
 *   1. The cart: grouped by store; adding again merges and re-prices; add-ons
 *      priced into the line; the per-order cap and live stock refused on add
 *      (a pre-order is not held to stock); changing to an option already in
 *      the cart is refused; signed-out and foreign-origin requests refused.
 *   2. The summary: delivery fee for the address, «لا يوصّل» for a governorate
 *      the store skips, pick-up only where offered, a store coupon previewed.
 *   3. Paying one store: a real order through the store's checkout — add-ons
 *      inside the unit price and named on the line, coupon, delivery fee,
 *      stock reserved, the shopper made a customer of the store; only those
 *      lines leave the cart; the same key replays the same order and a key
 *      reused with different data is refused.
 *   4. A price that moved refuses once and is corrected, the next tap succeeds.
 *   5. Pick-up: no delivery fee, fulfilment recorded; refused where not offered.
 *   6. A store that already knew the shopper's phone links that customer row.
 *   7. «طلباتي»: every store's orders, newest first, paged; the detail with
 *      add-ons and timeline; another shopper's order is a 404.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");

const sent = [];
setOtpProviderForTests({ name: "capture", async send(phone, code) { sent.push({ phone, code }); } });
const testId = `m5${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

function client() {
  const jar = new Map();
  return {
    async request(path, { method = "GET", body, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), origin: base, ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const line of response.headers.getSetCookie?.() ?? []) { const [pair] = line.split(";"); const eq = pair.indexOf("="); jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1)); }
      return { status: response.status, headers: response.headers, payload: await response.json().catch(() => null) };
    },
  };
}
async function signIn(phone) {
  const shopper = client();
  const asked = await shopper.request("/market/auth/code", { method: "POST", body: { phone } });
  assert.equal(asked.status, 200, JSON.stringify(asked.payload));
  const verified = await shopper.request("/market/auth/verify", { method: "POST", body: { challengeId: asked.payload.challengeId, code: sent.at(-1).code } });
  assert.equal(verified.status, 200, JSON.stringify(verified.payload));
  return { shopper, id: verified.payload.shopper.id };
}
const key = (label) => `${testId}-${label}-idempotency`;

const created = { stores: [], shoppers: [] };
try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  const phone = `+96477${digits}4`.slice(0, 14);
  const merchant = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}6`.slice(0, 14), email: `${testId}@codiq.test`, password: "MarketCart!2026Strong" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  const A = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: `سوق ${testId} أ`, slug: `${testId}-a`, defaultSubdomain: `${testId}-a`, latitude: 33.3, longitude: 44.4, pickupEnabled: true, ...listed } });
  const B = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: `سوق ${testId} ب`, slug: `${testId}-b`, defaultSubdomain: `${testId}-b`, ...listed } });
  created.stores.push(A.id, B.id);
  await prisma.deliveryRate.create({ data: { storeId: A.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  await prisma.deliveryRate.create({ data: { storeId: B.id, governorate: "Basra", amountIqd: 4000, isEnabled: true } });
  const product = (store, data) => prisma.product.create({ data: { storeId: store.id, sku: `${testId}-${Math.random().toString(36).slice(2, 8)}`, ...data } });
  const a1 = await product(A, { name: "عطر", priceIqd: 10000, stockQuantity: 5 });
  const a1v1 = await prisma.productVariant.findFirstOrThrow({ where: { productId: a1.id, isDefault: true } });
  const a1v2 = await prisma.productVariant.create({ data: { storeId: A.id, productId: a1.id, sku: `${testId}-v2`, name: "حجم كبير", priceIqd: 15000, stockQuantity: 5, position: 1 } });
  const gift = await prisma.productAddon.create({ data: { storeId: A.id, productId: a1.id, name: "تغليف هدية", priceIqd: 2000 } });
  const a2 = await product(A, { name: "هاتف", priceIqd: 50000, stockQuantity: 10, maxPerOrder: 2 });
  const a3 = await product(A, { name: "ساعة قادمة", priceIqd: 7000, stockQuantity: 0, isPreorder: true });
  const b1 = await product(B, { name: "سماعة", priceIqd: 20000, stockQuantity: 3 });
  await prisma.coupon.create({ data: { storeId: A.id, code: "SAVE10", codeNormalized: "SAVE10", kind: "percent", percentOff: 10 } });
  // Store B already knows this phone from its own storefront.
  const knownAtB = await prisma.customer.create({ data: { storeId: B.id, fullName: "زبون قديم", phoneNormalized: phone, passwordHash: "$2b$12$C6UzMDM.H6dfI/f/IKcEe.7Gp3XW5rGN8pO1KcOxNrK5jP1Z2fZ2W" } });

  const { shopper, id: shopperId } = await signIn(phone);
  created.shoppers.push(shopperId);
  const kadhimiya = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكاظمية" } });
  const home = (await shopper.request("/market/me/addresses", { method: "POST", body: { label: "البيت", recipientName: "علي", phone, altPhone: `+96478${digits}7`.slice(0, 14), governorateKey: "Baghdad", districtId: kadhimiya.id, addressLine: "شارع ٢٠ قرب الجامع", latitude: null, longitude: null } })).payload.address;
  assert.ok(home?.id, "an address to deliver to");

  // ── 1. the cart ──────────────────────────────────────────────────────────
  assert.equal((await client().request("/market/cart")).status, 401, "the cart needs a shopper");
  assert.equal((await shopper.request("/market/cart/items", { method: "POST", body: { productId: a1.id, quantity: 1 }, headers: { origin: "https://evil.example" } })).status, 403);
  let cart = (await shopper.request("/market/cart/items", { method: "POST", body: { productId: a1.id, quantity: 2, addonIds: [gift.id] } })).payload;
  cart = (await shopper.request("/market/cart/items", { method: "POST", body: { productId: a1.id, quantity: 1, addonIds: [gift.id] } })).payload;
  const a1line = cart.stores[0].lines[0];
  assert.deepEqual([a1line.quantity, a1line.unitPriceIqd, a1line.addons[0].name], [3, 12000, "تغليف هدية"], "adding again merges; the add-on is in the unit price");
  const capped = await shopper.request("/market/cart/items", { method: "POST", body: { productId: a2.id, quantity: 3 } });
  assert.equal(capped.payload.error.code, "ORDER_LIMIT_EXCEEDED");
  const short = await shopper.request("/market/cart/items", { method: "POST", body: { productId: b1.id, quantity: 5 } });
  assert.deepEqual([short.payload.error.code, short.payload.error.available], ["INSUFFICIENT_AVAILABLE_STOCK", 3]);
  assert.equal((await shopper.request("/market/cart/items", { method: "POST", body: { productId: b1.id, quantity: 2 } })).status, 200);
  assert.equal((await shopper.request("/market/cart/items", { method: "POST", body: { productId: a3.id, quantity: 4 } })).status, 200, "a pre-order is not held to stock");
  const bigLine = (await shopper.request("/market/cart/items", { method: "POST", body: { variantId: a1v2.id, quantity: 1 } })).payload.stores[0].lines.find((line) => line.variant.id === a1v2.id);
  assert.equal((await shopper.request(`/market/cart/items/${bigLine.id}`, { method: "PATCH", body: { variantId: a1v1.id } })).payload.error.code, "CART_LINE_EXISTS", "that option is already in the cart");
  assert.equal((await shopper.request(`/market/cart/items/${bigLine.id}`, { method: "DELETE" })).status, 200);
  cart = (await shopper.request("/market/cart")).payload;
  assert.deepEqual(cart.stores.map((group) => group.store.slug).sort(), [A.slug, B.slug].sort(), "grouped by store");
  const groupA = cart.stores.find((group) => group.store.slug === A.slug);
  assert.equal(groupA.subtotalIqd, 3 * 12000 + 4 * 7000);
  summary.cart = true;

  // ── 2. summaries ─────────────────────────────────────────────────────────
  const sumA = (await shopper.request(`/market/checkout/${A.slug}?addressId=${home.id}&coupon=save10`)).payload;
  assert.deepEqual([sumA.delivery.amountIqd, sumA.coupon.discountIqd, sumA.totalIqd], [3000, Math.floor(sumA.subtotalIqd / 10), sumA.subtotalIqd - Math.floor(sumA.subtotalIqd / 10) + 3000]);
  const badCoupon = (await shopper.request(`/market/checkout/${A.slug}?addressId=${home.id}&coupon=NOPE`)).payload;
  assert.ok(badCoupon.coupon.error, "an invalid coupon is explained, not thrown");
  const sumB = (await shopper.request(`/market/checkout/${B.slug}?addressId=${home.id}`)).payload;
  assert.equal(sumB.delivery.available, false);
  assert.match(sumB.delivery.reason, /بغداد/);
  assert.equal((await shopper.request(`/market/checkout/${B.slug}?addressId=${home.id}&fulfilment=pickup`)).payload.delivery.available, false, "B offers no pick-up");
  summary.summary = true;

  // ── 3. paying store A ────────────────────────────────────────────────────
  assert.equal((await shopper.request(`/market/checkout/${B.slug}`, { method: "POST", body: { addressId: home.id }, headers: { "idempotency-key": key("b-baghdad") } })).payload.error.code, "DELIVERY_UNAVAILABLE_FOR_GOVERNORATE", "the store's own refusal, unchanged");
  const placed = await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id, couponCode: "SAVE10", note: "اتصل قبل الوصول" }, headers: { "idempotency-key": key("a1") } });
  assert.equal(placed.status, 201, JSON.stringify(placed.payload));
  const order = await prisma.storeOrder.findUniqueOrThrow({ where: { id: placed.payload.order.id }, include: { items: true, customer: true } });
  assert.equal(order.storeId, A.id);
  assert.equal(order.customer.shopperId, shopperId, "the shopper became the store's customer");
  assert.equal(order.deliveryFeeIqd, 3000);
  assert.equal(order.couponCode, "SAVE10");
  assert.equal(order.subtotalIqd, 3 * 12000 + 4 * 7000);
  assert.equal(order.totalIqd, order.subtotalIqd - order.discountIqd + 3000);
  const perfumeLine = order.items.find((item) => item.productId === a1.id);
  assert.deepEqual([perfumeLine.unitPriceIqd, perfumeLine.addons[0].name], [12000, "تغليف هدية"], "the add-on is priced into the line and named on it");
  assert.match(order.customerNote, /رقم بديل/, "the alternate number reaches the store");
  const reservations = await prisma.inventoryReservation.findMany({ where: { orderId: order.id } });
  assert.equal(reservations.reduce((sum, row) => sum + row.quantity, 0), 7, "stock reserved like any storefront order");
  cart = (await shopper.request("/market/cart")).payload;
  assert.deepEqual(cart.stores.map((group) => group.store.slug), [B.slug], "only store A's lines left the cart");
  const replay = await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id, couponCode: "SAVE10", note: "اتصل قبل الوصول" }, headers: { "idempotency-key": key("a1") } });
  assert.deepEqual([replay.status, replay.payload.replayed, replay.payload.order.id], [200, true, order.id], "the same key is the same order");
  summary.checkout = true;

  // ── 4. a moved price ─────────────────────────────────────────────────────
  await shopper.request("/market/cart/items", { method: "POST", body: { productId: a2.id, quantity: 1 } });
  await prisma.productVariant.updateMany({ where: { productId: a2.id }, data: { priceIqd: 55000 } });
  const moved = await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id }, headers: { "idempotency-key": key("moved-1") } });
  assert.equal(moved.payload.error.code, "CART_PRICE_CHANGED");
  const corrected = (await shopper.request("/market/cart")).payload.stores.find((group) => group.store.slug === A.slug).lines[0];
  assert.deepEqual([corrected.unitPriceIqd, corrected.problem], [55000, null], "the cart now shows the live price");
  const after = await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id }, headers: { "idempotency-key": key("moved-2") } });
  assert.equal(after.status, 201, JSON.stringify(after.payload));
  summary.priceMoved = true;

  // ── 5. pick-up ───────────────────────────────────────────────────────────
  await shopper.request("/market/cart/items", { method: "POST", body: { productId: a1.id, quantity: 1 } });
  const pickup = await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id, fulfilment: "pickup" }, headers: { "idempotency-key": key("pickup") } });
  assert.equal(pickup.status, 201, JSON.stringify(pickup.payload));
  const pickupOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: pickup.payload.order.id } });
  assert.deepEqual([pickupOrder.fulfilment, pickupOrder.deliveryFeeIqd], ["pickup", 0]);
  assert.equal((await shopper.request(`/market/checkout/${B.slug}`, { method: "POST", body: { addressId: home.id, fulfilment: "pickup" }, headers: { "idempotency-key": key("b-pickup") } })).payload.error.code, "PICKUP_NOT_AVAILABLE");
  // The merchant's own order screen reads the same order: the pick-up and the add-on are on it.
  const merchantToken = (await client().request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}@codiq.test`, password: "MarketCart!2026Strong" } })).payload.accessToken;
  const asMerchant = async (orderId) => (await fetch(`${base}/merchant/stores/${A.slug}/orders/${orderId}`, { headers: { authorization: `Bearer ${merchantToken}` } })).json();
  const merchantView = await asMerchant(pickupOrder.id);
  assert.equal((merchantView.order ?? merchantView).fulfilment, "pickup", "the merchant sees it is a pick-up");
  const firstView = await asMerchant(order.id);
  assert.equal((firstView.order ?? firstView).items.find((item) => item.productId === a1.id).addons[0].name, "تغليف هدية", "and which add-ons to pack");
  summary.pickup = true;

  // ── 6. a store that already knew him ─────────────────────────────────────
  const ashar = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Basra", nameAr: "العشار" } });
  const basra = (await shopper.request("/market/me/addresses", { method: "POST", body: { label: "العمل", recipientName: "علي", phone, altPhone: null, governorateKey: "Basra", districtId: ashar.id, addressLine: "العشار، شارع الكورنيش", latitude: null, longitude: null } })).payload.address;
  const atB = await shopper.request(`/market/checkout/${B.slug}`, { method: "POST", body: { addressId: basra.id }, headers: { "idempotency-key": key("b-basra") } });
  assert.equal(atB.status, 201, JSON.stringify(atB.payload));
  const bOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: atB.payload.order.id } });
  assert.equal(bOrder.customerId, knownAtB.id, "the store's existing customer row is linked, not duplicated");
  assert.equal(await prisma.customer.count({ where: { storeId: B.id, phoneNormalized: phone } }), 1);
  assert.deepEqual((await shopper.request("/market/cart")).payload.stores, [], "the cart is empty");
  summary.linkedCustomer = true;

  // ── 7. «طلباتي» ──────────────────────────────────────────────────────────
  const page1 = (await shopper.request("/market/orders?limit=2")).payload;
  assert.equal(page1.orders.length, 2);
  assert.equal(page1.orders[0].id, bOrder.id, "newest first, across stores");
  const page2 = (await shopper.request(`/market/orders?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`)).payload;
  assert.equal(page1.orders.length + page2.orders.length, 4);
  const detail = (await shopper.request(`/market/orders/${order.id}`)).payload.order;
  assert.equal(detail.items.find((item) => item.productId === a1.id).addons[0].name, "تغليف هدية");
  assert.equal(detail.timeline[0].label, "قيد المراجعة");
  const stranger = await signIn(`+96479${digits}8`.slice(0, 14));
  created.shoppers.push(stranger.id);
  assert.equal((await stranger.shopper.request(`/market/orders/${order.id}`)).status, 404, "another shopper's order is a 404");
  assert.deepEqual((await stranger.shopper.request("/market/orders")).payload.orders, []);
  summary.orders = true;

  // ── 8. «اشتريت منها» ─────────────────────────────────────────────────────
  // Only a COMPLETED order makes a store «bought from»; open ones do not.
  assert.deepEqual((await shopper.request("/market/me/stores")).payload.stores, [], "no completed order yet, no store");
  await prisma.storeOrder.update({ where: { id: order.id }, data: { status: "completed" } });
  const bought = await shopper.request("/market/me/stores");
  assert.equal(bought.status, 200);
  assert.deepEqual(bought.payload.stores.map((store) => store.slug), [A.slug], "the store with a completed order, and only it");
  assert.match(bought.headers.get("cache-control") ?? "", /private/, "a shopper's own history is never cached publicly");
  assert.deepEqual((await stranger.shopper.request("/market/me/stores")).payload.stores, [], "another shopper's purchases are not his");
  assert.equal((await client().request("/market/me/stores")).status, 401);
  summary.boughtFrom = true;

  // ── 9. M6 «إلغاء الطلب» ──────────────────────────────────────────────────
  await shopper.request("/market/cart/items", { method: "POST", body: { productId: a1.id, quantity: 1 } });
  const toCancel = (await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id }, headers: { "idempotency-key": key("to-cancel") } })).payload.order;
  assert.ok(toCancel?.id, "an order to call off");
  const offered = (await shopper.request(`/market/orders/${toCancel.id}`)).payload;
  assert.equal(offered.order.cancellable, true, "a new order can be cancelled");
  assert.ok(offered.cancelReasons.some((reason) => reason.code === "other"), "…with reasons to choose from");
  assert.equal((await prisma.inventoryReservation.count({ where: { orderId: toCancel.id, status: "active" } })) > 0, true, "the order holds stock");
  assert.equal((await stranger.shopper.request(`/market/orders/${toCancel.id}/cancel`, { method: "POST", body: { reasonCode: "changed_mind" } })).status, 404, "another shopper cannot cancel it");
  assert.equal((await shopper.request(`/market/orders/${toCancel.id}/cancel`, { method: "POST", body: { reasonCode: "because" } })).status, 422, "a reason off the list is refused");
  assert.equal((await shopper.request(`/market/orders/${toCancel.id}/cancel`, { method: "POST", body: { reasonCode: "other" } })).payload.error.code, "CANCELLATION_NOTE_REQUIRED", "«سبب آخر» needs words");
  assert.equal((await shopper.request(`/market/orders/${toCancel.id}/cancel`, { method: "POST", body: { reasonCode: "changed_mind" }, headers: { origin: "https://evil.example" } })).status, 403, "origin-checked");
  const cancelled = await shopper.request(`/market/orders/${toCancel.id}/cancel`, { method: "POST", body: { reasonCode: "delivery_too_long", note: "أحتاجه اليوم" } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.order.status, "cancelled");
  const cancelEvent = await prisma.orderStatusEvent.findFirst({ where: { orderId: toCancel.id, toStatus: "cancelled" } });
  assert.equal(cancelEvent.note, "سبب الإلغاء: مدّة التوصيل طويلة — أحتاجه اليوم", "the merchant reads the reason on the order");
  assert.equal(cancelEvent.actorKind, "customer", "…as the customer's own move");
  assert.equal(await prisma.inventoryReservation.count({ where: { orderId: toCancel.id, status: "active" } }), 0, "the stock is released — the store's own transition ran");
  assert.equal((await shopper.request(`/market/orders/${toCancel.id}/cancel`, { method: "POST", body: { reasonCode: "changed_mind" } })).payload.error.code, "ORDER_NOT_CANCELLABLE", "a cancelled order cannot be cancelled again");
  assert.equal((await shopper.request(`/market/orders/${toCancel.id}`)).payload.order.cancellable, false);
  // Past «new» the store has started: the shopper is sent to the store instead.
  await prisma.storeOrder.update({ where: { id: bOrder.id }, data: { status: "processing" } });
  const late = await shopper.request(`/market/orders/${bOrder.id}/cancel`, { method: "POST", body: { reasonCode: "changed_mind" } });
  assert.equal(late.status, 409);
  assert.equal(late.payload.error.code, "ORDER_NOT_CANCELLABLE");
  assert.deepEqual((await shopper.request(`/market/orders/${bOrder.id}`)).payload.cancelReasons, [], "no reasons are offered once the store has started");
  summary.cancel = true;

  // ── 10. M6 «قيّم طلبك» ───────────────────────────────────────────────────
  // `order` (store A, delivery) was completed in section 8.
  const rateUrl = `/market/orders/${order.id}/rating`;
  assert.equal((await shopper.request(`/market/orders/${toCancel.id}/rating`, { method: "PUT", body: { tags: ["fast_delivery"] } })).payload.error.code, "ORDER_NOT_RATEABLE", "only a completed order is rated");
  const before = (await shopper.request(`/market/orders/${order.id}`)).payload;
  assert.equal(before.order.rateable, true);
  assert.equal(before.order.rating, null, "not rated yet");
  assert.ok(before.ratingTags.some((tag) => tag.code === "great_service"), "the tags to choose from");
  assert.ok((await shopper.request("/market/me/ratings/pending")).payload.orders.some((row) => row.id === order.id), "«بانتظار تقييمك» lists it");
  assert.equal((await stranger.shopper.request(rateUrl, { method: "PUT", body: { tags: ["fast_delivery"] } })).status, 404, "another shopper cannot rate it");
  assert.equal((await shopper.request(rateUrl, { method: "PUT", body: {} })).payload.error.code, "EMPTY_RATING");
  assert.equal((await shopper.request(rateUrl, { method: "PUT", body: { tags: ["lovely"] } })).status, 422, "a tag off the list is refused");
  assert.equal((await shopper.request(rateUrl, { method: "PUT", body: { products: [{ productId: b1.id, rating: 5 }] } })).payload.error.code, "PRODUCT_NOT_IN_ORDER");
  assert.equal((await shopper.request(rateUrl, { method: "PUT", body: { deliveryRating: 6 } })).status, 422, "stars are one to five");
  const rated = await shopper.request(rateUrl, { method: "PUT", body: { products: [{ productId: a1.id, rating: 4, comment: "رائحة جميلة" }], deliveryRating: 5, tags: ["fast_delivery", "as_described"], note: "شكراً" } });
  assert.equal(rated.status, 200, JSON.stringify(rated.payload));
  assert.deepEqual(rated.payload.rating.tags.map((tag) => tag.code), ["fast_delivery", "as_described"]);
  const review = await prisma.productReview.findFirst({ where: { productId: a1.id, customerId: order.customerId, withdrawnAt: null } });
  assert.equal(review.rating, 4, "the product's stars are a verified-buyer review of the store");
  assert.equal(review.orderId, order.id);
  assert.equal(review.body, "رائحة جميلة");
  assert.ok(!(await shopper.request("/market/me/ratings/pending")).payload.orders.some((row) => row.id === order.id), "…and leaves «بانتظار تقييمك»");
  // Revised: still one review, now two stars; the comment kept when none is sent.
  await shopper.request(rateUrl, { method: "PUT", body: { products: [{ productId: a1.id, rating: 2 }], deliveryRating: 3, tags: ["late_delivery"] } });
  const reviews = await prisma.productReview.findMany({ where: { productId: a1.id, customerId: order.customerId, withdrawnAt: null } });
  assert.deepEqual(reviews.map((row) => [row.rating, row.body]), [[2, "رائحة جميلة"]], "one review per product, revised in place");
  assert.equal(await prisma.orderRating.count({ where: { orderId: order.id } }), 1);
  const mine = (await shopper.request("/market/me/ratings")).payload;
  assert.deepEqual(mine.ratings.map((row) => [row.order.id, row.deliveryRating, row.tags.map((tag) => tag.code)]), [[order.id, 3, ["late_delivery"]]], "«تقييماتي»");
  assert.deepEqual((await stranger.shopper.request("/market/me/ratings")).payload.ratings, []);
  // A pick-up has no delivery to rate.
  await prisma.storeOrder.update({ where: { id: pickupOrder.id }, data: { status: "completed" } });
  assert.equal((await shopper.request(`/market/orders/${pickupOrder.id}/rating`, { method: "PUT", body: { deliveryRating: 5 } })).payload.error.code, "NO_DELIVERY_TO_RATE");
  assert.equal((await shopper.request(`/market/orders/${pickupOrder.id}/rating`, { method: "PUT", body: { tags: ["great_service"] } })).status, 200, "…its service can still be rated");
  // The database holds the list too: a tag the code does not know cannot be written past it.
  await assert.rejects(prisma.orderRating.update({ where: { orderId: order.id }, data: { tags: ["lovely"] } }), "order_ratings_known_tags");
  summary.rating = true;

  // ── 11. M6 «رمز الاستلام» ────────────────────────────────────────────────
  await shopper.request("/market/cart/items", { method: "POST", body: { productId: a1.id, quantity: 1 } });
  const collect = (await shopper.request(`/market/checkout/${A.slug}`, { method: "POST", body: { addressId: home.id, fulfilment: "pickup" }, headers: { "idempotency-key": key("collect") } })).payload.order;
  assert.equal((await shopper.request(`/market/orders/${collect.id}`)).payload.order.pickupCode, null, "no code before the order is ready");
  const asMerchantPost = async (path, body) => {
    const response = await fetch(`${base}/merchant/stores/${A.slug}/orders/${path}`, { method: "POST", headers: { authorization: `Bearer ${merchantToken}`, "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  for (const toStatus of ["processing", "preparation", "out_for_delivery"]) {
    const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: collect.id }, select: { version: true } });
    assert.equal((await asMerchantPost(`${collect.id}/status`, { toStatus, expectedVersion: version })).status, 200, toStatus);
  }
  const ready = (await shopper.request(`/market/orders/${collect.id}`)).payload.order;
  assert.match(ready.pickupCode ?? "", /^\d{6}$/, "a ready pick-up shows six digits");
  assert.equal(ready.statusLabel, "جاهز للاستلام");
  assert.equal((await shopper.request("/market/orders?limit=50")).payload.orders.find((row) => row.id === collect.id).statusLabel, "جاهز للاستلام", "…in «طلباتي» too");
  const wrong = String((Number(ready.pickupCode) + 1) % 1_000_000).padStart(6, "0");
  assert.equal((await asMerchantPost(`${collect.id}/pickup-confirm`, { code: "12ab" })).status, 422, "six digits");
  assert.equal((await asMerchantPost(`${collect.id}/pickup-confirm`, { code: wrong })).payload.error.code, "WRONG_PICKUP_CODE");
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: collect.id } })).status, "out_for_delivery", "a wrong code changes nothing");
  assert.equal((await asMerchantPost(`${order.id}/pickup-confirm`, { code: ready.pickupCode })).payload.error.code, "NOT_A_PICKUP_ORDER", "a delivery order has no pick-up code");
  const confirmedPickup = await asMerchantPost(`${collect.id}/pickup-confirm`, { code: ready.pickupCode });
  assert.equal(confirmedPickup.status, 200, JSON.stringify(confirmedPickup.payload));
  assert.equal(confirmedPickup.payload.order.status, "completed");
  const handedOver = await prisma.orderStatusEvent.findFirst({ where: { orderId: collect.id, toStatus: "completed" } });
  assert.match(handedOver.note, /رمز الاستلام/, "the history says how it was confirmed");
  assert.equal((await shopper.request(`/market/orders/${collect.id}`)).payload.order.pickupCode, null, "a collected order shows no code");
  assert.equal((await asMerchantPost(`${collect.id}/pickup-confirm`, { code: ready.pickupCode })).payload.error.code, "PICKUP_NOT_READY", "a second confirmation is refused");
  summary.pickupCode = true;

  console.log(JSON.stringify({ suite: "market-cart", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.store.updateMany({ where: { id: { in: created.stores } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}

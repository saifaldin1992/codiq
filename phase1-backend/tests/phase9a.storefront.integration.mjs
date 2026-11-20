import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `phase9a-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "phase9a-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createPasswordHash, createTypedSession } = await import("../src/auth/identity.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function cookieFrom(response, prefix) {
  const raw = response.headers.get("set-cookie") ?? "";
  const matched = raw.match(new RegExp(`(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=[^;]+)`));
  return matched?.[1] ?? null;
}

async function request(path, { method = "GET", body, token, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, payload: response.status === 204 ? null : await response.json().catch(() => null), response };
}

async function merchantStatus(token, slug, orderId, toStatus, expectedVersion) {
  return request(`/merchant/stores/${slug}/orders/${orderId}/status`, { method: "POST", token, body: { toStatus, expectedVersion } });
}

async function waitForCheckoutProductLock(monitor) {
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const result = await monitor.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%' AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting");
    if (result.rows[0].waiting) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("CO-05 synchronization barrier was not reached.");
}

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100745101", email: `${testId}.merchant-a@codiq.test`, password: "Phase9MerchantPass123!", businessName: "متجر 9A ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100745102", email: `${testId}.merchant-b@codiq.test`, password: "Phase9MerchantPass123!", businessName: "متجر 9A باء" });
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر 9A ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر 9A باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  const merchantLoginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-a@codiq.test`, password: "Phase9MerchantPass123!" } });
  assert.equal(merchantLoginA.status, 200);
  const merchantTokenA = merchantLoginA.payload.accessToken;

  const categoryA = await prisma.productCategory.create({ data: { storeId: storeA.id, name: "تصنيف ألف", normalizedName: "تصنيف ألف" } });
  const categoryB = await prisma.productCategory.create({ data: { storeId: storeB.id, name: "تصنيف باء", normalizedName: "تصنيف باء" } });
  const productA = await prisma.product.create({ data: { storeId: storeA.id, categoryId: categoryA.id, sku: "SF-A", name: "منتج متجر ألف للبحث", description: "وصف قابل للبحث ألف", priceIqd: 10000, stockQuantity: 5, lowStockThreshold: 1 } });
  const productB = await prisma.product.create({ data: { storeId: storeB.id, categoryId: categoryB.id, sku: "SF-B", name: "منتج متجر باء للبحث", description: "وصف قابل للبحث باء", priceIqd: 9000, stockQuantity: 5, lowStockThreshold: 1 } });
  const activeDeliveryRate = await prisma.deliveryRate.create({ data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  const publicList = await request(`/store/${storeA.slug}/products`);
  assert.equal(publicList.status, 200); assert.equal(publicList.payload.products.some((product) => product.id === productA.id), true); assert.equal(publicList.payload.products.some((product) => product.id === productB.id), false);
  const hiddenCrossProduct = await request(`/store/${storeA.slug}/products/${productB.id}`);
  assert.equal(hiddenCrossProduct.status, 404);
  const publicCategories = await request(`/store/${storeA.slug}/categories`);
  assert.equal(publicCategories.status, 200); assert.deepEqual(publicCategories.payload.categories, [{ id: categoryA.id, name: categoryA.name, parentCategoryId: null }]);
  const filteredPublicProducts = await request(`/store/${storeA.slug}/products?categoryId=${categoryA.id}`);
  assert.equal(filteredPublicProducts.status, 200); assert.equal(filteredPublicProducts.payload.products.some((product) => product.id === productA.id), true); assert.equal(filteredPublicProducts.payload.products.some((product) => product.id === productB.id), false);
  const foreignCategoryFilter = await request(`/store/${storeA.slug}/products?categoryId=${categoryB.id}`);
  assert.equal(foreignCategoryFilter.status, 200); assert.equal(foreignCategoryFilter.payload.products.length, 0);
  const searchedPublicProducts = await request(`/store/${storeA.slug}/products?q=${encodeURIComponent("وصف قابل للبحث")}`);
  assert.equal(searchedPublicProducts.status, 200); assert.equal(searchedPublicProducts.payload.products.some((product) => product.id === productA.id), true); assert.equal(searchedPublicProducts.payload.products.some((product) => product.id === productB.id), false);
  const invalidProductFilter = await request(`/store/${storeA.slug}/products?categoryId=not-a-uuid`);
  assert.equal(invalidProductFilter.status, 400); assert.equal(invalidProductFilter.payload.error.code, "INVALID_PRODUCT_FILTER");
  const zeroStockProduct = await prisma.product.create({ data: { storeId: storeA.id, categoryId: categoryA.id, sku: "SF-A-ZERO", name: "منتج نافد عام", priceIqd: 4000, stockQuantity: 0, lowStockThreshold: 1 } });
  const zeroStockPublic = await request(`/store/${storeA.slug}/products/${zeroStockProduct.id}`);
  assert.equal(zeroStockPublic.status, 200); assert.equal(zeroStockPublic.payload.product.isAvailable, false); assert.equal(Object.hasOwn(zeroStockPublic.payload.product, "stockQuantity"), false);

  const guestAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", body: { productId: productA.id, quantity: 2 } });
  assert.equal(guestAdd.status, 200); assert.equal(guestAdd.payload.cart.items[0].priceSnapshotIqd, 10000);
  const guestCookie = cookieFrom(guestAdd.response, `codiq_cart_${storeA.slug}`);
  assert.ok(guestCookie);
  const guestCheckout = await request(`/store/${storeA.slug}/checkout`, { method: "POST", cookie: guestCookie, headers: { "idempotency-key": "phase9a-guest-checkout-key-00001" }, body: { cartVersion: guestAdd.payload.cart.version, addressId: "00000000-0000-0000-0000-000000000000", paymentMethodCode: "cod" } });
  assert.equal(guestCheckout.status, 401); assert.equal(guestCheckout.payload.error.code, "CUSTOMER_SESSION_REQUIRED");
  const guestTokenHash = (await prisma.shoppingCart.findUniqueOrThrow({ where: { id: guestAdd.payload.cart.id }, select: { sessionTokenHash: true } })).sessionTokenHash;
  let guestTokenUniqueCode = null;
  try { await sql.query("INSERT INTO shopping_carts (store_id, owner_kind, session_token_hash, expires_at) VALUES ($1::uuid, 'guest', $2, now() + interval '7 days')", [storeA.id, guestTokenHash]); } catch (error) { guestTokenUniqueCode = error?.code ?? null; }
  assert.equal(guestTokenUniqueCode, "23505");
  const crossStoreCart = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", cookie: guestCookie, body: { productId: productB.id, quantity: 1 } });
  assert.equal(crossStoreCart.status, 404);
  const csrfDenied = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", cookie: guestCookie, headers: { origin: "https://evil.example" }, body: { productId: productA.id, quantity: 1 } });
  assert.equal(csrfDenied.status, 403);

  await prisma.product.update({ where: { id: productA.id }, data: { priceIqd: 15000 } });
  const guestCart = await request(`/store/${storeA.slug}/cart`, { cookie: guestCookie });
  assert.equal(guestCart.status, 200); assert.equal(guestCart.payload.cart.items[0].priceSnapshotIqd, 10000);
  const guestCartId = guestCart.payload.cart.id;
  let compositeFkCode = null;
  try { await sql.query("INSERT INTO cart_items (cart_id, store_id, product_id, quantity, price_snapshot_iqd) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1)", [guestCartId, storeA.id, productB.id]); } catch (error) { compositeFkCode = error?.code ?? null; }
  assert.equal(compositeFkCode, "23503");

  const register = await request(`/store/${storeA.slug}/account/register`, { method: "POST", cookie: guestCookie, body: { phone: "+9647700000001", password: "Phase9CustomerPass123!", fullName: "زبون متجر ألف" } });
  assert.equal(register.status, 201); assert.equal(register.payload.cart.items[0].quantity, 2);
  const customerTokenA = register.payload.accessToken;
  const customerA = register.payload.account;
  const duplicatePhone = await request(`/store/${storeA.slug}/account/register`, { method: "POST", body: { phone: "+9647700000001", password: "Phase9CustomerPass123!", fullName: "مكرر" } });
  assert.equal(duplicatePhone.status, 409);
  const samePhoneDifferentStore = await request(`/store/${storeB.slug}/account/register`, { method: "POST", body: { phone: "+9647700000001", password: "Phase9CustomerPass123!", fullName: "نفس الهاتف متجر باء" } });
  assert.equal(samePhoneDifferentStore.status, 201);
  const mergeGuest = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", body: { productId: productA.id, quantity: 1 } });
  const mergeGuestCookie = cookieFrom(mergeGuest.response, `codiq_cart_${storeA.slug}`);
  await prisma.customer.create({ data: { storeId: storeA.id, fullName: "عميل دمج متزامن", passwordHash: await createPasswordHash("Phase9ConcurrentMergePass123!"), phoneNormalized: "+9647700000003" } });
  const concurrentLogins = await Promise.all([
    request(`/store/${storeA.slug}/account/login`, { method: "POST", cookie: mergeGuestCookie, body: { phone: "+9647700000003", password: "Phase9ConcurrentMergePass123!" } }),
    request(`/store/${storeA.slug}/account/login`, { method: "POST", cookie: mergeGuestCookie, body: { phone: "+9647700000003", password: "Phase9ConcurrentMergePass123!" } }),
  ]);
  assert.equal(concurrentLogins.every((result) => result.status === 200), true);
  const mergedConcurrentCart = await request(`/store/${storeA.slug}/cart`, { token: concurrentLogins[0].payload.accessToken });
  assert.equal(mergedConcurrentCart.payload.cart.items.length, 1); assert.equal(mergedConcurrentCart.payload.cart.items[0].quantity, 1);
  let addressStoreGuardCode = null;
  try { await sql.query("INSERT INTO customer_addresses (store_id, customer_id, recipient_name, full_address, city, governorate, phone_contact_normalized) VALUES ($1::uuid, $2::uuid, 'ممنوع', 'عنوان', 'Baghdad', 'Baghdad', '+9647700000001')", [storeB.id, customerA.id]); } catch (error) { addressStoreGuardCode = error?.code ?? null; }
  assert.equal(addressStoreGuardCode, "23503");
  let orderCustomerStoreGuardCode = null;
  try { await sql.query("INSERT INTO store_orders (store_id, customer_id, order_number, status, customer_name, subtotal_iqd, total_iqd) VALUES ($1::uuid, $2::uuid, 'PHASE9A-CROSS-STORE', 'new', 'ممنوع', 1, 1)", [storeB.id, customerA.id]); } catch (error) { orderCustomerStoreGuardCode = error?.code ?? null; }
  assert.equal(orderCustomerStoreGuardCode, "23503");
  const address = await request(`/store/${storeA.slug}/account/addresses`, { method: "POST", token: customerTokenA, body: { recipientName: "زبون متجر ألف", fullAddress: "شارع الاختبار 1", city: "Baghdad", governorate: "Baghdad", phoneContact: "+9647700000001", isDefault: true } });
  assert.equal(address.status, 201);
  const unavailableAddress = await request(`/store/${storeA.slug}/account/addresses`, { method: "POST", token: customerTokenA, body: { recipientName: "زبون محافظة غير متاحة", fullAddress: "شارع الاختبار 2", city: "Karbala", governorate: "Karbala", phoneContact: "+9647700000001", isDefault: false } });
  assert.equal(unavailableAddress.status, 201);

  const co05Locker = new Client({ connectionString: process.env.DATABASE_URL });
  const co05Monitor = new Client({ connectionString: process.env.DATABASE_URL });
  await co05Locker.connect();
  await co05Monitor.connect();
  await co05Locker.query("BEGIN");
  await co05Locker.query("SELECT id FROM products WHERE id = $1::uuid FOR UPDATE", [productA.id]);
  const co05OrdersBefore = await prisma.storeOrder.count({ where: { storeId: storeA.id, customerId: customerA.id, source: "storefront" } });
  const co05ReservationsBefore = await prisma.inventoryReservation.count({ where: { storeId: storeA.id, productId: productA.id } });
  const co05StockBefore = (await prisma.product.findUniqueOrThrow({ where: { id: productA.id } })).stockQuantity;
  const co05Cart = await request(`/store/${storeA.slug}/cart`, { token: customerTokenA });
  assert.equal(co05Cart.status, 200);
  const co05Checkout = request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-co05-deterministic-key" }, body: { cartVersion: co05Cart.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" } });
  await waitForCheckoutProductLock(co05Monitor);
  await co05Locker.query("UPDATE products SET is_active = false WHERE id = $1::uuid", [productA.id]);
  await co05Locker.query("COMMIT");
  const co05 = await co05Checkout;
  await co05Locker.end();
  await co05Monitor.end();
  assert.equal(co05.status, 422); assert.equal(co05.payload.error.code, "PRODUCT_UNAVAILABLE");
  // ق-221: the refusal NAMES the line. «منتج أو أكثر» to a shopper with ten
  // lines is an instruction to fix something without saying what; a COD
  // shopper refused at the last step with nothing to act on closes the tab.
  assert.ok(Array.isArray(co05.payload.error.lines) && co05.payload.error.lines.length === 1, `ق-221: the refusal carries the offending lines — ${JSON.stringify(co05.payload.error)}`);
  assert.equal(co05.payload.error.lines[0].productName, productA.name, "…by the product's own name");
  assert.equal(co05.payload.error.lines[0].reason, "unavailable");
  assert.equal(co05.payload.error.lines[0].variantName, null, "the default variant has no name a shopper would recognise, so none is shown");
  const co05OrdersAfter = await prisma.storeOrder.count({ where: { storeId: storeA.id, customerId: customerA.id, source: "storefront" } });
  const co05ReservationsAfter = await prisma.inventoryReservation.count({ where: { storeId: storeA.id, productId: productA.id } });
  const co05StockAfter = (await prisma.product.findUniqueOrThrow({ where: { id: productA.id } })).stockQuantity;
  assert.equal(co05OrdersAfter, co05OrdersBefore); assert.equal(co05ReservationsAfter, co05ReservationsBefore); assert.equal(co05StockAfter, co05StockBefore);
  await prisma.product.update({ where: { id: productA.id }, data: { isActive: true } });

  const customerCart = await request(`/store/${storeA.slug}/cart`, { token: customerTokenA });
  assert.equal(customerCart.status, 200);
  const expectedSubtotalIqd = customerCart.payload.cart.items.reduce((sum, item) => sum + item.quantity * item.priceSnapshotIqd, 0);
  const expectedDeliveryTotalIqd = expectedSubtotalIqd + 2500;
  const checkoutHeaders = { "idempotency-key": "phase9a-idempotency-key-0001" };
  const unavailableDelivery = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-delivery-unavailable-key" }, body: { cartVersion: customerCart.payload.cart.version, addressId: unavailableAddress.payload.address.id, paymentMethodCode: "cod" } });
  assert.equal(unavailableDelivery.status, 422); assert.equal(unavailableDelivery.payload.error.code, "DELIVERY_UNAVAILABLE_FOR_GOVERNORATE");
  const checkoutFirst = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: checkoutHeaders, body: { cartVersion: customerCart.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" } });
  assert.equal(checkoutFirst.status, 201); assert.equal(checkoutFirst.payload.order.status, "new");
  const storefrontOrder = checkoutFirst.payload.order;
  assert.equal(storefrontOrder.deliveryFeeIqd, 2500); assert.equal(storefrontOrder.totalIqd, expectedDeliveryTotalIqd);
  await prisma.deliveryRate.update({ where: { id: activeDeliveryRate.id }, data: { amountIqd: 9000 } });
  // ق-224: a replay is a read of a saved result, not a creation attempt, so it
  // must not spend the checkout budget — a shopper retrying over a dropped 3G
  // connection was answered 429 on his thirteenth tap instead of being handed
  // the order he already has. Both buckets (per shopper, per address) are
  // measured before and after: consumed on entry, refunded on the replay.
  const bucketsBeforeReplay = await prisma.$queryRawUnsafe("SELECT COALESCE(SUM(attempt_count), 0)::int AS total FROM storefront_rate_limits WHERE scope IN ('checkout', 'checkout_addr')");
  const checkoutReplay = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: checkoutHeaders, body: { cartVersion: customerCart.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" } });
  assert.equal(checkoutReplay.status, 200); assert.equal(checkoutReplay.payload.order.id, storefrontOrder.id); assert.equal(checkoutReplay.payload.order.deliveryFeeIqd, 2500); assert.equal(checkoutReplay.payload.order.totalIqd, expectedDeliveryTotalIqd);
  assert.equal(checkoutReplay.payload.replayed, true);
  const bucketsAfterReplay = await prisma.$queryRawUnsafe("SELECT COALESCE(SUM(attempt_count), 0)::int AS total FROM storefront_rate_limits WHERE scope IN ('checkout', 'checkout_addr')");
  assert.equal(bucketsAfterReplay[0].total, bucketsBeforeReplay[0].total, "ق-224: an idempotent replay leaves the checkout rate-limit buckets exactly where they were");
  const ordersBeforeIdempotencyMismatch = await prisma.storeOrder.count({ where: { storeId: storeA.id, customerId: customerA.id, source: "storefront" } });
  const reservationsBeforeIdempotencyMismatch = await prisma.inventoryReservation.count({ where: { storeId: storeA.id, orderId: storefrontOrder.id } });
  const idempotencyPayloadMismatch = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: checkoutHeaders, body: { cartVersion: customerCart.payload.cart.version + 1, addressId: address.payload.address.id, paymentMethodCode: "cod" } });
  assert.equal(idempotencyPayloadMismatch.status, 409); assert.equal(idempotencyPayloadMismatch.payload.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id, customerId: customerA.id, source: "storefront" } }), ordersBeforeIdempotencyMismatch);
  assert.equal(await prisma.inventoryReservation.count({ where: { storeId: storeA.id, orderId: storefrontOrder.id } }), reservationsBeforeIdempotencyMismatch);
  const reservation = await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: storefrontOrder.id }, select: { status: true, quantity: true, returnDisposition: true } });
  assert.equal(reservation.status, "active"); assert.equal(reservation.quantity, 2); assert.equal(reservation.returnDisposition, "not_returned");
  const stockAfterCheckout = await prisma.product.findUniqueOrThrow({ where: { id: productA.id } });
  assert.equal(stockAfterCheckout.stockQuantity, 5);

  const concurrentCartAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: productA.id, quantity: 1 } });
  assert.equal(concurrentCartAdd.status, 200);
  const concurrentCart = concurrentCartAdd.payload.cart;
  const concurrentKey = "phase9a-idempotency-key-0002";
  const concurrentCheckout = await Promise.all([
    request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: { "idempotency-key": concurrentKey }, body: { cartVersion: concurrentCart.version, addressId: address.payload.address.id } }),
    request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: { "idempotency-key": concurrentKey }, body: { cartVersion: concurrentCart.version, addressId: address.payload.address.id } }),
  ]);
  // Name the failure. On 2026-09-05 the browser twin of this case answered
  // `[201, 500]` in CI and the log said only «Expected values to be strictly
  // deep-equal» — which cost an hour to trace back to a retry budget capped at
  // three by a literal while its own retry condition read the shared constant
  // (six). A 5xx here has exactly one meaning and it is worth saying out loud,
  // because this assertion is the one that catches it while the machine is
  // loaded and no human is watching.
  const loserFailed = concurrentCheckout.find((result) => result.status >= 500);
  assert.equal(loserFailed, undefined, `CO: two concurrent checkouts on ONE idempotency key must answer 200+201, never a 5xx — a lost race that outlives its retry budget is contention, not a broken platform: ${JSON.stringify(concurrentCheckout.map((result) => ({ status: result.status, code: result.payload?.error?.code })))}`);
  assert.equal(concurrentCheckout.filter((result) => [200, 201].includes(result.status)).length, 2, `CO: one creates and one replays — ${JSON.stringify(concurrentCheckout.map((result) => result.status))}`);
  assert.equal(new Set(concurrentCheckout.map((result) => result.payload.order.id)).size, 1);
  const cancellableOrderId = concurrentCheckout[0].payload.order.id;
  const cancelled = await merchantStatus(merchantTokenA, storeA.slug, cancellableOrderId, "cancelled", 1);
  assert.equal(cancelled.status, 200);
  const releasedReservation = await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: cancellableOrderId } });
  assert.equal(releasedReservation.status, "released"); assert.equal(releasedReservation.releaseReason, "cancelled");

  const rejectedCartAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: productA.id, quantity: 1 } });
  const rejectedOrderResponse = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-idempotency-key-0003" }, body: { cartVersion: rejectedCartAdd.payload.cart.version, addressId: address.payload.address.id } });
  assert.equal(rejectedOrderResponse.status, 201);
  const rejected = await merchantStatus(merchantTokenA, storeA.slug, rejectedOrderResponse.payload.order.id, "rejected", 1);
  assert.equal(rejected.status, 200);
  const rejectedReservation = await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: rejectedOrderResponse.payload.order.id } });
  assert.equal(rejectedReservation.status, "released"); assert.equal(rejectedReservation.releaseReason, "rejected");

  const returnCartAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: productA.id, quantity: 1 } });
  const returnOrderResponse = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-idempotency-key-0004" }, body: { cartVersion: returnCartAdd.payload.cart.version, addressId: address.payload.address.id } });
  assert.equal(returnOrderResponse.status, 201);
  for (const [toStatus, version] of [["processing", 1], ["preparation", 2], ["out_for_delivery", 3], ["returned", 4]]) {
    const result = await merchantStatus(merchantTokenA, storeA.slug, returnOrderResponse.payload.order.id, toStatus, version);
    assert.equal(result.status, 200);
  }
  const preCompletionReturnReservation = await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: returnOrderResponse.payload.order.id } });
  assert.equal(preCompletionReturnReservation.status, "active"); assert.equal(preCompletionReturnReservation.returnDisposition, "pending_inspection");

  for (const [toStatus, version] of [["processing", 1], ["preparation", 2], ["out_for_delivery", 3], ["completed", 4], ["returned", 5]]) {
    const result = await merchantStatus(merchantTokenA, storeA.slug, storefrontOrder.id, toStatus, version);
    assert.equal(result.status, 200);
  }
  const stockAfterCompletedReturned = await prisma.product.findUniqueOrThrow({ where: { id: productA.id } });
  const returnedReservation = await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: storefrontOrder.id } });
  assert.equal(stockAfterCompletedReturned.stockQuantity, 3);
  assert.equal(returnedReservation.status, "consumed"); assert.equal(returnedReservation.returnDisposition, "pending_inspection");
  const restoreMovements = await prisma.inventoryMovement.count({ where: { storeId: storeA.id, productId: productA.id, reason: "storefront_returned_restored" } });
  assert.equal(restoreMovements, 0);

  const customerB = await prisma.customer.create({ data: { storeId: storeA.id, fullName: "عميل آخر", passwordHash: "not-used", phoneNormalized: "+9647700000002" } });
  const customerTokenB = await createTypedSession("customer", customerB.id);
  const hiddenOrder = await request(`/store/${storeA.slug}/account/orders/${storefrontOrder.id}`, { token: customerTokenB });
  assert.equal(hiddenOrder.status, 404);
  const customerOrdersPageOne = await request(`/store/${storeA.slug}/account/orders?limit=1`, { token: customerTokenA });
  assert.equal(customerOrdersPageOne.status, 200); assert.equal(customerOrdersPageOne.payload.orders.length, 1); assert.ok(customerOrdersPageOne.payload.nextCursor);
  const customerOrdersPageTwo = await request(`/store/${storeA.slug}/account/orders?limit=1&cursor=${encodeURIComponent(customerOrdersPageOne.payload.nextCursor)}`, { token: customerTokenA });
  assert.equal(customerOrdersPageTwo.status, 200); assert.equal(customerOrdersPageTwo.payload.orders.length, 1);
  assert.notEqual(customerOrdersPageOne.payload.orders[0].id, customerOrdersPageTwo.payload.orders[0].id);
  const crossStoreSession = await request(`/store/${storeB.slug}/account/orders`, { token: customerTokenA });
  assert.equal(crossStoreSession.status, 403);
  const customerMerchantArea = await request(`/merchant/stores/${storeA.slug}/orders`, { token: customerTokenA });
  assert.equal(customerMerchantArea.status, 403);
  let loginRateLimitStatus = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await request(`/store/${storeA.slug}/account/login`, { method: "POST", body: { phone: "+9647799999999", password: "InvalidPhase9Password123!" } });
    if (response.status === 429) { loginRateLimitStatus = response.status; break; }
  }
  assert.equal(loginRateLimitStatus, 429);

  const expiringGuest = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", body: { productId: productA.id, quantity: 1 } });
  const expiringGuestCookie = cookieFrom(expiringGuest.response, `codiq_cart_${storeA.slug}`);
  await prisma.shoppingCart.update({ where: { id: expiringGuest.payload.cart.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expiredGuestRead = await request(`/store/${storeA.slug}/cart`, { cookie: expiringGuestCookie });
  assert.equal(expiredGuestRead.status, 200); assert.equal(expiredGuestRead.payload.cart.status, "empty");

  const immutableEvent = await prisma.orderStatusEvent.findFirstOrThrow({ where: { orderId: storefrontOrder.id } });
  let immutableCode = null;
  try { await sql.query("UPDATE order_status_events SET note = 'blocked' WHERE id = $1::uuid", [immutableEvent.id]); } catch (error) { immutableCode = error?.code ?? null; }
  assert.equal(immutableCode, "23514");


  // =========================================================================
  // PG-5 (ق-73) — the note the customer writes at checkout.
  //
  // «اتصل قبل الوصول» · «الشقة فوق الصيدلية» · «هدية، لا تضع الفاتورة». Daily
  // requests in this market that had nowhere to go: the customer phoned the
  // merchant, or the courier arrived at a locked door.
  // =========================================================================
  // This block performs a dozen checkouts back to back, which is well past the
  // storefront rate limit — a limit that is doing its job. The bucket is cleared
  // rather than the limit raised: raising a real guard so a test can run is how
  // guards quietly stop guarding.
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
  // …and its own product with ample stock. Reusing `productA` (five units) made
  // the run fail at INSUFFICIENT_AVAILABLE_STOCK while the assertion accused the
  // 500-character boundary — a fixture exhaustion wearing a logic bug's clothes.
  const noteProduct = await prisma.product.create({ data: { storeId: storeA.id, categoryId: categoryA.id, sku: "SF-PG5-NOTE", name: "منتج ملاحظة التوصيل", priceIqd: 12000, stockQuantity: 40, lowStockThreshold: 1 } });
  const noteCartAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: noteProduct.id, quantity: 1 } });
  assert.equal(noteCartAdd.status, 200, JSON.stringify(noteCartAdd.payload));
  const noteOrder = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-pg5-note-0001" },
    body: { cartVersion: noteCartAdd.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod", note: "  اتصل قبل الوصول، الشقة فوق الصيدلية.  " },
  });
  assert.equal(noteOrder.status, 201, JSON.stringify(noteOrder.payload));
  assert.equal(noteOrder.payload.order.customerNote, "اتصل قبل الوصول، الشقة فوق الصيدلية.", "PG-5: the note is stored trimmed, exactly as written");
  // …and the MERCHANT sees it. A note stored and never shown is worse than none:
  // the customer believes he has been heard and the courier still knocks wrong.
  const merchantSeesNote = await request(`/merchant/stores/${storeA.slug}/orders/${noteOrder.payload.order.id}`, { token: merchantTokenA });
  assert.equal(merchantSeesNote.status, 200, JSON.stringify(merchantSeesNote.payload));
  assert.equal(merchantSeesNote.payload.order.customerNote, "اتصل قبل الوصول، الشقة فوق الصيدلية.");

  // A field opened and left blank is the same state as never opening it.
  const blankAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: noteProduct.id, quantity: 1 } });
  const blankOrder = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-pg5-blank-0001" },
    body: { cartVersion: blankAdd.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod", note: "   " },
  });
  assert.equal(blankOrder.status, 201, JSON.stringify(blankOrder.payload));
  assert.equal(blankOrder.payload.order.customerNote, null, "PG-5: whitespace is null, not an empty string");

  // The ceiling is the SERVER's, not a hint in the form.
  const longAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: noteProduct.id, quantity: 1 } });
  const tooLongNote = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-pg5-long-0001" },
    body: { cartVersion: longAdd.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod", note: "ن".repeat(501) },
  });
  assert.equal(tooLongNote.status, 422, JSON.stringify(tooLongNote.payload));
  assert.equal(tooLongNote.payload.error.code, "INVALID_ORDER_NOTE");
  const exactlyMax = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-pg5-max-0001" },
    body: { cartVersion: longAdd.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod", note: "ن".repeat(500) },
  });
  assert.equal(exactlyMax.status, 201, `PG-5: exactly 500 is allowed — the boundary is not off by one · ${JSON.stringify(exactlyMax.payload)}`);

  // Idempotency. This is where the implementation READS the plan rather than
  // transcribing it. Its criterion says the note must be stored «بلا مساس ببصمة
  // idempotency», whose stated purpose is that existing fingerprints must not
  // break — and conditional inclusion, the shape 20B-1 chose for the coupon,
  // preserves exactly that. Leaving the note out of the fingerprint instead
  // would mean a retry carrying a DIFFERENT note silently returns the original
  // order with the original note: the customer sees his correction accepted and
  // the merchant never receives it.
  const replayAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: noteProduct.id, quantity: 1 } });
  const replayHeaders = { "idempotency-key": "phase9a-pg5-replay-0001" };
  const replayBody = { cartVersion: replayAdd.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" };
  const notedFirst = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: replayHeaders, body: { ...replayBody, note: "اتصل قبل الوصول" } });
  assert.equal(notedFirst.status, 201, JSON.stringify(notedFirst.payload));
  const notedAgain = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: replayHeaders, body: { ...replayBody, note: "اتصل قبل الوصول" } });
  assert.equal(notedAgain.status, 200, "PG-5: the SAME note under the same key replays the same order");
  assert.equal(notedAgain.payload.order.id, notedFirst.payload.order.id);
  const changedNote = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: replayHeaders, body: { ...replayBody, note: "لا تتصل، اتركه عند البواب" } });
  assert.equal(changedNote.status, 409, JSON.stringify(changedNote.payload));
  assert.equal(changedNote.payload.error.code, "IDEMPOTENCY_KEY_REUSED", "PG-5: a DIFFERENT note is a different request, and the customer is told so rather than silently ignored");

  // And a checkout with NO note keeps the fingerprint it had before the field
  // existed — which is the promise the plan's criterion was really protecting.
  const legacyAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: noteProduct.id, quantity: 1 } });
  const legacyHeaders = { "idempotency-key": "phase9a-pg5-legacy-0001" };
  const legacyBody = { cartVersion: legacyAdd.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" };
  assert.equal((await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: legacyHeaders, body: legacyBody })).status, 201);
  const legacyReplay = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customerTokenA, headers: legacyHeaders, body: legacyBody });
  assert.equal(legacyReplay.status, 200, "PG-5: a note-less checkout replays exactly as it did before the field existed");

  // ============================================================
  // 19-د (عدسة المال) — A PRICE SNAPSHOT COVERS THE UNITS IT WAS TAKEN FOR,
  // AND CHECKOUT NEVER PRICES FROM A SNAPSHOT IT HAS NOT RE-READ.
  //
  // `priceSnapshotIqd` was captured once, when the line was created, and no
  // writer refreshed it and no reader revalidated it: the checkout lock query
  // deliberately never selected `v.price_iqd`. A customer cart has no expiry,
  // so a line bought during a promotion waited indefinitely for the merchant to
  // restore his price — and the quantity was raisable on that stale line, which
  // turned a 1,000 IQD promotional unit into 50 units at 1,000 against a live
  // price of 10,000: 450,000 IQD taken from the merchant in one order, with the
  // platform's commission under-booked on the same sale.
  // ============================================================
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
  const promoProduct = await prisma.product.create({ data: { storeId: storeA.id, categoryId: categoryA.id, sku: "SF-RT-PROMO", name: "منتج بسعر ترويجي", priceIqd: 1000, stockQuantity: 300, lowStockThreshold: 1 } });
  const promoVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: promoProduct.id, isDefault: true }, select: { id: true } });
  const promoAdd = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: customerTokenA, body: { productId: promoProduct.id, quantity: 1 } });
  assert.equal(promoAdd.status, 200, JSON.stringify(promoAdd.payload));
  const promoLine = promoAdd.payload.cart.items.find((item) => item.productId === promoProduct.id);
  assert.equal(promoLine.priceSnapshotIqd, 1000, "19-د: the shopper's line is snapshotted at the promotional price, exactly as CART-03 documents");

  // The promotion ends: the merchant restores his real price on the VARIANT,
  // which is what checkout prices from.
  await prisma.productVariant.update({ where: { id: promoVariant.id }, data: { priceIqd: 10000 } });

  // …and raising the quantity on that stale line re-prices it. This is the
  // amplification: 50 units at a price he was shown for one.
  const raised = await request(`/store/${storeA.slug}/cart/items/${promoLine.id}`, { method: "PATCH", token: customerTokenA, body: { quantity: 50 } });
  assert.equal(raised.status, 200, JSON.stringify(raised.payload));
  const raisedLine = raised.payload.cart.items.find((item) => item.id === promoLine.id);
  assert.equal(raisedLine.quantity, 50);
  assert.equal(raisedLine.priceSnapshotIqd, 10000, "19-د: a quantity RAISE re-prices the line — the snapshot never covered 49 units the shopper did not add at that price");

  // Lowering does not re-price: a shopper trimming his basket has asked for
  // nothing new, and taking back the price he was promised would be a worse bug.
  await prisma.productVariant.update({ where: { id: promoVariant.id }, data: { priceIqd: 500 } });
  const lowered = await request(`/store/${storeA.slug}/cart/items/${promoLine.id}`, { method: "PATCH", token: customerTokenA, body: { quantity: 2 } });
  const loweredLine = lowered.payload.cart.items.find((item) => item.id === promoLine.id);
  assert.equal(loweredLine.priceSnapshotIqd, 10000, "19-د: …and a quantity DROP leaves the snapshot alone — the rule is directional on purpose");

  // The cart writers are three call sites and a rule enforced only by call sites
  // is a rule the fourth one breaks. Checkout is where money is decided, so the
  // snapshot is reconciled there too — against the price read under the SAME
  // FOR UPDATE lock that guards the stock. Here the live price (500) is now
  // BELOW the snapshot (10,000), so the refusal protects the shopper as well.
  const staleCart = await request(`/store/${storeA.slug}/cart`, { token: customerTokenA });
  const staleCheckout = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-rt-money-stale-0001" },
    body: { cartVersion: staleCart.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" },
  });
  assert.equal(staleCheckout.status, 422, JSON.stringify(staleCheckout.payload));
  assert.equal(staleCheckout.payload.error.code, "CART_PRICE_CHANGED", "19-د: checkout refuses a snapshot it has not re-read, in BOTH directions — neither party is moved without seeing the number");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id, customerId: register.payload.customer?.id ?? undefined, items: { some: { variantId: promoVariant.id } } } }), 0, "19-د: …and no order was created");

  // ق-132's principle at the checkout button: the refusal is not a dead end.
  // The server has already written the true price onto the cart, so the next
  // read shows what he will pay and the next tap goes through.
  const correctedCart = await request(`/store/${storeA.slug}/cart`, { token: customerTokenA });
  const correctedLine = correctedCart.payload.cart.items.find((item) => item.id === promoLine.id);
  assert.equal(correctedLine.priceSnapshotIqd, 500, "19-د: the refusal CORRECTED the cart — a shopper told «راجع الملخص» must find something to review");
  assert.notEqual(correctedCart.payload.cart.version, staleCart.payload.cart.version, "19-د: …and the version moved, which is the honest signal that his cart changed");
  const secondTap = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST", token: customerTokenA, headers: { "idempotency-key": "phase9a-rt-money-stale-0002" },
    body: { cartVersion: correctedCart.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" },
  });
  assert.equal(secondTap.status, 201, `19-د: one tap from done · ${JSON.stringify(secondTap.payload)}`);
  const promoOrderLine = secondTap.payload.order.items.find((item) => item.variantId === promoVariant.id);
  assert.equal(promoOrderLine.unitPriceIqd, 500, "19-د: and the order is stamped with the price he actually confirmed");
  assert.equal(promoOrderLine.lineTotalIqd, 500 * 2);


  // =========================================================================
  // PG-8 (ق-76) — the new merchant's first path.
  //
  // The criterion this suite exists for: every step's state is DERIVED from real
  // data, not from a flag. A flag drifts the first time a merchant deletes the
  // very product it claims he added, and then the path lies to him about his own
  // store — so the test undoes each step and watches the path notice.
  // =========================================================================
  const onboardingUrl = `/merchant/stores/${storeA.slug}/onboarding`;
  const onboardingAt = async () => (await request(onboardingUrl, { token: merchantTokenA })).payload.onboarding;

  const startState = await onboardingAt();
  assert.equal(startState.totalCount, 5, "PG-8: five steps");
  assert.equal(startState.steps.find((s) => s.key === "first_product").done, true, "PG-8: complete because a product EXISTS, not because anything was flagged");
  assert.equal(startState.steps.find((s) => s.key === "delivery_enabled").done, true, "PG-8: complete because an enabled rate exists");
  assert.equal(startState.steps.find((s) => s.key === "order_preview").done, false, "PG-8: he has not looked at the example order yet");

  // Derivation, proven by UNDOING a step: disable the delivery rate and watch the
  // path change its mind. A stored flag would still be claiming it was done.
  await prisma.deliveryRate.update({ where: { id: activeDeliveryRate.id }, data: { isEnabled: false } });
  assert.equal((await onboardingAt()).steps.find((s) => s.key === "delivery_enabled").done, false, "PG-8: turning delivery off un-completes the step — the state is read, not remembered");
  await prisma.deliveryRate.update({ where: { id: activeDeliveryRate.id }, data: { isEnabled: true } });
  assert.equal((await onboardingAt()).steps.find((s) => s.key === "delivery_enabled").done, true);

  // The preview shows HIS product, and — the whole point — inserts nothing.
  const ordersBeforePreview = await prisma.storeOrder.count({ where: { storeId: storeA.id } });
  const ledgerBeforePreview = await prisma.ledgerEntry.count({ where: { storeId: storeA.id } });
  const beforePreview = await onboardingAt();
  assert.ok(beforePreview.preview, "PG-8: once he has a product, there is an example to show him");
  assert.ok(beforePreview.preview.totalIqd > 0, "PG-8: …priced from his own product and his own delivery rate");
  const seen = await request(`${onboardingUrl}/preview-seen`, { method: "POST", token: merchantTokenA });
  assert.equal(seen.status, 200, JSON.stringify(seen.payload));
  assert.equal(seen.payload.onboarding.steps.find((s) => s.key === "order_preview").done, true);
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id } }), ordersBeforePreview,
    "PG-8: the «demo order» step created NO order — which is how it can never reach the ledger or the analytics, rather than by everyone remembering to exclude it at eleven aggregate sites");
  assert.equal(await prisma.ledgerEntry.count({ where: { storeId: storeA.id } }), ledgerBeforePreview, "PG-8: …and no ledger entry either");

  // Skippable, and gone for good once skipped.
  const dismissed = await request(`${onboardingUrl}/dismiss`, { method: "POST", token: merchantTokenA });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.payload.onboarding.visible, false, "PG-8: the path is skippable and never blocks the dashboard");
  assert.equal((await onboardingAt()).visible, false, "PG-8: …and stays gone across requests");

  // It also stays gone when the reason for showing it comes back. Deleting his
  // only product months later must not resurrect a welcome mat.
  await prisma.product.updateMany({ where: { storeId: storeA.id }, data: { isActive: false } });
  assert.equal((await onboardingAt()).visible, false, "PG-8: dismissed is permanent — a later change does not bring the path back");
  await prisma.product.updateMany({ where: { storeId: storeA.id }, data: { isActive: true } });

  // Another merchant's store is not readable through this route.
  const foreignOnboarding = await request(`/merchant/stores/${storeB.slug}/onboarding`, { token: merchantTokenA });
  assert.equal(foreignOnboarding.status, 403, "PG-8: the store boundary holds here as everywhere");
  assert.equal((await request(onboardingUrl)).status, 401, "PG-8: and it needs a session");

  console.log(JSON.stringify({
    co05: { barrier: "checkout_waited_on_product_row_lock", status: co05.status, code: co05.payload.error.code, ordersBefore: co05OrdersBefore, ordersAfter: co05OrdersAfter, reservationsBefore: co05ReservationsBefore, reservationsAfter: co05ReservationsAfter, stockBefore: co05StockBefore, stockAfter: co05StockAfter },
    cart: { crossStoreProduct: crossStoreCart.status, csrfDenied: csrfDenied.status, snapshot: guestCart.payload.cart.items[0].priceSnapshotIqd, expiredPolicy: expiredGuestRead.payload.cart.status },
    checkout: { guest: { status: guestCheckout.status, code: guestCheckout.payload.error.code }, first: checkoutFirst.status, replay: checkoutReplay.status, idempotencyPayloadMismatch: { status: idempotencyPayloadMismatch.status, code: idempotencyPayloadMismatch.payload.error.code }, concurrent: concurrentCheckout.map((result) => result.status), order: storefrontOrder.id, delivery: { unavailable: unavailableDelivery.status, feeSnapshotIqd: storefrontOrder.deliveryFeeIqd, totalSnapshotIqd: storefrontOrder.totalIqd, replayFeeIqd: checkoutReplay.payload.order.deliveryFeeIqd } },
    reservation: { afterCheckout: reservation.status, cancelled: releasedReservation.status, rejected: rejectedReservation.status, preCompletionReturn: { status: preCompletionReturnReservation.status, returnDisposition: preCompletionReturnReservation.returnDisposition }, afterReturned: { status: returnedReservation.status, returnDisposition: returnedReservation.returnDisposition, stockQuantity: stockAfterCompletedReturned.stockQuantity, restoreMovements } },
    idor: { customerOtherOrder: hiddenOrder.status, customerOrdersCursor: { first: customerOrdersPageOne.status, second: customerOrdersPageTwo.status, distinct: customerOrdersPageOne.payload.orders[0].id !== customerOrdersPageTwo.payload.orders[0].id }, crossStoreSession: crossStoreSession.status, customerMerchantArea: customerMerchantArea.status, loginRateLimit: loginRateLimitStatus },
    constraints: { guestTokenUnique: guestTokenUniqueCode, cartProductStoreFk: compositeFkCode, addressCustomerStoreFk: addressStoreGuardCode, orderCustomerStoreFk: orderCustomerStoreGuardCode, orderEventImmutable: immutableCode },
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

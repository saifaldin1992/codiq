/**
 * codiq phase 20B-2 — merchant analytics + abandoned-cart recovery proof.
 * Phase15-style harness: the real HTTP app over a real PostgreSQL, with the
 * scanner driven directly (scanAbandonedCarts) exactly as phase 15 drives
 * processOutboxBatch. Coverage per plan §2.4/§3.4:
 *
 * Analytics:
 *  1. aggregate correctness on seeded known data — realized revenue from the
 *     ledger including the return-reversal effect, orders count, AOV, new
 *     customers; sales-series totals; VARIANT-AWARE top products (two variants
 *     of one product rank separately, cancelled orders excluded); status
 *     funnel; customers summary;
 *  2. coupons usage with the status-filtered consuming definition
 *     (cancelled/rejected redemptions do not consume, rows stay append-only);
 *  3. two-store isolation; 4. 403 without permission (cross-store merchant,
 *     staff with orders.view denied, customer session).
 *
 * Abandoned carts:
 *  5. config validation — window bounds 1–72 (422), foreign/inactive recovery
 *     coupon refused (422), merge preserves untouched fields;
 *  6. scanner: abandoned customer cart => exactly ONE outbox row (payload,
 *     dedupe key, cart link, coupon code), second scan adds nothing, the
 *     P2002 swallow race-guard proven with a colliding dedupe key;
 *  7. guest cart NEVER messaged; customer without email never messaged;
 *  8. preference off / master off => nothing (with a positive control);
 *  9. converted-before-scan => nothing; 10. window respected and configurable;
 * 11. panel stats: sent = outbox count, recovered = sent rows whose cart
 *     converted (correlation), counted after a post-message conversion;
 * 12. the worker renders and delivers the Arabic cart.abandoned message.
 */
import assert from "node:assert/strict";
import { ownStaffPassword } from "./helpers/own-staff-password.js";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `phase20b2-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "phase20b2-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { scanAbandonedCarts } = await import("../src/notifications/abandoned-cart-scanner.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  // This suite performs many registrations/checkouts; the fixed-window limiter
  // is phase 9A's subject, so counters are cleared before every write to keep
  // scenarios independent of call volume (phase 20B-1 lesson).
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function merchantStatus(token, slug, orderId, toStatus, expectedVersion) {
  return request(`/merchant/stores/${slug}/orders/${orderId}/status`, { method: "POST", token, body: { toStatus, expectedVersion } });
}

async function completeOrder(token, slug, orderId, startVersion = 1) {
  const path = [["processing", startVersion], ["preparation", startVersion + 1], ["out_for_delivery", startVersion + 2], ["completed", startVersion + 3]];
  for (const [toStatus, version] of path) {
    const result = await merchantStatus(token, slug, orderId, toStatus, version);
    assert.equal(result.status, 200, `transition to ${toStatus} failed: ${JSON.stringify(result.payload)}`);
  }
}

let customerPhoneSuffix = 0;
async function registerCustomer(slug, fullName, email) {
  customerPhoneSuffix += 1;
  const phone = `+96477042${String(customerPhoneSuffix).padStart(5, "0")}`;
  const registered = await request(`/store/${slug}/account/register`, { method: "POST", body: { phone, password: "Phase20B2CustomerPass!", fullName, ...(email ? { email } : {}) } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const address = await request(`/store/${slug}/account/addresses`, { method: "POST", token: registered.payload.accessToken, body: { recipientName: fullName, fullAddress: "شارع التحليلات 20", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  return { token: registered.payload.accessToken, account: registered.payload.account, addressId: address.payload.address.id };
}

async function cartAdd(slug, token, body) {
  const added = await request(`/store/${slug}/cart/items`, { method: "POST", token, body });
  assert.equal(added.status, 200, JSON.stringify(added.payload));
  return added.payload.cart;
}

let checkoutKeySuffix = 0;
async function doCheckout(slug, customer, cart, { couponCode } = {}) {
  checkoutKeySuffix += 1;
  const idempotencyKey = `phase20b2-key-${String(checkoutKeySuffix).padStart(4, "0")}`;
  const body = { cartVersion: cart.version, addressId: customer.addressId, paymentMethodCode: "cod", ...(couponCode ? { couponCode } : {}) };
  return request(`/store/${slug}/checkout`, { method: "POST", token: customer.token, headers: { "idempotency-key": idempotencyKey }, body });
}

function hoursAgo(hours) { return new Date(Date.now() - hours * 60 * 60 * 1000); }

const summary = {};

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE");

  // ---------- fixtures ----------
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100014701", email: `${testId}.merchant-a@codiq.test`, password: "Phase20B2MerchantPass!", businessName: "متجر 20B2 ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100014702", email: `${testId}.merchant-b@codiq.test`, password: "Phase20B2MerchantPass!", businessName: "متجر 20B2 باء" });
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر 20B2 ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر 20B2 باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  await prisma.deliveryRate.create({ data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  await prisma.deliveryRate.create({ data: { storeId: storeB.id, governorate: "Baghdad", amountIqd: 2000, isEnabled: true } });
  await prisma.notificationSettings.create({ data: { storeId: storeA.id, isEnabled: true } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-a@codiq.test`, password: "Phase20B2MerchantPass!" } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-b@codiq.test`, password: "Phase20B2MerchantPass!" } });
  assert.equal(loginA.status, 200); assert.equal(loginB.status, 200);
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;
  // Ledger math needs a real commission: 300 bps on the free plan for this run.
  // `plans` is GLOBAL and outside this suite's TRUNCATE, so whatever is changed
  // here has to be put back EXACTLY — restoring a guessed value corrupts it for
  // every later suite. phase17 asserts 300 (the value migration 20260825190000
  // seeds) and used to fail in a sweep while passing alone, which reads as flake.
  const seededFreeCommissionBps = (await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { commissionBps: true } })).commissionBps;
  await prisma.plan.update({ where: { code: "free" }, data: { commissionBps: 300 } });
  // ق-128 grants every new merchant a free MONTH on «growth» (200 bps), so
  // setting the FREE plan's commission above no longer reaches this suite's
  // merchants — they are not on it. Pinning them is what restores the premise
  // the ledger assertions below were written against.
  const freePlanId = (await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } })).id;
  await prisma.merchantSubscription.updateMany({
    where: { merchantId: { in: [merchantA.payload.account.id, merchantB.payload.account.id] }, status: "active" },
    data: { planId: freePlanId, endsAt: null },
  });

  // Variant-aware seed: one product with TWO variants + one simple product.
  const multi = await prisma.product.create({ data: { storeId: storeA.id, sku: "P20B2-MULTI", name: "منتج متعدد المتغيرات", priceIqd: 10000, stockQuantity: 50, lowStockThreshold: 0 } });
  const variantOne = await prisma.productVariant.findFirstOrThrow({ where: { productId: multi.id, isDefault: true } });
  const variantTwo = await prisma.productVariant.create({ data: { storeId: storeA.id, productId: multi.id, sku: "P20B2-MULTI-V2", name: "المتغير الكبير", priceIqd: 15000, stockQuantity: 30, isDefault: false, position: 1 } });
  const simple = await prisma.product.create({ data: { storeId: storeA.id, sku: "P20B2-SIMPLE", name: "منتج بسيط", priceIqd: 5000, stockQuantity: 40, lowStockThreshold: 0 } });
  const productB = await prisma.product.create({ data: { storeId: storeB.id, sku: "P20B2-B", name: "منتج متجر باء", priceIqd: 9000, stockQuantity: 10 } });

  const analyticsBase = `/merchant/stores/${storeA.slug}/marketing/analytics`;

  // ---------- known-data orders for the aggregates ----------
  // Order 1: 2× variantOne (20000) -> completed.
  const customer1 = await registerCustomer(storeA.slug, "زبونة الإتمام", `${testId}.c1@codiq.test`);
  const cart1 = await cartAdd(storeA.slug, customer1.token, { variantId: variantOne.id, quantity: 2 });
  const order1 = (await doCheckout(storeA.slug, customer1, cart1)).payload.order;
  await completeOrder(tokenA, storeA.slug, order1.id);
  // Order 2: 1× variantTwo + 1× simple (20000) -> completed -> RETURNED (reversal).
  const customer2 = await registerCustomer(storeA.slug, "زبونة الإرجاع", `${testId}.c2@codiq.test`);
  await cartAdd(storeA.slug, customer2.token, { variantId: variantTwo.id, quantity: 1 });
  const cart2 = await cartAdd(storeA.slug, customer2.token, { productId: simple.id, quantity: 1 });
  const order2 = (await doCheckout(storeA.slug, customer2, cart2)).payload.order;
  await completeOrder(tokenA, storeA.slug, order2.id);
  assert.equal((await merchantStatus(tokenA, storeA.slug, order2.id, "returned", 5)).status, 200);
  // Order 3: 1× variantOne (10000) -> stays new.
  const customer3 = await registerCustomer(storeA.slug, "زبونة الانتظار", `${testId}.c3@codiq.test`);
  const cart3 = await cartAdd(storeA.slug, customer3.token, { variantId: variantOne.id, quantity: 1 });
  const order3 = (await doCheckout(storeA.slug, customer3, cart3)).payload.order;
  assert.equal(order3.totalIqd, 12500);
  // Order 4: 1× simple -> CANCELLED (must vanish from sales + top products).
  const customer4 = await registerCustomer(storeA.slug, "زبونة الإلغاء", `${testId}.c4@codiq.test`);
  const cart4 = await cartAdd(storeA.slug, customer4.token, { productId: simple.id, quantity: 1 });
  const order4 = (await doCheckout(storeA.slug, customer4, cart4)).payload.order;
  assert.equal((await merchantStatus(tokenA, storeA.slug, order4.id, "cancelled", 1)).status, 200);

  // ---------- summary: ledger revenue with the reversal effect ----------
  const from = "2026-01-01T00:00:00.000Z";
  const summaryA = await request(`${analyticsBase}/summary?from=${from}`, { token: tokenA });
  assert.equal(summaryA.status, 200, JSON.stringify(summaryA.payload));
  const s = summaryA.payload.summary;
  // Ledger: order1 completed (20000 + 2500, comm 600) + order2 completed (20000 + 2500, comm 600) − order2 reversal.
  assert.equal(s.revenue.completedOrders, 2);
  assert.equal(s.revenue.reversedOrders, 1, "the return must appear as a signed reversal");
  assert.equal(s.revenue.subtotalIqd, 20000, "net subtotal after the reversal");
  assert.equal(s.revenue.deliveryFeeIqd, 2500);
  assert.equal(s.revenue.commissionIqd, 600, "round(20000*300/10000) net of the mirrored reversal");
  assert.equal(s.revenue.revenueIqd, 22500);
  assert.equal(s.ordersCount, 4, "every created order counts, all statuses");
  assert.equal(s.averageOrderValueIqd, 22500, "net revenue / net completed (1)");
  assert.equal(s.newCustomers, 4);
  summary.analyticsSummary = { revenue: s.revenue.revenueIqd, reversed: s.revenue.reversedOrders, orders: s.ordersCount, aov: s.averageOrderValueIqd, newCustomers: s.newCustomers };

  // ---------- sales series: day/month buckets, cancelled excluded ----------
  const seriesDay = await request(`${analyticsBase}/sales-series?from=${from}&interval=day`, { token: tokenA });
  assert.equal(seriesDay.status, 200);
  const daySum = seriesDay.payload.series.reduce((sum, bucket) => sum + bucket.totalIqd, 0);
  const dayOrders = seriesDay.payload.series.reduce((sum, bucket) => sum + bucket.ordersCount, 0);
  assert.equal(daySum, 57500, "22500 + 22500 + 12500 — the cancelled order contributes nothing");
  assert.equal(dayOrders, 3);
  const seriesMonth = await request(`${analyticsBase}/sales-series?from=${from}&interval=month`, { token: tokenA });
  assert.equal(seriesMonth.payload.series.reduce((sum, bucket) => sum + bucket.totalIqd, 0), 57500);
  assert.equal((await request(`${analyticsBase}/sales-series?interval=hour`, { token: tokenA })).status, 422);
  assert.equal((await request(`${analyticsBase}/summary?from=not-a-date`, { token: tokenA })).status, 400);
  summary.salesSeries = { daySum, dayOrders, invalidInterval: 422 };

  // ---------- top products: variant-aware, by revenue and by units ----------
  const topRevenue = await request(`${analyticsBase}/top-products?from=${from}&by=revenue`, { token: tokenA });
  assert.equal(topRevenue.status, 200);
  const products = topRevenue.payload.products;
  assert.equal(products.length, 3, "cancelled order items must not appear as a fourth line");
  assert.equal(products[0].variantId, variantOne.id);
  assert.equal(products[0].revenueIqd, 30000, "2×10000 (order1) + 1×10000 (order3)");
  assert.equal(products[0].units, 3);
  assert.equal(products[1].variantId, variantTwo.id);
  assert.equal(products[1].revenueIqd, 15000);
  assert.equal(products[0].productId, products[1].productId, "TWO rows for the SAME product — variant-aware ranking");
  assert.equal(products[2].revenueIqd, 5000, "simple product counts order2 only; the cancelled order4 line is excluded");
  assert.equal(products[2].units, 1);
  const topUnits = await request(`${analyticsBase}/top-products?from=${from}&by=units`, { token: tokenA });
  assert.equal(topUnits.payload.products[0].variantId, variantOne.id);
  assert.equal(topUnits.payload.products[0].units, 3);
  assert.equal((await request(`${analyticsBase}/top-products?by=bogus`, { token: tokenA })).status, 422);
  summary.topProducts = { variantAware: true, first: products[0].revenueIqd, cancelledExcluded: true };

  // ---------- status funnel + customers summary ----------
  const funnel = await request(`${analyticsBase}/status-funnel?from=${from}`, { token: tokenA });
  const funnelMap = Object.fromEntries(funnel.payload.funnel.map((row) => [row.status, row.count]));
  assert.deepEqual(funnelMap, { new: 1, processing: 0, preparation: 0, out_for_delivery: 0, completed: 1, cancelled: 1, rejected: 0, returned: 1 });
  const customersSummary = await request(`${analyticsBase}/customers`, { token: tokenA });
  assert.deepEqual(customersSummary.payload.customers, { totalCustomers: 4, newCustomers: 4, activeCustomers: 4, prospectCustomers: 0 });
  summary.funnel = funnelMap;

  // ---------- two-store isolation ----------
  const customerB1 = await registerCustomer(storeB.slug, "زبونة باء", `${testId}.b1@codiq.test`);
  const cartB1 = await cartAdd(storeB.slug, customerB1.token, { productId: productB.id, quantity: 1 });
  const orderB1 = (await doCheckout(storeB.slug, customerB1, cartB1)).payload.order;
  await completeOrder(tokenB, storeB.slug, orderB1.id);
  const summaryB = await request(`/merchant/stores/${storeB.slug}/marketing/analytics/summary?from=${from}`, { token: tokenB });
  assert.equal(summaryB.payload.summary.ordersCount, 1);
  assert.equal(summaryB.payload.summary.revenue.revenueIqd, 11000, "9000 + 2000 — store B only");
  const summaryAAfterB = await request(`${analyticsBase}/summary?from=${from}`, { token: tokenA });
  assert.equal(summaryAAfterB.payload.summary.revenue.revenueIqd, 22500, "store B's completion must not leak into store A");
  assert.equal(summaryAAfterB.payload.summary.ordersCount, 4);
  summary.isolation = { storeB: summaryB.payload.summary.revenue.revenueIqd, storeAUnchanged: true };

  // ---------- coupons usage: the status-filtered consuming definition ----------
  const couponCreate = await request(`/merchant/stores/${storeA.slug}/marketing/coupons`, { method: "POST", token: tokenA, body: { code: "SAVE10", kind: "percent", percentOff: 10 } });
  assert.equal(couponCreate.status, 201);
  const save10 = couponCreate.payload.coupon;
  const customer5 = await registerCustomer(storeA.slug, "زبونة الكوبون", `${testId}.c5@codiq.test`);
  const cart5 = await cartAdd(storeA.slug, customer5.token, { variantId: variantOne.id, quantity: 1 });
  const order5 = (await doCheckout(storeA.slug, customer5, cart5, { couponCode: "SAVE10" })).payload.order;
  assert.equal(order5.discountIqd, 1000);
  const customer6 = await registerCustomer(storeA.slug, "زبونة الكوبون الملغى", `${testId}.c6@codiq.test`);
  const cart6 = await cartAdd(storeA.slug, customer6.token, { variantId: variantOne.id, quantity: 1 });
  const order6 = (await doCheckout(storeA.slug, customer6, cart6, { couponCode: "SAVE10" })).payload.order;
  assert.equal((await merchantStatus(tokenA, storeA.slug, order6.id, "cancelled", 1)).status, 200);
  const usage = await request(`${analyticsBase}/coupons`, { token: tokenA });
  assert.equal(usage.status, 200);
  const usageRow = usage.payload.coupons.find((row) => row.code === "SAVE10");
  assert.equal(usageRow.consumingUses, 1, "the cancelled redemption must NOT consume");
  assert.equal(usageRow.redemptionsTotal, 2, "append-only rows both remain visible");
  assert.equal(usageRow.discountIqd, 1000, "discount totals follow the consuming definition");
  summary.couponsUsage = { consuming: usageRow.consumingUses, total: usageRow.redemptionsTotal, discount: usageRow.discountIqd };

  // ---------- permissions: 403 without orders.view / settings.manage / customers.view ----------
  const crossStore = await request(`${analyticsBase}/summary`, { token: tokenB });
  assert.equal(crossStore.status, 403); assert.equal(crossStore.payload.error.code, "STORE_BOUNDARY_DENIED");
  const customerDenied = await request(`${analyticsBase}/summary`, { token: customer1.token });
  assert.equal(customerDenied.status, 403);
  const staffCreate = await request(`/merchant/stores/${storeA.slug}/team`, { method: "POST", token: tokenA, body: { email: `${testId}.staff@codiq.test`, displayName: "موظفة 20B2", temporaryPassword: "phase20b2-staff-pass", roleCode: "store_staff" } });
  assert.equal(staffCreate.status, 201, JSON.stringify(staffCreate.payload));
  await ownStaffPassword(base, storeA.slug, `${testId}.staff@codiq.test`, "phase20b2-staff-pass"); // audit 14-ب
  const staffLogin = await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "phase20b2-staff-pass" } });
  assert.equal(staffLogin.status, 200);
  const tokenStaff = staffLogin.payload.accessToken;
  assert.equal((await request(`${analyticsBase}/summary`, { token: tokenStaff })).status, 200, "store_staff holds orders.view");
  const abandonedBase = `/merchant/stores/${storeA.slug}/marketing/abandoned-carts`;
  const staffSettings = await request(`${abandonedBase}/settings`, { token: tokenStaff });
  assert.equal(staffSettings.status, 403); assert.equal(staffSettings.payload.error.code, "STAFF_PERMISSION_DENIED");
  const staffList = await request(abandonedBase, { token: tokenStaff });
  assert.equal(staffList.status, 403, "store_staff lacks customers.view");
  const denyOverride = await request(`/merchant/stores/${storeA.slug}/team/${staffCreate.payload.membership.id}/overrides`, { method: "PUT", token: tokenA, body: { overrides: [{ permissionCode: "orders.view", effect: "deny" }] } });
  assert.equal(denyOverride.status, 200);
  const staffDenied = await request(`${analyticsBase}/summary`, { token: tokenStaff });
  assert.equal(staffDenied.status, 403); assert.equal(staffDenied.payload.error.code, "STAFF_PERMISSION_DENIED");
  summary.permissions = { crossStore: crossStore.status, customer: customerDenied.status, staffAfterDeny: staffDenied.status, staffSettings: staffSettings.status, staffList: staffList.status };

  // ---------- abandoned-cart configuration: bounds + coupon validation ----------
  assert.equal((await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { windowHours: 0 } })).status, 422);
  assert.equal((await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { windowHours: 73 } })).status, 422);
  assert.equal((await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { windowHours: 12.5 } })).status, 422);
  const bCoupon = await request(`/merchant/stores/${storeB.slug}/marketing/coupons`, { method: "POST", token: tokenB, body: { code: "BSAVE", kind: "fixed", amountOffIqd: 500 } });
  const foreignCoupon = await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { recoveryCouponId: bCoupon.payload.coupon.id } });
  assert.equal(foreignCoupon.status, 422); assert.equal(foreignCoupon.payload.error.code, "INVALID_RECOVERY_COUPON");
  const retiredCreate = await request(`/merchant/stores/${storeA.slug}/marketing/coupons`, { method: "POST", token: tokenA, body: { code: "RETIRED", kind: "percent", percentOff: 5, isActive: false } });
  const inactiveCoupon = await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { recoveryCouponId: retiredCreate.payload.coupon.id } });
  assert.equal(inactiveCoupon.status, 422); assert.equal(inactiveCoupon.payload.error.code, "INVALID_RECOVERY_COUPON");
  const enable = await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { enabled: true, windowHours: 12, recoveryCouponId: save10.id } });
  assert.equal(enable.status, 200, JSON.stringify(enable.payload));
  assert.equal(enable.payload.settings.enabled, true);
  assert.equal(enable.payload.settings.windowHours, 12);
  assert.equal(enable.payload.settings.recoveryCouponCode, "SAVE10");
  assert.equal(enable.payload.settings.masterEnabled, true);
  // A phase-15 preferences write must NOT clobber the abandonedCart block.
  assert.equal((await request(`/merchant/stores/${storeA.slug}/notifications/settings`, { method: "PUT", token: tokenA, body: { preferences: { lowStock: false } } })).status, 200);
  const settingsAfterPrefWrite = await request(`${abandonedBase}/settings`, { token: tokenA });
  assert.equal(settingsAfterPrefWrite.payload.settings.enabled, true, "notification preference writes must preserve the abandonedCart configuration");
  assert.equal(settingsAfterPrefWrite.payload.settings.recoveryCouponCode, "SAVE10");
  summary.config = { bounds: [422, 422, 422], foreignCoupon: foreignCoupon.status, inactiveCoupon: inactiveCoupon.status, enabled: true, survivesPrefWrite: true };

  // ---------- scanner: one message per abandoned customer cart, forever ----------
  const customer7 = await registerCustomer(storeA.slug, "زبونة السلة المتروكة", `${testId}.c7@codiq.test`);
  const cart7 = await cartAdd(storeA.slug, customer7.token, { variantId: variantOne.id, quantity: 2 });
  await prisma.shoppingCart.update({ where: { id: cart7.id }, data: { lastActivityAt: hoursAgo(13) } });
  const scan1 = await scanAbandonedCarts();
  assert.equal(scan1.enqueued, 1, JSON.stringify(scan1));
  const rows7 = await prisma.notificationOutbox.findMany({ where: { cartId: cart7.id, eventType: "cart.abandoned" } });
  assert.equal(rows7.length, 1, "exactly ONE outbox row for the abandoned cart");
  const row7 = rows7[0];
  assert.equal(row7.dedupeKey, `cart_abandoned:${cart7.id}`);
  assert.equal(row7.recipientKind, "customer");
  assert.equal(row7.channel, "email");
  assert.equal(row7.recipient, `${testId}.c7@codiq.test`);
  assert.equal(row7.status, "pending");
  assert.equal(row7.payload.itemCount, 2);
  assert.equal(row7.payload.totalIqd, 20000);
  assert.equal(row7.payload.cartUrl, `/store/${storeA.slug}/cart`);
  assert.equal(row7.payload.couponCode, "SAVE10", "the active recovery coupon rides the payload");
  const scan2 = await scanAbandonedCarts();
  assert.equal(scan2.enqueued, 0, "second scan must add nothing");
  assert.equal(await prisma.notificationOutbox.count({ where: { cartId: cart7.id } }), 1);
  summary.scanner = { firstScan: scan1.enqueued, secondScan: scan2.enqueued, dedupeKey: row7.dedupeKey };

  // ---------- guest cart: counted statistically, NEVER messaged ----------
  const guestCart = await prisma.shoppingCart.create({ data: { storeId: storeA.id, ownerKind: "guest", sessionTokenHash: `${testId}-guest-hash`, expiresAt: new Date(Date.now() + 7 * 86400000), lastActivityAt: hoursAgo(14) } });
  await prisma.cartItem.create({ data: { cartId: guestCart.id, storeId: storeA.id, productId: multi.id, variantId: variantOne.id, quantity: 1, priceSnapshotIqd: 10000 } });
  // ---------- customer WITHOUT email: never messaged either ----------
  const customer8 = await registerCustomer(storeA.slug, "زبونة بلا بريد");
  const cart8 = await cartAdd(storeA.slug, customer8.token, { productId: simple.id, quantity: 1 });
  await prisma.shoppingCart.update({ where: { id: cart8.id }, data: { lastActivityAt: hoursAgo(14) } });
  // ---------- converted before the scan: not abandoned ----------
  const customer9 = await registerCustomer(storeA.slug, "زبونة تحولت قبل المسح", `${testId}.c9@codiq.test`);
  const cart9 = await cartAdd(storeA.slug, customer9.token, { variantId: variantOne.id, quantity: 1 });
  assert.equal((await doCheckout(storeA.slug, customer9, cart9)).status, 201);
  await prisma.shoppingCart.update({ where: { id: cart9.id }, data: { lastActivityAt: hoursAgo(14) } });
  const scan3 = await scanAbandonedCarts();
  assert.equal(scan3.enqueued, 0, "guest, email-less, and converted carts must all be skipped");
  assert.equal(await prisma.notificationOutbox.count({ where: { cartId: { in: [guestCart.id, cart8.id, cart9.id] } } }), 0);
  summary.exclusions = { guest: 0, noEmail: 0, convertedBefore: 0 };

  // ---------- window respected AND configurable (1–72) ----------
  const customer10 = await registerCustomer(storeA.slug, "زبونة النافذة", `${testId}.c10@codiq.test`);
  const cart10 = await cartAdd(storeA.slug, customer10.token, { variantId: variantOne.id, quantity: 1 });
  await prisma.shoppingCart.update({ where: { id: cart10.id }, data: { lastActivityAt: hoursAgo(5) } });
  assert.equal((await scanAbandonedCarts()).enqueued, 0, "a 5h-old cart is NOT abandoned under the 12h window");
  await prisma.shoppingCart.update({ where: { id: cart10.id }, data: { lastActivityAt: hoursAgo(13) } });
  assert.equal((await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { windowHours: 24 } })).status, 200);
  assert.equal((await scanAbandonedCarts()).enqueued, 0, "a 13h-old cart is NOT abandoned under a 24h window");
  assert.equal((await request(`${abandonedBase}/settings`, { method: "PUT", token: tokenA, body: { windowHours: 12 } })).status, 200);
  const scanWindow = await scanAbandonedCarts();
  assert.equal(scanWindow.enqueued, 1, "back at 12h the 13h-old cart IS abandoned");
  assert.equal(await prisma.notificationOutbox.count({ where: { cartId: cart10.id, eventType: "cart.abandoned" } }), 1);
  summary.window = { under: 0, widened: 0, back: scanWindow.enqueued };

  // ---------- dedupe race-guard: colliding dedupe key -> swallowed P2002 ----------
  const customer11 = await registerCustomer(storeA.slug, "زبونة التكرار", `${testId}.c11@codiq.test`);
  const cart11 = await cartAdd(storeA.slug, customer11.token, { variantId: variantOne.id, quantity: 1 });
  await prisma.shoppingCart.update({ where: { id: cart11.id }, data: { lastActivityAt: hoursAgo(13) } });
  // The probe must use a REAL event type — the outbox CHECK constraint pins the
  // allowed values. cartId stays null so the scanner's relation filter does not
  // see it; only the (store_id, dedupe_key) unique collides.
  await prisma.notificationOutbox.create({ data: { storeId: storeA.id, eventType: "cart.abandoned", recipientKind: "merchant", channel: "email", recipient: "probe@codiq.test", dedupeKey: `cart_abandoned:${cart11.id}`, payload: {} } });
  const scanDupe = await scanAbandonedCarts();
  assert.equal(scanDupe.duplicates, 1, "the UNIQUE(store_id, dedupe_key) collision is swallowed like enqueueLowStockIfCrossed");
  assert.equal(scanDupe.enqueued, 0);
  assert.equal(await prisma.notificationOutbox.count({ where: { cartId: cart11.id, eventType: "cart.abandoned" } }), 0);
  summary.dedupeRace = { duplicates: scanDupe.duplicates, thrown: false };

  // ---------- preference off / master off => nothing (with positive control) ----------
  const customerB2 = await registerCustomer(storeB.slug, "زبونة باء المتروكة", `${testId}.b2@codiq.test`);
  const cartB2 = await cartAdd(storeB.slug, customerB2.token, { productId: productB.id, quantity: 1 });
  await prisma.shoppingCart.update({ where: { id: cartB2.id }, data: { lastActivityAt: hoursAgo(14) } });
  assert.equal((await scanAbandonedCarts()).enqueued, 0, "store B has no notification settings at all yet");
  await prisma.notificationSettings.create({ data: { storeId: storeB.id, isEnabled: false, configuration: { abandonedCart: { enabled: true, windowHours: 12, recoveryCouponId: null } } } });
  assert.equal((await scanAbandonedCarts()).enqueued, 0, "master switch off => nothing, even with the preference on");
  await prisma.notificationSettings.update({ where: { storeId: storeB.id }, data: { isEnabled: true, configuration: { abandonedCart: { enabled: false, windowHours: 12, recoveryCouponId: null } } } });
  assert.equal((await scanAbandonedCarts()).enqueued, 0, "abandonedCart preference off (the default) => nothing");
  await prisma.notificationSettings.update({ where: { storeId: storeB.id }, data: { configuration: { abandonedCart: { enabled: true, windowHours: 12, recoveryCouponId: null } } } });
  const scanB = await scanAbandonedCarts();
  assert.equal(scanB.enqueued, 1, "positive control: both switches on => the same cart IS picked up");
  const rowB = await prisma.notificationOutbox.findFirstOrThrow({ where: { cartId: cartB2.id, eventType: "cart.abandoned" } });
  assert.equal(rowB.storeId, storeB.id);
  assert.equal(rowB.payload.couponCode, undefined, "store B configured no recovery coupon");
  await prisma.notificationSettings.update({ where: { storeId: storeB.id }, data: { configuration: { abandonedCart: { enabled: false, windowHours: 12, recoveryCouponId: null } } } });
  summary.gating = { noSettings: 0, masterOff: 0, prefOff: 0, positiveControl: scanB.enqueued };

  // ---------- panel: live list (customers AND guests) + honest stats ----------
  const panelBefore = await request(abandonedBase, { token: tokenA });
  assert.equal(panelBefore.status, 200);
  assert.equal(panelBefore.payload.windowHours, 12);
  const panelCartIds = panelBefore.payload.carts.map((cart) => cart.id);
  assert.ok(panelCartIds.includes(cart7.id), "messaged customer cart listed");
  assert.ok(panelCartIds.includes(guestCart.id), "guest cart listed statistically");
  assert.ok(panelCartIds.includes(cart8.id), "email-less customer cart listed");
  assert.ok(!panelCartIds.includes(cart9.id), "converted cart is not abandoned");
  const guestRow = panelBefore.payload.carts.find((cart) => cart.id === guestCart.id);
  assert.equal(guestRow.ownerKind, "guest");
  assert.equal(guestRow.hasEmail, false);
  assert.equal(guestRow.message, null, "guests are never messaged");
  const cart7Row = panelBefore.payload.carts.find((cart) => cart.id === cart7.id);
  assert.equal(cart7Row.itemCount, 2);
  assert.equal(cart7Row.totalIqd, 20000);
  assert.ok(cart7Row.message, "the recovery message shows on the row");
  assert.equal(panelBefore.payload.stats.sent, 2, "cart7 + cart10 rows only (store A)");
  assert.equal(panelBefore.payload.stats.recovered, 0);

  // Recovery correlation: customer7 completes checkout AFTER the message.
  const cart7Now = (await request(`/store/${storeA.slug}/cart`, { token: customer7.token })).payload.cart;
  assert.equal(cart7Now.id, cart7.id);
  assert.equal((await doCheckout(storeA.slug, customer7, cart7Now)).status, 201);
  const panelAfter = await request(abandonedBase, { token: tokenA });
  assert.equal(panelAfter.payload.stats.sent, 2);
  assert.equal(panelAfter.payload.stats.recovered, 1, "the converted cart's message counts as recovered (correlation)");
  assert.ok(!panelAfter.payload.carts.some((cart) => cart.id === cart7.id), "a converted cart leaves the live list");
  summary.panel = { sent: panelAfter.payload.stats.sent, recovered: panelAfter.payload.stats.recovered, guestListed: true };

  // ---------- the worker delivers the Arabic recovery message ----------
  // PG-3: cart.abandoned is the platform's only MARKETING event, so the worker
  // now refuses to send it without a working unsubscribe link — and that link
  // needs a public base URL. The same setting also absolutises the cart link,
  // which used to ship as a bare «/store/x/cart» that no mail client can open.
  process.env.CODIQ_PUBLIC_BASE_URL = "https://b2.codiqos.test";
  const fake = new FakeNotificationProvider();
  await processOutboxBatch(fake, { batchSize: 100 });
  const recoveryEmail = fake.sent.find((message) => message.channel === "email" && message.to === `${testId}.c7@codiq.test` && message.subject?.includes("سلتك"));
  assert.ok(recoveryEmail, "the cart.abandoned email must be delivered by the untouched worker");
  assert.ok(recoveryEmail.subject.includes("متجر 20B2 ألف"), "subject carries the store name");
  assert.ok(recoveryEmail.body.includes(`https://b2.codiqos.test/store/${storeA.slug}/cart`), "body carries the cart link as an absolute URL");
  assert.ok(recoveryEmail.body.includes("SAVE10"), "body carries the recovery coupon code");
  assert.ok(recoveryEmail.body.includes("20000"), "body carries the cart total");
  // PG-3: a marketing message never leaves without a way out of it.
  assert.ok(recoveryEmail.body.includes("https://b2.codiqos.test/unsubscribe/"), "the marketing message carries an unsubscribe link");
  summary.workerDelivery = { subject: recoveryEmail.subject };

  // restore the shared plan so later suites see the seeded default
  await prisma.plan.update({ where: { code: "free" }, data: { commissionBps: seededFreeCommissionBps } });

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

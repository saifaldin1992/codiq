/**
 * codiq CD-1 «حزمة تدليل الزبون» — customer-delight proof.
 * Phase15/20B-style harness: the real HTTP app over a real PostgreSQL, with the
 * outbox worker driven directly (processOutboxBatch) exactly as phase 15 does.
 *
 * CD-1a — public «أين طلبي؟» tracking:
 *   1. the correct (order number + phone) pair returns the projection, and the
 *      response key sets are asserted EXACTLY — no customer name, email, phone,
 *      address line, note, actor, or internal id may ever appear;
 *   2. wrong phone, wrong order number, an unparsable phone, and another
 *      store's order all return the IDENTICAL generic 404 (status, code, and
 *      message compared byte-for-byte against the baseline miss);
 *   3. missing fields are a 400 that is NOT the miss shape;
 *   4. the dedicated `order_track` limiter trips at 10 per window and keys per
 *      phone (a second phone is unaffected).
 *
 * CD-1b — «مندوبك في الطريق» courier notice:
 *   5. the preparation→out_for_delivery transition enqueues EXACTLY ONE
 *      customer row with dedupeKey courier_dispatched:{orderId} and no merchant
 *      copy; a repeated transition attempt adds nothing;
 *   6. master switch off => none; the courierDispatch preference off => none;
 *      an order without a customer email => none (skipped honestly);
 *   7. the preference lives OUTSIDE the phase-15 `preferences` trio and a
 *      preferences write does not clobber it (nor it the preferences);
 *   8. the untouched worker renders and delivers the Arabic message with the
 *      store name, order number, and the /track link.
 *
 * CD-1c — «اطلبه مجدداً» one-click reorder:
 *   9. available lines land in the cart with the CURRENT variant price —
 *      INCLUDING a line the cart already had, which is re-priced rather than
 *      left on a snapshot checkout would then refuse (LOY-1; see 10b);
 *  10. an inactive variant and an out-of-stock variant are skipped with their
 *      honest reasons while the rest of the order still lands;
 *  11. IDOR: another customer's order => 404; cross-store order => 404;
 *  12. an all-stale order returns the untouched cart plus a full skipped list.
 *
 * Rate limiting: storefront_rate_limits is cleared before every non-GET request
 * EXCEPT inside scenario 4, which is the limiter's own proof.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `cd1-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "cd1-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");
const { ORDER_TRACKING_KEYS, ORDER_TRACKING_TIMELINE_KEYS } = await import(
  "../src/services/order-tracking.service.ts"
);

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(
  path,
  { method = "GET", body, token, headers = {}, keepRateLimits = false } = {}
) {
  // The fixed-window limiter is phase 9A's subject; counters are cleared before
  // every write so scenarios stay independent of call volume. Scenario 4 opts
  // out with keepRateLimits because it is the limiter's own proof.
  if (method !== "GET" && !keepRateLimits) await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function merchantStatus(token, slug, orderId, toStatus, expectedVersion) {
  return request(`/merchant/stores/${slug}/orders/${orderId}/status`, {
    method: "POST",
    token,
    body: { toStatus, expectedVersion },
  });
}

async function driveToOutForDelivery(token, slug, orderId, startVersion = 1) {
  for (const [toStatus, version] of [
    ["processing", startVersion],
    ["preparation", startVersion + 1],
    ["out_for_delivery", startVersion + 2],
  ]) {
    const result = await merchantStatus(token, slug, orderId, toStatus, version);
    assert.equal(
      result.status,
      200,
      `transition to ${toStatus} failed: ${JSON.stringify(result.payload)}`
    );
  }
}

let customerPhoneSuffix = 0;
async function registerCustomer(slug, fullName, email) {
  customerPhoneSuffix += 1;
  const phone = `+96477055${String(customerPhoneSuffix).padStart(5, "0")}`;
  const registered = await request(`/store/${slug}/account/register`, {
    method: "POST",
    body: { phone, password: "Cd1CustomerPass2026!", fullName, ...(email ? { email } : {}) },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const address = await request(`/store/${slug}/account/addresses`, {
    method: "POST",
    token: registered.payload.accessToken,
    body: {
      recipientName: fullName,
      fullAddress: "شارع التدليل 1",
      city: "Baghdad",
      governorate: "Baghdad",
      phoneContact: phone,
      isDefault: true,
    },
  });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  return {
    token: registered.payload.accessToken,
    account: registered.payload.account,
    addressId: address.payload.address.id,
    phone,
  };
}

async function cartAdd(slug, token, body) {
  const added = await request(`/store/${slug}/cart/items`, { method: "POST", token, body });
  assert.equal(added.status, 200, JSON.stringify(added.payload));
  return added.payload.cart;
}

let checkoutKeySuffix = 0;
async function doCheckout(slug, customer, cart) {
  checkoutKeySuffix += 1;
  const idempotencyKey = `cd1-checkout-key-${String(checkoutKeySuffix).padStart(4, "0")}`;
  const result = await request(`/store/${slug}/checkout`, {
    method: "POST",
    token: customer.token,
    headers: { "idempotency-key": idempotencyKey },
    body: { cartVersion: cart.version, addressId: customer.addressId, paymentMethodCode: "cod" },
  });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  return result.payload.order;
}

function trackBody(orderNumber, phone) {
  return { orderNumber, phone };
}
function missShape(result) {
  return {
    status: result.status,
    code: result.payload?.error?.code,
    message: result.payload?.error?.message,
  };
}

const summary = {};

try {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE"
  );

  // ---------------------------------------------------------------- fixtures
  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100509201",
    email: `${testId}.merchant-a@codiq.test`,
    password: "Cd1MerchantPass2026!",
    businessName: "متجر التدليل ألف",
  });
  const merchantB = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100509202",
    email: `${testId}.merchant-b@codiq.test`,
    password: "Cd1MerchantPass2026!",
    businessName: "متجر التدليل باء",
  });
  assert.equal(merchantA.status, 201);
  assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.payload.account.id,
      name: "متجر التدليل ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.payload.account.id,
      name: "متجر التدليل باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  await prisma.deliveryRate.create({
    data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
  });
  await prisma.deliveryRate.create({
    data: { storeId: storeB.id, governorate: "Baghdad", amountIqd: 2000, isEnabled: true },
  });
  await prisma.notificationSettings.create({ data: { storeId: storeA.id, isEnabled: true } });
  const loginA = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}.merchant-a@codiq.test`, password: "Cd1MerchantPass2026!" },
  });
  const loginB = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}.merchant-b@codiq.test`, password: "Cd1MerchantPass2026!" },
  });
  assert.equal(loginA.status, 200);
  assert.equal(loginB.status, 200);
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;

  const staple = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "CD1-STAPLE",
      name: "منتج أساسي",
      priceIqd: 6000,
      stockQuantity: 60,
      lowStockThreshold: 0,
    },
  });
  const stapleVariant = await prisma.productVariant.findFirstOrThrow({
    where: { productId: staple.id, isDefault: true },
  });
  const retiring = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "CD1-RETIRING",
      name: "منتج سيتوقف",
      priceIqd: 4000,
      stockQuantity: 30,
      lowStockThreshold: 0,
    },
  });
  const retiringVariant = await prisma.productVariant.findFirstOrThrow({
    where: { productId: retiring.id, isDefault: true },
  });
  const scarce = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "CD1-SCARCE",
      name: "منتج نادر",
      priceIqd: 9000,
      stockQuantity: 20,
      lowStockThreshold: 0,
    },
  });
  const scarceVariant = await prisma.productVariant.findFirstOrThrow({
    where: { productId: scarce.id, isDefault: true },
  });
  const productB = await prisma.product.create({
    data: {
      storeId: storeB.id,
      sku: "CD1-B",
      name: "منتج متجر باء",
      priceIqd: 7000,
      stockQuantity: 25,
      lowStockThreshold: 0,
    },
  });

  // ======================================================================
  // CD-1a — public order tracking
  // ======================================================================
  const tracked = await registerCustomer(storeA.slug, "زبونة التتبع", `${testId}.track@codiq.test`);
  const trackCart = await cartAdd(storeA.slug, tracked.token, {
    productId: staple.id,
    quantity: 3,
  });
  const trackOrder = await doCheckout(storeA.slug, tracked, trackCart);
  // One extra transition so the public timeline has more than the creation event.
  assert.equal(
    (await merchantStatus(tokenA, storeA.slug, trackOrder.id, "processing", 1)).status,
    200
  );

  const trackPath = `/store/${storeA.slug}/orders/track`;
  const hit = await request(trackPath, {
    method: "POST",
    body: trackBody(trackOrder.orderNumber, tracked.phone),
  });
  assert.equal(hit.status, 200, JSON.stringify(hit.payload));

  // --- 1. EXACT key sets: the projection is an allow-list, not a filter. ---
  assert.deepEqual(
    Object.keys(hit.payload).sort(),
    ["order"],
    "the envelope carries the projection and nothing else"
  );
  assert.deepEqual(
    Object.keys(hit.payload.order).sort(),
    [...ORDER_TRACKING_KEYS].sort(),
    "the public projection must match ORDER_TRACKING_KEYS exactly"
  );
  for (const event of hit.payload.order.statusTimeline) {
    assert.deepEqual(
      Object.keys(event).sort(),
      [...ORDER_TRACKING_TIMELINE_KEYS].sort(),
      "timeline events expose the transition and its time ONLY"
    );
  }
  // Belt and braces: no PII value may appear anywhere in the serialized body.
  const serialized = JSON.stringify(hit.payload);
  for (const forbidden of [
    "customerName",
    "customerEmail",
    "recipientPhone",
    "shippingAddressLine1",
    "shippingAddressLine2",
    "actorKind",
    "actorId",
    "note",
    "fromStatus",
    "customerId",
    "storeId",
    "زبونة التتبع",
    `${testId}.track@codiq.test`,
    tracked.phone,
    "شارع التدليل 1",
  ]) {
    assert.ok(!serialized.includes(forbidden), `the public tracking response leaked ${forbidden}`);
  }
  assert.equal(hit.payload.order.orderNumber, trackOrder.orderNumber);
  assert.equal(hit.payload.order.status, "processing");
  assert.equal(
    hit.payload.order.itemCount,
    3,
    "item count is the summed quantity, not the line count"
  );
  assert.equal(hit.payload.order.totalIqd, 21000, "3×6000 + 3000 delivery");
  assert.equal(hit.payload.order.governorate, "Baghdad");
  assert.deepEqual(
    hit.payload.order.statusTimeline.map((event) => event.toStatus),
    ["new", "processing"]
  );
  summary.trackingProjection = {
    keys: Object.keys(hit.payload.order).sort(),
    timelineKeys: [...ORDER_TRACKING_TIMELINE_KEYS],
    itemCount: hit.payload.order.itemCount,
    totalIqd: hit.payload.order.totalIqd,
  };

  // --- 2. every miss is the IDENTICAL generic 404. ---
  const baselineMiss = missShape(
    await request(trackPath, {
      method: "POST",
      body: trackBody("SF-DOES-NOT-EXIST", tracked.phone),
    })
  );
  assert.equal(baselineMiss.status, 404);
  const wrongPhone = missShape(
    await request(trackPath, {
      method: "POST",
      body: trackBody(trackOrder.orderNumber, "+9647705599999"),
    })
  );
  const unparsablePhone = missShape(
    await request(trackPath, {
      method: "POST",
      body: trackBody(trackOrder.orderNumber, "not-a-phone"),
    })
  );
  const foreignStore = missShape(
    await request(`/store/${storeB.slug}/orders/track`, {
      method: "POST",
      body: trackBody(trackOrder.orderNumber, tracked.phone),
    })
  );
  for (const [label, miss] of [
    ["wrong phone", wrongPhone],
    ["unparsable phone", unparsablePhone],
    ["cross-store", foreignStore],
  ]) {
    assert.deepEqual(
      miss,
      baselineMiss,
      `${label} must be byte-identical to the unknown-order miss — no existence oracle`
    );
  }
  // --- 3. a malformed request is a 400 and NOT the miss shape. ---
  const missingFields = await request(trackPath, {
    method: "POST",
    body: { orderNumber: trackOrder.orderNumber },
  });
  assert.equal(missingFields.status, 400);
  assert.equal(missingFields.payload.error.code, "INVALID_TRACKING_REQUEST");
  summary.trackingMisses = {
    baseline: baselineMiss,
    identical: ["wrong phone", "unparsable phone", "cross-store"],
    malformed: missingFields.status,
  };

  // --- 4. the order_track limiter: 10 per window, keyed per (slug, phone). ---
  await sql.query("DELETE FROM storefront_rate_limits");
  const limiterStatuses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const result = await request(trackPath, {
      method: "POST",
      keepRateLimits: true,
      body: trackBody("SF-GUESS-ATTEMPT", tracked.phone),
    });
    limiterStatuses.push(result.status);
  }
  assert.deepEqual(
    limiterStatuses.slice(0, 10),
    Array(10).fill(404),
    "the first 10 attempts pass the limiter and miss"
  );
  assert.equal(limiterStatuses[10], 429, "the 11th attempt in the window is rate limited");
  const scopedRows = await sql.query(
    "SELECT scope, attempt_count FROM storefront_rate_limits WHERE scope = 'order_track'"
  );
  assert.equal(scopedRows.rows.length, 1, "one counter for one (slug, phone) key");
  assert.equal(Number(scopedRows.rows[0].attempt_count), 11);
  // A different phone is a different bucket and is unaffected by the trip.
  const otherPhone = await request(trackPath, {
    method: "POST",
    keepRateLimits: true,
    body: trackBody(trackOrder.orderNumber, "+9647705577777"),
  });
  assert.equal(otherPhone.status, 404, "a second phone has its own counter");
  assert.equal(
    (
      await sql.query(
        "SELECT COUNT(*)::int AS count FROM storefront_rate_limits WHERE scope = 'order_track'"
      )
    ).rows[0].count,
    2
  );
  await sql.query("DELETE FROM storefront_rate_limits");
  summary.trackingRateLimit = { firstTen: 404, eleventh: limiterStatuses[10], buckets: 2 };

  // ======================================================================
  // CD-1b — «مندوبك في الطريق»
  // ======================================================================
  const courier = await registerCustomer(
    storeA.slug,
    "زبونة المندوب",
    `${testId}.courier@codiq.test`
  );
  const courierCart = await cartAdd(storeA.slug, courier.token, {
    productId: staple.id,
    quantity: 1,
  });
  const courierOrder = await doCheckout(storeA.slug, courier, courierCart);
  await driveToOutForDelivery(tokenA, storeA.slug, courierOrder.id);

  // --- 5. exactly one customer row with the dedupe key, no merchant copy. ---
  const courierRows = await prisma.notificationOutbox.findMany({
    where: { orderId: courierOrder.id, eventType: "order.courier_dispatched" },
  });
  assert.equal(courierRows.length, 1, "exactly ONE courier notice per order");
  const courierRow = courierRows[0];
  assert.equal(courierRow.dedupeKey, `courier_dispatched:${courierOrder.id}`);
  assert.equal(courierRow.recipientKind, "customer");
  assert.equal(courierRow.channel, "email");
  assert.equal(courierRow.recipient, `${testId}.courier@codiq.test`);
  assert.equal(courierRow.status, "pending");
  assert.equal(courierRow.payload.orderNumber, courierOrder.orderNumber);
  assert.equal(courierRow.payload.storeName, "متجر التدليل ألف");
  assert.equal(courierRow.payload.trackingUrl, `/store/${storeA.slug}/track`);
  assert.equal(
    await prisma.notificationOutbox.count({
      where: {
        orderId: courierOrder.id,
        eventType: "order.courier_dispatched",
        recipientKind: "merchant",
      },
    }),
    0,
    "the courier notice is customer-directed only"
  );
  // A repeated transition attempt is refused by the lifecycle and adds nothing.
  const repeated = await merchantStatus(
    tokenA,
    storeA.slug,
    courierOrder.id,
    "out_for_delivery",
    4
  );
  assert.equal(repeated.status, 422, JSON.stringify(repeated.payload));
  assert.equal(
    await prisma.notificationOutbox.count({
      where: { orderId: courierOrder.id, eventType: "order.courier_dispatched" },
    }),
    1,
    "no duplicate courier notice"
  );
  summary.courierEnqueue = {
    rows: courierRows.length,
    dedupeKey: courierRow.dedupeKey,
    merchantCopies: 0,
    repeatAttempt: repeated.status,
  };

  // --- 6a. master switch OFF => nothing (with a positive control after). ---
  await prisma.notificationSettings.update({
    where: { storeId: storeA.id },
    data: { isEnabled: false },
  });
  const masterOff = await registerCustomer(
    storeA.slug,
    "زبونة المفتاح العام",
    `${testId}.master@codiq.test`
  );
  const masterOffOrder = await doCheckout(
    storeA.slug,
    masterOff,
    await cartAdd(storeA.slug, masterOff.token, { productId: staple.id, quantity: 1 })
  );
  await driveToOutForDelivery(tokenA, storeA.slug, masterOffOrder.id);
  assert.equal(
    await prisma.notificationOutbox.count({ where: { orderId: masterOffOrder.id } }),
    0,
    "master switch off silences every channel"
  );
  await prisma.notificationSettings.update({
    where: { storeId: storeA.id },
    data: { isEnabled: true },
  });

  // --- 6b. the courierDispatch preference OFF => nothing, other events intact. ---
  const prefOffWrite = await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
    method: "PUT",
    token: tokenA,
    body: { courierDispatch: { enabled: false } },
  });
  assert.equal(prefOffWrite.status, 200, JSON.stringify(prefOffWrite.payload));
  assert.equal(prefOffWrite.payload.settings.courierDispatch.enabled, false);
  const prefOff = await registerCustomer(storeA.slug, "زبونة التفضيل", `${testId}.pref@codiq.test`);
  const prefOffOrder = await doCheckout(
    storeA.slug,
    prefOff,
    await cartAdd(storeA.slug, prefOff.token, { productId: staple.id, quantity: 1 })
  );
  await driveToOutForDelivery(tokenA, storeA.slug, prefOffOrder.id);
  assert.equal(
    await prisma.notificationOutbox.count({
      where: { orderId: prefOffOrder.id, eventType: "order.courier_dispatched" },
    }),
    0,
    "courierDispatch preference off => no courier notice"
  );
  assert.ok(
    (await prisma.notificationOutbox.count({
      where: { orderId: prefOffOrder.id, eventType: "order.status_changed" },
    })) > 0,
    "the phase-15 status notifications are untouched by the new toggle"
  );
  const prefOnWrite = await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
    method: "PUT",
    token: tokenA,
    body: { courierDispatch: { enabled: true } },
  });
  assert.equal(prefOnWrite.status, 200);
  assert.equal(prefOnWrite.payload.settings.courierDispatch.enabled, true);

  // --- 6c. no customer email => skipped honestly (no dead row). ---
  const emailless = await registerCustomer(storeA.slug, "زبونة بلا بريد");
  const emaillessOrder = await doCheckout(
    storeA.slug,
    emailless,
    await cartAdd(storeA.slug, emailless.token, { productId: staple.id, quantity: 1 })
  );
  await driveToOutForDelivery(tokenA, storeA.slug, emaillessOrder.id);
  assert.equal(
    await prisma.notificationOutbox.count({
      where: { orderId: emaillessOrder.id, eventType: "order.courier_dispatched" },
    }),
    0,
    "no customer email => no courier row at all"
  );
  summary.courierGating = {
    masterOff: 0,
    preferenceOff: 0,
    noEmail: 0,
    statusChangedUntouched: true,
  };

  // --- 7. the toggle lives OUTSIDE the phase-15 preferences trio. ---
  const settingsView = await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
    token: tokenA,
  });
  assert.equal(settingsView.status, 200);
  assert.deepEqual(
    settingsView.payload.settings.preferences,
    { orderCreated: true, orderStatusChanged: true, lowStock: true },
    "the phase-15 preferences shape must stay EXACTLY three keys"
  );
  assert.deepEqual(settingsView.payload.settings.courierDispatch, { enabled: true });
  // A preferences write must not clobber courierDispatch, and vice versa.
  assert.equal(
    (
      await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
        method: "PUT",
        token: tokenA,
        body: { courierDispatch: { enabled: false } },
      })
    ).status,
    200
  );
  const afterPrefWrite = await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
    method: "PUT",
    token: tokenA,
    body: { preferences: { lowStock: false } },
  });
  assert.equal(
    afterPrefWrite.payload.settings.courierDispatch.enabled,
    false,
    "a preferences write must preserve courierDispatch"
  );
  assert.equal(afterPrefWrite.payload.settings.preferences.lowStock, false);
  const afterCourierWrite = await request(
    `/merchant/stores/${storeA.slug}/notifications/settings`,
    { method: "PUT", token: tokenA, body: { courierDispatch: { enabled: true } } }
  );
  assert.equal(
    afterCourierWrite.payload.settings.preferences.lowStock,
    false,
    "a courierDispatch write must preserve the preferences"
  );
  assert.equal(afterCourierWrite.payload.settings.courierDispatch.enabled, true);
  assert.equal(
    (
      await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
        method: "PUT",
        token: tokenA,
        body: { preferences: { lowStock: true } },
      })
    ).status,
    200
  );
  assert.equal(
    (
      await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
        method: "PUT",
        token: tokenA,
        body: { courierDispatch: { enabled: "yes" } },
      })
    ).status,
    422
  );
  assert.equal(
    (
      await request(`/merchant/stores/${storeA.slug}/notifications/settings`, {
        method: "PUT",
        token: tokenA,
        body: { preferences: { courierDispatch: true } },
      })
    ).status,
    422,
    "the new toggle is NOT accepted inside the phase-15 trio"
  );
  summary.preferenceStorage = {
    location: "configuration.courierDispatch",
    phase15TrioIntact: true,
    mutualPreservation: true,
  };

  // --- 8. the untouched worker renders and delivers the Arabic message. ---
  // PG-3: the payload stores a relative path, and the renderer absolutises it —
  // a bare «/store/x/track» is not a link in an email. The base URL is what
  // turns the stored path into something a customer can press.
  process.env.CODIQ_PUBLIC_BASE_URL = "https://cd1.codiqos.test";
  const fake = new FakeNotificationProvider();
  await processOutboxBatch(fake, { batchSize: 200 });
  const courierEmail = fake.sent.find(
    (message) =>
      message.channel === "email" &&
      message.to === `${testId}.courier@codiq.test` &&
      message.subject?.includes("مندوبك في الطريق")
  );
  assert.ok(
    courierEmail,
    "the order.courier_dispatched email must be delivered by the untouched worker"
  );
  assert.ok(
    courierEmail.subject.includes(courierOrder.orderNumber),
    "subject carries the order number"
  );
  assert.ok(courierEmail.body.includes("متجر التدليل ألف"), "body carries the store name");
  assert.ok(
    courierEmail.body.includes(`https://cd1.codiqos.test/store/${storeA.slug}/track`),
    "body carries the public tracking link as an absolute URL a customer can actually press"
  );
  assert.equal(
    (await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: courierRow.id } })).status,
    "sent"
  );
  summary.courierDelivery = { subject: courierEmail.subject };

  // ======================================================================
  // CD-1c — «اطلبه مجدداً»
  // ======================================================================
  const buyer = await registerCustomer(
    storeA.slug,
    "زبونة إعادة الطلب",
    `${testId}.reorder@codiq.test`
  );
  await cartAdd(storeA.slug, buyer.token, { productId: staple.id, quantity: 2 });
  await cartAdd(storeA.slug, buyer.token, { productId: retiring.id, quantity: 1 });
  const mixedCart = await cartAdd(storeA.slug, buyer.token, { productId: scarce.id, quantity: 4 });
  const mixedOrder = await doCheckout(storeA.slug, buyer, mixedCart);
  const reorderPath = (orderId) => `/store/${storeA.slug}/account/orders/${orderId}/reorder`;
  // Placed BEFORE the catalog goes stale below — scenario 12 replays it once
  // every one of its lines has become unavailable.
  const stale = await registerCustomer(
    storeA.slug,
    "زبونة الطلب القديم",
    `${testId}.stale@codiq.test`
  );
  const staleOrder = await doCheckout(
    storeA.slug,
    stale,
    await cartAdd(storeA.slug, stale.token, { productId: retiring.id, quantity: 1 })
  );

  // --- 9/10. inactive + out-of-stock lines skipped; the rest still lands. ---
  // The retiring variant is deactivated; the scarce variant's stock drops below
  // the ordered quantity. The staple line must still make it into the cart.
  await prisma.productVariant.update({
    where: { id: retiringVariant.id },
    data: { isActive: false },
  });
  await prisma.productVariant.update({
    where: { id: scarceVariant.id },
    data: { stockQuantity: 2 },
  });
  // Price moved since the order: the reorder must snapshot TODAY's price.
  await prisma.productVariant.update({ where: { id: stapleVariant.id }, data: { priceIqd: 6500 } });

  const reordered = await request(reorderPath(mixedOrder.id), {
    method: "POST",
    token: buyer.token,
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.payload));
  assert.deepEqual(Object.keys(reordered.payload).sort(), ["addedCount", "cart", "skipped"]);
  assert.equal(
    reordered.payload.cart.items.length,
    1,
    "only the still-available line lands in the cart"
  );
  const reorderedLine = reordered.payload.cart.items[0];
  assert.equal(reorderedLine.variantId, stapleVariant.id);
  assert.equal(reorderedLine.quantity, 2, "the original line quantity is preserved");
  assert.equal(
    reorderedLine.priceSnapshotIqd,
    6500,
    "the reorder snapshots the CURRENT variant price"
  );
  const skippedByName = Object.fromEntries(
    reordered.payload.skipped.map((row) => [row.productName, row.reason])
  );
  assert.deepEqual(
    skippedByName,
    { "منتج سيتوقف": "product_unavailable", "منتج نادر": "insufficient_stock" },
    "each skipped line names its honest reason"
  );
  for (const row of reordered.payload.skipped)
    assert.deepEqual(Object.keys(row).sort(), ["productName", "reason", "variantName"]);
  assert.equal(
    reordered.payload.addedCount,
    1,
    "addedCount reports exactly what landed in the cart"
  );
  summary.reorderMixed = {
    added: reordered.payload.cart.items.length,
    skipped: skippedByName,
    repricedTo: reorderedLine.priceSnapshotIqd,
  };

  // --- 10b. an EXISTING cart line is RE-PRICED by the reorder, and a reorder
  // that only hits the quantity cap must not touch the cart at all. ---
  //
  // LOY-1 — THIS ASSERTION IS THE REVERSE OF WHAT IT USED TO BE, and the reason
  // it changed is worth writing down.
  //
  // It used to pin «an existing line keeps the price the customer already had»,
  // on the reasoning that overwriting a snapshot silently re-prices something he
  // already had in his cart. That reasoning has been overtaken twice:
  //
  //   - 19-د made `addCartItem`/`updateCartItem` re-price any line whose
  //     quantity RISES, because a frozen promotional price stretched over 98
  //     more units is not a promise kept, it is 450,000 IQD taken from the
  //     merchant. A reorder ALWAYS raises the quantity, so it was the last door
  //     left open on the same behaviour;
  //   - 19-د also made checkout refuse any line whose snapshot no longer matches
  //     the live price (CART_PRICE_CHANGED). So the stale snapshot could not
  //     survive the till anyway — it could only ambush him there.
  //
  // What was left was therefore not a money question but a shopper's one, and it
  // answers itself: he taps «أعد الطلب», and he should get a cart he can pay
  // for, not one built on a price that stopped existing and a refusal he cannot
  // explain three screens later. The line is priced from the same read that
  // decided it was available.
  const priceBefore = reorderedLine.priceSnapshotIqd;
  await prisma.productVariant.update({ where: { id: stapleVariant.id }, data: { priceIqd: 9000 } });
  const repriceProbe = await request(reorderPath(mixedOrder.id), {
    method: "POST",
    token: buyer.token,
  });
  assert.equal(repriceProbe.status, 200, JSON.stringify(repriceProbe.payload));
  const repricedLine = repriceProbe.payload.cart.items.find(
    (item) => item.variantId === stapleVariant.id
  );
  assert.notEqual(
    priceBefore,
    9000,
    "the fixture only proves anything if the price actually moved"
  );
  assert.equal(
    repricedLine.priceSnapshotIqd,
    9000,
    "LOY-1: a reorder onto an existing line re-prices it, exactly as addCartItem does — checkout would refuse the stale snapshot with CART_PRICE_CHANGED, and a cart he cannot pay for is not a reorder"
  );
  assert.equal(repricedLine.quantity, 4, "quantities still accumulate");
  summary.reorderReprices = { was: priceBefore, now: repricedLine.priceSnapshotIqd };
  await prisma.productVariant.update({ where: { id: stapleVariant.id }, data: { priceIqd: 6500 } });

  await prisma.cartItem.updateMany({
    where: { cartId: repriceProbe.payload.cart.id, variantId: stapleVariant.id },
    data: { quantity: 99 },
  });
  const cartAtCap = await request(`/store/${storeA.slug}/cart`, { token: buyer.token });
  const versionAtCap = cartAtCap.payload.cart.version;
  const cappedReorder = await request(reorderPath(mixedOrder.id), {
    method: "POST",
    token: buyer.token,
  });
  assert.equal(cappedReorder.status, 200, JSON.stringify(cappedReorder.payload));
  assert.equal(cappedReorder.payload.addedCount, 0, "nothing was added");
  assert.equal(
    cappedReorder.payload.cart.version,
    versionAtCap,
    "a fully-capped reorder must not bump the cart version"
  );
  assert.ok(
    cappedReorder.payload.skipped.some((row) => row.reason === "quantity_limit"),
    "the cap is reported honestly"
  );
  summary.reorderCap = { addedCount: 0, versionUnchanged: true };
  // The cap probe parked the line at 99; put it back where the accumulation
  // scenario below expects to find it.
  await prisma.cartItem.updateMany({
    where: { cartId: repriceProbe.payload.cart.id, variantId: stapleVariant.id },
    data: { quantity: 2 },
  });

  // --- 11. IDOR: another customer's order, and a cross-store order. ---
  const stranger = await registerCustomer(
    storeA.slug,
    "زبونة غريبة",
    `${testId}.stranger@codiq.test`
  );
  const foreignOrderAttempt = await request(reorderPath(mixedOrder.id), {
    method: "POST",
    token: stranger.token,
  });
  assert.equal(
    foreignOrderAttempt.status,
    404,
    "another customer's order is not even acknowledged"
  );
  assert.equal(foreignOrderAttempt.payload.error.code, "RESOURCE_NOT_FOUND");
  const buyerB = await registerCustomer(storeB.slug, "زبونة باء", `${testId}.b@codiq.test`);
  const orderB = await doCheckout(
    storeB.slug,
    buyerB,
    await cartAdd(storeB.slug, buyerB.token, { productId: productB.id, quantity: 1 })
  );
  const crossStore = await request(
    `/store/${storeB.slug}/account/orders/${mixedOrder.id}/reorder`,
    { method: "POST", token: buyerB.token }
  );
  assert.equal(crossStore.status, 404, "store A's order is invisible from store B");
  const crossSession = await request(`/store/${storeA.slug}/account/orders/${orderB.id}/reorder`, {
    method: "POST",
    token: buyerB.token,
  });
  assert.equal(crossSession.status, 403, "a store B session is refused at the store A boundary");
  assert.equal(crossSession.payload.error.code, "STORE_BOUNDARY_DENIED");
  const anonymous = await request(reorderPath(mixedOrder.id), { method: "POST" });
  assert.equal(anonymous.status, 401, "reorder always requires a customer session");
  summary.reorderGuards = {
    foreignCustomer: 404,
    crossStoreOrder: 404,
    crossStoreSession: 403,
    anonymous: 401,
  };

  // --- 12. an all-stale order: the cart is untouched and every line is named. ---
  const cartBefore = await request(`/store/${storeA.slug}/cart`, { token: stale.token });
  const staleResult = await request(reorderPath(staleOrder.id), {
    method: "POST",
    token: stale.token,
  });
  assert.equal(staleResult.status, 200);
  assert.equal(staleResult.payload.cart.items.length, 0);
  assert.equal(
    staleResult.payload.cart.version,
    cartBefore.payload.cart.version,
    "nothing addable => the cart version does not move"
  );
  assert.equal(staleResult.payload.skipped.length, 1);
  assert.equal(staleResult.payload.skipped[0].reason, "product_unavailable");
  assert.equal(staleResult.payload.skipped[0].productName, "منتج سيتوقف");

  // A second reorder of an available order ACCUMULATES into the existing cart.
  await prisma.productVariant.update({
    where: { id: retiringVariant.id },
    data: { isActive: true },
  });
  const again = await request(reorderPath(mixedOrder.id), { method: "POST", token: buyer.token });
  assert.equal(again.status, 200);
  const stapleLine = again.payload.cart.items.find((item) => item.variantId === stapleVariant.id);
  assert.equal(stapleLine.quantity, 4, "reordering twice adds to the existing cart line");
  assert.ok(
    again.payload.cart.items.some((item) => item.variantId === retiringVariant.id),
    "the reactivated variant is addable again"
  );
  assert.deepEqual(
    again.payload.skipped.map((row) => row.reason),
    ["insufficient_stock"],
    "the scarce line is still honestly skipped"
  );
  summary.reorderStale = {
    addedLines: 0,
    skipped: staleResult.payload.skipped.map((row) => row.reason),
    accumulates: stapleLine.quantity,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

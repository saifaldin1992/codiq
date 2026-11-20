/**
 * codiq MD-3 «الرسائل الذكية» — the merchant's daily digest and the stock-out
 * forecast.
 *
 * The digest is a scanner that runs every fifteen minutes and must nonetheless
 * send exactly one message per store per day, so the tests are about the
 * boundaries rather than the wording:
 *
 *   1. ONE PER DAY, STRUCTURALLY — scanning repeatedly within a Baghdad day
 *      enqueues once; the unique key, not a flag, is what enforces it;
 *   2. THE DAY IS A BAGHDAD DAY — an order placed at 23:00 Baghdad belongs to
 *      that evening's digest, not to the next one, and the same instant read as
 *      UTC would fall on the previous day;
 *   3. NOT BEFORE HIS HOUR — a digest for a day still running is not sent;
 *   4. OPT-IN — a store that did not ask gets nothing, and neither does one
 *      whose master switch is off;
 *   5. NOTHING TO SAY, NOTHING SENT — a silent day produces no message, because
 *      an evening email reading «0 طلبات» teaches him to ignore the one that
 *      matters;
 *   6. OPERATIONAL, NOT MARKETING — the digest is classified operational, so a
 *      marketing unsubscribe never silences a merchant's report about his own
 *      shop, and the message renders as a digest rather than falling through to
 *      the low-stock template;
 *   7. THE FORECAST REFUSES TO GUESS — a product with too little history has no
 *      «سينفد خلال N أيام» at all, and the days it does report are floored.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `md3-${Date.now()}`;
const testPhone = `+9647${String(Date.now()).slice(-9)}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "md3-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { scanMerchantDigests, baghdadClock } = await import("../src/notifications/merchant-digest-scanner.ts");
const { stockForecasts, FORECAST_MIN_UNITS, FORECAST_WINDOW_DAYS } = await import("../src/services/stock-forecast.service.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" ? {} : { origin: base }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

const summary = {};

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, notification_outbox RESTART IDENTITY CASCADE");
  // The scanner is GLOBAL — it sweeps every opted-in store — so its counts only
  // mean something if no other store is opted in. notification_settings rows
  // survive the truncate above (their stores do), and stores left behind by a
  // previous run of this very suite would otherwise be swept in and make
  // «skippedTooEarly === 1» pass or fail by history rather than by behaviour.
  await prisma.notificationSettings.updateMany({ data: { dailyDigestEnabled: false } });

  const merchant = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: testPhone, email: `${testId}@codiq.test`, password: "md3-merchant-password", businessName: "تجارة الملخص" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: "متجر الملخص", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const quiet = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: "متجر صامت", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  const login = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}@codiq.test`, password: "md3-merchant-password" } });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const token = login.payload.accessToken;

  await prisma.notificationSettings.create({ data: { storeId: store.id, isEnabled: true } });
  await prisma.notificationSettings.create({ data: { storeId: quiet.id, isEnabled: true } });

  // ============================================================
  // 4. Opt-in: default off, and nothing is sent until he asks.
  // ============================================================
  const defaults = await request(`/merchant/stores/${store.slug}/notifications/settings`, { token });
  assert.equal(defaults.status, 200, JSON.stringify(defaults.payload));
  assert.deepEqual(defaults.payload.settings.dailyDigest, { enabled: false, hour: 20 }, "MD-3: the digest is off until the merchant asks for it");
  assert.equal((await scanMerchantDigests()).enqueued, 0, "MD-3: nothing is enqueued for a store that did not opt in");

  const optIn = await request(`/merchant/stores/${store.slug}/notifications/settings`, { method: "PUT", token, body: { dailyDigest: { enabled: true, hour: 20 } } });
  assert.equal(optIn.status, 200, JSON.stringify(optIn.payload));
  assert.deepEqual(optIn.payload.settings.dailyDigest, { enabled: true, hour: 20 });
  // …and the toggle did not disturb the preference object beside it.
  assert.deepEqual(optIn.payload.settings.preferences, defaults.payload.settings.preferences, "MD-3: opting in changed nothing else");
  // Phase 19-ج: the settings body is parsed by a schema now, so a bad hour and an
  // unknown key are ONE code — and each one names the field, which is what a form
  // needs in order to point at the box he has to fix.
  const badHour = await request(`/merchant/stores/${store.slug}/notifications/settings`, { method: "PUT", token, body: { dailyDigest: { hour: 24 } } });
  assert.equal(badHour.status, 422, JSON.stringify(badHour.payload));
  assert.equal(badHour.payload.error.code, "VALIDATION_FAILED");
  assert.equal(badHour.payload.error.fields[0].path, "dailyDigest.hour");
  const unknownKey = await request(`/merchant/stores/${store.slug}/notifications/settings`, { method: "PUT", token, body: { dailyDigest: { whenever: true } } });
  assert.equal(unknownKey.status, 422, JSON.stringify(unknownKey.payload));
  assert.equal(unknownKey.payload.error.code, "VALIDATION_FAILED");
  assert.equal(unknownKey.payload.error.fields[0].path, "dailyDigest", "19-ج: an unknown key is reported against the block that refused it");

  // ============================================================
  // 2. The day is a BAGHDAD day.
  // ============================================================
  // 2026-07-15 20:00 Baghdad === 17:00 UTC.
  const evening = new Date("2026-07-15T17:00:00.000Z");
  const clock = baghdadClock(evening);
  assert.equal(clock.hour, 20, "MD-3: 17:00 UTC is 20:00 in Baghdad");
  assert.equal(clock.date, "2026-07-15");
  // An order at 23:00 Baghdad on the 15th is 20:00 UTC on the 15th — inside the
  // Baghdad day, and the one that a UTC-day scanner would get right by luck.
  // The real discriminator is 01:00 Baghdad on the 16th = 22:00 UTC on the 15th:
  // the same instant is "the 15th" in UTC and "the 16th" in Baghdad.
  const lateOrder = new Date("2026-07-15T20:00:00.000Z"); // 23:00 Baghdad, the 15th
  const afterMidnight = new Date("2026-07-15T22:00:00.000Z"); // 01:00 Baghdad, the 16th
  assert.equal(baghdadClock(lateOrder).date, "2026-07-15");
  assert.equal(baghdadClock(afterMidnight).date, "2026-07-16", "MD-3: after midnight in Baghdad is a new day even though UTC still says yesterday");
  assert.ok(clock.dayStartUtc < lateOrder && lateOrder <= clock.dayEndUtc, "MD-3: the late-evening order belongs to this digest…");
  assert.ok(afterMidnight > clock.dayEndUtc, "MD-3: …and the one after Baghdad midnight does not");

  let orderCounter = 0;
  const placeOrder = async (createdAt, status = "new", totalIqd = 25_000, storeId = store.id) => {
    orderCounter += 1;
    return prisma.storeOrder.create({
      data: {
        storeId, orderNumber: `MD3-${String(orderCounter).padStart(4, "0")}`, status, createdAt,
        customerName: "زبون", customerEmail: `md3.${orderCounter}@codiq.test`, recipientPhone: "+9647100000002",
        shippingGovernorate: "بغداد", shippingAddressLine1: "شارع 1",
        subtotalIqd: totalIqd, deliveryFeeIqd: 0, totalIqd,
      },
    });
  };
  await placeOrder(new Date("2026-07-15T09:00:00.000Z"));   // 12:00 Baghdad, the 15th
  await placeOrder(lateOrder);                               // 23:00 Baghdad, the 15th
  await placeOrder(afterMidnight);                           // 01:00 Baghdad, the 16th

  // ============================================================
  // 3. Not before his hour.
  // ============================================================
  const tooEarly = await scanMerchantDigests({ now: new Date("2026-07-15T14:00:00.000Z") }); // 17:00 Baghdad
  assert.equal(tooEarly.enqueued, 0, "MD-3: a digest for a day still running is not sent");
  assert.equal(tooEarly.skippedTooEarly, 1);

  // ============================================================
  // 1. One per day, structurally.
  // ============================================================
  const first = await scanMerchantDigests({ now: evening });
  assert.equal(first.enqueued, 1, JSON.stringify(first));
  const again = await scanMerchantDigests({ now: new Date("2026-07-15T18:30:00.000Z") });
  assert.equal(again.enqueued, 0, "MD-3: a second pass the same Baghdad day enqueues nothing…");
  assert.equal(again.duplicates, 1, "MD-3: …and says why — the unique key refused it, no flag was consulted");
  assert.equal(await prisma.notificationOutbox.count({ where: { storeId: store.id, eventType: "merchant.daily_digest" } }), 1);

  const digestRow = await prisma.notificationOutbox.findFirstOrThrow({ where: { storeId: store.id, eventType: "merchant.daily_digest" } });
  assert.equal(digestRow.dedupeKey, `merchant_digest:${store.id}:2026-07-15`, "MD-3: the key names the Baghdad date, which is what makes it once-per-day");
  assert.equal(digestRow.recipientKind, "merchant");
  assert.equal(digestRow.recipient, `${testId}@codiq.test`, "MD-3: it goes to the merchant, not to a customer");
  assert.equal(digestRow.payload.ordersToday, 2, "MD-3: the 12:00 and 23:00 Baghdad orders — not the one after midnight");
  assert.equal(digestRow.payload.revenueTodayIqd, 50_000);
  assert.equal(digestRow.payload.ordersWaiting, 3, "MD-3: orders waiting is a LIVE figure, not a figure about today");

  // The next Baghdad day is a new digest, not a duplicate.
  const nextDay = await scanMerchantDigests({ now: new Date("2026-07-16T17:00:00.000Z") });
  assert.equal(nextDay.enqueued, 1, "MD-3: tomorrow gets its own digest");
  assert.equal((await prisma.notificationOutbox.findFirstOrThrow({ where: { storeId: store.id, dedupeKey: `merchant_digest:${store.id}:2026-07-16` } })).payload.ordersToday, 1);

  // ============================================================
  // 5. A store with nothing to say is skipped.
  // ============================================================
  await prisma.notificationSettings.update({ where: { storeId: quiet.id }, data: { dailyDigestEnabled: true } });
  const quietScan = await scanMerchantDigests({ now: new Date("2026-07-17T17:00:00.000Z") });
  assert.equal(await prisma.notificationOutbox.count({ where: { storeId: quiet.id } }), 0, "MD-3: a store with no orders and nothing waiting gets no evening email");
  assert.ok(quietScan.skippedNothingToSay >= 1);

  // The master switch still governs everything beneath it.
  await prisma.notificationSettings.update({ where: { storeId: store.id }, data: { isEnabled: false } });
  await scanMerchantDigests({ now: new Date("2026-07-18T17:00:00.000Z") });
  // Asserted against THIS store rather than against the scan's totals: the
  // quiet store is opted in too, so a count of eligible stores would pass for
  // the wrong reason.
  assert.equal(await prisma.notificationOutbox.count({ where: { storeId: store.id, dedupeKey: `merchant_digest:${store.id}:2026-07-18` } }), 0, "MD-3: the master switch off means the digest is off too");
  await prisma.notificationSettings.update({ where: { storeId: store.id }, data: { isEnabled: true } });

  // ============================================================
  // 6. Operational, and rendered as a digest.
  // ============================================================
  const kind = await sql.query("SELECT kind FROM notification_event_kinds WHERE event_type = 'merchant.daily_digest'");
  assert.equal(kind.rows[0].kind, "operational", "MD-3: a merchant's report about his own shop is not marketing");

  const provider = new FakeNotificationProvider();
  // A real time, deliberately: the outbox rows were written by the scanner with
  // the database's own now(), so a 2026-07 batch clock would find nothing
  // claimable and the assertion below would fail for the wrong reason. The
  // SCANNER takes a fake clock; the WORKER runs on the real one.
  await processOutboxBatch(provider, { now: new Date(Date.now() + 60_000) });
  const sent = provider.sent.filter((message) => message.subject.includes("ملخص يومك"));
  assert.ok(sent.length >= 1, `MD-3: the digest renders as a digest — subjects seen: ${provider.sent.map((message) => message.subject).join(" | ")}`);
  assert.ok(!sent[0].subject.includes("مخزون"), "MD-3: …not as a low-stock alert, which is what the render fallback would have made of it");
  assert.ok(sent[0].body.includes("طلبات اليوم"), sent[0].body);
  assert.ok(sent[0].body.includes("ينتظر تجهيزك"), "MD-3: waiting orders are named when there are any");

  // ============================================================
  // 7. The forecast refuses to guess.
  // ============================================================
  const product = await prisma.product.create({ data: { storeId: store.id, sku: "MD3-FAST", name: "منتج سريع", priceIqd: 5000, isActive: true } });
  // A product arrives with its default variant already made for it, so this
  // adopts that row instead of inserting a second one the partial unique index
  // would refuse.
  const fast = await prisma.productVariant.update({
    where: { id: (await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id, isDefault: true } })).id },
    data: { sku: "MD3-FAST-D", stockQuantity: 20, priceIqd: 5000 },
  });
  const slowProduct = await prisma.product.create({ data: { storeId: store.id, sku: "MD3-SLOW", name: "منتج بطيء", priceIqd: 5000, isActive: true } });
  const slow = await prisma.productVariant.update({
    where: { id: (await prisma.productVariant.findFirstOrThrow({ where: { productId: slowProduct.id, isDefault: true } })).id },
    data: { sku: "MD3-SLOW-D", stockQuantity: 20, priceIqd: 5000 },
  });

  const now = new Date();
  const recentOrder = await placeOrder(new Date(now.getTime() - 2 * 86_400_000), "completed");
  // 14 units over 14 days = 1/day against 20 in stock → 20 days.
  await prisma.orderItem.create({ data: { orderId: recentOrder.id, productId: product.id, variantId: fast.id, sku: "MD3-FAST-D", productName: "منتج سريع", variantName: "افتراضي", quantity: 14, unitPriceIqd: 5000, lineTotalIqd: 70_000 } });
  // Below the floor: two units is a coincidence, not a rate.
  await prisma.orderItem.create({ data: { orderId: recentOrder.id, productId: slowProduct.id, variantId: slow.id, sku: "MD3-SLOW-D", productName: "منتج بطيء", variantName: "افتراضي", quantity: FORECAST_MIN_UNITS - 1, unitPriceIqd: 5000, lineTotalIqd: 10_000 } });

  const forecasts = await stockForecasts(store.id, { now });
  const fastForecast = forecasts.find((row) => row.sku === "MD3-FAST-D");
  assert.ok(fastForecast, "MD-3: a product with real sales gets a forecast");
  assert.equal(fastForecast.soldInWindow, 14);
  assert.equal(fastForecast.dailyRate, 1, `14 units over ${FORECAST_WINDOW_DAYS} days is one a day`);
  assert.equal(fastForecast.daysRemaining, 20, "MD-3: 20 in stock at one a day is 20 days");
  assert.equal(fastForecast.windowDays, FORECAST_WINDOW_DAYS, "MD-3: the window travels with the number so the merchant can judge it");
  assert.equal(forecasts.find((row) => row.sku === "MD3-SLOW-D"), undefined, "MD-3: too little history means NO forecast — not a confident number built on two units");

  // An order outside the window is not evidence about today's rate.
  const oldOrder = await placeOrder(new Date(now.getTime() - 60 * 86_400_000), "completed");
  await prisma.orderItem.create({ data: { orderId: oldOrder.id, productId: slowProduct.id, variantId: slow.id, sku: "MD3-SLOW-D", productName: "منتج بطيء", variantName: "افتراضي", quantity: 40, unitPriceIqd: 5000, lineTotalIqd: 200_000 } });
  assert.equal((await stockForecasts(store.id, { now })).find((row) => row.sku === "MD3-SLOW-D"), undefined, "MD-3: forty units two months ago say nothing about this fortnight");

  assert.equal((await request(`/merchant/stores/${store.slug}/inventory/forecast`)).status, 401);
  const forecastApi = await request(`/merchant/stores/${store.slug}/inventory/forecast`, { token });
  assert.equal(forecastApi.status, 200, JSON.stringify(forecastApi.payload));
  assert.equal(forecastApi.payload.forecasts.find((row) => row.sku === "MD3-FAST-D").daysRemaining, 20);

  summary.smartMessages = {
    optInDefault: false,
    baghdadDate: clock.date,
    ordersInBaghdadDay: digestRow.payload.ordersToday,
    secondScanEnqueued: again.enqueued,
    secondScanDuplicates: again.duplicates,
    kind: kind.rows[0].kind,
    forecastDays: fastForecast.daysRemaining,
    belowFloorForecast: null,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

/**
 * Marketplace M1 — the stores directory end to end, over HTTP.
 *
 *   1. The merchant's profile: readiness facts, the district-in-governorate
 *      check, opening hours, and «طلب الانضمام» refused until the profile is
 *      complete, then accepted once (a second request is a 409).
 *   2. The owner's queue and decisions: reject needs a reason the merchant
 *      reads; list puts the store in the market; a merchant cannot decide.
 *   3. The directory: only listed stores of active merchants; every sort, the
 *      filters, keyset paging across pages, a cursor from another sort refused,
 *      «nearest» by distance, and boost lifting a store to the top.
 *   4. The reputation job: completed/cancelled orders and response times turn
 *      into rates, a score and badges.
 *   5. The store page: hours with «open now», the badge sheet, payment methods,
 *      reviews and cover; leaving the market makes every public route 404.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");

const testId = `m1-${Date.now().toString(36)}`;
const suffix = String(Date.now()).slice(-6);
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

async function request(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, headers: response.headers, payload: await response.json().catch(() => null) };
}
const ours = (stores, slugs) => stores.filter((store) => slugs.includes(store.slug)).map((store) => store.slug);

const created = [];
try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  const ownerRegister = await request("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: ownerPassword, displayName: "مالك السوق" } });
  assert.ok([200, 201].includes(ownerRegister.status), JSON.stringify(ownerRegister.payload));
  const ownerToken = (await request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: ownerPassword } })).payload.accessToken;
  assert.ok(ownerToken);

  const password = "MarketStores!2026Strong";
  const stores = {};
  for (const [key, digit] of [["a", "1"], ["b", "2"], ["c", "3"]]) {
    const email = `${testId}.${key}@codiq.test`;
    const registered = await registerMerchantDirect({ ownerName: `تاجر ${key}`, businessName: `متجر ${key}`, phone: `+964770${digit}${suffix}`, email, password });
    assert.equal(registered.status, 201, JSON.stringify(registered.payload));
    const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `سوق ${testId} ${key}`, slug: `${testId}-${key}`, defaultSubdomain: `${testId}-${key}` }, select: { id: true, slug: true } });
    created.push(store.id);
    const token = (await request("/auth/merchant/login", { method: "POST", body: { identifier: email, password } })).payload.accessToken;
    assert.ok(token, `merchant ${key} signs in`);
    stores[key] = { ...store, token, path: `/merchant/stores/${store.slug}/market-profile` };
  }
  const { a, b, c } = stores;
  const slugs = [a.slug, b.slug, c.slug];
  const kadhimiya = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكاظمية" } });
  const ashar = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Basra", nameAr: "العشار" } });

  // ── 1. the merchant's profile ────────────────────────────────────────────
  const empty = await request(a.path, { token: a.token });
  assert.equal(empty.status, 200, JSON.stringify(empty.payload));
  assert.equal(empty.payload.listing.status, "unlisted");
  assert.equal(empty.payload.listing.ready, false);
  assert.deepEqual(empty.payload.listing.items.filter((item) => !item.done).map((item) => item.code), ["logo", "business_type", "location", "products"]);

  const early = await request(`${a.path}/listing`, { method: "POST", token: a.token });
  assert.equal(early.status, 422);
  assert.equal(early.payload.error.code, "MARKET_PROFILE_INCOMPLETE");

  const profile = (governorateKey, districtId, extra = {}) => ({ businessType: "أجهزة ذكية", governorateKey, districtId, latitude: null, longitude: null, pickupEnabled: false, openingHours: [], ...extra });
  const wrongDistrict = await request(a.path, { method: "PUT", token: a.token, body: profile("Basra", kadhimiya.id) });
  assert.equal(wrongDistrict.status, 422);
  assert.equal(wrongDistrict.payload.error.code, "DISTRICT_NOT_IN_GOVERNORATE");
  const pickupNoPlace = await request(a.path, { method: "PUT", token: a.token, body: profile("Baghdad", kadhimiya.id, { pickupEnabled: true }) });
  assert.equal(pickupNoPlace.status, 422, "pick-up without coordinates is refused by the schema");
  const noCsrf = await fetch(`${base}${a.path}`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example", authorization: `Bearer ${a.token}` }, body: JSON.stringify(profile("Baghdad", kadhimiya.id)) });
  assert.equal(noCsrf.status, 403, "a write from a foreign origin is refused");

  const hours = [0, 1, 2, 3, 4, 6].map((weekday) => ({ weekday, opensAt: "00:00", closesAt: "23:59" }));
  const saved = await request(a.path, { method: "PUT", token: a.token, body: profile("Baghdad", kadhimiya.id, { latitude: 33.378, longitude: 44.339, pickupEnabled: true, openingHours: hours }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.profile.districtName, "الكاظمية");
  assert.equal(saved.payload.profile.openingHours.filter((day) => day.opensAt).length, 6);
  assert.equal(saved.payload.profile.openingHours[5].opensAt, null, "Friday has no row: closed");

  const otherMerchant = await request(a.path, { token: b.token });
  assert.ok([403, 404].includes(otherMerchant.status), "a merchant cannot read another store's market profile");

  for (const [store, governorateKey, district, lat, lng] of [[a, "Baghdad", kadhimiya, 33.378, 44.339], [b, "Basra", ashar, 30.508, 47.783], [c, "Baghdad", kadhimiya, 33.31, 44.36]]) {
    await prisma.store.update({ where: { id: store.id }, data: { logoObjectKey: `logos/${store.id}/logo.png`, logoContentType: "image/png", logoByteSize: 10 } });
    await prisma.product.create({ data: { storeId: store.id, sku: `${testId}-sku`, name: "منتج", priceIqd: 1000, stockQuantity: 5 } });
    if (store !== a) {
      const put = await request(store.path, { method: "PUT", token: store.token, body: profile(governorateKey, district.id, { latitude: lat, longitude: lng }) });
      assert.equal(put.status, 200, JSON.stringify(put.payload));
    }
  }

  const requested = await request(`${a.path}/listing`, { method: "POST", token: a.token });
  assert.equal(requested.status, 200, JSON.stringify(requested.payload));
  assert.equal(requested.payload.listing.status, "pending");
  assert.equal((await request(`${a.path}/listing`, { method: "POST", token: a.token })).status, 409, "a second request while pending is a 409");
  summary.merchantProfile = true;

  // Pending is not public.
  assert.equal((await request(`/market/stores/${a.slug}`)).status, 404);

  // ── 2. the owner's queue and decisions ───────────────────────────────────
  assert.ok([401, 403].includes((await request("/platform/market/stores", { token: a.token })).status), "a merchant cannot read the owner's queue");
  const queue = await request("/platform/market/stores?status=pending&limit=100", { token: ownerToken });
  assert.equal(queue.status, 200, JSON.stringify(queue.payload));
  const queued = queue.payload.stores.find((row) => row.slug === a.slug);
  assert.ok(queued, "the request is in the owner's pending queue");
  assert.equal(queued.location, "بغداد · الكاظمية");
  assert.equal(queued.activeProducts, 1);

  const noReason = await request(`/platform/market/stores/${a.id}/decision`, { method: "PUT", token: ownerToken, body: { decision: "reject" } });
  assert.equal(noReason.status, 422, "a rejection needs a reason");
  const rejected = await request(`/platform/market/stores/${a.id}/decision`, { method: "PUT", token: ownerToken, body: { decision: "reject", note: "أضف صورة غلاف واضحة" } });
  assert.equal(rejected.status, 200);
  const seen = await request(a.path, { token: a.token });
  assert.equal(seen.payload.listing.status, "rejected");
  assert.equal(seen.payload.listing.note, "أضف صورة غلاف واضحة", "the merchant reads why");
  assert.equal((await request(`/platform/market/stores/${a.id}/decision`, { method: "PUT", token: ownerToken, body: { decision: "delist", note: "ليس معروضاً أصلاً" } })).status, 409, "cannot delist what is not listed");

  for (const store of [a, b, c]) {
    assert.equal((await request(`${store.path}/listing`, { method: "POST", token: store.token })).status, 200);
    const listed = await request(`/platform/market/stores/${store.id}/decision`, { method: "PUT", token: ownerToken, body: { decision: "list" } });
    assert.equal(listed.status, 200, JSON.stringify(listed.payload));
  }
  summary.ownerDecisions = true;

  // ── 4. the reputation job ────────────────────────────────────────────────
  const minute = 60_000;
  const t0 = Date.now() - 2 * 86_400_000;
  async function order(store, n, status, replyMinutes) {
    const createdAt = new Date(t0 + n * minute * 30);
    const row = await prisma.storeOrder.create({ data: { storeId: store.id, orderNumber: `${testId}-${store.slug}-${n}`, status, source: "storefront", customerName: "زبون", paymentMethodCode: "cod", subtotalIqd: 1000, deliveryFeeIqd: 0, totalIqd: 1000, createdAt } });
    if (replyMinutes !== null) {
      await prisma.orderStatusEvent.create({ data: { storeId: store.id, orderId: row.id, fromStatus: "new", toStatus: status === "completed" ? "processing" : status, actorKind: "merchant", createdAt: new Date(createdAt.getTime() + replyMinutes * minute) } });
    }
  }
  for (let n = 0; n < 12; n += 1) await order(b, n, "completed", 3);                       // b: fast, never cancels
  for (let n = 0; n < 8; n += 1) await order(c, n, n < 4 ? "cancelled" : "completed", 90); // c: slow, half cancelled
  const recompute = await request("/platform/market/metrics/recompute", { method: "POST", token: ownerToken });
  assert.equal(recompute.status, 200);
  assert.ok(recompute.payload.stores >= 3);
  const metricsB = await prisma.storeMarketMetrics.findUniqueOrThrow({ where: { storeId: b.id } });
  const metricsC = await prisma.storeMarketMetrics.findUniqueOrThrow({ where: { storeId: c.id } });
  assert.equal(metricsB.medianResponseMinutes, 3);
  assert.equal(Number(metricsB.cancelRate), 0);
  assert.equal(Number(metricsC.cancelRate), 0.5);
  assert.ok(Number(metricsB.score) > Number(metricsC.score), "the fast, reliable store scores higher");
  assert.ok(metricsB.badges.some((badge) => badge.code === "fast_response" && badge.level === "platinum"));
  assert.ok(metricsB.badges.some((badge) => badge.code === "low_cancellation"));
  assert.ok(!metricsC.badges.some((badge) => badge.code === "low_cancellation"));
  assert.equal(metricsB.inStockRate.toString(), "1");
  summary.reputation = { b: Number(metricsB.score), c: Number(metricsC.score) };

  // ── 3. the directory ─────────────────────────────────────────────────────
  const all = await request(`/market/stores?q=${encodeURIComponent(testId)}&limit=50`);
  assert.equal(all.status, 200, JSON.stringify(all.payload));
  assert.match(all.headers.get("cache-control") ?? "", /public, max-age=60/);
  assert.deepEqual(ours(all.payload.stores, slugs).sort(), [...slugs].sort(), "the three listed stores are in the market");
  const cardB = all.payload.stores.find((store) => store.slug === b.slug);
  assert.equal(cardB.governorate.name, "البصرة");
  assert.equal(cardB.district.name, "العشار");
  assert.ok(cardB.marks.includes("new_store"));
  assert.equal(cardB.logoUrl.startsWith(`/api/store/${b.slug}/logo?v=`), true);

  const bySort = async (sort, extra = "") => ours((await request(`/market/stores?sort=${sort}&q=${encodeURIComponent(testId)}${extra}`)).payload.stores, slugs);
  assert.equal((await bySort("recommended"))[0], b.slug, "the best score leads «recommended»");
  assert.deepEqual((await bySort("response")).slice(0, 2), [b.slug, c.slug], "fastest response first; a store with no replies last");
  assert.equal((await bySort("sales"))[0], b.slug);
  assert.deepEqual(await bySort("recommended", "&governorate=Basra"), [b.slug], "governorate filter");
  assert.deepEqual((await bySort("recommended", `&district=${kadhimiya.id}`)).sort(), [a.slug, c.slug].sort(), "district filter");
  const nearBasra = await request(`/market/stores?sort=nearest&lat=30.5&lng=47.8&q=${encodeURIComponent(testId)}`);
  assert.equal(nearBasra.status, 200, JSON.stringify(nearBasra.payload));
  assert.equal(ours(nearBasra.payload.stores, slugs)[0], b.slug, "nearest to Basra is the Basra store");
  assert.ok(nearBasra.payload.stores.find((store) => store.slug === b.slug).distanceKm < 5);
  assert.equal((await request("/market/stores?sort=nearest")).status, 422, "«nearest» without a position is refused");
  assert.equal((await request("/market/stores?lat=30")).status, 422, "half a position is refused");

  // Keyset paging: one store per page, three pages, no repeats, then null.
  const seenSlugs = [];
  let cursor = null;
  for (let pageNo = 0; pageNo < 10; pageNo += 1) {
    const page = await request(`/market/stores?sort=views&limit=1&q=${encodeURIComponent(testId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(page.status, 200, JSON.stringify(page.payload));
    seenSlugs.push(...page.payload.stores.map((store) => store.slug));
    cursor = page.payload.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual([...seenSlugs].sort(), [...slugs].sort(), "paging visits every store exactly once");
  const firstPage = await request(`/market/stores?sort=views&limit=1&q=${encodeURIComponent(testId)}`);
  const crossed = await request(`/market/stores?sort=rating&cursor=${encodeURIComponent(firstPage.payload.nextCursor)}`);
  assert.equal(crossed.status, 400, "a «views» cursor is refused by «rating»");

  // Boost lifts a store to the top of «recommended» while it lasts.
  const until = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await request(`/platform/market/stores/${c.id}/flags`, { method: "PUT", token: ownerToken, body: { boostedUntil: until, isBrand: true } })).status, 200);
  assert.equal((await bySort("recommended"))[0], c.slug, "boosted first");
  assert.deepEqual(await bySort("recommended", "&brand=1"), [c.slug], "brand filter");
  assert.equal((await request(`/platform/market/stores/${c.id}/flags`, { method: "PUT", token: ownerToken, body: { boostedUntil: null } })).status, 200);
  assert.equal((await bySort("recommended"))[0], b.slug, "and back when the boost ends");
  summary.directory = true;

  // ── 5. the store page ────────────────────────────────────────────────────
  await prisma.paymentMethod.upsert({ where: { storeId_code: { storeId: a.id, code: "cod" } }, create: { storeId: a.id, code: "cod", displayName: "الدفع عند الاستلام", isEnabled: true }, update: { isEnabled: true } });
  const page = await request(`/market/stores/${a.slug}`);
  assert.equal(page.status, 200, JSON.stringify(page.payload));
  assert.equal(page.payload.store.pickupEnabled, true);
  assert.equal(page.payload.hours.days.length, 7);
  assert.equal(typeof page.payload.hours.openNow, "boolean");
  assert.ok(page.payload.badges.length >= 10, "the whole badge catalog, earned or not");
  assert.ok(page.payload.paymentMethods.some((method) => method.code === "cod"));
  assert.equal(page.payload.reputation.score, null, "no completed orders: not scored yet");
  assert.equal(page.payload.store.storefrontPath, `/store/${a.slug}`);
  const reviews = await request(`/market/stores/${a.slug}/reviews`);
  assert.equal(reviews.status, 200);
  assert.deepEqual(reviews.payload.reviews, []);
  assert.equal(reviews.payload.nextCursor, null);
  assert.equal((await request(`/market/stores/${a.slug}/cover`)).status, 404, "no cover uploaded");
  const ranking = await request("/market/ranking");
  assert.equal(ranking.payload.criteria.reduce((sum, row) => sum + row.weight, 0), 100);

  // The merchant leaves: every public route forgets the store.
  const left = await request(`${a.path}/listing`, { method: "DELETE", token: a.token });
  assert.equal(left.status, 200);
  assert.equal(left.payload.listing.status, "unlisted");
  assert.equal((await request(`/market/stores/${a.slug}`)).status, 404);
  assert.ok(!ours((await request(`/market/stores?q=${encodeURIComponent(testId)}`)).payload.stores, slugs).includes(a.slug));
  // A suspended merchant's store vanishes too.
  await prisma.merchant.update({ where: { id: (await prisma.store.findUniqueOrThrow({ where: { id: b.id } })).merchantId }, data: { isActive: false } });
  assert.equal((await request(`/market/stores/${b.slug}`)).status, 404, "an inactive merchant's store is not in the market");
  summary.storePage = true;

  console.log(JSON.stringify({ suite: "market-stores", ok: true, summary }, null, 2));
} finally {
  if (created.length) await prisma.store.updateMany({ where: { id: { in: created } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}

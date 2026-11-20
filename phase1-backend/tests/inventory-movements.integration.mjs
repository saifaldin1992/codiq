/**
 * ق-176 — the stock movement log can be READ.
 *
 * `inventory_movements` had thirteen writers and one reader — a `count()` that
 * printed a number inside the delete-confirm sheet, beside a sentence promising
 * the merchant that «سجل حركة المخزون يُحفظ دائماً». It was kept. Nobody
 * could open it. This suite proves the door: newest first, the reason on every
 * row, the snapshot name and SKU, one product's history on request, the house
 * cursor across pages, and the tenant boundary.
 *
 * Run: pnpm inventory:movements
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `invmov-${Date.now()}`;
// Merchant phones are unique platform-wide; a fixed one collides with the previous run on a shared database.
const suffix = String(Date.now()).slice(-8);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
// The login and registration limiters are keyed by IP and stored in the database;
// inside one CI job every suite shares both, so a late suite inherits an
// exhausted budget. pg3 set the pattern: start with the limiter table empty.
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload };
}

const summary = {};
try {
  // ── two merchants, two stores, one product each ──────────────────────────
  const password = "InvMovPass123!";
  const registerA = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الحركة ألف", phone: `+96471${suffix}`, email: `${testId}.a@codiq.test`, password });
  const registerB = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الحركة باء", phone: `+96472${suffix}`, email: `${testId}.b@codiq.test`, password });
  assert.equal(registerA.status, 201, JSON.stringify(registerA.payload));
  assert.equal(registerB.status, 201, JSON.stringify(registerB.payload));
  const storeA = await prisma.store.create({ data: { merchantId: registerA.payload.account.id, name: "متجر الحركة ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: registerB.payload.account.id, name: "متجر الحركة باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password } });
  assert.equal(loginA.status, 200, JSON.stringify(loginA.payload));
  assert.equal(loginB.status, 200, JSON.stringify(loginB.payload));
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;

  // Created through Prisma on purpose: no service runs, so no movement is
  // written, and the log starts EMPTY. Every row below is one this suite made.
  const shirt = await prisma.product.create({ data: { storeId: storeA.id, sku: "INV-SHIRT", name: "قميص الجرد", priceIqd: 15000, stockQuantity: 5, lowStockThreshold: 0 } });
  const cap = await prisma.product.create({ data: { storeId: storeA.id, sku: "INV-CAP", name: "قبعة الجرد", priceIqd: 5000, stockQuantity: 2, lowStockThreshold: 0 } });
  await prisma.product.create({ data: { storeId: storeB.id, sku: "INV-B", name: "منتج باء", priceIqd: 1000, stockQuantity: 1, lowStockThreshold: 0 } });

  const path = (slug, query = "") => `/merchant/stores/${slug}/inventory/movements${query}`;

  const empty = await request(path(storeA.slug), { token: tokenA });
  assert.equal(empty.status, 200, JSON.stringify(empty.payload));
  assert.deepEqual(empty.payload.movements, [], "ق-176: a product created outside the services has no movement yet");
  assert.equal(empty.payload.nextCursor, null);
  assert.equal(empty.payload.storeSlug, storeA.slug, "the envelope says which store it is a list of");

  // ── three reasoned adjustments, on two products ──────────────────────────
  const adjust = (productId, stockQuantity, reason) =>
    request(`/merchant/stores/${storeA.slug}/catalog/products/${productId}/inventory`, { method: "POST", token: tokenA, body: { stockQuantity, reason } });
  assert.equal((await adjust(shirt.id, 8, "وصلت شحنة")).status, 200);
  assert.equal((await adjust(cap.id, 0, "بيعت الأخيرة نقداً")).status, 200);
  assert.equal((await adjust(shirt.id, 6, "قطعتان تالفتان عند الجرد")).status, 200);

  // ── newest first, with the why and the snapshot ──────────────────────────
  const all = await request(path(storeA.slug), { token: tokenA });
  assert.equal(all.status, 200);
  assert.equal(all.payload.movements.length, 3);
  const [latest, middle, first] = all.payload.movements;
  assert.equal(latest.delta, -2, "ق-176: the last adjustment is the first row");
  assert.equal(latest.reason, "قطعتان تالفتان عند الجرد", "ق-176: the reason a merchant typed is the reason he reads back");
  assert.equal(latest.productName, "قميص الجرد", "ق-176: the snapshot name rides the row");
  assert.equal(latest.productSku, "INV-SHIRT", "ق-176: …and the snapshot SKU");
  assert.equal(middle.delta, -2);
  assert.equal(middle.productName, "قبعة الجرد");
  assert.equal(first.delta, 3);
  assert.equal(first.reason, "وصلت شحنة");
  for (const row of all.payload.movements) {
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.createdAt, "string");
    assert.ok(!("storeId" in row), "the store is the envelope's, not every row's");
  }
  summary.newestFirst = all.payload.movements.map((row) => `${row.productSku} ${row.delta > 0 ? "+" : ""}${row.delta}`);

  // ── one product's own history ────────────────────────────────────────────
  const shirtOnly = await request(path(storeA.slug, `?productId=${shirt.id}`), { token: tokenA });
  assert.equal(shirtOnly.status, 200);
  assert.deepEqual(shirtOnly.payload.movements.map((row) => row.delta), [-2, 3], "ق-176: «لماذا نقص هذا؟» — one product, its own rows, newest first");
  const nobody = await request(path(storeA.slug, "?productId=00000000-0000-4000-8000-000000000000"), { token: tokenA });
  assert.equal(nobody.status, 200);
  assert.deepEqual(nobody.payload.movements, [], "an unknown product filter is an empty list, not an error");

  // ── the house cursor, across the narrowing ───────────────────────────────
  const page1 = await request(path(storeA.slug, "?limit=2"), { token: tokenA });
  assert.equal(page1.status, 200);
  assert.equal(page1.payload.movements.length, 2);
  assert.ok(page1.payload.nextCursor, "a page that does not fit offers page 2");
  const page2 = await request(path(storeA.slug, `?limit=2&cursor=${encodeURIComponent(page1.payload.nextCursor)}`), { token: tokenA });
  assert.equal(page2.status, 200);
  assert.equal(page2.payload.movements.length, 1);
  assert.equal(page2.payload.movements[0].id, first.id, "page 2 begins exactly where page 1 ended");
  assert.equal(page2.payload.nextCursor, null);
  const ids = [...page1.payload.movements, ...page2.payload.movements].map((row) => row.id);
  assert.deepEqual(ids, all.payload.movements.map((row) => row.id), "walking the pages sees every row once");
  // A cursor minted on the unfiltered page stays valid when the merchant then
  // narrows to one product: the keyset is on time, not on position (ع-3).
  const narrowed = await request(path(storeA.slug, `?limit=2&productId=${shirt.id}&cursor=${encodeURIComponent(page1.payload.nextCursor)}`), { token: tokenA });
  assert.equal(narrowed.status, 200);
  assert.deepEqual(narrowed.payload.movements.map((row) => row.id), [first.id], "the cursor survives the narrowing");
  assert.equal((await request(path(storeA.slug, "?limit=0"), { token: tokenA })).status, 400, "limit is validated once, in one code");
  assert.equal((await request(path(storeA.slug, "?cursor=not-a-cursor"), { token: tokenA })).status, 400, "…and so is the cursor");
  summary.cursor = "keyset (createdAt, id); survives a productId narrowing";

  // ── the boundary ─────────────────────────────────────────────────────────
  assert.equal((await request(path(storeA.slug))).status, 401, "reading the log needs a session");
  const crossTenant = await request(path(storeA.slug), { token: tokenB });
  assert.equal(crossTenant.status, 403, `a merchant cannot read another store's log — ${JSON.stringify(crossTenant.payload)}`);
  const ownB = await request(path(storeB.slug), { token: tokenB });
  assert.equal(ownB.status, 200);
  assert.deepEqual(ownB.payload.movements, [], "…and his own is untouched by A's adjustments");
  summary.boundary = { anonymous: 401, crossTenant: 403 };

  // ── the promise in the delete sheet is now true ──────────────────────────
  // «سجل حركة المخزون يُحفظ دائماً»: purge the product, the rows stay legible.
  await prisma.product.delete({ where: { id: cap.id } });
  const afterPurge = await request(path(storeA.slug), { token: tokenA });
  assert.equal(afterPurge.status, 200);
  const orphan = afterPurge.payload.movements.find((row) => row.productSku === "INV-CAP");
  assert.ok(orphan, "ق-176: the movement outlives the product");
  assert.equal(orphan.productId, null, "…with its foreign key nulled");
  assert.equal(orphan.productName, "قبعة الجرد", "…and its snapshot name intact");
  summary.survivesPurge = true;

  console.log(JSON.stringify({ suite: "inventory-movements", status: "passed", summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
}

/**
 * Regression suite for the 2026-11 SaaS review fixes. Each block fails on the
 * code before its fix.
 *
 *   1. Audit 16-ب — re-activating a suspended staff member spends `max_staff`.
 *   2. Audit 14-أ — the merchant-wide wallet is not served to store staff.
 *   3. SCALE      — the visit counter batches in memory and flushes correctly,
 *                   including the live-product filter for views.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
// Batching ON for this suite: block 3 proves nothing is written until a flush.
process.env.CODIQ_VISIT_FLUSH_MS = "600000";

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const { baghdadDay, recordVisit, flushVisits } = await import("../src/services/store-traffic.service.ts");

const testId = `rvw-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload };
}

const summary = {};
try {
  const merchant = await registerMerchantDirect({ ownerName: "مراجعة", businessName: "متجر المراجعة", phone: `+96475${suffix}`, email: `${testId}@codiq.test`, password: "ReviewMerchant!2026" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const merchantId = merchant.payload.account.id;
  const store = await prisma.store.create({ data: { merchantId, name: "متجر المراجعة", slug: `${testId}-s`, defaultSubdomain: `${testId}-s` } });
  const token = await createTypedSession("merchant", merchantId, store.id);

  // A plan with exactly one seat.
  const plan = await prisma.plan.create({ data: { code: `${testId}-one-seat`, name: "مقعد واحد", features: { createMany: { data: [
    { featureCode: "max_stores", limitValue: 5 },
    { featureCode: "max_products", limitValue: 5 },
    { featureCode: "max_staff", limitValue: 1 },
    { featureCode: "max_monthly_orders", limitValue: 100 },
    { featureCode: "max_image_storage_mb", limitValue: 10 },
  ] } } } });
  await prisma.merchantSubscription.updateMany({ where: { merchantId, status: "active" }, data: { status: "cancelled", endsAt: new Date() } });
  await prisma.merchantSubscription.create({ data: { merchantId, planId: plan.id, status: "active" } });

  // ── 1. reactivation is plan-gated ─────────────────────────────────────────
  const team = `/merchant/stores/${store.slug}/team`;
  const first = await call(team, { method: "POST", token, body: { email: `${testId}.a@codiq.test`, displayName: "موظف أ", temporaryPassword: "review-staff-pass-a", roleCode: "store_staff" } });
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  const firstMembershipId = first.payload.membership.id;
  const suspend = await call(`${team}/${firstMembershipId}`, { method: "PATCH", token, body: { isActive: false } });
  assert.equal(suspend.status, 200, JSON.stringify(suspend.payload));
  const second = await call(team, { method: "POST", token, body: { email: `${testId}.b@codiq.test`, displayName: "موظف ب", temporaryPassword: "review-staff-pass-b", roleCode: "store_staff" } });
  assert.equal(second.status, 201, "the seat freed by the suspension is reusable");
  const reactivate = await call(`${team}/${firstMembershipId}`, { method: "PATCH", token, body: { isActive: true } });
  assert.equal(reactivate.status, 403, `16-ب: reactivating past max_staff must be refused — ${JSON.stringify(reactivate.payload)}`);
  assert.equal(reactivate.payload.error.code, "PLAN_LIMIT_EXCEEDED");
  const stillSuspended = await prisma.storeStaffMembership.findUniqueOrThrow({ where: { id: firstMembershipId } });
  assert.equal(stillSuspended.isActive, false, "…and the refusal rolled the write back");
  summary.reactivationGated = 403;

  // ── 2. the wallet is the merchant's only ──────────────────────────────────
  const secondMembership = await prisma.storeStaffMembership.findUniqueOrThrow({ where: { id: second.payload.membership.id }, select: { id: true, staffId: true } });
  const staffToken = await createTypedSession("staff", secondMembership.staffId, store.id, secondMembership.id);
  const staffHome = await call(`/merchant/stores/${store.slug}/dashboard/home`, { token: staffToken });
  assert.equal(staffHome.status, 200, JSON.stringify(staffHome.payload));
  assert.equal(staffHome.payload.home.wallet, null, "14-أ: a store_staff member holding orders.view must not read the merchant-wide balance");
  const merchantHome = await call(`/merchant/stores/${store.slug}/dashboard/home`, { token });
  assert.equal(merchantHome.status, 200);
  assert.equal(typeof merchantHome.payload.home.wallet?.pendingNetIqd, "number", "the merchant still sees his balance");
  summary.walletHiddenFromStaff = true;

  // ── 3. batched visit counter ──────────────────────────────────────────────
  const live = await prisma.product.create({ data: { storeId: store.id, sku: "RV-1", name: "حيّ", priceIqd: 1000, stockQuantity: 1 } });
  const off = await prisma.product.create({ data: { storeId: store.id, sku: "RV-2", name: "متوقّف", priceIqd: 1000, stockQuantity: 1, isActive: false } });
  const day = baghdadDay();
  for (let i = 0; i < 40; i += 1) await recordVisit(store.id, { day, newVisitor: i < 3, productId: i % 2 ? live.id : off.id });
  await recordVisit(store.id, { day, newVisitor: false, productId: "not-a-uuid" });
  const before = await prisma.$queryRawUnsafe(`SELECT visits FROM store_visits_daily WHERE store_id = '${store.id}'`);
  assert.equal(before.length, 0, "nothing is written per page view while batching");
  await flushVisits();
  const [row] = await prisma.$queryRawUnsafe(`SELECT visits, visitors FROM store_visits_daily WHERE store_id = '${store.id}' AND day = '${day}'::date`);
  assert.deepEqual({ visits: Number(row.visits), visitors: Number(row.visitors) }, { visits: 41, visitors: 3 }, "41 views from 3 visitors in ONE upsert");
  const views = await prisma.$queryRawUnsafe(`SELECT product_id, views FROM product_views_daily WHERE store_id = '${store.id}'`);
  assert.deepEqual(views.map((v) => [v.product_id, Number(v.views)]), [[live.id, 20]], "only the live product's views are kept");
  await recordVisit(store.id, { day, newVisitor: false });
  await flushVisits();
  const [again] = await prisma.$queryRawUnsafe(`SELECT visits FROM store_visits_daily WHERE store_id = '${store.id}' AND day = '${day}'::date`);
  assert.equal(Number(again.visits), 42, "a second flush adds onto the row, it does not overwrite it");
  summary.batchedVisits = { visits: 42, liveViews: 20 };

  console.log(JSON.stringify({ suite: "review-fixes", ok: true, summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
}

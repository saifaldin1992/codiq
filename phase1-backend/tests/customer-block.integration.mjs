/**
 * ق-179 — the merchant can block a shopper, and the block is a fact the log keeps.
 *
 * `Customer.isActive` was enforced at the door from day one — login refused,
 * account routes refused — and nothing in the platform could set it to false.
 * The classic cash-on-delivery loss in Iraq is the shopper who orders and does
 * not open the door; the column to stop him existed, the switch did not.
 *
 * Run: pnpm customer:block
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `cblock-${Date.now()}`;
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
  const password = "CBlockPass123!";
  const registerA = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الحظر ألف", phone: `+96471${suffix}`, email: `${testId}.a@codiq.test`, password });
  const registerB = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الحظر باء", phone: `+96472${suffix}`, email: `${testId}.b@codiq.test`, password });
  assert.equal(registerA.status, 201, JSON.stringify(registerA.payload));
  assert.equal(registerB.status, 201, JSON.stringify(registerB.payload));
  const storeA = await prisma.store.create({ data: { merchantId: registerA.payload.account.id, name: "متجر الحظر ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: registerB.payload.account.id, name: "متجر الحظر باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  const tokenA = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password } })).payload.accessToken;
  const tokenB = (await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password } })).payload.accessToken;
  assert.ok(tokenA && tokenB, "both merchants signed in");

  // ── a shopper with an account on store A ─────────────────────────────────
  const phone = "+9647700000771";
  const shopperPassword = "ShopperPass123!";
  const registered = await request(`/store/${storeA.slug}/account/register`, { method: "POST", body: { phone, password: shopperPassword, fullName: "زبون لا يفتح الباب" } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const shopperToken = registered.payload.accessToken;
  const customerId = registered.payload.account.id;
  assert.equal((await request(`/store/${storeA.slug}/account`, { token: shopperToken })).status, 200, "precondition: the shopper reads his own account");

  const customersPath = `/merchant/stores/${storeA.slug}/customers`;
  const before = await request(customersPath, { token: tokenA });
  assert.equal(before.status, 200);
  assert.equal(before.payload.customers.find((row) => row.id === customerId)?.isActive, true, "ق-179: the directory says whether a shopper may still buy");

  // ── the block ────────────────────────────────────────────────────────────
  const blocked = await request(`${customersPath}/${customerId}`, { method: "PATCH", token: tokenA, body: { isActive: false, reason: "رفض الاستلام ثلاث مرات" } });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.customer.isActive, false);
  assert.equal(blocked.payload.customer.id, customerId);

  // …and its three consequences, none of which needed new code:
  assert.equal((await request(`/store/${storeA.slug}/account`, { token: shopperToken })).status, 403, "ق-179: the open session is refused at once — the door, not the login, is the boundary");
  const relogin = await request(`/store/${storeA.slug}/account/login`, { method: "POST", body: { phone, password: shopperPassword } });
  assert.equal(relogin.status, 401, "ق-179: a blocked shopper cannot sign back in");
  assert.equal(relogin.payload.error.code, "INVALID_CUSTOMER_CREDENTIALS", "…and is told nothing more than a wrong password would be told (19-د: constant work, no disclosure)");
  const after = await request(customersPath, { token: tokenA });
  assert.equal(after.payload.customers.find((row) => row.id === customerId)?.isActive, false, "ق-179: the directory shows the block");
  summary.block = { session: 403, login: 401, directory: "isActive:false" };

  // ── the block is a fact the log keeps: who, whom, why ────────────────────
  const events = await request(`/merchant/stores/${storeA.slug}/audit-events?limit=10`, { token: tokenA });
  assert.equal(events.status, 200, JSON.stringify(events.payload));
  const event = events.payload.events.find((row) => row.action === "customer.blocked" && row.entityId === customerId);
  assert.ok(event, "ق-179: blocking a shopper is an audit event, not a silent column flip");
  assert.equal(event.entityType, "customer");
  assert.equal(event.entityLabel, "زبون لا يفتح الباب");
  assert.equal(event.actorKind, "merchant");
  summary.audit = "customer.blocked recorded with the reason";

  // ── the unblock ──────────────────────────────────────────────────────────
  const unblocked = await request(`${customersPath}/${customerId}`, { method: "PATCH", token: tokenA, body: { isActive: true } });
  assert.equal(unblocked.status, 200, JSON.stringify(unblocked.payload));
  assert.equal(unblocked.payload.customer.isActive, true);
  const backIn = await request(`/store/${storeA.slug}/account/login`, { method: "POST", body: { phone, password: shopperPassword } });
  assert.equal(backIn.status, 200, "ق-179: lifting the block lets him back in");
  const unblockEvent = (await request(`/merchant/stores/${storeA.slug}/audit-events?limit=10`, { token: tokenA })).payload.events.find((row) => row.action === "customer.unblocked" && row.entityId === customerId);
  assert.ok(unblockEvent, "…and that is logged too");

  // ── the walls ────────────────────────────────────────────────────────────
  assert.equal((await request(`${customersPath}/${customerId}`, { method: "PATCH", token: tokenB, body: { isActive: false } })).status, 403, "another merchant cannot block A's shopper");
  assert.equal((await request(`/merchant/stores/${storeB.slug}/customers/${customerId}`, { method: "PATCH", token: tokenB, body: { isActive: false } })).status, 404, "…nor reach him through his own store's path");
  assert.equal((await request(`${customersPath}/00000000-0000-4000-8000-000000000000`, { method: "PATCH", token: tokenA, body: { isActive: false } })).status, 404, "an unknown shopper is 404");
  assert.equal((await request(`${customersPath}/${customerId}`, { method: "PATCH", token: tokenA, body: { isActive: "no" } })).status, 422, "isActive must be a boolean");
  assert.equal((await request(`${customersPath}/${customerId}`, { method: "PATCH", body: { isActive: false } })).status, 401, "needs a session");

  // A store employee without settings.manage cannot block — the act is policy,
  // not day-to-day, so it rides the same code as the store's other rules.
  const staff = await request(`/merchant/stores/${storeA.slug}/team`, { method: "POST", token: tokenA, body: { email: `${testId}.staff@codiq.test`, displayName: "موظف الحظر", temporaryPassword: "cblock-staff-temp-pass", roleCode: "store_staff" } });
  assert.equal(staff.status, 201, JSON.stringify(staff.payload));
  const staffToken = (await request(`/auth/staff/stores/${storeA.slug}/login`, { method: "POST", body: { email: `${testId}.staff@codiq.test`, password: "cblock-staff-temp-pass" } })).payload.accessToken;
  assert.ok(staffToken, "the employee signed in");
  assert.equal((await request(`${customersPath}/${customerId}`, { method: "PATCH", token: staffToken, body: { isActive: false } })).status, 403, "ق-179: store_staff holds no settings.manage and cannot block");
  summary.walls = { crossTenant: 403, unknown: 404, invalid: 422, anonymous: 401, staffWithoutCode: 403 };

  console.log(JSON.stringify({ suite: "customer-block", status: "passed", summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
}

/**
 * ق-225 — stopping an approved merchant, proven end to end.
 *
 * Until this batch the platform's only leverage was the approval queue: approve
 * a pending registration, or reject one. An APPROVED merchant could not be
 * stopped from any screen or any route — `merchant.isActive` was written by
 * `decideMerchantApproval` and by nothing else — so the trust-and-safety answer
 * to a shop that takes cash-on-delivery orders and never delivers was a
 * hand-written UPDATE against production. The merchants directory said so in its
 * own footer.
 *
 * What this proves:
 *  1. suspension refuses the merchant at HIS OWN DOOR — the same 401 a wrong
 *     password gets, so a stolen account's holder is not told the platform
 *     noticed;
 *  2. every store vanishes from the storefront in the same transaction (404, not
 *     an empty shop);
 *  3. every live session dies with it — his AND his staff's — because a decision
 *     that waits for the next login is a decision delayed by up to eight hours
 *     (ق-192's lesson, from the other side);
 *  4. the MONEY IS UNTOUCHED: orders, ledger entries and the wallet balance the
 *     platform still owes him survive suspension exactly as they were;
 *  5. resuming restores all of it;
 *  6. the record: an append-only audit row per decision, carrying the reason —
 *     and a suspension with no reason is refused;
 *  7. the boundaries: a merchant cannot suspend himself or anyone else, a
 *     platform staff member without `merchants.manage` is refused, and a
 *     merchant whose registration is still pending is sent to the queue instead.
 *
 * Run: pnpm suspension:test
 */
import assert from "node:assert/strict";

process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "merchant-suspension-test-secret-only";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
// 19-ب makes the second factor mandatory for platform staff, so the boundary
// case below enrols one exactly as a person would — `ps1:test` owns the proof
// that the factor itself is enforced.
const { totpForCounter, base32Decode, currentStep } = await import("../src/auth/totp.ts");
const codeFor = (secret, step = currentStep()) => totpForCounter(base32Decode(secret), step);

await prisma.$executeRawUnsafe("TRUNCATE TABLE platform_audit_events, plan_upgrade_requests, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_staff_sessions, platform_staff, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: response.status, body };
}
function bearer(accessToken) { return { authorization: `Bearer ${accessToken}` }; }

const summary = { task: "merchant-suspension" };
const MERCHANT_PASSWORD = "SuspensionMerchant!2026";

try {
  // ── setup: an owner, an approved merchant with a store, and his staff member ──
  const ownerRegister = await request("/auth/platform/register", { method: "POST", body: JSON.stringify({ email: "owner.suspension@codiq.test", password: "OwnerSuspension!2026", displayName: "مالك الإيقاف" }) });
  assert.equal(ownerRegister.status, 201, JSON.stringify(ownerRegister.body));
  const ownerLogin = await request("/auth/platform/login", { method: "POST", body: JSON.stringify({ email: "owner.suspension@codiq.test", password: "OwnerSuspension!2026" }) });
  assert.equal(ownerLogin.status, 200);
  const tokenOwner = ownerLogin.body.accessToken;

  const provisioned = await request("/platform/merchants/manual", { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100811001", email: "merchant.suspension@codiq.test", temporaryPassword: MERCHANT_PASSWORD, businessName: "تاجر الإيقاف", firstStoreName: "متجر الإيقاف" }) });
  assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
  const merchantId = provisioned.body.merchant.id;
  const storeSlug = provisioned.body.store.slug;
  const storeId = provisioned.body.store.id;
  // ق-218: he replaces the provisioner's password before any merchant surface
  // opens. That gate is proven in `phase6:test`; here it is one call so the
  // suite can get to its own subject.
  const firstLogin = await request("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: "merchant.suspension@codiq.test", password: MERCHANT_PASSWORD }) });
  assert.equal(firstLogin.status, 200, JSON.stringify(firstLogin.body));
  assert.equal((await request("/auth/password", { method: "POST", headers: bearer(firstLogin.body.accessToken), body: JSON.stringify({ currentPassword: MERCHANT_PASSWORD, newPassword: `${MERCHANT_PASSWORD}-Owned` }) })).status, 200);
  const merchantPassword = `${MERCHANT_PASSWORD}-Owned`;

  const merchantLogin = await request("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: "merchant.suspension@codiq.test", password: merchantPassword }) });
  assert.equal(merchantLogin.status, 200, JSON.stringify(merchantLogin.body));
  const tokenMerchant = merchantLogin.body.accessToken;

  const staffCreated = await request(`/merchant/stores/${storeSlug}/team`, { method: "POST", headers: bearer(tokenMerchant), body: JSON.stringify({ email: "staff.suspension@codiq.test", displayName: "موظفة الإيقاف", temporaryPassword: "StaffSuspension!2026", roleCode: "store_staff" }) });
  assert.equal(staffCreated.status, 201, JSON.stringify(staffCreated.body));
  const staffLogin = await request(`/auth/staff/stores/${storeSlug}/login`, { method: "POST", body: JSON.stringify({ email: "staff.suspension@codiq.test", password: "StaffSuspension!2026" }) });
  assert.equal(staffLogin.status, 200, JSON.stringify(staffLogin.body));
  const tokenStaff = staffLogin.body.accessToken;

  // A completed order, so the money assertions below have something to protect.
  const product = await prisma.product.create({ data: { storeId, sku: "SUSPEND-1", name: "منتج الإيقاف", priceIqd: 15000, stockQuantity: 5, lowStockThreshold: 1 } });
  const order = await prisma.storeOrder.create({ data: { storeId, orderNumber: "SUSP-0001", customerName: "زبون الإيقاف", status: "new", totalIqd: 15000, subtotalIqd: 15000, items: { create: { productId: product.id, productName: product.name, quantity: 1, unitPriceIqd: 15000, lineTotalIqd: 15000 } } }, select: { id: true } });
  const ordersBefore = await prisma.storeOrder.count({ where: { storeId } });
  const ledgerBefore = await prisma.ledgerEntry.count();

  // The shop is open, and every door works.
  assert.equal((await request(`/store/${storeSlug}/products`)).status, 200, "the storefront is open before suspension");
  assert.equal((await request(`/merchant/stores/${storeSlug}/orders`, { headers: bearer(tokenMerchant) })).status, 200);
  assert.equal((await request(`/merchant/stores/${storeSlug}/orders`, { headers: bearer(tokenStaff) })).status, 200);
  summary.before = { storefront: 200, merchant: 200, staff: 200 };

  // ── 1. a suspension with no reason is refused ─────────────────────────────
  const noReason = await request(`/platform/merchants/${merchantId}/suspension`, { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ suspended: true }) });
  assert.equal(noReason.status, 422, JSON.stringify(noReason.body));
  assert.equal(noReason.body.error.code, "SUSPENSION_REASON_REQUIRED", "ق-225: «لماذا أُوقف هذا التاجر» is answered months later from the audit log, or not at all");
  assert.equal((await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { isActive: true } })).isActive, true, "the refused call changed nothing");

  // ── 2. the suspension itself ──────────────────────────────────────────────
  const suspended = await request(`/platform/merchants/${merchantId}/suspension`, { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ suspended: true, reason: "طلبات لا تصل الزبائن — بلاغان" }) });
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  assert.equal(suspended.body.suspension.changed, true);
  assert.equal(suspended.body.suspension.storesAffected, 1);
  assert.ok(suspended.body.suspension.sessionsRevoked.merchant >= 1, `his own session is revoked — ${JSON.stringify(suspended.body.suspension)}`);
  assert.ok(suspended.body.suspension.sessionsRevoked.staff >= 1, "…and his staff's, because a stopped shop must not keep selling through the people he hired");

  // His door answers like a wrong password, not like a stopped account.
  const loginAfter = await request("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: "merchant.suspension@codiq.test", password: merchantPassword }) });
  assert.equal(loginAfter.status, 401, JSON.stringify(loginAfter.body));
  assert.equal(loginAfter.body.error.code, "INVALID_MERCHANT_CREDENTIALS", "ق-225: a stolen account's holder is not told the platform noticed");
  // The session he already held is dead on its NEXT REQUEST, not in eight hours.
  // 401 rather than 403 on purpose: the token itself is revoked, so it is refused
  // by `verifyTypedSession` before any guard gets as far as reading whether the
  // merchant is active. Both answers would be correct; this is the stronger one.
  assert.equal((await request(`/merchant/stores/${storeSlug}/orders`, { headers: bearer(tokenMerchant) })).status, 401, "the live session is refused immediately — the token is revoked, not merely out-ranked");
  assert.equal((await request(`/merchant/stores/${storeSlug}/orders`, { headers: bearer(tokenStaff) })).status, 401, "…and so is his staff's");
  // ق-226: his own SHELL sees it too — the merchant dashboard's bootstrap probe
  // is refused, so the browser shows him the door instead of drawing a dashboard
  // whose every card would say «تعذر التحميل».
  const shellProbe = await request("/merchant/session", { headers: bearer(tokenMerchant) });
  assert.ok(shellProbe.status === 401 || shellProbe.status === 403, `ق-226: the shell probe refuses a suspended merchant — got ${shellProbe.status}`);

  // The shop is gone from the storefront — 404, not an empty shop.
  assert.equal((await request(`/store/${storeSlug}/products`)).status, 404, "ق-225: the storefront vanishes with the merchant");
  assert.equal((await request(`/store/${storeSlug}/public-config`)).status, 404);
  // …and the STORE ROWS themselves are off, which is a separate guarantee from
  // the one above: `resolveStorefrontStore` refuses on the merchant alone, but
  // HOST resolution (`storeForHost`, the subdomain and custom-domain door) reads
  // only `store.is_active`. Without the cascade a suspended merchant's own
  // domain would keep serving his shop, and the `/store/:slug` assertions above
  // would not have noticed.
  assert.equal(await prisma.store.count({ where: { merchantId, isActive: true } }), 0, "ق-225: every store row is off, so the host door closes with the platform door");
  summary.suspended = { login: 401, merchantSession: 403, staffSession: 403, storefront: 404 };

  // ── 3. the money is untouched ─────────────────────────────────────────────
  assert.equal(await prisma.storeOrder.count({ where: { storeId } }), ordersBefore, "ق-225: suspension is a gate on ACTING, never on the record");
  assert.equal(await prisma.ledgerEntry.count(), ledgerBefore, "…and the append-only ledger is not something a suspension may edit");
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status, "new", "the order the shop already took is exactly as it was");

  // ── 4. the record ─────────────────────────────────────────────────────────
  const suspendEvent = await prisma.platformAuditEvent.findFirstOrThrow({ where: { entityId: merchantId, action: "merchant_suspended" }, orderBy: { createdAt: "desc" } });
  assert.match(JSON.stringify(suspendEvent.metadata), /بلاغان/, "the reason rides the record — it is the only place anyone will look for it");

  // ── 5. idempotence: suspending a suspended merchant writes nothing ────────
  const auditRowsBefore = await prisma.platformAuditEvent.count({ where: { entityId: merchantId } });
  const again = await request(`/platform/merchants/${merchantId}/suspension`, { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ suspended: true, reason: "نفس السبب" }) });
  assert.equal(again.status, 200);
  assert.equal(again.body.suspension.changed, false, "already suspended: no rows written");
  assert.equal(await prisma.platformAuditEvent.count({ where: { entityId: merchantId } }), auditRowsBefore, "…and no audit noise");

  // ── 6. resuming restores all of it ────────────────────────────────────────
  const resumed = await request(`/platform/merchants/${merchantId}/suspension`, { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ suspended: false }) });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.suspension.changed, true);
  assert.equal((await request(`/store/${storeSlug}/products`)).status, 200, "the shop is open again");
  assert.equal(await prisma.store.count({ where: { merchantId, isActive: false } }), 0, "…and every store row is back on, so his own domain serves again too");
  const loginBack = await request("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: "merchant.suspension@codiq.test", password: merchantPassword }) });
  assert.equal(loginBack.status, 200, "…and so is his door");
  // …with a NEW session: the revoked one stays revoked, which is the point.
  assert.equal((await request(`/merchant/stores/${storeSlug}/orders`, { headers: bearer(tokenMerchant) })).status, 401, "ق-225: a revoked session is not resurrected by lifting the suspension");
  assert.equal((await request(`/merchant/stores/${storeSlug}/orders`, { headers: bearer(loginBack.body.accessToken) })).status, 200);
  await prisma.platformAuditEvent.findFirstOrThrow({ where: { entityId: merchantId, action: "merchant_resumed" } });
  summary.resumed = { storefront: 200, login: 200, oldSession: 401 };

  // ── 7. the boundaries ─────────────────────────────────────────────────────
  const byMerchant = await request(`/platform/merchants/${merchantId}/suspension`, { method: "POST", headers: bearer(loginBack.body.accessToken), body: JSON.stringify({ suspended: true, reason: "أوقف نفسي" }) });
  assert.equal(byMerchant.status, 403, JSON.stringify(byMerchant.body));
  assert.equal(byMerchant.body.error.code, "IDENTITY_BOUNDARY_DENIED", "a merchant is not on the platform surface at all");

  // A platform staff member whose role does not carry `merchants.manage`, and one
  // whose role does — the matrix decides, not the route's luck.
  const accountant = await request("/platform/staff/team", { method: "POST", headers: { ...bearer(tokenOwner), origin: base }, body: JSON.stringify({ email: "accountant.suspension@codiq.test", displayName: "محاسبة المنصة", temporaryPassword: "AccountantSuspend!2026", roleCode: "accountant" }) });
  assert.equal(accountant.status, 201, JSON.stringify(accountant.body));
  const accountantFirst = await request("/auth/platform/staff/login", { method: "POST", headers: { origin: base }, body: JSON.stringify({ email: "accountant.suspension@codiq.test", password: "AccountantSuspend!2026" }) });
  assert.equal(accountantFirst.status, 200, JSON.stringify(accountantFirst.body));
  const accountantBegin = await request("/platform/staff/security/totp/begin", { method: "POST", headers: { ...bearer(accountantFirst.body.accessToken), origin: base } });
  assert.equal(accountantBegin.status, 200, JSON.stringify(accountantBegin.body));
  assert.equal((await request("/platform/staff/security/totp/confirm", { method: "POST", headers: { ...bearer(accountantFirst.body.accessToken), origin: base }, body: JSON.stringify({ code: codeFor(accountantBegin.body.secret) }) })).status, 200);
  const byAccountant = await request(`/platform/merchants/${merchantId}/suspension`, { method: "POST", headers: { ...bearer(accountantFirst.body.accessToken), origin: base }, body: JSON.stringify({ suspended: true, reason: "خارج صلاحيتي" }) });
  assert.equal(byAccountant.status, 403, JSON.stringify(byAccountant.body));
  assert.equal(byAccountant.body.error.code, "PLATFORM_PERMISSION_DENIED", "…and a role without merchants.manage is refused by the matrix, not by luck");
  assert.equal((await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { isActive: true } })).isActive, true, "…and the shop he could not stop is still open");

  // A merchant still waiting in the approval queue belongs to the queue.
  const pendingMerchant = await prisma.merchant.create({ data: { email: "pending.suspension@codiq.test", passwordHash: "$2b$12$0000000000000000000000000000000000000000000000000000", businessName: "تاجر معلّق", approvalStatus: "pending", isActive: false }, select: { id: true } });
  const pendingSuspend = await request(`/platform/merchants/${pendingMerchant.id}/suspension`, { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ suspended: true, reason: "ما زال معلّقاً" }) });
  assert.equal(pendingSuspend.status, 409, JSON.stringify(pendingSuspend.body));
  assert.equal(pendingSuspend.body.error.code, "REGISTRATION_NOT_DECIDED", "two doors onto one decision is how the two disagree");
  const missing = await request("/platform/merchants/00000000-0000-4000-8000-000000000000/suspension", { method: "POST", headers: bearer(tokenOwner), body: JSON.stringify({ suspended: true, reason: "غير موجود" }) });
  assert.equal(missing.status, 404);
  summary.boundaries = { merchant: 403, accountantWithoutPermission: 403, pendingRegistration: 409, missing: 404 };

  console.log(JSON.stringify({ suite: "merchant-suspension", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}

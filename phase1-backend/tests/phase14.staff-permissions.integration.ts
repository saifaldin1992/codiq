/**
 * codiq phase 14 acceptance matrix — staff identity, permissions, navigation enforcement.
 * Gate coverage (owner instructions §4):
 *  - positive AND negative outcome for every one of the 11 permission codes
 *    (resolver level for all 11 × 4 dimensions, plus live API calls for every
 *    code that has an HTTP surface today — settings.manage has none yet),
 *  - real session expiry against the database row (created_at < expires_at < now),
 *  - staff with no membership in a completely different merchant's store,
 *  - direct-API navigation bypass refused by the server,
 *  - membership disable/role change cutting sessions immediately (D14-07),
 *  - order status events recording the true staff actor.
 */
import assert from "node:assert/strict";
import { ownStaffPassword } from "./helpers/own-staff-password.js";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { createServer } from "node:http";
import { Client } from "pg";
import { config } from "../src/config.js";
import { createTypedSession } from "../src/auth/identity.js";
import { PERMISSION_CODES, ROLE_PERMISSION_MATRIX, resolvePermissionSet, type PermissionCode } from "../src/auth/staff-permissions.js";
import { prisma } from "../src/db/prisma.js";
import { createApp } from "../src/http/app.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";
import { softDelete } from "../src/services/soft-delete/soft-delete.service.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";
import { assertNoEnumerationOracle } from "./helpers/login-timing.js";

const port = 3141;
const base = `http://127.0.0.1:${port}`;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const raw = await response.text();
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: response.status, body };
}

function bearer(accessToken: string) { return { authorization: `Bearer ${accessToken}` }; }

const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
if (process.env.DATABASE_URL !== testDatabaseUrl || process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl) {
  throw new Error("Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL.");
}

await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

const summary: Record<string, unknown> = { phase: 14 };
let orderCounter = 0;
let phoneCounter = 100;

try {
  // ---------- fixtures ----------
  const owner = await prisma.platformOwner.create({ data: { email: "owner.phase14@codiq.test", passwordHash: "unused", displayName: "Phase14 Owner" } });
  const merchantA = await prisma.merchant.create({ data: { email: "merchant.a.phase14@codiq.test", passwordHash: "unused", businessName: "تاجر المرحلة 14 A" } });
  const merchantB = await prisma.merchant.create({ data: { email: "merchant.b.phase14@codiq.test", passwordHash: "unused", businessName: "تاجر المرحلة 14 B" } });
  // Phase 16: staff creation is plan-gated; this suite provisions several memberships so merchant A runs on pro.
  const proPlan = await prisma.plan.findUniqueOrThrow({ where: { code: "pro" }, select: { id: true } });
  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  await prisma.merchantSubscription.createMany({ data: [{ merchantId: merchantA.id, planId: proPlan.id, status: "active" }, { merchantId: merchantB.id, planId: freePlan.id, status: "active" }] });
  const storeA1 = await createStoreFoundation({ merchantId: merchantA.id, name: "متجر 14 ألف أول", slug: "phase14-a-one", defaultSubdomain: "phase14-a-one" });
  const storeA2 = await createStoreFoundation({ merchantId: merchantA.id, name: "متجر 14 ألف ثان", slug: "phase14-a-two", defaultSubdomain: "phase14-a-two" });
  const storeB1 = await createStoreFoundation({ merchantId: merchantB.id, name: "متجر 14 باء", slug: "phase14-b-one", defaultSubdomain: "phase14-b-one" });
  const productA1 = await prisma.product.create({ data: { storeId: storeA1.id, sku: "P14-BASE", name: "منتج المرحلة 14", priceIqd: 2500, stockQuantity: 50, lowStockThreshold: 2 } });

  const tokenMerchantA1 = await createTypedSession("merchant", merchantA.id, storeA1.id);
  const tokenMerchantA2 = await createTypedSession("merchant", merchantA.id, storeA2.id);
  const tokenMerchantB1 = await createTypedSession("merchant", merchantB.id, storeB1.id);

  async function makeOrder(storeId: string) {
    orderCounter += 1;
    return prisma.storeOrder.create({ data: { storeId, orderNumber: `P14-${String(orderCounter).padStart(4, "0")}`, status: "new", customerName: "زبون المرحلة 14", totalIqd: 2500 } });
  }

  const teamUrl = (slug: string) => `/merchant/stores/${slug}/team`;

  // ---------- merchant creates the team (D14-05) ----------
  const managerCreated = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: "staff.manager.phase14@codiq.test", displayName: "مديرة المتجر", temporaryPassword: "manager-temp-password-14", roleCode: "store_manager" }) });
  assert.equal(managerCreated.status, 201, JSON.stringify(managerCreated.body));
  assert.equal(managerCreated.body.created, "staff");
  const basicCreated = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", displayName: "موظف المتجر", temporaryPassword: "basic-temp-password-14", roleCode: "store_staff" }) });
  assert.equal(basicCreated.status, 201);
  const lifecycleCreated = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: "staff.lifecycle.phase14@codiq.test", displayName: "موظف الدورة", temporaryPassword: "cycle-temp-password-14", roleCode: "store_staff" }) });
  assert.equal(lifecycleCreated.status, 201);
  for (const [email, password] of [["staff.manager.phase14@codiq.test", "manager-temp-password-14"], ["staff.basic.phase14@codiq.test", "basic-temp-password-14"], ["staff.lifecycle.phase14@codiq.test", "cycle-temp-password-14"]]) await ownStaffPassword(base, "phase14-a-one", email, password); // audit 14-ب
  const managerMembershipId: string = managerCreated.body.membership.id;
  const basicMembershipId: string = basicCreated.body.membership.id;
  const lifecycleMembershipId: string = lifecycleCreated.body.membership.id;
  const basicStaffId: string = basicCreated.body.membership.staff.id;

  // Weak temporary password is refused server-side.
  const weakPassword = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: "staff.weak.phase14@codiq.test", displayName: "ضعيف", temporaryPassword: "short", roleCode: "store_staff" }) });
  assert.equal(weakPassword.status, 400);
  assert.equal(weakPassword.body.error.code, "WEAK_PASSWORD");

  // ---------- staff login is independent and store-explicit (D14-06) ----------
  const managerLogin = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.manager.phase14@codiq.test", password: "manager-temp-password-14" }) });
  assert.equal(managerLogin.status, 200, JSON.stringify(managerLogin.body));
  assert.equal(managerLogin.body.redirectTo, "/staff/stores/phase14-a-one/dashboard");
  const basicLogin = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", password: "basic-temp-password-14" }) });
  assert.equal(basicLogin.status, 200);
  const lifecycleLogin = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.lifecycle.phase14@codiq.test", password: "cycle-temp-password-14" }) });
  assert.equal(lifecycleLogin.status, 200);
  const tokenManager: string = managerLogin.body.accessToken;
  const tokenBasic: string = basicLogin.body.accessToken;
  const tokenLifecycle: string = lifecycleLogin.body.accessToken;

  const wrongPassword = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", password: "definitely-wrong-password" }) });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error.code, "INVALID_STAFF_CREDENTIALS");
  const noMembershipLogin = await request("/auth/staff/stores/phase14-b-one/login", { method: "POST", body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", password: "basic-temp-password-14" }) });
  assert.equal(noMembershipLogin.status, 404);
  assert.equal(noMembershipLogin.body.error.code, "STAFF_STORE_CONTEXT_NOT_FOUND");
  // 19-د (ATTACK-SURFACE): the generic 401 above is only half a refusal while
  // the response TIME still separates «this address is a staff member here» from
  // «it is nobody». It measured 788 ms against 32 ms before the fix — a sweep of
  // candidate addresses at one request each, whose output feeds a password
  // guessing run. See helpers/login-timing.ts for why the band is a ratio.
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
  const staffDoorTiming = await assertNoEnumerationOracle("staff door", {
    known: () => request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", password: "wrong-on-purpose" }) }),
    unknown: () => request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "nobody.phase14@codiq.test", password: "wrong-on-purpose" }) }),
  });
  const unknownStaff = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "nobody.phase14@codiq.test", password: "wrong-on-purpose" }) });
  assert.equal(unknownStaff.status, 401, "the unknown-identity probe must be a 401 for the measurement to mean anything");
  assert.equal(unknownStaff.body.error.code, "INVALID_STAFF_CREDENTIALS");
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
  summary.enumerationOracle = staffDoorTiming;
  // Staff must not enter through the merchant login (independent identity, D14-01).
  const staffViaMerchantLogin = await request("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: "staff.basic.phase14@codiq.test", password: "basic-temp-password-14" }) });
  assert.equal(staffViaMerchantLogin.status, 401);

  // ---------- read-only session endpoint feeds the staff shell ----------
  const managerSession = await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenManager) });
  assert.equal(managerSession.status, 200);
  assert.deepEqual(managerSession.body.permissions, [...PERMISSION_CODES].sort());
  const basicSession = await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenBasic) });
  assert.deepEqual(basicSession.body.permissions, [...ROLE_PERMISSION_MATRIX.store_staff].sort());
  summary.sessionEndpoint = { manager: managerSession.body.permissions.length, storeStaff: basicSession.body.permissions.length };

  // ---------- resolver matrix: 11 codes × 4 dimensions, no sampling ----------
  let resolverChecks = 0;
  for (const code of PERMISSION_CODES) {
    const managerBase = resolvePermissionSet("store_manager", []);
    assert.equal(managerBase.has(code), true, `store_manager base must grant ${code}`);
    const staffBase = resolvePermissionSet("store_staff", []);
    assert.equal(staffBase.has(code), ROLE_PERMISSION_MATRIX.store_staff.includes(code), `store_staff base mismatch for ${code}`);
    const allowOverride = resolvePermissionSet("store_staff", [{ permissionCode: code, effect: "allow" }]);
    assert.equal(allowOverride.has(code), true, `allow override must grant ${code}`);
    const denyOverride = resolvePermissionSet("store_manager", [{ permissionCode: code, effect: "deny" }]);
    assert.equal(denyOverride.has(code), false, `deny override must remove ${code}`);
    resolverChecks += 4;
  }
  summary.resolverMatrix = { codes: PERMISSION_CODES.length, checks: resolverChecks };

  // ---------- live API matrix for every code with an HTTP surface ----------
  const catalogBase = "/merchant/stores/phase14-a-one/catalog";
  let actionCounter = 0;
  const apiActions: Record<Exclude<PermissionCode, "settings.manage">, (token: string) => Promise<{ status: number; body: any }>> = {
    "catalog.products.view": (token) => request(`${catalogBase}/products`, { headers: bearer(token) }),
    "catalog.products.create": (token) => { actionCounter += 1; return request(`${catalogBase}/products`, { method: "POST", headers: bearer(token), body: JSON.stringify({ sku: `P14-NEW-${actionCounter}`, name: `منتج ${actionCounter}`, priceIqd: 1000 }) }); },
    "catalog.products.update": (token) => { actionCounter += 1; return request(`${catalogBase}/products/${productA1.id}`, { method: "PATCH", headers: bearer(token), body: JSON.stringify({ name: `منتج معدل ${actionCounter}` }) }); },
    "catalog.products.delete": async (token) => {
      actionCounter += 1;
      const disposable = await prisma.product.create({ data: { storeId: storeA1.id, sku: `P14-DEL-${actionCounter}`, name: "منتج للحذف", priceIqd: 500 } });
      return request(`${catalogBase}/products/${disposable.id}`, { method: "DELETE", headers: bearer(token) });
    },
    "catalog.categories.manage": (token) => { actionCounter += 1; return request(`${catalogBase}/categories`, { method: "POST", headers: bearer(token), body: JSON.stringify({ name: `تصنيف ${actionCounter}` }) }); },
    "inventory.update": (token) => { actionCounter += 1; return request(`${catalogBase}/products/${productA1.id}/inventory`, { method: "POST", headers: bearer(token), body: JSON.stringify({ stockQuantity: 50 + actionCounter, reason: "phase14-matrix" }) }); },
    "orders.view": (token) => request("/merchant/stores/phase14-a-one/orders", { headers: bearer(token) }),
    "orders.update": async (token) => {
      const order = await makeOrder(storeA1.id);
      return request(`/merchant/stores/phase14-a-one/orders/${order.id}/status`, { method: "POST", headers: bearer(token), body: JSON.stringify({ toStatus: "processing", expectedVersion: 1 }) });
    },
    // D-64 (ق-244): the READ code opens the directory; the WRITE — creating a
    // customer by hand — has its own code now. It used to ride `customers.view`.
    "customers.view": (token) => request("/merchant/stores/phase14-a-one/customers", { headers: bearer(token) }),
    "customers.manage": (token) => { phoneCounter += 1; return request("/merchant/stores/phase14-a-one/customers/manual", { method: "POST", headers: bearer(token), body: JSON.stringify({ fullName: `عميل ${phoneCounter}`, email: `customer.p14.${phoneCounter}@codiq.test`, phone: `+96477000${phoneCounter}` }) }); },
    "team.manage": (token) => request(teamUrl("phase14-a-one"), { headers: bearer(token) }),
    // PG-2: the three new codes, all store_manager-only.
    "catalog.trash.view": (token) => request("/merchant/stores/phase14-a-one/trash", { headers: bearer(token) }),
    "catalog.trash.restore": async (token) => {
      actionCounter += 1;
      const disposable = await prisma.product.create({ data: { storeId: storeA1.id, sku: `P14-TRASH-${actionCounter}`, name: "منتج للاستعادة", priceIqd: 500 } });
      await softDelete("product", storeA1.id, disposable.id, { kind: "merchant", id: merchantA.id });
      return request(`/merchant/stores/phase14-a-one/trash/product/${disposable.id}/restore`, { method: "POST", headers: bearer(token), body: JSON.stringify({}) });
    },
    "catalog.audit.view": (token) => request("/merchant/stores/phase14-a-one/audit-events", { headers: bearer(token) }),
    // ق-132: the till. The probe is the device LIST because it is the one
    // read that pos.sell alone unlocks — pairing needs settings.manage and
    // would test the wrong code.
    "pos.sell": (token) => request("/merchant/stores/phase14-a-one/pos/devices", { headers: bearer(token) }),
  };
  const successStatus: Record<Exclude<PermissionCode, "settings.manage">, number> = {
    "catalog.products.view": 200,
    "catalog.products.create": 201,
    "catalog.products.update": 200,
    // PG-2: the delete answers 200 with { id, deletedAt, purgeAt } instead of 204.
    "catalog.products.delete": 200,
    "catalog.categories.manage": 201,
    "inventory.update": 200,
    "orders.view": 200,
    "orders.update": 200,
    "customers.view": 200,
    "customers.manage": 201,
    "team.manage": 200,
    "catalog.trash.view": 200,
    "catalog.trash.restore": 200,
    "catalog.audit.view": 200,
    "pos.sell": 200,
  };
  const endpointCodes = Object.keys(apiActions) as (keyof typeof apiActions)[];

  async function putOverrides(membershipId: string, overrides: { permissionCode: string; effect: "allow" | "deny" }[]) {
    const result = await request(`${teamUrl("phase14-a-one")}/${membershipId}/overrides`, { method: "PUT", headers: bearer(tokenMerchantA1), body: JSON.stringify({ overrides }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.membership;
  }

  const apiMatrix = { managerPositive: 0, staffPositive: 0, staffNegative: 0, allowOverridePositive: 0, denyOverrideNegative: 0 };
  for (const code of endpointCodes) {
    // store_manager: authorized outcome for every code.
    const managerResult = await apiActions[code](tokenManager);
    assert.equal(managerResult.status, successStatus[code], `manager ${code}: ${JSON.stringify(managerResult.body)}`);
    apiMatrix.managerPositive += 1;

    // store_staff role: matrix decides.
    const staffResult = await apiActions[code](tokenBasic);
    if (ROLE_PERMISSION_MATRIX.store_staff.includes(code)) {
      assert.equal(staffResult.status, successStatus[code], `store_staff ${code}: ${JSON.stringify(staffResult.body)}`);
      apiMatrix.staffPositive += 1;
    } else {
      assert.equal(staffResult.status, 403, `store_staff ${code} must be denied`);
      assert.equal(staffResult.body.error.code, "STAFF_PERMISSION_DENIED");
      apiMatrix.staffNegative += 1;

      // allow override grants exactly this code to the basic membership.
      await putOverrides(basicMembershipId, [{ permissionCode: code, effect: "allow" }]);
      const allowed = await apiActions[code](tokenBasic);
      assert.equal(allowed.status, successStatus[code], `allow override ${code}: ${JSON.stringify(allowed.body)}`);
      apiMatrix.allowOverridePositive += 1;
      await putOverrides(basicMembershipId, []);
    }

    // deny override removes the code even from a store_manager membership.
    await putOverrides(managerMembershipId, [{ permissionCode: code, effect: "deny" }]);
    const denied = await apiActions[code](tokenManager);
    assert.equal(denied.status, 403, `deny override ${code} must be denied`);
    assert.equal(denied.body.error.code, "STAFF_PERMISSION_DENIED");
    apiMatrix.denyOverrideNegative += 1;
    await putOverrides(managerMembershipId, []);
  }
  summary.apiMatrix = { ...apiMatrix, note: "settings.manage has no HTTP surface in phases 1-13; covered at resolver level above" };

  // Override churn bumped permission_version and stayed visible to team.manage readers.
  const teamAfterMatrix = await request(teamUrl("phase14-a-one"), { headers: bearer(tokenMerchantA1) });
  const managerRow = teamAfterMatrix.body.team.find((row: any) => row.id === managerMembershipId);
  assert.ok(managerRow.permissionVersion > 1, "override churn must increment permission_version");

  // ---------- order audit records the true actor ----------
  const merchantOrder = await makeOrder(storeA1.id);
  const merchantTransition = await request(`/merchant/stores/phase14-a-one/orders/${merchantOrder.id}/status`, { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ toStatus: "processing", expectedVersion: 1 }) });
  assert.equal(merchantTransition.status, 200);
  const staffOrder = await makeOrder(storeA1.id);
  const staffTransition = await request(`/merchant/stores/phase14-a-one/orders/${staffOrder.id}/status`, { method: "POST", headers: bearer(tokenBasic), body: JSON.stringify({ toStatus: "processing", expectedVersion: 1 }) });
  assert.equal(staffTransition.status, 200);
  const merchantEvent = await prisma.orderStatusEvent.findFirst({ where: { orderId: merchantOrder.id }, orderBy: { createdAt: "desc" } });
  assert.equal(merchantEvent?.actorKind, "merchant");
  assert.equal(merchantEvent?.actorId, merchantA.id);
  const staffEvent = await prisma.orderStatusEvent.findFirst({ where: { orderId: staffOrder.id }, orderBy: { createdAt: "desc" } });
  assert.equal(staffEvent?.actorKind, "staff");
  assert.equal(staffEvent?.actorId, basicStaffId);
  const staffOrderRow = await prisma.storeOrder.findUnique({ where: { id: staffOrder.id }, select: { updatedByKind: true } });
  assert.equal(staffOrderRow?.updatedByKind, "staff");
  const historyThroughApi = await request(`/merchant/stores/phase14-a-one/orders/${staffOrder.id}/history`, { headers: bearer(tokenBasic) });
  assert.equal(historyThroughApi.status, 200);
  assert.equal(historyThroughApi.body.events.at(-1).actorKind, "staff");
  summary.orderAudit = { merchantActor: merchantEvent?.actorKind, staffActor: staffEvent?.actorKind, updatedByKind: staffOrderRow?.updatedByKind };

  // ---------- tenancy and identity boundaries ----------
  const crossStore = await request("/merchant/stores/phase14-a-two/orders", { headers: bearer(tokenBasic) });
  assert.equal(crossStore.status, 403);
  assert.equal(crossStore.body.error.code, "STORE_BOUNDARY_DENIED");
  const crossMerchant = await request("/merchant/stores/phase14-b-one/orders", { headers: bearer(tokenBasic) });
  assert.equal(crossMerchant.status, 403);
  assert.equal(crossMerchant.body.error.code, "STORE_BOUNDARY_DENIED");
  const staffOnMerchantArea = await request("/merchant/stores", { headers: bearer(tokenBasic) });
  assert.equal(staffOnMerchantArea.status, 403);
  assert.equal(staffOnMerchantArea.body.error.code, "IDENTITY_BOUNDARY_DENIED");
  const staffOnSwitch = await request("/merchant/stores/switch", { method: "POST", headers: bearer(tokenBasic), body: JSON.stringify({ storeSlug: "phase14-a-two" }) });
  assert.equal(staffOnSwitch.status, 403);
  const staffOnPlatform = await request("/platform/dashboard", { headers: bearer(tokenBasic) });
  assert.equal(staffOnPlatform.status, 403);
  const merchantOnStaffDashboard = await request("/staff/stores/phase14-a-one/dashboard", { headers: bearer(tokenMerchantA1) });
  assert.equal(merchantOnStaffDashboard.status, 403);
  assert.equal(merchantOnStaffDashboard.body.error.code, "IDENTITY_BOUNDARY_DENIED");
  const staffDashboardOk = await request("/staff/stores/phase14-a-one/dashboard", { headers: bearer(tokenBasic) });
  assert.equal(staffDashboardOk.status, 200);
  const foreignMerchantOnTeam = await request(teamUrl("phase14-a-one"), { headers: bearer(tokenMerchantB1) });
  assert.equal(foreignMerchantOnTeam.status, 403);
  assert.equal(foreignMerchantOnTeam.body.error.code, "STORE_BOUNDARY_DENIED");

  // Client-supplied storeId/membershipId/roleCode in the body never override the server context.
  const injectionAttempt = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: "staff.inject.phase14@codiq.test", displayName: "حقن السياق", temporaryPassword: "inject-temp-password-14", roleCode: "store_staff", storeId: storeB1.id, membershipId: "11111111-1111-1111-1111-111111111111" }) });
  assert.equal(injectionAttempt.status, 201);
  const injectedMembership = await prisma.storeStaffMembership.findFirst({ where: { staff: { email: "staff.inject.phase14@codiq.test" } }, select: { storeId: true } });
  assert.equal(injectedMembership?.storeId, storeA1.id);

  // ---------- D14-06 + ق-228: an existing identity is attached only when the
  // merchant SAYS he means it ----------
  //
  // Linking is legitimate — one person genuinely works in two shops. What this
  // route used to do is link SILENTLY: any merchant could type any address that
  // belongs to a store employee anywhere on the platform and that person became
  // his employee, in a role he chose, without knowing and without typing a
  // password. Whoever planted the address first won the identity.
  const silentLink = await request(teamUrl("phase14-a-two"), { method: "POST", headers: bearer(tokenMerchantA2), body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", roleCode: "store_manager" }) });
  assert.equal(silentLink.status, 409, JSON.stringify(silentLink.body));
  assert.equal(silentLink.body.error.code, "STAFF_EMAIL_ALREADY_REGISTERED", "ق-228: an existing identity is never attached without the merchant saying so");
  assert.equal(await prisma.storeStaffMembership.count({ where: { storeId: storeA2.id, staff: { email: "staff.basic.phase14@codiq.test" } } }), 0, "…and the refused call attached nobody");

  const secondMembership = await request(teamUrl("phase14-a-two"), { method: "POST", headers: bearer(tokenMerchantA2), body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", roleCode: "store_manager", linkExisting: true }) });
  assert.equal(secondMembership.status, 201, JSON.stringify(secondMembership.body));
  assert.equal(secondMembership.body.created, "membership");
  const duplicateMembership = await request(teamUrl("phase14-a-two"), { method: "POST", headers: bearer(tokenMerchantA2), body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", roleCode: "store_staff" }) });
  assert.equal(duplicateMembership.status, 409);
  const basicLoginA2 = await request("/auth/staff/stores/phase14-a-two/login", { method: "POST", body: JSON.stringify({ email: "staff.basic.phase14@codiq.test", password: "basic-temp-password-14" }) });
  assert.equal(basicLoginA2.status, 200);
  const tokenBasicA2: string = basicLoginA2.body.accessToken;
  const a2SessionOnA1 = await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenBasicA2) });
  assert.equal(a2SessionOnA1.status, 403, "an A2-bound staff session must not read A1");
  const a1TokenStillA1Only = await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenBasic) });
  assert.equal(a1TokenStillA1Only.status, 200);
  summary.multiMembership = { secondStoreMembership: secondMembership.status, duplicateRejected: duplicateMembership.status, sessionsStayStoreBound: true, silentLinkRefused: silentLink.status };

  // ---------- ق-227: the employee who leaves takes his address with him ----------
  //
  // A store removes a MEMBERSHIP and never the person — right, because he may
  // work in other shops. But a person NO shop employs was holding his email
  // hostage across all four identities: he could never become a merchant, never
  // be re-added anywhere, and a merchant who typed a STRANGER's address burned it
  // permanently for one free account and one API call. That is the hole ق-143
  // closed for platform staff; this proves it closed here.
  const leaverEmail = "staff.leaver.phase14@codiq.test";
  const leaverCreated = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: leaverEmail, displayName: "موظّف مغادر", temporaryPassword: "leaver-temp-password-14", roleCode: "store_staff" }) });
  assert.equal(leaverCreated.status, 201, JSON.stringify(leaverCreated.body));
  await ownStaffPassword(base, "phase14-a-one", leaverEmail, "leaver-temp-password-14"); // audit 14-ب
  const leaverMembershipId: string = leaverCreated.body.membership.id;
  const leaverStaffId: string = leaverCreated.body.membership.staff.id;
  // While he is employed the address is claimed, exactly as before.
  const merchantOnLiveStaffEmail = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100497055", email: leaverEmail, password: "merchant-conflict-pass-14b", businessName: "تسجيل على بريد موظّف حيّ" });
  assert.equal(merchantOnLiveStaffEmail.status, 409, "a LIVE employee's address is still his");

  const leaverRemoved = await request(`/merchant/stores/phase14-a-one/team/${leaverMembershipId}`, { method: "DELETE", headers: bearer(tokenMerchantA1) });
  assert.ok([200, 204].includes(leaverRemoved.status), `the membership is removed — ${leaverRemoved.status} ${JSON.stringify(leaverRemoved.body)}`);
  const leaverRow = await prisma.staff.findUniqueOrThrow({ where: { id: leaverStaffId }, select: { deletedAt: true } });
  assert.ok(leaverRow.deletedAt, "ق-227: his last membership gone, the identity is released");
  assert.equal(await prisma.staffSession.count({ where: { staffId: leaverStaffId, revokedAt: null } }), 0, "…and an account nobody employs is signed in nowhere");
  assert.equal((await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: leaverEmail, password: "leaver-temp-password-14" }) })).status, 401, "…and the door does not open for a released identity");

  // The address is FREE — the whole point.
  const merchantOnReleasedEmail = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100497056", email: leaverEmail, password: "merchant-released-pass-14", businessName: "تاجر على بريد محرَّر" });
  assert.equal(merchantOnReleasedEmail.status, 201, `ق-227: a departed employee's address is free again — ${JSON.stringify(merchantOnReleasedEmail.payload)}`);

  // …and restoring the seat now refuses BY NAME rather than by a 23505 from three
  // layers down, because the address belongs to that merchant today.
  const restoreTaken = await request(`/merchant/stores/phase14-a-one/trash/staff_membership/${leaverMembershipId}/restore`, { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({}) });
  assert.equal(restoreTaken.status, 409, JSON.stringify(restoreTaken.body));
  assert.equal(restoreTaken.body.error.code, "STAFF_EMAIL_TAKEN_SINCE");
  summary.staffEmailRelease = { liveEmailClaimed: 409, releasedEmailFree: 201, releasedLogin: 401, restoreAfterClaim: 409 };

  // ---------- email conflict protection across identities ----------
  const staffWithOwnerEmail = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: owner.email, displayName: "تعارض مالك", temporaryPassword: "conflict-temp-password-14", roleCode: "store_staff" }) });
  assert.equal(staffWithOwnerEmail.status, 409, JSON.stringify(staffWithOwnerEmail.body));
  const staffWithMerchantEmail = await request(teamUrl("phase14-a-one"), { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ email: merchantA.email, displayName: "تعارض تاجر", temporaryPassword: "conflict-temp-password-14", roleCode: "store_staff" }) });
  assert.equal(staffWithMerchantEmail.status, 409);
  const merchantWithStaffEmail = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100497001", email: "staff.basic.phase14@codiq.test", password: "merchant-conflict-pass-14", businessName: "تسجيل متعارض" });
  assert.equal(merchantWithStaffEmail.status, 409);
  const directClient = new Client({ connectionString: config.databaseUrl });
  await directClient.connect();
  let directStaffConflict: { code?: string } = {};
  try {
    await directClient.query("INSERT INTO staff (email, password_hash, display_name) VALUES ($1, $2, $3)", [merchantA.email, "x", "Direct Conflict"]);
    assert.fail("The trigger should reject a staff row reusing a merchant email.");
  } catch (error: any) {
    directStaffConflict = { code: error.code };
    assert.equal(error.code, "23505");
    assert.match(error.message, /CODIQ_EMAIL_CONFLICT/);
  } finally {
    await directClient.end();
  }
  summary.emailConflicts = { staffVsOwner: staffWithOwnerEmail.status, staffVsMerchant: staffWithMerchantEmail.status, merchantVsStaff: merchantWithStaffEmail.status, directSql: directStaffConflict.code };

  // ---------- session lifecycle (real expiry, revocation, D14-07) ----------
  const garbageToken = await request("/staff/stores/phase14-a-one/session", { headers: bearer("garbage-token") });
  assert.equal(garbageToken.status, 401);

  // Real expiry: keep the JWT valid but age the database row (created_at < expires_at < now).
  const lifecycleSessionRow = await prisma.staffSession.findFirst({ where: { membershipId: lifecycleMembershipId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  assert.ok(lifecycleSessionRow);
  await prisma.staffSession.update({ where: { id: lifecycleSessionRow!.id }, data: { createdAt: new Date(Date.now() - 2 * 3600 * 1000), expiresAt: new Date(Date.now() - 1 * 3600 * 1000) } });
  const expiredResult = await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenLifecycle) });
  assert.equal(expiredResult.status, 401, "a database-expired staff session must be refused");

  const lifecycleRelogin = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.lifecycle.phase14@codiq.test", password: "cycle-temp-password-14" }) });
  assert.equal(lifecycleRelogin.status, 200);
  const tokenLifecycle2: string = lifecycleRelogin.body.accessToken;
  assert.equal((await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenLifecycle2) })).status, 200);

  // Disabling the membership revokes open sessions immediately.
  const disable = await request(`${teamUrl("phase14-a-one")}/${lifecycleMembershipId}`, { method: "PATCH", headers: bearer(tokenMerchantA1), body: JSON.stringify({ isActive: false }) });
  assert.equal(disable.status, 200);
  const afterDisable = await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenLifecycle2) });
  assert.equal(afterDisable.status, 401, "disable must cut the live session immediately");
  const disabledLogin = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.lifecycle.phase14@codiq.test", password: "cycle-temp-password-14" }) });
  assert.equal(disabledLogin.status, 404, "a disabled membership cannot start a new session");

  const reenable = await request(`${teamUrl("phase14-a-one")}/${lifecycleMembershipId}`, { method: "PATCH", headers: bearer(tokenMerchantA1), body: JSON.stringify({ isActive: true }) });
  assert.equal(reenable.status, 200);
  assert.equal((await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenLifecycle2) })).status, 401, "re-enable must not resurrect revoked sessions");
  const lifecycleRelogin2 = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.lifecycle.phase14@codiq.test", password: "cycle-temp-password-14" }) });
  assert.equal(lifecycleRelogin2.status, 200);
  const tokenLifecycle3: string = lifecycleRelogin2.body.accessToken;

  // Role change also revokes open sessions (permission_version bumps).
  const roleChange = await request(`${teamUrl("phase14-a-one")}/${lifecycleMembershipId}`, { method: "PATCH", headers: bearer(tokenMerchantA1), body: JSON.stringify({ roleCode: "store_manager" }) });
  assert.equal(roleChange.status, 200);
  assert.equal((await request("/staff/stores/phase14-a-one/session", { headers: bearer(tokenLifecycle3) })).status, 401, "role change must cut live sessions");
  const promotedLogin = await request("/auth/staff/stores/phase14-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.lifecycle.phase14@codiq.test", password: "cycle-temp-password-14" }) });
  assert.equal(promotedLogin.status, 200);
  const promotedSession = await request("/staff/stores/phase14-a-one/session", { headers: bearer(promotedLogin.body.accessToken) });
  assert.deepEqual(promotedSession.body.permissions, [...PERMISSION_CODES].sort(), "the new session carries the promoted role matrix");
  summary.sessionLifecycle = { invalidToken: 401, databaseExpiry: expiredResult.status, disableCutsSession: afterDisable.status, disabledLoginRefused: disabledLogin.status, roleChangeCutsSession: 401, promotedPermissions: promotedSession.body.permissions.length };

  // ---------- merchant compatibility is untouched ----------
  const merchantOrders = await request("/merchant/stores/phase14-a-one/orders", { headers: bearer(tokenMerchantA1) });
  assert.equal(merchantOrders.status, 200);
  const merchantCatalog = await request(`${catalogBase}/products`, { headers: bearer(tokenMerchantA1) });
  assert.equal(merchantCatalog.status, 200);
  summary.merchantCompatibility = { orders: merchantOrders.status, catalog: merchantCatalog.status };

  // ============================================================
  // ق-192 — DISABLING A MERCHANT MUST STOP HIM ON THE NEXT REQUEST
  //
  // `decideMerchantApproval` sets `merchant.isActive = false` on a rejection or
  // a disable. `requireMerchantStore` (http/shared.ts) had always refused a
  // disabled merchant — but `resolveStoreActor`, the guard almost every store
  // route actually uses, never asked. So the owner's decision took effect on the
  // merchant's next LOGIN rather than his next request, and a merchant who had
  // just been told he was rejected kept full write access for up to eight hours.
  //
  // The staff half is wider: a merchant may have many people, and every one of
  // them kept writing to the store he was just stopped from touching.
  //
  // The two assertions before and after the flip are both required — a route
  // that answered 403 for an unrelated reason would make this pass on nothing.
  // ============================================================
  const staffOrdersBefore = await request("/merchant/stores/phase14-a-one/orders", { headers: bearer(tokenManager) });
  assert.equal(staffOrdersBefore.status, 200, "ق-192: the staff route works while the merchant is active — the baseline the flip is measured against");

  await prisma.merchant.update({ where: { id: merchantA.id }, data: { isActive: false } });

  const disabledMerchantOrders = await request("/merchant/stores/phase14-a-one/orders", { headers: bearer(tokenMerchantA1) });
  assert.equal(disabledMerchantOrders.status, 403, "ق-192: a disabled merchant is stopped on his NEXT REQUEST, not at his next login");
  assert.equal(disabledMerchantOrders.body.error.code, "MERCHANT_DISABLED");
  const disabledMerchantWrite = await request(`${catalogBase}/products`, { method: "POST", headers: bearer(tokenMerchantA1), body: JSON.stringify({ sku: "Q192-001", name: "منتج بعد التعطيل", priceIqd: 1000, stockQuantity: 1 }) });
  assert.equal(disabledMerchantWrite.status, 403, "ق-192: …and writing is refused too, not merely reading");

  const disabledStaffOrders = await request("/merchant/stores/phase14-a-one/orders", { headers: bearer(tokenManager) });
  assert.equal(disabledStaffOrders.status, 403, "ق-192: his STAFF stop with him — a store may have many, which makes this the wider hole");
  assert.equal(disabledStaffOrders.body.error.code, "MERCHANT_DISABLED");

  // Re-enabling restores both, so the gate is the live flag and not a one-way latch.
  await prisma.merchant.update({ where: { id: merchantA.id }, data: { isActive: true } });
  assert.equal((await request("/merchant/stores/phase14-a-one/orders", { headers: bearer(tokenMerchantA1) })).status, 200, "ق-192: re-enabling restores the merchant");
  assert.equal((await request("/merchant/stores/phase14-a-one/orders", { headers: bearer(tokenManager) })).status, 200, "ق-192: …and his staff");
  summary.disabledMerchantStops = { merchantRead: 403, merchantWrite: 403, staff: 403, restored: 200 };

  // ============================================================
  // `team.manage` IS NOT EVERY PERMISSION.
  //
  // An employee the merchant trusted with `team.manage` alone used to be able to
  // grant himself any other code through his own overrides, promote himself to
  // store_manager, or create a manager account whose password he chose. He now
  // manages the team inside his own authority: never himself, never beyond the
  // codes he holds, never a member who outranks him. The merchant is unaffected.
  // ============================================================
  async function seatMember(email: string, roleCode: "store_manager" | "store_staff", allow: PermissionCode[] = []) {
    const person = await prisma.staff.create({ data: { email, passwordHash: "unused", displayName: email.split("@")[0]! } });
    const seat = await prisma.storeStaffMembership.create({ data: { staffId: person.id, storeId: storeA1.id, roleCode } });
    if (allow.length) await prisma.staffMembershipPermissionOverride.createMany({ data: allow.map((permissionCode) => ({ membershipId: seat.id, permissionCode, effect: "allow" })) });
    return { seat, token: await createTypedSession("staff", person.id, storeA1.id, seat.id) };
  }
  const teamOnly = await seatMember("team.only.phase14@codiq.test", "store_staff", ["team.manage"]);
  const peer = await seatMember("peer.phase14@codiq.test", "store_staff");
  const boss = await seatMember("boss.phase14@codiq.test", "store_manager");
  const asTeamOnly = (path: string, method: string, body: unknown) => request(`${teamUrl("phase14-a-one")}${path}`, { method, headers: bearer(teamOnly.token), body: JSON.stringify(body) });

  const selfGrant = await asTeamOnly(`/${teamOnly.seat.id}/overrides`, "PUT", { overrides: [{ permissionCode: "team.manage", effect: "allow" }, { permissionCode: "settings.manage", effect: "allow" }] });
  assert.equal(selfGrant.status, 403, `an employee cannot grant himself a permission · ${JSON.stringify(selfGrant.body)}`);
  assert.equal(selfGrant.body.error.code, "TEAM_SELF_CHANGE_DENIED");
  const selfPromote = await asTeamOnly(`/${teamOnly.seat.id}`, "PATCH", { roleCode: "store_manager" });
  assert.equal(selfPromote.body.error?.code, "TEAM_SELF_CHANGE_DENIED", "…nor promote himself");
  const managerAccount = await asTeamOnly("", "POST", { email: "planted.manager.phase14@codiq.test", displayName: "مدير مزروع", temporaryPassword: "PlantedManager!2026", roleCode: "store_manager" });
  assert.equal(managerAccount.status, 403, `…nor create a manager account whose password he knows · ${JSON.stringify(managerAccount.body)}`);
  assert.equal(managerAccount.body.error.code, "TEAM_GRANT_EXCEEDS_OWN");
  const peerBeyond = await asTeamOnly(`/${peer.seat.id}/overrides`, "PUT", { overrides: [{ permissionCode: "settings.manage", effect: "allow" }] });
  assert.equal(peerBeyond.body.error?.code, "TEAM_GRANT_EXCEEDS_OWN", "…nor grant a colleague a code he does not hold — a confederate is the same escalation");
  const peerWithin = await asTeamOnly(`/${peer.seat.id}/overrides`, "PUT", { overrides: [{ permissionCode: "orders.update", effect: "deny" }] });
  assert.equal(peerWithin.status, 200, `inside his own authority he still manages the team · ${JSON.stringify(peerWithin.body)}`);
  const bossDisabled = await asTeamOnly(`/${boss.seat.id}`, "PATCH", { isActive: false });
  assert.equal(bossDisabled.body.error?.code, "TEAM_TARGET_OUTRANKS", "…but cannot disable a manager who outranks him");
  const bossRemoved = await request(`${teamUrl("phase14-a-one")}/${boss.seat.id}`, { method: "DELETE", headers: bearer(teamOnly.token) });
  assert.equal(bossRemoved.body.error?.code, "TEAM_TARGET_OUTRANKS", "…nor remove him");
  assert.equal((await request("/merchant/stores/phase14-a-one/payment-methods", { headers: bearer(teamOnly.token) })).status, 403, "and after all of it he still holds no settings.manage");
  // The merchant is never bounded.
  const merchantGrant = await putOverrides(teamOnly.seat.id, [{ permissionCode: "team.manage", effect: "allow" }, { permissionCode: "settings.manage", effect: "allow" }]);
  assert.ok(merchantGrant.permissions.includes("settings.manage"), "the merchant grants whatever he chooses");
  summary.teamEscalationClosed = { selfGrant: selfGrant.body.error.code, managerAccount: managerAccount.body.error.code, outranked: bossDisabled.body.error.code, withinAuthority: peerWithin.status };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

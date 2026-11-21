/**
 * codiq المرحلة 19-ب (ق-143) — «طاقم المنصة»: الهوية الخامسة، صلاحياتها، وسجلّها.
 *
 * The acceptance gates, in one breath:
 *  1. TEAM CRUD is the owner's alone, and an email can belong to exactly ONE
 *     identity across the whole platform — API and raw SQL alike;
 *  2. THE DOOR answers one generic 401 for unknown, wrong, disabled and
 *     removed alike;
 *  3. TOTP IS MANDATORY (ق-124): a pre-enrolment session reaches enrolment and
 *     nothing else, and the owner's reset forces re-enrolment;
 *  4. THE RESOLVER is verified for EVERY code × role × allow × deny — no
 *     sampling;
 *  5. THE LIVE API honours the same matrix, overrides landing WITHOUT relogin;
 *  6. OWNER-ONLY stays owner-only for the strongest staff role there is;
 *  7. REVOCATION is immediate: disable, role change, expiry, removal;
 *  8. IDENTITY BOUNDARIES hold in both directions;
 *  9. EVERY mutation writes exactly one immutable audit row with the TRUE actor;
 * 10. ATTRIBUTION is honest: staff acts are recorded as staff acts;
 * 11. THE GENERIC ACCOUNT SURFACES (sessions, password) serve the fifth kind.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import crypto from "node:crypto";
import { Client } from "pg";

process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "ps1-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const { totpForCounter, base32Decode, currentStep } = await import("../src/auth/totp.ts");
const {
  PLATFORM_PERMISSION_CODES,
  PLATFORM_ROLE_MATRIX,
  PLATFORM_STAFF_ROLE_CODES,
  resolvePlatformPermissionSet,
} = await import("../src/auth/platform-permissions.ts");
const { createStoreFoundation } = await import("../src/services/store-bootstrap.service.ts");
const { assertNoEnumerationOracle } = await import("./helpers/login-timing.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();

if (
  process.env.DATABASE_URL !== testDatabaseUrl ||
  process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl
) {
  throw new Error(
    "Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL."
  );
}
// The phase-14 list plus the four 19-ب tables (and the finance tables the
// attribution group writes into).
await prisma.$executeRawUnsafe(
  "TRUNCATE TABLE storefront_rate_limits, platform_staff_sessions, platform_staff_permission_overrides, platform_audit_events, platform_staff, settlements, plan_upgrade_requests, ledger_entries, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
);
// Plans survive the truncate on purpose (free/pro are migration-seeded); the
// plans THIS suite creates must not survive its previous run.
await sql.query("DELETE FROM plans WHERE code LIKE 'ps1-%'");

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

/** The code the staff member's phone would be showing right now. */
const codeFor = (secret, step = currentStep()) => totpForCounter(base32Decode(secret), step);

/** Fresh sign-in for an ENROLLED member: clears the spent step (test-only) so
 *  the current code is usable again — single-use itself is asserted once,
 *  explicitly, in group 3. */
async function staffLogin(email, password, secret) {
  await sql.query("UPDATE platform_staff SET totp_last_step = NULL WHERE email = $1", [email]);
  return request("/auth/platform/staff/login", {
    method: "POST",
    body: { email, password, totpCode: codeFor(secret) },
  });
}

// Every audited mutation below calls bump(); group 9 asserts the table holds
// EXACTLY this many rows — one per mutation, none silent, none doubled.
let auditExpected = 0;
const bump = () => {
  auditExpected += 1;
};

const summary = { phase: "19-ب" };

try {
  // ---------- fixtures ----------
  const ownerEmail = "owner.ps1@codiq.test";
  const ownerPassword = "Ps1OwnerPass2026!";
  const registered = await request("/auth/platform/register", {
    method: "POST",
    body: { email: ownerEmail, password: ownerPassword, displayName: "مالك المنصة 19ب" },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const ownerId = registered.payload.account.id;
  const ownerLogin = await request("/auth/platform/login", {
    method: "POST",
    body: { email: ownerEmail, password: ownerPassword },
  });
  assert.equal(ownerLogin.status, 200);
  const ownerToken = ownerLogin.payload.accessToken;

  const merchantEmail = "merchant.ps1@codiq.test";
  const merchant = await prisma.merchant.create({
    data: { email: merchantEmail, passwordHash: "unused", businessName: "تاجر المرحلة 19ب" },
  });
  const freePlan = await prisma.plan.findUniqueOrThrow({
    where: { code: "free" },
    select: { id: true },
  });
  const proPlan = await prisma.plan.findUniqueOrThrow({
    where: { code: "pro" },
    select: { id: true },
  });
  await prisma.merchantSubscription.create({
    data: { merchantId: merchant.id, planId: freePlan.id, status: "active" },
  });
  const store = await createStoreFoundation({
    merchantId: merchant.id,
    name: "متجر 19ب",
    slug: "ps1-store",
    defaultSubdomain: "ps1-store",
  });

  const regEmail = "reg.ps1@codiq.test";
  const accEmail = "acc.ps1@codiq.test";
  const supEmail = "sup.ps1@codiq.test";
  const staffPassword = "Ps1StaffPass2026!";
  const teamUrl = "/platform/staff/team";

  // ============================================================
  // 1. Team CRUD — the owner's alone, one email one identity.
  // ============================================================
  const regCreated = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: regEmail,
      displayName: "مشرف التسجيلات",
      temporaryPassword: staffPassword,
      roleCode: "registrations_admin",
    },
  });
  assert.equal(regCreated.status, 201, JSON.stringify(regCreated.payload));
  bump();
  const regId = regCreated.payload.member.id;
  assert.equal(regCreated.payload.member.totpEnrolled, false, "19-ب: nobody is born enrolled");
  assert.equal(regCreated.payload.member.permissionVersion, 1);
  assert.deepEqual(
    regCreated.payload.member.permissions,
    [...PLATFORM_ROLE_MATRIX.registrations_admin].sort(),
    "19-ب: the payload carries the RESOLVED set"
  );

  const accCreated = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: accEmail,
      displayName: "محاسب المنصة",
      temporaryPassword: staffPassword,
      roleCode: "accountant",
    },
  });
  assert.equal(accCreated.status, 201);
  bump();
  const accId = accCreated.payload.member.id;
  const supCreated = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: supEmail,
      displayName: "المشرف العام",
      temporaryPassword: staffPassword,
      roleCode: "supervisor",
    },
  });
  assert.equal(supCreated.status, 201);
  bump();
  const supId = supCreated.payload.member.id;
  assert.deepEqual(
    supCreated.payload.member.permissions,
    [...PLATFORM_PERMISSION_CODES].sort(),
    "19-ب: «مشرف عام» holds all nine codes"
  );

  const weak = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: "weak.ps1@codiq.test",
      displayName: "ضعيف",
      temporaryPassword: "short",
      roleCode: "accountant",
    },
  });
  assert.equal(weak.status, 400);
  assert.equal(
    weak.payload.error.code,
    "WEAK_PASSWORD",
    "19-ب: the platform's one password policy applies here too"
  );

  const duplicate = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: accEmail,
      displayName: "مكرر",
      temporaryPassword: staffPassword,
      roleCode: "accountant",
    },
  });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.payload));

  const crossIdentity = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: merchantEmail,
      displayName: "متصادم",
      temporaryPassword: staffPassword,
      roleCode: "accountant",
    },
  });
  assert.equal(crossIdentity.status, 409, "19-ب: a merchant's email cannot become platform staff");
  assert.equal(crossIdentity.payload.error.code, "EMAIL_RESERVED_FOR_PLATFORM_OWNER");

  // The other direction: a platform-staff email cannot register as a merchant.
  const reverseCollision = await registerMerchantDirect({
    email: regEmail,
    password: "SomeMerchantPass1!",
    businessName: "متجر التصادم",
    ownerName: "صاحب التصادم",
    phone: "07709998877",
  });
  assert.equal(reverseCollision.status, 409, JSON.stringify(reverseCollision.payload));

  // And the trigger itself, past every service: raw SQL is refused too.
  await assert.rejects(
    sql.query(
      "INSERT INTO platform_staff (email, password_hash, display_name, role_code) VALUES ($1, 'x', 'x', 'supervisor')",
      [merchantEmail]
    ),
    /CODIQ_EMAIL_CONFLICT/,
    "19-ب: the advisory-locked trigger guards the fourth identity table"
  );

  const badRole = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: "role.ps1@codiq.test",
      displayName: "دور خاطئ",
      temporaryPassword: staffPassword,
      roleCode: "chief",
    },
  });
  assert.equal(badRole.status, 422);
  assert.equal(badRole.payload.error.code, "INVALID_PLATFORM_STAFF_ROLE");

  const teamList = await request(teamUrl, { token: ownerToken });
  assert.equal(teamList.status, 200);
  assert.equal(teamList.payload.team.length, 3);

  async function teamMember(email) {
    const list = await request(teamUrl, { token: ownerToken });
    return list.payload.team.find((member) => member.email === email);
  }

  // ============================================================
  // 2. The login door — one generic 401 for everything wrong.
  // ============================================================
  const loginUrl = "/auth/platform/staff/login";
  const regFirstLogin = await request(loginUrl, {
    method: "POST",
    body: { email: regEmail, password: staffPassword },
  });
  assert.equal(regFirstLogin.status, 200, JSON.stringify(regFirstLogin.payload));
  assert.equal(regFirstLogin.payload.redirectTo, "/platform/staff/dashboard");
  let regToken = regFirstLogin.payload.accessToken;

  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: regEmail, password: "wrong-password-19b" },
      })
    ).payload.error.code,
    "INVALID_PLATFORM_STAFF_CREDENTIALS"
  );
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: "nobody.ps1@codiq.test", password: staffPassword },
      })
    ).payload.error.code,
    "INVALID_PLATFORM_STAFF_CREDENTIALS",
    "19-ب: unknown and wrong answer identically"
  );

  // 19-د (ATTACK-SURFACE): «answer identically» has to include HOW LONG the
  // answer took. The three assertions above compare error codes, and the door
  // passed all three while returning in ~30 ms for unknown/disabled/removed and
  // ~800 ms for a live account with a wrong password — so the clock said exactly
  // what the module header promises it must not say. See helpers/login-timing.ts.
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");
  summary.enumerationOracle = await assertNoEnumerationOracle("platform-staff door", {
    known: () =>
      request(loginUrl, {
        method: "POST",
        body: { email: regEmail, password: "wrong-on-purpose-19d" },
      }),
    unknown: () =>
      request(loginUrl, {
        method: "POST",
        body: { email: "nobody.19d.ps1@codiq.test", password: "wrong-on-purpose-19d" },
      }),
  });
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: "nobody.19d.ps1@codiq.test", password: "wrong-on-purpose-19d" },
      })
    ).status,
    401,
    "the unknown-identity probe must be a 401 for the measurement to mean anything"
  );
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

  const disabledPatch = await request(`${teamUrl}/${accId}`, {
    method: "PATCH",
    token: ownerToken,
    body: { isActive: false },
  });
  assert.equal(disabledPatch.status, 200);
  bump();
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: accEmail, password: staffPassword },
      })
    ).payload.error.code,
    "INVALID_PLATFORM_STAFF_CREDENTIALS",
    "19-ب: a disabled account is indistinguishable at the door"
  );
  assert.equal(
    (
      await request(`${teamUrl}/${accId}`, {
        method: "PATCH",
        token: ownerToken,
        body: { isActive: true },
      })
    ).status,
    200
  );
  bump();

  const tempCreated = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: "temp.ps1@codiq.test",
      displayName: "موظف مؤقت",
      temporaryPassword: staffPassword,
      roleCode: "accountant",
    },
  });
  assert.equal(tempCreated.status, 201);
  bump();
  assert.equal(
    (
      await request(`${teamUrl}/${tempCreated.payload.member.id}`, {
        method: "DELETE",
        token: ownerToken,
      })
    ).status,
    200
  );
  bump();
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: "temp.ps1@codiq.test", password: staffPassword },
      })
    ).payload.error.code,
    "INVALID_PLATFORM_STAFF_CREDENTIALS",
    "19-ب: a removed account is indistinguishable at the door"
  );
  assert.equal(await teamMember("temp.ps1@codiq.test"), undefined, "19-ب: …and off the roster");
  // Removal must RELEASE the address, not hold it hostage: uniqueness is a
  // claim on the living (the PG-2 partial-index idiom). Before this was fixed,
  // a removed member could never be re-added, never become a merchant, and
  // never be store staff — with no way back short of a hand-written DELETE.
  const reAdded = await request(teamUrl, {
    method: "POST",
    token: ownerToken,
    body: {
      email: "temp.ps1@codiq.test",
      displayName: "موظف مؤقت عاد",
      temporaryPassword: staffPassword,
      roleCode: "accountant",
    },
  });
  assert.equal(
    reAdded.status,
    201,
    `19-ب: a removed member's email is free again — ${JSON.stringify(reAdded.payload)}`
  );
  bump();
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: "temp.ps1@codiq.test", password: staffPassword },
      })
    ).status,
    200,
    "19-ب: …and the re-added member signs in as himself, not the ghost"
  );
  assert.equal(
    (
      await request(`${teamUrl}/${reAdded.payload.member.id}`, {
        method: "DELETE",
        token: ownerToken,
      })
    ).status,
    200
  );
  bump();

  // A staff email at the OWNER'S door fails as an owner failure.
  assert.equal(
    (
      await request("/auth/platform/login", {
        method: "POST",
        body: { email: regEmail, password: staffPassword },
      })
    ).payload.error.code,
    "INVALID_PLATFORM_OWNER_CREDENTIALS"
  );

  summary.loginDoor = {
    generic401: "INVALID_PLATFORM_STAFF_CREDENTIALS",
    cases: ["correct", "wrong-password", "unknown", "disabled", "removed"],
  };

  // ============================================================
  // 3. The TOTP mandate (ق-124).
  // ============================================================
  // The session bootstrap read is the one pre-enrolment window: it must return
  // totpEnrolled:false so the shell can render the enrolment screen — gating it
  // would strand the member on a dead page with no path to the enrolment routes.
  const preEnrolSession = await request("/platform/staff/session", { token: regToken });
  assert.equal(
    preEnrolSession.status,
    200,
    "19-ب: the shell can read its own pre-enrolment session"
  );
  assert.equal(
    preEnrolSession.payload.totpEnrolled,
    false,
    "19-ب: and it says enrolment is still pending"
  );
  assert.equal(
    (await request("/platform/overview", { token: regToken })).payload.error.code,
    "SECOND_FACTOR_ENROLMENT_REQUIRED",
    "19-ب: but no WORK screen opens — not even one his role would grant"
  );

  const begun = await request("/platform/staff/security/totp/begin", {
    method: "POST",
    token: regToken,
  });
  assert.equal(begun.status, 200, JSON.stringify(begun.payload));
  assert.match(begun.payload.uri, /^otpauth:\/\/totp\//);
  let regSecret = begun.payload.secret;

  assert.equal(
    (
      await request("/platform/staff/security/totp/confirm", {
        method: "POST",
        token: regToken,
        body: { code: "000000" },
      })
    ).payload.error.code,
    "INVALID_TOTP_CODE"
  );
  const confirmed = await request("/platform/staff/security/totp/confirm", {
    method: "POST",
    token: regToken,
    body: { code: codeFor(regSecret) },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.payload));
  assert.equal(confirmed.payload.totpEnrolled, true);
  const regSession = await request("/platform/staff/session", { token: regToken });
  assert.equal(regSession.status, 200, "19-ب: the same session serves once enrolment completes");
  assert.deepEqual(
    regSession.payload.permissions,
    [...PLATFORM_ROLE_MATRIX.registrations_admin].sort()
  );

  // The door now demands the second factor.
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: regEmail, password: staffPassword },
      })
    ).payload.error.code,
    "SECOND_FACTOR_REQUIRED"
  );
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: regEmail, password: staffPassword, totpCode: "000000" },
      })
    ).payload.error.code,
    "INVALID_SECOND_FACTOR"
  );
  const totpStep = currentStep() + 1;
  const regRelogin = await request(loginUrl, {
    method: "POST",
    body: { email: regEmail, password: staffPassword, totpCode: codeFor(regSecret, totpStep) },
  });
  assert.equal(regRelogin.status, 200, JSON.stringify(regRelogin.payload));
  const regToken2 = regRelogin.payload.accessToken;
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: regEmail, password: staffPassword, totpCode: codeFor(regSecret, totpStep) },
      })
    ).payload.error.code,
    "INVALID_SECOND_FACTOR",
    "19-ب: a code is single-use"
  );

  // The owner's reset: clears the factor, kills the sessions, forces re-enrolment.
  const reset = await request(`${teamUrl}/${regId}/totp/reset`, {
    method: "POST",
    token: ownerToken,
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.payload.member.totpEnrolled, false);
  bump();
  assert.equal(
    (await request("/platform/staff/session", { token: regToken2 })).status,
    401,
    "19-ب: the reset revoked every open session"
  );
  const afterReset = await request(loginUrl, {
    method: "POST",
    body: { email: regEmail, password: staffPassword },
  });
  assert.equal(
    afterReset.status,
    200,
    "19-ب: the password alone re-opens the door — into the enrolment corridor only"
  );
  regToken = afterReset.payload.accessToken;
  const reEnrolSession = await request("/platform/staff/session", { token: regToken });
  assert.equal(
    reEnrolSession.status,
    200,
    "19-ب: after a reset the session reads again, enrolment pending"
  );
  assert.equal(reEnrolSession.payload.totpEnrolled, false);
  const reBegun = await request("/platform/staff/security/totp/begin", {
    method: "POST",
    token: regToken,
  });
  assert.equal(reBegun.status, 200);
  regSecret = reBegun.payload.secret;
  assert.equal(
    (
      await request("/platform/staff/security/totp/confirm", {
        method: "POST",
        token: regToken,
        body: { code: codeFor(regSecret) },
      })
    ).status,
    200
  );
  assert.equal((await request("/platform/staff/session", { token: regToken })).status, 200);

  // Enrol the other two (their pre-enrolment session keeps serving after confirm).
  const accLogin1 = await request(loginUrl, {
    method: "POST",
    body: { email: accEmail, password: staffPassword },
  });
  assert.equal(accLogin1.status, 200);
  let accToken = accLogin1.payload.accessToken;
  const accBegun = await request("/platform/staff/security/totp/begin", {
    method: "POST",
    token: accToken,
  });
  const accSecret = accBegun.payload.secret;
  assert.equal(
    (
      await request("/platform/staff/security/totp/confirm", {
        method: "POST",
        token: accToken,
        body: { code: codeFor(accSecret) },
      })
    ).status,
    200
  );

  const supLogin1 = await request(loginUrl, {
    method: "POST",
    body: { email: supEmail, password: staffPassword },
  });
  let supToken = supLogin1.payload.accessToken;
  const supBegun = await request("/platform/staff/security/totp/begin", {
    method: "POST",
    token: supToken,
  });
  const supSecret = supBegun.payload.secret;
  assert.equal(
    (
      await request("/platform/staff/security/totp/confirm", {
        method: "POST",
        token: supToken,
        body: { code: codeFor(supSecret) },
      })
    ).status,
    200
  );

  summary.totpMandate = {
    preEnrolment: "SECOND_FACTOR_ENROLMENT_REQUIRED",
    door: "SECOND_FACTOR_REQUIRED",
    replay: "INVALID_SECOND_FACTOR",
    ownerResetForcesReEnrol: true,
  };

  // ============================================================
  // 4. The resolver matrix — every code × role × allow × deny.
  // ============================================================
  let resolverChecks = 0;
  for (const role of PLATFORM_STAFF_ROLE_CODES) {
    for (const code of PLATFORM_PERMISSION_CODES) {
      const baseExpected = PLATFORM_ROLE_MATRIX[role].includes(code);
      assert.equal(
        resolvePlatformPermissionSet(role, []).has(code),
        baseExpected,
        `resolver base: ${role} × ${code}`
      );
      assert.equal(
        resolvePlatformPermissionSet(role, [{ permissionCode: code, effect: "allow" }]).has(code),
        true,
        `resolver allow: ${role} × ${code}`
      );
      assert.equal(
        resolvePlatformPermissionSet(role, [{ permissionCode: code, effect: "deny" }]).has(code),
        false,
        `resolver deny: ${role} × ${code}`
      );
      resolverChecks += 3;
    }
  }
  // An unknown role resolves to NOTHING, and an unknown override code is inert.
  assert.equal(resolvePlatformPermissionSet("chief", []).size, 0);
  assert.equal(
    resolvePlatformPermissionSet("accountant", [
      { permissionCode: "no.such.code", effect: "allow" },
    ]).size,
    PLATFORM_ROLE_MATRIX.accountant.length
  );
  summary.resolverMatrix = {
    roles: PLATFORM_STAFF_ROLE_CODES.length,
    codes: PLATFORM_PERMISSION_CODES.length,
    assertions: resolverChecks,
  };

  // ============================================================
  // 5. The live API matrix — one probe route per code.
  // ============================================================
  const PROBES = {
    "overview.view": { method: "GET", path: "/platform/overview" },
    "registrations.approve": { method: "GET", path: "/platform/merchants/registration-requests" },
    "merchants.manage": { method: "GET", path: "/platform/merchants" },
    "plans.manage": { method: "GET", path: "/platform/plans" },
    "finance.view": { method: "GET", path: "/platform/finance/report" },
    // A 404 for a made-up order id PROVES the guard admitted the actor; the
    // denied actor never reaches the body check.
    "finance.settle": {
      method: "POST",
      path: "/platform/finance/adjustments",
      body: () => ({ orderId: crypto.randomUUID() }),
      passStatus: 404,
    },
    "orders.oversee": { method: "GET", path: "/platform/orders" },
    "brand.manage": { method: "GET", path: "/platform/brand/logo" },
    "audit.view": { method: "GET", path: "/platform/audit-events" },
    // ق-249: the services control room, and the availability overrides behind their own code.
    "services.manage": { method: "GET", path: "/platform/services" },
    "availability.manage": { method: "GET", path: "/platform/availability/overrides" },
  };
  const tokensByRole = {
    registrations_admin: () => regToken,
    accountant: () => accToken,
    supervisor: () => supToken,
  };
  const staffIdsByRole = { registrations_admin: regId, accountant: accId, supervisor: supId };

  async function probe(code, token) {
    const spec = PROBES[code];
    return request(spec.path, {
      method: spec.method,
      token,
      ...(spec.body ? { body: spec.body() } : {}),
    });
  }
  async function setOverrides(staffId, overrides) {
    const result = await request(`${teamUrl}/${staffId}/overrides`, {
      method: "PUT",
      token: ownerToken,
      body: { overrides },
    });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    bump();
    return result.payload.member;
  }

  for (const code of PLATFORM_PERMISSION_CODES) {
    const spec = PROBES[code];
    const passStatus = spec.passStatus ?? 200;
    // Holder passes.
    const holderRole = PLATFORM_STAFF_ROLE_CODES.find((role) =>
      PLATFORM_ROLE_MATRIX[role].includes(code)
    );
    const holderProbe = await probe(code, tokensByRole[holderRole]());
    assert.equal(
      holderProbe.status,
      passStatus,
      `${code}: holder ${holderRole} → ${holderProbe.status} ${JSON.stringify(holderProbe.payload)}`
    );

    // Base non-holder refused (every code has one among the two narrow roles,
    // except overview.view which all three hold — the deny case below covers it).
    const lackingRole = ["registrations_admin", "accountant"].find(
      (role) => !PLATFORM_ROLE_MATRIX[role].includes(code)
    );
    if (lackingRole) {
      const denied = await probe(code, tokensByRole[lackingRole]());
      assert.equal(denied.status, 403, `${code}: non-holder ${lackingRole}`);
      assert.equal(denied.payload.error.code, "PLATFORM_PERMISSION_DENIED");

      // An allow override GRANTS it — on the very next request, no relogin.
      await setOverrides(staffIdsByRole[lackingRole], [{ permissionCode: code, effect: "allow" }]);
      assert.equal(
        (await probe(code, tokensByRole[lackingRole]())).status,
        passStatus,
        `${code}: allow override grants ${lackingRole}`
      );
      await setOverrides(staffIdsByRole[lackingRole], []);
      assert.equal(
        (await probe(code, tokensByRole[lackingRole]())).status,
        403,
        `${code}: cleared override strips again`
      );
    }

    // A deny override STRIPS the supervisor of even this.
    await setOverrides(supId, [{ permissionCode: code, effect: "deny" }]);
    const stripped = await probe(code, supToken);
    assert.equal(stripped.status, 403, `${code}: deny strips supervisor`);
    assert.equal(stripped.payload.error.code, "PLATFORM_PERMISSION_DENIED");
    await setOverrides(supId, []);
    assert.equal((await probe(code, supToken)).status, passStatus, `${code}: supervisor restored`);
  }

  // Override hygiene: duplicates and unknown effects are refused with their own codes.
  const dupOverride = await request(`${teamUrl}/${accId}/overrides`, {
    method: "PUT",
    token: ownerToken,
    body: {
      overrides: [
        { permissionCode: "audit.view", effect: "allow" },
        { permissionCode: "audit.view", effect: "deny" },
      ],
    },
  });
  assert.equal(dupOverride.status, 422);
  assert.equal(dupOverride.payload.error.code, "DUPLICATE_OVERRIDE");
  const badEffect = await request(`${teamUrl}/${accId}/overrides`, {
    method: "PUT",
    token: ownerToken,
    body: { overrides: [{ permissionCode: "audit.view", effect: "maybe" }] },
  });
  assert.equal(badEffect.payload.error.code, "INVALID_OVERRIDE_EFFECT");
  const badCode = await request(`${teamUrl}/${accId}/overrides`, {
    method: "PUT",
    token: ownerToken,
    body: { overrides: [{ permissionCode: "no.such", effect: "allow" }] },
  });
  assert.equal(badCode.payload.error.code, "INVALID_PERMISSION_CODE");
  summary.liveMatrix = {
    probes: Object.keys(PROBES).length,
    deniedCode: "PLATFORM_PERMISSION_DENIED",
    overridesApplyWithoutRelogin: true,
  };

  // ============================================================
  // 6. Owner-only stays owner-only — for the supervisor himself.
  // ============================================================
  // Plan CREATION is owner-only at the IDENTITY level. Refusing only the
  // commissionBps FIELD protected the field name, not the revenue: an omitted
  // commission defaults to 0 and a new plan is born active, so a supervisor
  // could mint a 0% plan and move merchants onto it with the same code that
  // grants assignment — zero commission booked into an append-only ledger
  // forever. Found in adversarial review; the door is shut at the identity.
  const commissionCreate = await request("/platform/plans", {
    method: "POST",
    token: supToken,
    body: { code: "ps1-sup-plan", name: "خطة المشرف", commissionBps: 100 },
  });
  assert.equal(commissionCreate.status, 403);
  assert.equal(
    commissionCreate.payload.error.code,
    "IDENTITY_BOUNDARY_DENIED",
    "19-ب: minting a plan is the owner's act, not a delegable field"
  );
  const bareCreate = await request("/platform/plans", {
    method: "POST",
    token: supToken,
    body: { code: "ps1-zero-plan", name: "خطة بلا عمولة", monthlyPriceIqd: 15000 },
  });
  assert.equal(
    bareCreate.payload.error.code,
    "IDENTITY_BOUNDARY_DENIED",
    "19-ب: …and omitting the field does not sneak a 0% plan past it"
  );
  const recommendPatch = await request(`/platform/plans/${proPlan.id}`, {
    method: "PATCH",
    token: supToken,
    body: { isRecommended: true },
  });
  assert.equal(
    recommendPatch.payload.error.code,
    "OWNER_ONLY_FIELD",
    "19-ب: «توصية المنصة» steers the public grid — the owner's word"
  );
  const commissionPatch = await request(`/platform/plans/${proPlan.id}`, {
    method: "PATCH",
    token: supToken,
    body: { commissionBps: 50 },
  });
  assert.equal(commissionPatch.payload.error.code, "OWNER_ONLY_FIELD");
  const isActivePatch = await request(`/platform/plans/${proPlan.id}`, {
    method: "PATCH",
    token: supToken,
    body: { isActive: false },
  });
  assert.equal(
    isActivePatch.payload.error.code,
    "OWNER_ONLY_FIELD",
    "19-ب: isActive via PATCH is the archive side-door — shut"
  );
  assert.equal(
    (await request(`/platform/plans/${proPlan.id}/archive`, { method: "POST", token: supToken }))
      .payload.error.code,
    "IDENTITY_BOUNDARY_DENIED"
  );
  assert.equal(
    (await request(teamUrl, { token: supToken })).payload.error.code,
    "IDENTITY_BOUNDARY_DENIED",
    "19-ب: no staff role reaches the team routes"
  );
  assert.equal(
    (
      await request("/platform/stores/ps1-store/verification", {
        method: "PUT",
        token: supToken,
        body: { verified: true },
      })
    ).payload.error.code,
    "IDENTITY_BOUNDARY_DENIED",
    "19-ب: MD-6 stays the owner's word"
  );

  // …while the supervisor CAN do the delegated half of the same surface —
  // EDITING a plan the owner minted, in the fields left to him:
  const supPlanEdit = await request(`/platform/plans/${proPlan.id}`, {
    method: "PATCH",
    token: supToken,
    body: { name: "خطة النمو المعدلة" },
  });
  assert.equal(supPlanEdit.status, 200, JSON.stringify(supPlanEdit.payload));
  bump();

  // …and the owner succeeds on every refused act:
  const ownerPlan = await request("/platform/plans", {
    method: "POST",
    token: ownerToken,
    body: { code: "ps1-owner-plan", name: "خطة المالك", commissionBps: 250 },
  });
  assert.equal(ownerPlan.status, 201);
  bump();
  const ownerPlanId = ownerPlan.payload.plan.id;
  assert.equal(
    (
      await request(`/platform/plans/${ownerPlanId}`, {
        method: "PATCH",
        token: ownerToken,
        body: { commissionBps: 300 },
      })
    ).status,
    200
  );
  bump();
  assert.equal(
    (await request(`/platform/plans/${ownerPlanId}/archive`, { method: "POST", token: ownerToken }))
      .status,
    200
  );
  bump();
  assert.equal(
    (
      await request(`/platform/plans/${ownerPlanId}/unarchive`, {
        method: "POST",
        token: ownerToken,
      })
    ).status,
    200
  );
  bump();
  assert.equal((await request(teamUrl, { token: ownerToken })).status, 200);
  const verify = await request("/platform/stores/ps1-store/verification", {
    method: "PUT",
    token: ownerToken,
    body: { verified: true },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.payload)); // store audit, not platform audit — no bump.
  summary.ownerOnly = {
    refusedForSupervisor: ["commissionBps", "isActive", "archive", "team", "verification PUT"],
    ownerSucceeds: true,
  };

  // ============================================================
  // 7. Revocation mid-session.
  // ============================================================
  assert.equal((await request("/platform/staff/session", { token: accToken })).status, 200);
  const versionBefore = (await teamMember(accEmail)).permissionVersion;

  // API disable: version bumps and the session dies in the SAME transaction.
  assert.equal(
    (
      await request(`${teamUrl}/${accId}`, {
        method: "PATCH",
        token: ownerToken,
        body: { isActive: false },
      })
    ).status,
    200
  );
  bump();
  assert.equal(
    (await request("/platform/staff/session", { token: accToken })).status,
    401,
    "19-ب: disable cuts the open session at once"
  );
  // Re-enable resurrects NOTHING.
  assert.equal(
    (
      await request(`${teamUrl}/${accId}`, {
        method: "PATCH",
        token: ownerToken,
        body: { isActive: true },
      })
    ).status,
    200
  );
  bump();
  assert.equal(
    (await request("/platform/staff/session", { token: accToken })).status,
    401,
    "19-ب: re-enable does not resurrect a revoked session"
  );

  const accRelogin = await staffLogin(accEmail, staffPassword, accSecret);
  assert.equal(accRelogin.status, 200, JSON.stringify(accRelogin.payload));
  accToken = accRelogin.payload.accessToken;

  // The LIVE gate, isolated from the session revoke: a row disabled behind the
  // session's back (raw SQL leaves the session untouched) is refused by name.
  await sql.query("UPDATE platform_staff SET is_active = FALSE WHERE id = $1", [accId]);
  const liveGate = await request("/platform/staff/session", { token: accToken });
  assert.equal(liveGate.status, 401);
  assert.equal(
    liveGate.payload.error.code,
    "PLATFORM_ACCESS_REVOKED",
    "19-ب: the guard re-reads the row on EVERY request"
  );
  await sql.query("UPDATE platform_staff SET is_active = TRUE WHERE id = $1", [accId]);
  assert.equal((await request("/platform/staff/session", { token: accToken })).status, 200);

  // Role change cuts too.
  assert.equal(
    (
      await request(`${teamUrl}/${accId}`, {
        method: "PATCH",
        token: ownerToken,
        body: { roleCode: "supervisor" },
      })
    ).status,
    200
  );
  bump();
  assert.equal(
    (await request("/platform/staff/session", { token: accToken })).status,
    401,
    "19-ب: a role change ends the sessions that carried the old role"
  );
  assert.equal(
    (
      await request(`${teamUrl}/${accId}`, {
        method: "PATCH",
        token: ownerToken,
        body: { roleCode: "accountant" },
      })
    ).status,
    200
  );
  bump();
  accToken = (await staffLogin(accEmail, staffPassword, accSecret)).payload.accessToken;

  // An aged expires_at is refused even while unrevoked (created_at ages with
  // it — the expiry CHECK still holds: created_at < expires_at < now).
  await sql.query(
    "UPDATE platform_staff_sessions SET created_at = NOW() - interval '2 hours', expires_at = NOW() - interval '1 hour' WHERE platform_staff_id = $1 AND revoked_at IS NULL",
    [accId]
  );
  assert.equal(
    (await request("/platform/staff/session", { token: accToken })).status,
    401,
    "19-ب: expiry is judged against the database row"
  );
  accToken = (await staffLogin(accEmail, staffPassword, accSecret)).payload.accessToken;

  // Overrides land WITHOUT relogin (asserted per-code in group 5; here across
  // the exact session that survives).
  assert.equal((await probe("orders.oversee", accToken)).status, 403);
  await setOverrides(accId, [{ permissionCode: "orders.oversee", effect: "allow" }]);
  assert.equal(
    (await probe("orders.oversee", accToken)).status,
    200,
    "19-ب: the override applies on the next request of the SAME session"
  );
  await setOverrides(accId, []);
  assert.equal((await probe("orders.oversee", accToken)).status, 403);

  const versionAfter = (await teamMember(accEmail)).permissionVersion;
  assert.ok(
    versionAfter > versionBefore,
    `19-ب: permission_version is monotonic (${versionBefore} → ${versionAfter})`
  );
  summary.revocation = { liveGate: "PLATFORM_ACCESS_REVOKED", versionBefore, versionAfter };

  // ============================================================
  // 8. Identity boundaries, both directions.
  // ============================================================
  const merchantToken = await createTypedSession("merchant", merchant.id, store.id);
  const storeStaffRow = await prisma.staff.create({
    data: {
      email: "storestaff.ps1@codiq.test",
      passwordHash: "unused",
      displayName: "موظف متجر 19ب",
    },
  });
  const membership = await prisma.storeStaffMembership.create({
    data: { staffId: storeStaffRow.id, storeId: store.id, roleCode: "store_manager" },
  });
  const storeStaffToken = await createTypedSession(
    "staff",
    storeStaffRow.id,
    store.id,
    membership.id
  );
  const customer = await prisma.customer.create({
    data: {
      storeId: store.id,
      passwordHash: "unused",
      fullName: "زبون 19ب",
      phoneNormalized: "+9647701112233",
    },
  });
  const customerToken = await createTypedSession("customer", customer.id);

  // Platform staff reaches NO other area…
  for (const [name, path] of [
    ["merchant team", "/merchant/stores/ps1-store/team"],
    ["staff dashboard", "/staff/stores/ps1-store/dashboard"],
    ["merchant subscription", "/merchant/subscription"],
    ["owner kind-probe", "/platform/dashboard"],
    ["customer account", "/stores/ps1-store/account"],
  ]) {
    const denied = await request(path, { token: supToken });
    assert.equal(denied.status, 403, `${name}: platform-staff token must be refused`);
    assert.equal(denied.payload.error.code, "IDENTITY_BOUNDARY_DENIED", name);
  }

  // …and no other identity reaches the platform.
  for (const [name, token] of [
    ["merchant", merchantToken],
    ["store staff", storeStaffToken],
    ["customer", customerToken],
    ["owner", ownerToken],
  ]) {
    const denied = await request("/platform/staff/session", { token });
    assert.equal(denied.status, 403, `${name} on /platform/staff/session`);
    assert.equal(denied.payload.error.code, "IDENTITY_BOUNDARY_DENIED");
  }
  for (const [name, token] of [
    ["merchant", merchantToken],
    ["store staff", storeStaffToken],
    ["customer", customerToken],
  ]) {
    const denied = await request("/platform/overview", { token });
    assert.equal(denied.status, 403, `${name} on /platform/overview`);
    assert.equal(denied.payload.error.code, "IDENTITY_BOUNDARY_DENIED");
  }
  summary.boundaries = { code: "IDENTITY_BOUNDARY_DENIED", ownerKindProbeStaysOwnerOnly: true };

  // ============================================================
  // 9. Audit rows — every mutation, exactly one, immutable, keyset-stable.
  //    (The remaining delegable mutations run here so all 15 live actions land.)
  // ============================================================
  assert.equal(
    (
      await request("/platform/settings/registration", {
        method: "PUT",
        token: regToken,
        body: { mode: "manual" },
      })
    ).status,
    200
  );
  bump();
  assert.equal(
    (
      await request("/platform/settings/registration", {
        method: "PUT",
        token: regToken,
        body: { mode: "auto" },
      })
    ).status,
    200
  );
  bump();

  const manual = await request("/platform/merchants/manual", {
    method: "POST",
    token: regToken,
    body: {
      businessName: "تاجر يدوي 19ب",
      email: "manual.ps1@codiq.test",
      temporaryPassword: staffPassword,
      firstStoreName: "متجر يدوي",
      ownerName: "صاحب المتجر اليدوي",
      phone: "07811112222",
    },
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.payload));
  bump();
  const manualMerchantId = manual.payload.merchant.id;

  const pendingMerchant = await prisma.merchant.create({
    data: {
      email: "pending.ps1@codiq.test",
      passwordHash: "unused",
      businessName: "تاجر معلق 19ب",
      approvalStatus: "pending",
      isActive: false,
    },
  });
  const approval = await request(`/platform/merchants/${pendingMerchant.id}/approval`, {
    method: "POST",
    token: regToken,
    body: { action: "approve" },
  });
  assert.equal(approval.status, 200, JSON.stringify(approval.payload));
  bump();

  assert.equal(
    (
      await request(`/platform/merchants/${manualMerchantId}/subscription`, {
        method: "PUT",
        token: supToken,
        body: { planCode: "pro" },
      })
    ).status,
    200
  );
  bump();

  assert.equal(
    (await request("/platform/brand/logo", { method: "DELETE", token: supToken })).status,
    200
  );
  bump();

  const auditCount = await prisma.platformAuditEvent.count();
  assert.equal(
    auditCount,
    auditExpected,
    `19-ب: EXACTLY one audit row per mutation — expected ${auditExpected}, found ${auditCount}`
  );

  // The true actor, snapshotted. Plan CREATION is the owner's alone now, so
  // the delegated act that proves staff attribution is the EDIT.
  const staffPlanRow = await prisma.platformAuditEvent.findFirst({
    where: { action: "plan_updated", actorKind: "platform_staff" },
  });
  assert.ok(staffPlanRow, "19-ب: the supervisor's plan edit names the supervisor");
  assert.equal(staffPlanRow.actorId, supId);
  assert.equal(staffPlanRow.actorLabel, "المشرف العام");
  assert.equal(
    await prisma.platformAuditEvent.count({
      where: { action: "plan_created", actorKind: "platform_staff" },
    }),
    0,
    "19-ب: …and no staff-minted plan exists at all"
  );
  const ownerCreateRow = await prisma.platformAuditEvent.findFirst({
    where: { action: "staff_created", actorKind: "platform_owner" },
  });
  assert.equal(
    ownerCreateRow.actorLabel,
    "مالك المنصة 19ب",
    "19-ب: the owner's acts are on the record too"
  );
  const modeRow = await prisma.platformAuditEvent.findFirst({
    where: { action: "registration_mode_changed" },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(modeRow.actorKind, "platform_staff");
  assert.equal(modeRow.actorId, regId);

  // Append-only in the database itself.
  await assert.rejects(
    sql.query("UPDATE platform_audit_events SET action = 'plan_created' WHERE id = $1", [
      staffPlanRow.id,
    ]),
    /CODIQ_AUDIT_EVENT_IMMUTABLE/
  );
  await assert.rejects(
    sql.query("DELETE FROM platform_audit_events WHERE id = $1", [staffPlanRow.id]),
    /CODIQ_AUDIT_EVENT_IMMUTABLE/
  );

  // Keyset pagination: walk the whole log, no duplicate, no loss, stable order.
  const seen = [];
  let cursor;
  for (;;) {
    const page = await request(
      `/platform/audit-events?limit=7${cursor ? `&cursor=${cursor}` : ""}`,
      { token: ownerToken }
    );
    assert.equal(page.status, 200);
    assert.ok(page.payload.events.length <= 7);
    seen.push(...page.payload.events.map((event) => event.id));
    if (!page.payload.nextCursor) break;
    cursor = page.payload.nextCursor;
  }
  assert.equal(seen.length, auditExpected, "19-ب: the keyset walk loses nothing");
  assert.equal(new Set(seen).size, seen.length, "19-ب: …and repeats nothing");
  assert.equal(
    (await request(`/platform/audit-events?cursor=${crypto.randomUUID()}`, { token: ownerToken }))
      .status,
    404,
    "19-ب: a foreign cursor is a 404, not an empty page"
  );
  summary.audit = {
    rows: auditCount,
    immutable: "CODIQ_AUDIT_EVENT_IMMUTABLE",
    keysetWalk: seen.length,
  };

  // ============================================================
  // 10. Attribution — staff acts recorded as staff acts.
  // ============================================================
  const staffSettlement = await request("/platform/finance/settlements", {
    method: "POST",
    token: accToken,
    body: { merchantId: merchant.id, periodFrom: "2026-01-01", periodTo: "2026-06-01" },
  });
  assert.equal(staffSettlement.status, 201, JSON.stringify(staffSettlement.payload));
  bump();
  const staffSettlementRow = await prisma.settlement.findUniqueOrThrow({
    where: { id: staffSettlement.payload.settlement.id },
  });
  assert.equal(
    staffSettlementRow.settledByStaffId,
    accId,
    "19-ب: the settling STAFF member is the recorded actor"
  );
  assert.equal(
    staffSettlementRow.platformOwnerId,
    null,
    "19-ب: …never laundered through the owner's column"
  );
  assert.equal(staffSettlementRow.settledByLabel, "محاسب المنصة");

  // ق-233: the second period starts exactly where the first ended. It used to
  // start the next DAY, leaving twenty-four hours in no settlement and in no
  // pending balance — the very hole ق-233 made impossible. What this section
  // asserts is the recorded ACTOR, so the dates simply obey the new rule.
  const ownerSettlement = await request("/platform/finance/settlements", {
    method: "POST",
    token: ownerToken,
    body: { merchantId: merchant.id, periodFrom: "2026-06-01", periodTo: "2026-07-01" },
  });
  assert.equal(ownerSettlement.status, 201);
  bump();
  const ownerSettlementRow = await prisma.settlement.findUniqueOrThrow({
    where: { id: ownerSettlement.payload.settlement.id },
  });
  assert.equal(ownerSettlementRow.platformOwnerId, ownerId);
  assert.equal(ownerSettlementRow.settledByStaffId, null);

  // A settlement with NEITHER actor is structurally impossible.
  await assert.rejects(
    sql.query(
      "INSERT INTO settlements (merchant_id, period_from, period_to, orders_count, subtotal_iqd, delivery_fee_iqd, commission_iqd) VALUES ($1, '2026-07-01'::timestamptz, NOW(), 0, 0, 0, 0)",
      [merchant.id]
    ),
    /settlements_settled_by_one_of/
  );

  const upgradeRequest = await prisma.planUpgradeRequest.create({
    data: { merchantId: merchant.id, requestedPlanId: proPlan.id },
  });
  const decided = await request(`/platform/upgrade-requests/${upgradeRequest.id}/approve`, {
    method: "POST",
    token: supToken,
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.payload));
  bump();
  const decidedRow = await prisma.planUpgradeRequest.findUniqueOrThrow({
    where: { id: upgradeRequest.id },
  });
  assert.equal(
    decidedRow.decidedByStaffId,
    supId,
    "19-ب: the deciding STAFF member is the recorded actor"
  );
  assert.equal(decidedRow.decidedById, null);
  assert.equal(decidedRow.decidedByLabel, "المشرف العام");

  // The manual ledger adjustment, end to end with a real returned order.
  const returnedOrder = await prisma.storeOrder.create({
    data: {
      storeId: store.id,
      orderNumber: "PS1-0001",
      status: "returned",
      customerName: "زبون المرتجع",
      totalIqd: 12000,
      subtotalIqd: 10000,
      deliveryFeeIqd: 2000,
    },
  });
  await prisma.ledgerEntry.create({
    data: {
      storeId: store.id,
      orderId: returnedOrder.id,
      entryType: "order_completed",
      subtotalIqd: 10000,
      deliveryFeeIqd: 2000,
      commissionIqd: 250,
      commissionBps: 250,
      planCode: "free",
    },
  });
  const adjustment = await request("/platform/finance/adjustments", {
    method: "POST",
    token: accToken,
    body: { orderId: returnedOrder.id, note: "تسوية اختبار 19ب" },
  });
  assert.equal(adjustment.status, 201, JSON.stringify(adjustment.payload));
  bump();
  const adjustmentAudit = await prisma.platformAuditEvent.findFirst({
    where: { action: "adjustment_created" },
  });
  assert.equal(adjustmentAudit.actorKind, "platform_staff");
  assert.equal(adjustmentAudit.actorId, accId);

  assert.equal(
    await prisma.platformAuditEvent.count(),
    auditExpected,
    "19-ب: the attribution group also wrote exactly one row per act"
  );
  const liveActions = await prisma.platformAuditEvent.findMany({
    select: { action: true },
    distinct: ["action"],
  });
  summary.attribution = {
    staffSettlement: "settled_by_staff_id",
    ownerSettlement: "platform_owner_id",
    staffDecision: "decided_by_staff_id",
    auditedActionsSeen: liveActions.length,
  };

  // ============================================================
  // 11. The generic account surfaces serve the fifth kind.
  // ============================================================
  const accTokenB = (await staffLogin(accEmail, staffPassword, accSecret)).payload.accessToken;
  const sessions = await request("/auth/sessions", { token: accToken });
  assert.equal(sessions.status, 200, JSON.stringify(sessions.payload));
  assert.ok(sessions.payload.sessions.length >= 2, "19-ب: both live sessions are listed");
  assert.equal(
    sessions.payload.sessions.filter((row) => row.current).length,
    1,
    "19-ب: the caller can find himself"
  );
  const currentId = sessions.payload.sessions.find((row) => row.current).id;
  const otherId = sessions.payload.sessions.find((row) => !row.current).id;

  const revokeCurrent = await request(`/auth/sessions/${currentId}`, {
    method: "DELETE",
    token: accToken,
  });
  assert.equal(revokeCurrent.status, 422);
  assert.equal(revokeCurrent.payload.error.code, "CANNOT_REVOKE_CURRENT_SESSION");
  assert.equal(
    (await request(`/auth/sessions/${otherId}`, { method: "DELETE", token: accToken })).status,
    204
  );
  assert.equal(
    (await request("/platform/staff/session", { token: accTokenB })).status,
    401,
    "19-ب: the revoked sibling is dead"
  );

  const newPassword = "Ps1NewStaffPass2026!";
  const changed = await request("/auth/password", {
    method: "POST",
    token: accToken,
    body: { currentPassword: staffPassword, newPassword },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  assert.equal(typeof changed.payload.otherSessionsEnded, "number");
  assert.equal(
    (
      await request(loginUrl, {
        method: "POST",
        body: { email: accEmail, password: staffPassword, totpCode: codeFor(accSecret) },
      })
    ).status,
    401,
    "19-ب: the old password is gone everywhere"
  );
  const newLogin = await staffLogin(accEmail, newPassword, accSecret);
  assert.equal(newLogin.status, 200, "19-ب: the new password + factor signs in");

  assert.equal((await request("/auth/logout", { method: "POST", token: accToken })).status, 204);
  assert.equal(
    (await request("/platform/staff/session", { token: accToken })).status,
    401,
    "19-ب: logout ends the session it came from"
  );
  summary.accountSurfaces = {
    sessions: true,
    revokeCurrentRefused: "CANNOT_REVOKE_CURRENT_SESSION",
    passwordChange: true,
    logout: true,
  };

  // The plans THIS suite minted must not leak into /public/plans — phase 17
  // asserts the exact migration-seeded count. Nothing subscribes to them, so
  // the delete is safe (features cascade; audit rows carry no FK by design).
  await sql.query("DELETE FROM plans WHERE code LIKE 'ps1-%'");

  summary.auditRows = auditExpected;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

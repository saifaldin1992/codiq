/**
 * PC-1 — «معلومات التواصل» as settings, and the owner's own sign-in email.
 *
 * The owner asked for two things on 2026-09-04: new contact details, and BUTTONS
 * so that the next change is his and not an engineer's. This suite holds down the
 * promises that make the buttons safe, each of which is cheap to break silently:
 *
 *   1. THE PUBLIC READ PUBLISHES EXACTLY THREE FIELDS. It is the one endpoint on
 *      the contact surface that needs no session, so it is the one that must be
 *      proven not to carry anything else — and never the owner's LOGIN address,
 *      which lives one table away and is a different thing entirely.
 *   2. AN EMPTY TABLE IS STILL A CORRECT ANSWER. The defaults live in the code,
 *      so a fresh database, a restored backup and a laptop are all right before
 *      anybody seeds anything.
 *   3. WRITING IS THE OWNER'S ALONE. Not «a platform session» — a platform-staff
 *      supervisor holding all nine permission codes is refused, because no code
 *      grants the platform's own published channels.
 *   4. WHATSAPP FOLLOWS THE PHONE UNLESS IT IS SET. Proven the only way that
 *      means anything: change the phone afterwards and watch WhatsApp move.
 *   5. CHANGING THE OWNER'S EMAIL IS RE-AUTHENTICATED, LEAVES THE PASSWORD
 *      ALONE, AND LEAVES HIM SIGNED IN. The password hash is compared byte for
 *      byte before and after, and the old password is used to sign in again
 *      under the NEW address — «و لا حاجة لتغيير كلمة السر», tested rather than
 *      promised.
 *   6. AN ADDRESS HELD BY ANOTHER IDENTITY IS A 409, NOT A 500. The database
 *      trigger is the authority; this proves its refusal reaches the owner as a
 *      sentence he can act on.
 *   7. EVERY WRITE LEAVES AN AUDIT ROW, with the metadata that makes the row
 *      worth having — both addresses for an email change.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const testId = `pc1-${Date.now()}`;
process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "pc1-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { totpForCounter, base32Decode, currentStep } = await import("../src/auth/totp.ts");
const { DEFAULT_PLATFORM_CONTACT } = await import("../src/services/platform-contact.service.ts");
const { PLATFORM_PERMISSION_CODES } = await import("../src/auth/platform-permissions.ts");

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
await prisma.$executeRawUnsafe(
  "TRUNCATE TABLE storefront_rate_limits, platform_staff_sessions, platform_staff_permission_overrides, platform_audit_events, platform_staff, staff_sessions, store_staff_memberships, staff, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
);

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, keepRateLimits = false } = {}) {
  if (method !== "GET" && !keepRateLimits) await sql.query("DELETE FROM storefront_rate_limits");
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
  return { status: response.status, payload, headers: response.headers };
}

const codeFor = (secret, step = currentStep()) => totpForCounter(base32Decode(secret), step);
const auditRows = (action) =>
  sql.query("SELECT * FROM platform_audit_events WHERE action = $1 ORDER BY created_at DESC", [
    action,
  ]);
const contactRow = (key) => sql.query("SELECT value FROM platform_settings WHERE key = $1", [key]);

const summary = {};

try {
  // =========================================================================
  // 0. THE THREE COPIES OF THE DEFAULTS AGREE.
  //
  // The values live in three places by necessity — the service (the authority),
  // the migration seed, and the landing page's compiled-in fallback, which
  // cannot import from the backend. Three copies that nobody compares are three
  // copies that will disagree, and the disagreement would surface as a footer
  // showing a phone number the platform no longer answers.
  // =========================================================================
  const migrationSql = readFileSync(
    fileURLToPath(
      new URL(
        "../../prisma/migrations/20260904200000_pc1_platform_contact_settings/migration.sql",
        import.meta.url
      )
    ),
    "utf8"
  );
  assert.ok(
    migrationSql.includes(`'${DEFAULT_PLATFORM_CONTACT.email}'`),
    "PC-1: the migration seeds the SAME contact email the service defaults to"
  );
  assert.ok(
    migrationSql.includes(`'${DEFAULT_PLATFORM_CONTACT.phone}'`),
    "PC-1: …and the same phone"
  );
  const clientFallback = readFileSync(
    fileURLToPath(new URL("../../client/src/lib/platform-contact.ts", import.meta.url)),
    "utf8"
  );
  assert.ok(
    clientFallback.includes(`"${DEFAULT_PLATFORM_CONTACT.email}"`),
    "PC-1: the landing's compiled-in fallback carries the same email"
  );
  assert.ok(
    clientFallback.includes(`"${DEFAULT_PLATFORM_CONTACT.phone}"`),
    "PC-1: …and the same phone, so first paint is never wrong"
  );
  summary.defaultsMirrored = ["service", "migration seed", "client fallback"];

  // =========================================================================
  // 1. AN EMPTY TABLE IS A CORRECT ANSWER.
  // =========================================================================
  await sql.query("DELETE FROM platform_settings WHERE key LIKE 'platform.contact.%'");
  const bare = await request("/public/contact");
  assert.equal(bare.status, 200, JSON.stringify(bare.payload));
  assert.equal(
    bare.payload.contact.email,
    DEFAULT_PLATFORM_CONTACT.email,
    "PC-1: with no rows at all the platform still publishes a real email"
  );
  assert.equal(bare.payload.contact.phone, DEFAULT_PLATFORM_CONTACT.phone);
  assert.equal(
    bare.payload.contact.whatsapp,
    DEFAULT_PLATFORM_CONTACT.phone,
    "PC-1: and WhatsApp follows the phone when nothing separate is stored"
  );

  // EXACTLY three fields. Named one by one rather than counted, so the day a
  // fourth is added the failure says WHICH one leaked.
  assert.deepEqual(
    Object.keys(bare.payload.contact).sort(),
    ["email", "phone", "whatsapp"],
    "PC-1: the public read publishes three fields and nothing else"
  );
  assert.deepEqual(
    Object.keys(bare.payload).sort(),
    ["contact"],
    "PC-1: …inside one envelope key, with no siblings"
  );
  assert.equal(
    bare.payload.contact.whatsappIsSeparate,
    undefined,
    "PC-1: the owner-only flag never crosses to the public surface"
  );
  assert.ok(
    bare.headers.get("cache-control")?.includes("max-age="),
    "PC-1: the landing's request is cacheable — it is under a speed budget (ق-137)"
  );
  summary.publicRead = {
    fields: ["email", "phone", "whatsapp"],
    sessionRequired: false,
    cacheControl: bare.headers.get("cache-control"),
  };

  // =========================================================================
  // 2. Identities.
  // =========================================================================
  const ownerEmail = `${testId}-owner@codiq.test`;
  const ownerPassword = "Pc1OwnerPass2026!";
  const ownerReg = await request("/auth/platform/register", {
    method: "POST",
    body: { email: ownerEmail, password: ownerPassword, displayName: "مالك المنصة" },
  });
  assert.equal(ownerReg.status, 201, JSON.stringify(ownerReg.payload));
  const ownerId = ownerReg.payload.account.id;
  const ownerToken = (
    await request("/auth/platform/login", {
      method: "POST",
      body: { email: ownerEmail, password: ownerPassword },
    })
  ).payload.accessToken;

  const merchantEmail = `${testId}-merchant@codiq.test`;
  const merchantPassword = "Pc1MerchantPass2026!";
  const merchantReg = await registerMerchantDirect({
    email: merchantEmail,
    password: merchantPassword,
    businessName: "متجر التواصل",
    ownerName: "صاحب المتجر",
    phone: `+9647${String(Date.now()).slice(-9)}`,
  });
  assert.equal(merchantReg.status, 201, JSON.stringify(merchantReg.payload));
  await prisma.store.create({
    data: {
      merchantId: merchantReg.payload.account.id,
      name: "متجر التواصل",
      slug: `${testId}-store`,
      defaultSubdomain: `${testId}-store`,
    },
  });
  const merchantToken = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: merchantEmail, password: merchantPassword },
    })
  ).payload.accessToken;

  // A SUPERVISOR — the platform-staff role that holds every permission code
  // there is. If any session other than the owner's could write these settings,
  // this is the one that would.
  const staffEmail = `${testId}-staff@codiq.test`;
  const staffPassword = "Pc1StaffPass2026!";
  const staffCreated = await request("/platform/staff/team", {
    method: "POST",
    token: ownerToken,
    body: {
      email: staffEmail,
      displayName: "المشرف العام",
      temporaryPassword: staffPassword,
      roleCode: "supervisor",
    },
  });
  assert.equal(staffCreated.status, 201, JSON.stringify(staffCreated.payload));
  assert.deepEqual(
    staffCreated.payload.member.permissions,
    [...PLATFORM_PERMISSION_CODES].sort(),
    "PC-1: the fixture really does hold every platform permission code"
  );
  const staffFirstToken = (
    await request("/auth/platform/staff/login", {
      method: "POST",
      body: { email: staffEmail, password: staffPassword },
    })
  ).payload.accessToken;
  const staffSecret = (
    await request("/platform/staff/security/totp/begin", { method: "POST", token: staffFirstToken })
  ).payload.secret;
  assert.equal(
    (
      await request("/platform/staff/security/totp/confirm", {
        method: "POST",
        token: staffFirstToken,
        body: { code: codeFor(staffSecret) },
      })
    ).status,
    200
  );
  const staffLogin = await request("/auth/platform/staff/login", {
    method: "POST",
    body: {
      email: staffEmail,
      password: staffPassword,
      totpCode: codeFor(staffSecret, currentStep() + 1),
    },
  });
  assert.equal(staffLogin.status, 200, JSON.stringify(staffLogin.payload));
  const staffToken = staffLogin.payload.accessToken;
  assert.equal(
    (await request("/platform/overview", { token: staffToken })).status,
    200,
    "PC-1: the supervisor's session really works on the surfaces his role DOES grant"
  );

  // =========================================================================
  // 3. Writing the contact details is the OWNER'S alone.
  // =========================================================================
  const goodBody = { email: "contact@codiq.test", phone: "07711122233", whatsapp: null };
  assert.equal(
    (await request("/platform/settings/contact")).status,
    401,
    "PC-1: no session cannot read the owner view"
  );
  assert.equal(
    (await request("/platform/settings/contact", { method: "PUT", body: goodBody })).status,
    401,
    "PC-1: nor write"
  );
  assert.equal(
    (
      await request("/platform/settings/contact", {
        method: "PUT",
        token: merchantToken,
        body: goodBody,
      })
    ).status,
    403,
    "PC-1: a merchant session is refused at the identity boundary"
  );
  const staffAttempt = await request("/platform/settings/contact", {
    method: "PUT",
    token: staffToken,
    body: goodBody,
  });
  assert.equal(staffAttempt.status, 403, JSON.stringify(staffAttempt.payload));
  assert.equal(
    staffAttempt.payload.error.code,
    "IDENTITY_BOUNDARY_DENIED",
    "PC-1: a supervisor with ALL NINE permission codes is still refused — no code grants the platform's own channels"
  );
  assert.equal(
    (await request("/platform/settings/contact", { token: staffToken })).status,
    403,
    "PC-1: …and he cannot read the owner view either"
  );
  // Nothing above wrote anything.
  assert.equal(
    (await contactRow("platform.contact.email")).rowCount,
    0,
    "PC-1: four refusals left the settings table exactly as it was"
  );
  summary.ownerOnly = { anonymous: 401, merchant: 403, supervisorWithAllNinePermissions: 403 };

  // =========================================================================
  // 4. Format rules, spoken by the surface that owns them.
  // =========================================================================
  const badEmail = await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { ...goodBody, email: "not-an-email" },
  });
  assert.equal(badEmail.payload.error.code, "INVALID_EMAIL", JSON.stringify(badEmail.payload));
  const landline = await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { ...goodBody, phone: "+96417778899" },
  });
  assert.equal(landline.status, 422, JSON.stringify(landline.payload));
  assert.equal(
    landline.payload.error.code,
    "INVALID_PLATFORM_CONTACT_PHONE",
    "PC-1: a landline is refused — this number is a WhatsApp channel"
  );
  assert.match(
    landline.payload.error.message,
    /[؀-ۿ]/,
    "PC-1: and it is refused in Arabic, on an Arabic-first platform"
  );
  assert.ok(
    landline.payload.error.message.includes("رقم التواصل"),
    "PC-1: the sentence names the FIELD the owner was editing, not «رقم الهاتف» generically"
  );
  const badWhatsapp = await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { ...goodBody, whatsapp: "12345" },
  });
  assert.ok(
    badWhatsapp.payload.error.message.includes("رقم واتساب"),
    "PC-1: …and the WhatsApp field is named as itself"
  );
  const missingField = await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { email: "a@b.co" },
  });
  assert.equal(missingField.status, 422);
  assert.equal(
    missingField.payload.error.code,
    "VALIDATION_FAILED",
    "PC-1: shape is the schema's answer, format is the service's (19-ج)"
  );
  assert.equal(
    (await contactRow("platform.contact.email")).rowCount,
    0,
    "PC-1: no refused write left a partial row behind"
  );

  // =========================================================================
  // 5. The real write, and WhatsApp following the phone.
  // =========================================================================
  const saved = await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { email: "CODIQ.Iraq@Example.test", phone: "07711122233", whatsapp: "" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(
    saved.payload.contact.email,
    "codiq.iraq@example.test",
    "PC-1: the address is normalized once, by the same function the login door uses"
  );
  assert.equal(
    saved.payload.contact.phone,
    "+9647711122233",
    "PC-1: the local 07… form an Iraqi actually types is stored as E.164"
  );
  assert.equal(saved.payload.contact.whatsapp, "+9647711122233");
  assert.equal(
    saved.payload.contact.whatsappIsSeparate,
    false,
    "PC-1: an empty box means «the same number», not «this number»"
  );
  assert.equal(
    (await contactRow("platform.contact.whatsapp")).rowCount,
    0,
    "PC-1: …and «the same number» is stored as an ABSENT row, never as a copy"
  );

  // The public read reflects it AT ONCE — an owner who saves and then looks must
  // not be shown what he just replaced (the in-process memo is invalidated by
  // the writer, not merely left to expire).
  const published = await request("/public/contact");
  assert.equal(
    published.payload.contact.email,
    "codiq.iraq@example.test",
    "PC-1: what he saved is what the world reads, immediately"
  );
  assert.equal(published.payload.contact.whatsapp, "+9647711122233");

  // A SEPARATE WhatsApp number.
  const split = await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { email: "codiq.iraq@example.test", phone: "07711122233", whatsapp: "07800011122" },
  });
  assert.equal(split.payload.contact.whatsapp, "+9647800011122");
  assert.equal(split.payload.contact.whatsappIsSeparate, true);
  assert.equal(
    (await request("/public/contact")).payload.contact.whatsapp,
    "+9647800011122",
    "PC-1: the two numbers may differ, and both are published"
  );

  // A WhatsApp number EQUAL to the phone is stored as «follows», not as a copy —
  // and this is the assertion that proves it matters: change the phone, and
  // WhatsApp moves with it instead of pointing at last month's number.
  await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { email: "codiq.iraq@example.test", phone: "07711122233", whatsapp: "+9647711122233" },
  });
  assert.equal(
    (await contactRow("platform.contact.whatsapp")).rowCount,
    0,
    "PC-1: WhatsApp equal to the phone is not stored as an override"
  );
  const moved = await request("/platform/settings/contact", {
    method: "PUT",
    token: ownerToken,
    body: { email: "codiq.iraq@example.test", phone: "07733344455", whatsapp: "" },
  });
  assert.equal(
    moved.payload.contact.whatsapp,
    "+9647733344455",
    "PC-1: changing the phone moves WhatsApp with it — the whole point of not storing a copy"
  );
  summary.whatsapp = {
    absentRowMeans: "follows the phone",
    separateNumberSupported: true,
    equalToPhoneStoredAs: "absent row",
  };

  // =========================================================================
  // 6. The audit rows.
  // =========================================================================
  const contactAudit = await auditRows("contact_details_changed");
  assert.ok(
    contactAudit.rowCount >= 4,
    `PC-1: every accepted write left a row (${contactAudit.rowCount})`
  );
  const latest = contactAudit.rows[0];
  assert.equal(latest.entity_type, "platform_contact");
  assert.equal(latest.actor_kind, "platform_owner");
  assert.equal(latest.actor_id, ownerId);
  assert.equal(latest.entity_label, "معلومات التواصل");
  assert.equal(
    latest.metadata.phone,
    "+9647733344455",
    "PC-1: the row records WHAT was set, so «who changed the platform's number» is answerable"
  );
  assert.equal(latest.metadata.whatsappIsSeparate, false);
  // The refused writes above must NOT appear — an audit log that records
  // attempts as if they were changes is a log that lies.
  assert.equal(
    contactAudit.rowCount,
    4,
    "PC-1: exactly the four ACCEPTED writes — no refusal was recorded as a change"
  );

  // =========================================================================
  // 7. The owner's own sign-in email.
  // =========================================================================
  const hashBefore = (
    await prisma.platformOwner.findUnique({
      where: { id: ownerId },
      select: { passwordHash: true },
    })
  ).passwordHash;
  const accountView = await request("/platform/security/account", { token: ownerToken });
  assert.equal(accountView.status, 200, JSON.stringify(accountView.payload));
  assert.equal(accountView.payload.account.email, ownerEmail);

  const newOwnerEmail = `${testId}-owner-new@codiq.test`;
  assert.equal(
    (
      await request("/platform/security/email", {
        method: "POST",
        body: { currentPassword: ownerPassword, email: newOwnerEmail },
      })
    ).status,
    401,
    "PC-1: no session cannot change the owner's address"
  );
  assert.equal(
    (
      await request("/platform/security/email", {
        method: "POST",
        token: merchantToken,
        body: { currentPassword: merchantPassword, email: newOwnerEmail },
      })
    ).status,
    403,
    "PC-1: nor a merchant's"
  );
  assert.equal(
    (
      await request("/platform/security/email", {
        method: "POST",
        token: staffToken,
        body: { currentPassword: staffPassword, email: newOwnerEmail },
      })
    ).status,
    403,
    "PC-1: nor a supervisor's"
  );

  const wrongPassword = await request("/platform/security/email", {
    method: "POST",
    token: ownerToken,
    body: { currentPassword: "not-his-password", email: newOwnerEmail },
  });
  assert.equal(wrongPassword.status, 422, JSON.stringify(wrongPassword.payload));
  assert.equal(
    wrongPassword.payload.error.code,
    "INVALID_PASSWORD",
    "PC-1: a live session is NOT enough — a borrowed unlocked laptop must not seize the account"
  );
  // Review batch 3, م-٣: …and the borrowed session cannot GUESS the password here either. The
  // password change and the 2FA switch-off share a re-verification budget; this door had none.
  const guesses = [];
  for (let n = 0; n < 12; n += 1)
    guesses.push(
      (
        await request("/platform/security/email", {
          method: "POST",
          token: ownerToken,
          body: { currentPassword: `guess-${n}-not-his`, email: newOwnerEmail },
          keepRateLimits: true,
        })
      ).payload?.error?.code
    );
  assert.ok(guesses.includes("RATE_LIMITED"), `the guessing stops · ${guesses.join(",")}`);
  await prisma.storefrontRateLimit.deleteMany({ where: { scope: "password_reverify" } });

  const unchanged = await request("/platform/security/email", {
    method: "POST",
    token: ownerToken,
    body: { currentPassword: ownerPassword, email: ownerEmail.toUpperCase() },
  });
  assert.equal(
    unchanged.payload.error.code,
    "EMAIL_UNCHANGED",
    "PC-1: his existing address (in any case) is refused rather than reported as a change"
  );

  // THE CROSS-IDENTITY REFUSAL. The trigger raises 23505; the platform must show
  // the owner a 409 he can act on, never a 500 that reads as a broken platform.
  const taken = await request("/platform/security/email", {
    method: "POST",
    token: ownerToken,
    body: { currentPassword: ownerPassword, email: merchantEmail },
  });
  assert.equal(taken.status, 409, JSON.stringify(taken.payload));
  assert.equal(
    taken.payload.error.code,
    "EMAIL_RESERVED_FOR_PLATFORM_OWNER",
    "PC-1: an address held by a merchant is a clean conflict, not a server fault"
  );
  const takenByStaff = await request("/platform/security/email", {
    method: "POST",
    token: ownerToken,
    body: { currentPassword: ownerPassword, email: staffEmail },
  });
  assert.equal(takenByStaff.status, 409, "PC-1: …and so is one held by platform staff");
  assert.equal(
    (await prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { email: true } }))
      .email,
    ownerEmail,
    "PC-1: every refusal above left his address alone"
  );

  const changed = await request("/platform/security/email", {
    method: "POST",
    token: ownerToken,
    body: { currentPassword: ownerPassword, email: newOwnerEmail },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.email, newOwnerEmail);
  assert.equal(changed.payload.previousEmail, ownerEmail);

  // «و لا حاجة لتغيير كلمة السر» — the hash is byte-identical, and the old
  // password signs him in under the NEW address.
  const hashAfter = (
    await prisma.platformOwner.findUnique({
      where: { id: ownerId },
      select: { passwordHash: true },
    })
  ).passwordHash;
  assert.equal(
    hashAfter,
    hashBefore,
    "PC-1: the password hash is untouched — the owner asked for exactly this"
  );
  assert.equal(
    (
      await request("/auth/platform/login", {
        method: "POST",
        body: { email: ownerEmail, password: ownerPassword },
      })
    ).status,
    401,
    "PC-1: the old address no longer signs him in"
  );
  const reloggedIn = await request("/auth/platform/login", {
    method: "POST",
    body: { email: newOwnerEmail, password: ownerPassword },
  });
  assert.equal(reloggedIn.status, 200, JSON.stringify(reloggedIn.payload));

  // …AND HE WAS NEVER SIGNED OUT. Unlike a password change, an email change
  // reveals nothing and invalidates nothing, so the session he is holding lives.
  assert.equal(
    (await request("/auth/sessions", { token: ownerToken })).status,
    200,
    "PC-1: the session he changed it from is still his"
  );
  assert.equal(
    (await request("/platform/security/account", { token: ownerToken })).payload.account.email,
    newOwnerEmail,
    "PC-1: and it now reads the new address"
  );

  const emailAudit = await auditRows("owner_email_changed");
  assert.equal(
    emailAudit.rowCount,
    1,
    "PC-1: one accepted change, one row — the refusals recorded nothing"
  );
  assert.equal(emailAudit.rows[0].entity_type, "platform_account");
  assert.equal(emailAudit.rows[0].entity_id, ownerId);
  assert.equal(
    emailAudit.rows[0].metadata.from,
    ownerEmail,
    "PC-1: the row says where it came FROM — a line that only says «changed» cannot answer the question it was written for"
  );
  assert.equal(emailAudit.rows[0].metadata.to, newOwnerEmail);
  summary.ownerEmail = {
    reauthentication: "current password",
    passwordHashUnchanged: true,
    sessionSurvives: true,
    crossIdentityConflict: 409,
  };

  // =========================================================================
  // 8. The two things must never be confused.
  // =========================================================================
  const finalPublic = await request("/public/contact");
  const asText = JSON.stringify(finalPublic.payload);
  assert.ok(
    !asText.includes(newOwnerEmail) && !asText.includes(ownerEmail),
    "PC-1: the owner's SIGN-IN address is not, and must never become, a published contact detail"
  );
  assert.equal(
    finalPublic.payload.contact.email,
    "codiq.iraq@example.test",
    "PC-1: the published email is the SETTING, independent of whoever signs in"
  );
  summary.loginAndContactAreSeparate = true;

  console.log(
    JSON.stringify({ suite: "pc1-platform-contact", status: "passed", summary }, null, 2)
  );
  console.log("pc1 OK");
} finally {
  await sql.end().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  server.close();
}

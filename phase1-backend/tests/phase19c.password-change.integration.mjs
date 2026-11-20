/**
 * codiq phase 19-أ — changing your own password (ق-48).
 *
 * Until this, NOBODY on the platform could change a password — not the owner,
 * not a merchant, not a staff member, not a customer. The advice everyone gives
 * after a leak, "change it immediately", had no button behind it.
 *
 * What this suite holds down:
 *
 *   1. THE CURRENT PASSWORD IS REQUIRED — a live session alone must not be
 *      enough, or a borrowed unlocked laptop seizes the account;
 *   2. A CHANGE THAT CHANGES NOTHING IS REFUSED — otherwise a leaked password
 *      stays live while he is told it does not;
 *   3. THE PLATFORM'S ONE POLICY APPLIES — the floor (8), from the single place
 *      that defines it, and said in Arabic;
 *   4. EVERY OTHER SESSION DIES, and this is the assertion that matters: the
 *      other session must be verifiably DEAD afterwards, not merely reported as
 *      revoked. A count is a claim; a 401 is the fact;
 *   5. THE CURRENT SESSION SURVIVES — logging him out at the moment he did the
 *      right thing teaches him not to do it again;
 *   6. THE OLD PASSWORD STOPS WORKING AND THE NEW ONE STARTS;
 *   7. IT IS NOT OWNER-ONLY — the whole sequence runs again as a merchant,
 *      because one service serving four identities is only worth it if a second
 *      identity is actually exercised.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `p19c-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "p19c-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, keepRateLimits = false } = {}) {
  // `keepRateLimits` exists for ONE block: the 19-د ceiling proof below. Every
  // other call clears the buckets so an unrelated limit never colours a result.
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
  return { status: response.status, payload };
}

const summary = {};

/**
 * The whole sequence, for one identity.
 *
 * Taking `login` as a function is what lets an owner and a merchant run the
 * IDENTICAL assertions. If the second identity needed different expectations,
 * "one service for four identities" would be a claim rather than a fact.
 */
async function runFor(kind, { login, oldPassword, newPassword }) {
  // Two devices, both signed in — the situation the revoke exists for.
  const first = await login(oldPassword);
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  const held = first.payload.accessToken;
  const other = (await login(oldPassword)).payload.accessToken;
  assert.notEqual(held, other, `${kind}: two real, distinct sessions`);

  // Both alive BEFORE anything happens — otherwise the 401 below proves nothing.
  assert.equal((await request("/auth/sessions", { token: held })).status, 200, `${kind}: the held session starts alive`);
  assert.equal((await request("/auth/sessions", { token: other })).status, 200, `${kind}: the other session starts alive`);

  // 1. A live session is not enough.
  const wrong = await request("/auth/password", { method: "POST", token: held, body: { currentPassword: "not-the-password", newPassword } });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.payload));
  assert.equal(wrong.payload.error.code, "INVALID_PASSWORD", `${kind}: a borrowed unlocked laptop cannot seize the account`);

  // 2. A change that changes nothing.
  const same = await request("/auth/password", { method: "POST", token: held, body: { currentPassword: oldPassword, newPassword: oldPassword } });
  assert.equal(same.payload.error.code, "PASSWORD_UNCHANGED", `${kind}: refused, rather than reported as a change`);

  // 3. The platform's single policy, reached by calling it — not restated.
  const weak = await request("/auth/password", { method: "POST", token: held, body: { currentPassword: oldPassword, newPassword: "short1!" } });
  assert.equal(weak.payload.error.code, "WEAK_PASSWORD", `${kind}: the floor, from the one place that defines it`);
  assert.match(weak.payload.error.message, /[؀-ۿ]/, `${kind}: and it says so in Arabic — this is an Arabic-first platform`);

  // Nothing above changed anything: the old password still signs him in.
  assert.equal((await login(oldPassword)).status, 200, `${kind}: three refusals left the account exactly as it was`);

  // The real change.
  const changed = await request("/auth/password", { method: "POST", token: held, body: { currentPassword: oldPassword, newPassword } });
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  assert.ok(changed.payload.otherSessionsEnded >= 2, `${kind}: the other sessions are reported ended (${changed.payload.otherSessionsEnded})`);

  // 4. THE ASSERTION THAT MATTERS. Not the count — the 401.
  const otherNow = await request("/auth/sessions", { token: other });
  assert.equal(otherNow.status, 401, `${kind}: the other session is DEAD, not merely counted as revoked`);

  // 5. …and he is still signed in on the device he is holding.
  assert.equal((await request("/auth/sessions", { token: held })).status, 200, `${kind}: doing the right thing did not sign him out`);

  // 6. The old password is genuinely gone, and the new one genuinely works.
  assert.equal((await login(oldPassword)).status, 401, `${kind}: the old password no longer works`);
  const fresh = await login(newPassword);
  assert.equal(fresh.status, 200, `${kind}: and the new one does`);

  return { otherSessionsEnded: changed.payload.otherSessionsEnded, oldPasswordRejected: true };
}

try {
  await sql.query("DELETE FROM storefront_rate_limits");

  // ============================================================
  // The owner.
  // ============================================================
  const ownerEmail = `${testId}-owner@codiq.test`;
  const ownerOld = "P19cOwnerPass2026!";
  const ownerNew = "P19cOwnerFresh2026!";
  const ownerReg = await request("/auth/platform/register", {
    method: "POST",
    body: { email: ownerEmail, password: ownerOld, displayName: "مالك المنصة" },
  });
  assert.equal(ownerReg.status, 201, JSON.stringify(ownerReg.payload));
  const ownerId = ownerReg.payload.account.id;
  const hashBefore = (await prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { passwordHash: true } })).passwordHash;

  summary.owner = await runFor("owner", {
    login: (password) => request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password } }),
    oldPassword: ownerOld,
    newPassword: ownerNew,
  });

  const hashAfter = (await prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { passwordHash: true } })).passwordHash;
  assert.notEqual(hashAfter, hashBefore, "19-أ: the stored hash actually moved");
  assert.ok(hashAfter.startsWith("$2"), "19-أ: …and what replaced it is a bcrypt hash, not the password");
  assert.ok(!hashAfter.includes(ownerNew), "19-أ: …the new password is nowhere in the column");

  // Every other owner session row carries `revokedAt` — and, exactly as the
  // sessions work learned the hard way, `expiresAt` must be UNTOUCHED. Expiring
  // a session instead of revoking it kills the token just as dead, so an
  // implementation that did that would pass every assertion above this one.
  const rows = await sql.query(
    "SELECT revoked_at, expires_at > now() AS still_in_date FROM platform_owner_sessions WHERE platform_owner_id = $1",
    [ownerId],
  );
  const revoked = rows.rows.filter((row) => row.revoked_at !== null);
  assert.ok(revoked.length >= 2, "19-أ: the other sessions are revoked at the row level");
  assert.ok(
    revoked.every((row) => row.still_in_date),
    "19-أ: REVOKED, not quietly expired — the distinction the sessions work established",
  );

  // ============================================================
  // The merchant — proving one service really does serve four identities.
  // ============================================================
  const merchantEmail = `${testId}-merchant@codiq.test`;
  const merchantOld = "P19cMerchantPass2026!";
  const merchantNew = "P19cMerchantFresh2026!";
  const phone = `+9647${String(Date.now()).slice(-9)}`;
  const merchantReg = await registerMerchantDirect({ email: merchantEmail, password: merchantOld, businessName: "متجر النور", ownerName: "سيف الدين", phone });
  assert.equal(merchantReg.status, 201, JSON.stringify(merchantReg.payload));
  // A registered merchant cannot sign in until a store exists — the platform
  // refuses a merchant with no active store, which is its own correct rule and
  // not something this suite should route around.
  await prisma.store.create({
    data: { merchantId: merchantReg.payload.account.id, name: "متجر النور", slug: `${testId}-m`, defaultSubdomain: `${testId}-m` },
  });

  summary.merchant = await runFor("merchant", {
    login: (password) => request("/auth/merchant/login", { method: "POST", body: { identifier: merchantEmail, password } }),
    oldPassword: merchantOld,
    newPassword: merchantNew,
  });

  // ============================================================
  // 8. (19-د, ATTACK-SURFACE) THE GATE HAS A CEILING.
  //
  // Everything above proves the current password is REQUIRED. None of it asked
  // how many times it may be guessed, and the answer was: without limit. Sixty
  // consecutive wrong `currentPassword` values on one ordinary session returned
  // zero 429s. That is the exact attacker the service header names — someone who
  // already holds the session, a borrowed unlocked laptop, a lifted token — and
  // the requirement written to stop him was a speed bump he could drive over as
  // long as he liked. On success the service revokes every OTHER session, so the
  // legitimate owner is logged out and locked out in the same step.
  //
  // It also voids the platform's own argument for the 8-character floor
  // (password-policy.ts: guessing «is bounded by the rate limit already on every
  // login route») — this is not a login route.
  // ============================================================
  const { REAUTH_ATTEMPT_LIMIT } = await import("../src/services/storefront.service.ts");
  await sql.query("DELETE FROM storefront_rate_limits");
  const grindLogin = await request("/auth/merchant/login", { method: "POST", body: { identifier: merchantEmail, password: merchantNew } });
  assert.equal(grindLogin.status, 200, JSON.stringify(grindLogin.payload));
  const grindToken = grindLogin.payload.accessToken;
  const grind = [];
  for (let attempt = 0; attempt < REAUTH_ATTEMPT_LIMIT + 2; attempt += 1) {
    const response = await request("/auth/password", { method: "POST", token: grindToken, keepRateLimits: true, body: { currentPassword: `guess-${attempt}`, newPassword: "P19dGrindPass2026!" } });
    grind.push(response.status);
    if (response.status === 429) { assert.equal(response.payload.error.code, "RATE_LIMITED"); break; }
    assert.equal(response.status, 422, `19-د: attempt ${attempt} must be a refused guess, not ${response.status}`);
    assert.equal(response.payload.error.code, "INVALID_PASSWORD");
  }
  assert.ok(grind.includes(429), `19-د: unmetered guessing at the password gate — ${grind.length} wrong currentPassword values and not one 429 (${grind.join(",")})`);
  assert.ok(grind.length <= REAUTH_ATTEMPT_LIMIT + 1, `19-د: the ceiling must bite by attempt ${REAUTH_ATTEMPT_LIMIT + 1}`);

  // …and the honest path never walks toward its own lockout. The budget exists
  // to slow GUESSING, so a correct password gives its attempt straight back —
  // read off the bucket itself rather than inferred from a status code.
  await sql.query("DELETE FROM storefront_rate_limits");
  const honest = await request("/auth/password", { method: "POST", token: grindToken, keepRateLimits: true, body: { currentPassword: merchantNew, newPassword: "P19dHonestPass2026!" } });
  assert.equal(honest.status, 200, JSON.stringify(honest.payload));
  const bucket = await sql.query("SELECT attempt_count FROM storefront_rate_limits WHERE scope = 'password_reverify'");
  assert.equal(bucket.rows.length, 1, "19-د: the gate must be keyed on the subject, so exactly one bucket exists for one account");
  assert.equal(Number(bucket.rows[0].attempt_count), 1, "19-د: a correct password must be refunded — ten honest changes must not lock the account out");
  summary.reauthCeiling = { limit: REAUTH_ATTEMPT_LIMIT, attemptsBefore429: grind.length - 1, refundedTo: Number(bucket.rows[0].attempt_count) };
  await sql.query("DELETE FROM storefront_rate_limits");

  summary.identitiesCovered = ["platform_owner", "merchant"];
  summary.currentSessionSurvives = true;
  summary.otherSessionsDieWith = 401;

  console.log(JSON.stringify({ phase19c: summary }, null, 2));
  console.log("phase19c OK");
} finally {
  await sql.end().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  server.close();
}

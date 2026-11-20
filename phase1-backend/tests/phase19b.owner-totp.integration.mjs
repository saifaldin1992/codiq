/**
 * codiq phase 19-أ — the owner's second factor (ق-48, ق-123).
 *
 * The acceptance gate for this phase is one sentence: signing in to the owner
 * account without the second factor is refused. Everything below exists to make
 * that true and to keep it survivable:
 *
 *   1. THE ALGORITHM IS THE STANDARD — verified against RFC 6238's own published
 *      vectors, which is what makes writing it rather than installing it safe;
 *   2. OFF BY DEFAULT, AND LOGIN IS UNCHANGED — every existing client and test
 *      sees the login it always saw, key for key;
 *   3. ENROLMENT IS TWO STEPS — a secret alone enables nothing; a working code
 *      from the app is required first, so a blurry QR cannot lock him out;
 *   4. ONCE ENABLED, A PASSWORD ALONE IS REFUSED — the gate, asserted directly;
 *   5. A CODE IS SINGLE-USE — the same one is refused the second time, so a code
 *      read over a shoulder is not ninety usable seconds;
 *   6. RECOVERY CODES WORK, ARE SINGLE-USE, AND ARE NEVER READABLE TWICE — this
 *      platform has one owner and nobody above him to restore access;
 *   7. TURNING IT OFF NEEDS THE PASSWORD, not merely a live session — otherwise
 *      a borrowed unlocked laptop removes the protection in two clicks.
 */
import assert from "node:assert/strict";
import { Client } from "pg";

const testId = `p19b-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "p19b-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { totpForCounter, base32Decode, currentStep, TOTP_STEP_SECONDS } = await import("../src/auth/totp.ts");

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

/** The code the owner's phone would be showing right now. */
const codeFor = (secret, step = currentStep()) => totpForCounter(base32Decode(secret), step);

const summary = {};

try {
  await sql.query("DELETE FROM storefront_rate_limits");

  const email = `${testId}@codiq.test`;
  const password = "P19bOwnerPass2026!";
  const registered = await request("/auth/platform/register", { method: "POST", body: { email, password, displayName: "مالك المنصة" } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  // Scoped to THIS owner everywhere below: the table is shared, and a previous
  // run of this suite leaves its own ten rows behind.
  const ownerId = registered.payload.account.id;

  // ============================================================
  // 2. Off by default, and the login is byte-for-byte the old one.
  // ============================================================
  const plain = await request("/auth/platform/login", { method: "POST", body: { email, password } });
  assert.equal(plain.status, 200, JSON.stringify(plain.payload));
  assert.deepEqual(
    Object.keys(plain.payload).sort(),
    ["accessToken", "redirectTo"],
    "19-أ: with no factor enrolled the login answers exactly what it always answered — no new keys for existing clients",
  );
  const token = plain.payload.accessToken;
  assert.equal((await request("/platform/security/totp", { token })).payload.totp.enabled, false, "19-أ: nobody is enrolled until he asks");

  // ============================================================
  // 3. Enrolment is two steps.
  // ============================================================
  const begun = await request("/platform/security/totp/begin", { method: "POST", token });
  assert.equal(begun.status, 200, JSON.stringify(begun.payload));
  const secret = begun.payload.secret;
  assert.match(begun.payload.uri, /^otpauth:\/\/totp\//, "19-أ: an app can be enrolled from the URI");
  assert.match(begun.payload.uri, /issuer=Codiq/, "19-أ: …and it says which service the code belongs to");
  assert.ok(begun.payload.uri.includes(secret), "19-أ: the QR carries the secret the app must store");

  // A secret alone changes nothing: the factor is still off and login untouched.
  assert.equal((await request("/platform/security/totp", { token })).payload.totp.enabled, false, "19-أ: beginning enrolment enables NOTHING — a blurry QR must not lock him out");
  assert.equal((await request("/auth/platform/login", { method: "POST", body: { email, password } })).status, 200, "19-أ: …and he can still sign in with the password alone");

  assert.equal((await request("/platform/security/totp/confirm", { method: "POST", token, body: { code: "000000" } })).payload.error.code, "INVALID_TOTP_CODE", "19-أ: a wrong code does not enable it");
  assert.equal((await request("/platform/security/totp", { token })).payload.totp.enabled, false);

  const confirmed = await request("/platform/security/totp/confirm", { method: "POST", token, body: { code: codeFor(secret) } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.payload));
  const recoveryCodes = confirmed.payload.recoveryCodes;
  assert.equal(recoveryCodes.length, 10, "19-أ: ten recovery codes — one owner, no support desk above him");
  assert.ok(recoveryCodes.every((code) => /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code)), `19-أ: readable off a screen — ${recoveryCodes[0]}`);
  assert.ok(!recoveryCodes.some((code) => /[ILOU]/.test(code)), "19-أ: no I, L, O or U — the four a person mistypes under stress");

  // They are hashed the moment they are handed over, and never readable again.
  const stored = await prisma.platformOwnerRecoveryCode.findMany({ where: { platformOwnerId: ownerId, usedAt: null }, select: { codeHash: true } });
  assert.equal(stored.length, 10);
  assert.ok(stored.every((row) => row.codeHash.startsWith("$2")), "19-أ: stored as bcrypt — a recovery code IS a password");
  assert.ok(!stored.some((row) => recoveryCodes.includes(row.codeHash)), "19-أ: …so a database dump yields none of them");

  // ============================================================
  // 4. THE GATE: a password alone no longer signs him in.
  // ============================================================
  const withoutFactor = await request("/auth/platform/login", { method: "POST", body: { email, password } });
  assert.equal(withoutFactor.status, 401, JSON.stringify(withoutFactor.payload));
  assert.equal(withoutFactor.payload.error.code, "SECOND_FACTOR_REQUIRED", "19-أ: THE acceptance gate — the owner cannot sign in on a password alone");
  assert.ok(!withoutFactor.payload.accessToken, "19-أ: …and no token is issued");

  const wrongCode = await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: "000000" } });
  assert.equal(wrongCode.payload.error.code, "INVALID_SECOND_FACTOR");
  const wrongPassword = await request("/auth/platform/login", { method: "POST", body: { email, password: "not-his-password", totpCode: codeFor(secret) } });
  assert.equal(wrongPassword.payload.error.code, "INVALID_PLATFORM_OWNER_CREDENTIALS", "19-أ: a wrong password fails on the password, whatever the code");

  // The NEXT step's code, not this one: confirming enrolment spent the current
  // code, and single-use means exactly that. In real use he waits for his phone
  // to roll over — which is what anyone who has ever enrolled an authenticator
  // expects, and the price of a code that cannot be replayed.
  const step = currentStep() + 1;
  const good = await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: codeFor(secret, step) } });
  assert.equal(good.status, 200, JSON.stringify(good.payload));
  assert.ok(good.payload.accessToken, "19-أ: password plus code signs him in");
  assert.ok(!good.payload.usedRecoveryCode, "19-أ: …without spending a recovery code");

  // ============================================================
  // 5. A code is single-use.
  // ============================================================
  const replay = await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: codeFor(secret, step) } });
  assert.equal(replay.payload.error.code, "INVALID_SECOND_FACTOR", "19-أ: the SAME code is refused a second time — one read over a shoulder is not ninety usable seconds");
  // And so is an OLDER code that is still inside the ±1 window: arithmetically
  // valid, but from a step at or below the one already spent. This is the same
  // property from the other side, and it is testable now — whereas "the next
  // code works" would need a real thirty seconds of waiting.
  const stale = await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: codeFor(secret, step - 1) } });
  assert.equal(stale.payload.error.code, "INVALID_SECOND_FACTOR", "19-أ: a code from a spent step is refused even while its window is still open");

  // ============================================================
  // 6. Recovery codes: they work, once.
  // ============================================================
  const recovery = recoveryCodes[0];
  const rescued = await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: recovery } });
  assert.equal(rescued.status, 200, JSON.stringify(rescued.payload));
  assert.equal(rescued.payload.usedRecoveryCode, true, "19-أ: he is TOLD one was spent — a silent count is one he discovers at zero");
  const rescuedToken = rescued.payload.accessToken;
  assert.equal((await request("/platform/security/totp", { token: rescuedToken })).payload.totp.recoveryCodesLeft, 9, "19-أ: nine left, and he can see the number");

  assert.equal(
    (await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: recovery } })).payload.error.code,
    "INVALID_SECOND_FACTOR",
    "19-أ: a spent recovery code is refused — otherwise it is a permanent password past the factor",
  );
  // A different one still works: spending one does not spend the rest.
  assert.equal((await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: recoveryCodes[1] } })).status, 200);
  // Case and dashes never matter — he types these off a screen under stress.
  assert.equal((await request("/auth/platform/login", { method: "POST", body: { email, password, totpCode: recoveryCodes[2].toLowerCase().replace("-", " ") } })).status, 200, "19-أ: case and punctuation are forgiven");

  // ============================================================
  // 7. Turning it off needs the password.
  // ============================================================
  assert.equal((await request("/platform/security/totp/disable", { method: "POST", token: rescuedToken, body: { password: "wrong" } })).payload.error.code, "INVALID_PASSWORD", "19-أ: a live session alone must not remove the factor — a borrowed laptop would");
  assert.equal((await request("/platform/security/totp", { token: rescuedToken })).payload.totp.enabled, true, "19-أ: …and the refused attempt left it on");

  // 19-د (ATTACK-SURFACE): «needs the password» is only a defence if the number
  // of guesses is bounded. This gate had NO ceiling at all, and it is the gate
  // that REMOVES the second factor — the control password-policy.ts names as
  // the reason an 8-character floor is acceptable for the one account with
  // nobody above it. A stolen session could grind the password with no limit and
  // take the factor off. The consume sits ahead of the bcrypt compare, so a
  // grinder is refused before he spends the CPU too.
  await sql.query("DELETE FROM storefront_rate_limits");
  const { REAUTH_ATTEMPT_LIMIT } = await import("../src/services/storefront.service.ts");
  const disableGrind = [];
  for (let attempt = 0; attempt < REAUTH_ATTEMPT_LIMIT + 2; attempt += 1) {
    const response = await request("/platform/security/totp/disable", { method: "POST", token: rescuedToken, keepRateLimits: true, body: { password: `guess-${attempt}` } });
    disableGrind.push(response.status);
    if (response.status === 429) { assert.equal(response.payload.error.code, "RATE_LIMITED"); break; }
    assert.equal(response.payload.error.code, "INVALID_PASSWORD", `19-د: attempt ${attempt} must be a refused guess`);
  }
  assert.ok(disableGrind.includes(429), `19-د: unmetered guessing at the TOTP-disable gate — ${disableGrind.length} wrong passwords and not one 429 (${disableGrind.join(",")})`);
  assert.ok(disableGrind.length <= REAUTH_ATTEMPT_LIMIT + 1, `19-د: the ceiling must bite by attempt ${REAUTH_ATTEMPT_LIMIT + 1}`);
  assert.equal((await request("/platform/security/totp", { token: rescuedToken })).payload.totp.enabled, true, "19-د: …and the whole grind left the factor on");
  await sql.query("DELETE FROM storefront_rate_limits");

  assert.equal((await request("/platform/security/totp/disable", { method: "POST", token: rescuedToken, keepRateLimits: true, body: { password } })).status, 204);
  // The refund: the owner who typed his own password must not be one wrong
  // guess away from being locked out of his own security screen.
  const disableBucket = await sql.query("SELECT attempt_count FROM storefront_rate_limits WHERE scope = 'password_reverify'");
  assert.equal(Number(disableBucket.rows[0]?.attempt_count), 1, "19-د: a correct password is refunded down to the bucket's floor");
  await sql.query("DELETE FROM storefront_rate_limits");
  assert.equal((await request("/platform/security/totp", { token: rescuedToken })).payload.totp.enabled, false);
  assert.equal(await prisma.platformOwnerRecoveryCode.count({ where: { platformOwnerId: ownerId } }), 0, "19-أ: the recovery codes go with the factor — they were ways past a factor that no longer exists");
  assert.equal((await request("/auth/platform/login", { method: "POST", body: { email, password } })).status, 200, "19-أ: and the password alone signs him in again");

  summary.ownerTotp = {
    defaultEnabled: false,
    loginKeysWhenDisabled: Object.keys(plain.payload).sort(),
    enrolmentSteps: 2,
    passwordAloneOnceEnabled: withoutFactor.payload.error.code,
    codeReplay: replay.payload.error.code,
    recoveryCodes: recoveryCodes.length,
    recoveryCodesLeftAfterOne: 9,
    disableWithoutPassword: "INVALID_PASSWORD",
    disableReauthCeiling: { limit: REAUTH_ATTEMPT_LIMIT, attemptsBefore429: disableGrind.length - 1 },
    stepSeconds: TOTP_STEP_SECONDS,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

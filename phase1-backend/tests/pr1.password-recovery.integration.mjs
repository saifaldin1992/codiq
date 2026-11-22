/**
 * codiq PR-1 (19-أ) — «استعادة كلمة السر».
 *
 * Until this feature, a merchant who forgot his password needed a manual UPDATE
 * against the production database. There was no reset and no verified mail path
 * anywhere on the platform. That was the last launch blocker of phase 19.
 *
 * A reset link is an ACCOUNT TAKEOVER PRIMITIVE, so every assertion below is
 * written to fail if the corresponding protection is removed:
 *
 *   1. SINGLE USE — the second attempt with the same link is refused;
 *   2. EXPIRY — a link past its 45 minutes is refused;
 *   3. RE-ISSUE INVALIDATES — asking again kills the mail already in the inbox;
 *   4. A PASSWORD CHANGE INVALIDATES — remembering your password and changing it
 *      from inside the dashboard must not leave a live link pointed at it;
 *   5. CONSUMING INVALIDATES EVERY SIBLING — an older link dies with the one used;
 *   6. EVERY SESSION DIES — not «every other»: nobody is signed in, and the
 *      sessions that exist are the ones that might not be his. The assertion is
 *      the 401, never the count;
 *   7. THE ANSWER IS IDENTICAL FOR A KNOWN AND AN UNKNOWN ADDRESS — status, body
 *      AND the clock, measured with the same helper that caught the 25×–59×
 *      oracle on the five sign-in doors;
 *   8. BOTH ENDS ARE RATE LIMITED — the request per address and per IP, the
 *      consume per IP (the per-token bucket alone is bypassable, because the
 *      token is attacker-supplied — the merchant-login slug lesson);
 *   9. THE SECOND FACTOR SURVIVES — a reset must never be a documented 2FA
 *      bypass reachable from a mailbox;
 *  10. A CUSTOMER'S LINK LANDS ON HIS OWN STORE — `customers` is UNIQUE(store_id,
 *      email), so the same address is a different person at a different shop;
 *  11. NO PROVIDER ⇒ NO PROMISE — nothing minted, nothing queued, and the answer
 *      says so;
 *  12. THE TOKEN IS NEVER STORED — not in its own table, not in the outbox.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import crypto from "node:crypto";
import { Client } from "pg";

const testId = `pr1-${Date.now()}`;
process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "pr1-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
process.env.CODIQ_ENCRYPTION_KEY =
  process.env.CODIQ_ENCRYPTION_KEY ?? "pr1-test-encryption-root-not-a-secret-0123456789abcdef";
// The mail channel, as the platform sees it. `smtpSettingsFromEnv` needs a host
// and a from address; the outbox worker in this suite is driven with a FAKE
// provider, so nothing is ever handed to a real SMTP server.
process.env.CODIQ_SMTP_HOST = "smtp.invalid.test";
process.env.CODIQ_SMTP_FROM = "codiq.iraq@example.test";
process.env.CODIQ_PUBLIC_BASE_URL = "https://pr1.codiqos.test";

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");
const { assertNoEnumerationOracle } = await import("./helpers/login-timing.ts");
const { totpForCounter, base32Decode, currentStep } = await import("../src/auth/totp.ts");
const {
  RESET_TOKEN_TTL_MS,
  RESET_REQUEST_ADDRESS_LIMIT,
  RESET_REQUEST_IP_LIMIT,
  RESET_CONSUME_IP_LIMIT,
} = await import("../src/services/password-reset.service.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, keepRateLimits = false } = {}) {
  // Buckets are cleared by default so an unrelated ceiling never colours a
  // result. `keepRateLimits` is for the two blocks that PROVE the ceilings.
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

const provider = new FakeNotificationProvider();

/**
 * Drives the outbox and returns the link out of the message that was actually
 * SENT — never out of the database.
 *
 * This is the point of reading it here rather than minting a token in the test:
 * the token only ever exists in the mail. If the worker failed to open the
 * sealed payload, or rendered the wrong branch, or dropped the link, no
 * assertion below could pass — which is what makes the render part of the
 * contract rather than an implementation detail.
 */
async function drainAndReadLink(recipient) {
  const before = provider.sent.length;
  // The clock is moved forward one worker tick, and that is a HARNESS fix rather
  // than a lenient assertion. `next_attempt_at` defaults to Postgres' NOW() while
  // `processOutboxBatch` compares against Node's, and the two machines differ by
  // a millisecond or two — enough for a row created microseconds ago to be «not
  // due yet» and for this suite to fail on a clock skew rather than on anything
  // it is testing. The real worker polls on a 5-second interval, so a row is
  // always claimed on a LATER tick than the one that created it; this reproduces
  // that and nothing else.
  const batch = await processOutboxBatch(provider, {
    batchSize: 50,
    now: new Date(Date.now() + 5000),
  });
  const sent = provider.sent.slice(before).filter((message) => message.to === recipient);
  if (sent.length !== 1) {
    const state = await prisma.notificationOutbox.findMany({
      where: { recipient },
      select: { status: true, lastOutcome: true, nextAttemptAt: true, attemptCount: true },
    });
    assert.fail(
      `exactly one recovery mail for ${recipient} (got ${sent.length}); batch=${JSON.stringify(batch)} rows=${JSON.stringify(state)}`
    );
  }
  const link = /https?:\/\/\S+/.exec(sent[0].body)?.[0];
  assert.ok(link, `the mail must carry a working absolute link:\n${sent[0].body}`);
  return { link, message: sent[0] };
}

function tokenOf(link) {
  const token = new URL(link).searchParams.get("token");
  assert.ok(token, `the link must carry a token: ${link}`);
  return token;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** Blocks until the TOTP step counter advances — a spent code cannot replay. */
async function waitForFreshTotpStep() {
  const start = currentStep();
  while (currentStep() === start) await new Promise((resolve) => setTimeout(resolve, 500));
}

/** One full round trip: ask, drain the queue, read the link out of the mail. */
async function requestLink(body, { path = "/auth/password/reset/request", recipient } = {}) {
  const asked = await request(path, { method: "POST", body });
  assert.equal(asked.status, 202, JSON.stringify(asked.payload));
  assert.equal(asked.payload.delivery, "queued", JSON.stringify(asked.payload));
  return drainAndReadLink(recipient ?? body.email);
}

const summary = {};

try {
  await sql.query("DELETE FROM storefront_rate_limits");

  // ==========================================================================
  // FIXTURES — a merchant (the identity this feature was blocking) and, later,
  // an owner and two customers of two different stores.
  // ==========================================================================
  const merchantEmail = `${testId}-merchant@codiq.test`;
  const merchantPassword = "Pr1MerchantPass2026!";
  const merchantPhone = `+9647${String(Date.now()).slice(-9)}`;
  const merchantReg = await registerMerchantDirect({
    email: merchantEmail,
    password: merchantPassword,
    businessName: "متجر النور",
    ownerName: "سيف الدين",
    phone: merchantPhone,
  });
  assert.equal(merchantReg.status, 201, JSON.stringify(merchantReg.payload));
  const merchantId = merchantReg.payload.account.id;
  await prisma.store.create({
    data: { merchantId, name: "متجر النور", slug: `${testId}-m`, defaultSubdomain: `${testId}-m` },
  });
  const loginMerchant = (password) =>
    request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: merchantEmail, password },
    });

  // ==========================================================================
  // 12. THE TOKEN IS NEVER STORED — asserted first, because everything else
  //     below would still pass on an implementation that kept it in the clear.
  //
  //     Two places have to be checked, not one. `password_reset_tokens` keeps a
  //     hash, which is the obvious half; the mail carrying the token travels
  //     through `notification_outbox.payload`, an ordinary jsonb column, and a
  //     plaintext link there would put the very value the token table refuses
  //     to keep back into the same database for every reset ever requested.
  // ==========================================================================
  const first = await requestLink({ kind: "merchant", email: merchantEmail });
  const firstToken = tokenOf(first.link);

  const rows = await sql.query(
    "SELECT token_hash, identity_kind, subject_id, store_id, expires_at FROM password_reset_tokens WHERE subject_id = $1",
    [merchantId]
  );
  assert.equal(rows.rows.length, 1, "one token row for one request");
  assert.equal(
    rows.rows[0].token_hash,
    sha256(firstToken),
    "PR-1: the column holds the HASH of the mailed token"
  );
  assert.ok(!rows.rows[0].token_hash.includes(firstToken), "PR-1: …and not the token itself");
  assert.equal(
    rows.rows[0].store_id,
    null,
    "PR-1: a merchant's token carries no store — he may own several"
  );

  const outboxRaw = await sql.query(
    "SELECT store_id, event_type, recipient_kind, payload::text AS payload FROM notification_outbox WHERE recipient = $1",
    [merchantEmail]
  );
  assert.equal(outboxRaw.rows.length, 1, "one queued message");
  assert.ok(
    !outboxRaw.rows[0].payload.includes(firstToken),
    `PR-1: the outbox payload must NOT contain the plaintext token:\n${outboxRaw.rows[0].payload}`
  );
  assert.match(
    outboxRaw.rows[0].payload,
    /codiq1\./,
    "PR-1: …it carries a secret-box envelope instead"
  );
  assert.equal(
    outboxRaw.rows[0].store_id,
    null,
    "PR-1: account-recovery mail belongs to no store — a store cap must never defer a link that expires in 45 minutes"
  );
  assert.equal(
    outboxRaw.rows[0].recipient_kind,
    "account",
    "PR-1: it is addressed to the account holder, whichever identity kind he is"
  );
  summary.tokenAtRest = { column: "sha256", outboxPayload: "sealed", storeId: null };

  // The mail is in Arabic, says how long the link lives, and tells the person
  // who did NOT ask that the correct action is none.
  assert.match(first.message.subject, /[؀-ۿ]/, "PR-1: Arabic-first, including the mail");
  assert.match(first.message.body, /45/, "PR-1: the mail states the lifetime");
  assert.match(
    first.message.body,
    /إن لم تطلب هذا/,
    "PR-1: …and tells an unwitting recipient that nothing has changed"
  );

  // ==========================================================================
  // 1. SINGLE USE.
  // ==========================================================================
  const merchantNew = "Pr1MerchantFresh2026!";
  // Review batch 3, ت-١: as if the platform had set his password (manual provisioning). The reset
  // is a password HE chose, so the «change it at first sign-in» demand must go with it.
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { passwordSetByProvisionerAt: new Date() },
  });
  const used = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: firstToken, newPassword: merchantNew },
  });
  assert.equal(used.status, 200, JSON.stringify(used.payload));
  assert.equal(used.payload.redirectTo, "/merchant/login", "PR-1: he is sent to his own door");

  const replay = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: firstToken, newPassword: "Pr1ReplayPass2026!" },
  });
  assert.equal(replay.status, 422, JSON.stringify(replay.payload));
  assert.equal(
    replay.payload.error.code,
    "INVALID_RESET_TOKEN",
    "PR-1: a spent link is spent — a link that works twice is a link an interceptor can use after its owner"
  );
  assert.equal(
    (await loginMerchant("Pr1ReplayPass2026!")).status,
    401,
    "PR-1: …and the replay changed nothing"
  );

  // The password genuinely moved.
  assert.equal(
    (await loginMerchant(merchantPassword)).status,
    401,
    "PR-1: the forgotten password no longer works"
  );
  const signedIn = await loginMerchant(merchantNew);
  assert.equal(signedIn.status, 200, "PR-1: …and the new one does");
  assert.equal(
    signedIn.payload.mustChangePassword,
    undefined,
    "a password he set himself by reset is not one the provisioner knows"
  );
  summary.singleUse = { secondAttempt: replay.payload.error.code };

  // ==========================================================================
  // 6. EVERY SESSION DIES ON USE — and the assertion is the 401, not a count.
  //
  //    A stolen session must not survive the recovery its owner performed. This
  //    is very often the exact reason he is recovering, so an implementation
  //    that reset the password and left the thief signed in would have achieved
  //    nothing while reporting success.
  // ==========================================================================
  const heldA = (await loginMerchant(merchantNew)).payload.accessToken;
  const heldB = (await loginMerchant(merchantNew)).payload.accessToken;
  assert.equal(
    (await request("/auth/sessions", { token: heldA })).status,
    200,
    "both sessions start alive"
  );
  assert.equal((await request("/auth/sessions", { token: heldB })).status, 200);

  const second = await requestLink({ kind: "merchant", email: merchantEmail });
  const recovered = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: tokenOf(second.link), newPassword: "Pr1MerchantThird2026!" },
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.payload));
  assert.ok(
    recovered.payload.sessionsEnded >= 2,
    `PR-1: the sessions are reported ended (${recovered.payload.sessionsEnded})`
  );
  assert.equal(
    (await request("/auth/sessions", { token: heldA })).status,
    401,
    "PR-1: the first session is DEAD, not merely counted as revoked"
  );
  assert.equal(
    (await request("/auth/sessions", { token: heldB })).status,
    401,
    "PR-1: …and so is the second"
  );

  // REVOKED, not quietly expired — the distinction 19-أ established. Expiring a
  // session kills the token just as dead, so an implementation that did that
  // would pass every assertion above this one.
  const sessionRows = await sql.query(
    "SELECT revoked_at, expires_at > now() AS still_in_date FROM merchant_sessions WHERE merchant_id = $1",
    [merchantId]
  );
  const revoked = sessionRows.rows.filter((row) => row.revoked_at !== null);
  assert.ok(revoked.length >= 2, "PR-1: revoked at the row level");
  assert.ok(
    revoked.every((row) => row.still_in_date),
    "PR-1: REVOKED, not quietly expired"
  );
  summary.sessionsRevokedOnUse = {
    reported: recovered.payload.sessionsEnded,
    verifiedDeadWith: 401,
  };

  // A successful reset does NOT sign him in. This is the security decision the
  // TOTP block below depends on, so it is asserted for its own sake here.
  assert.ok(
    !("accessToken" in recovered.payload),
    "PR-1: a reset issues NO session — a mail link must not become one"
  );

  // ==========================================================================
  // 3 + 5. RE-ISSUE KILLS THE OLDER LINK, AND CONSUMING KILLS EVERY SIBLING.
  //
  //    A person who presses the button twice must not be left holding two live
  //    takeover primitives, and the older mail is the one more likely to have
  //    been intercepted.
  // ==========================================================================
  const older = await requestLink({ kind: "merchant", email: merchantEmail });
  const newer = await requestLink({ kind: "merchant", email: merchantEmail });
  assert.notEqual(
    tokenOf(older.link),
    tokenOf(newer.link),
    "two requests mint two different tokens"
  );

  assert.equal(
    (
      await request("/auth/password/reset/inspect", {
        method: "POST",
        body: { token: tokenOf(older.link) },
      })
    ).payload.valid,
    false,
    "PR-1: issuing a newer link kills the older one"
  );
  assert.equal(
    (
      await request("/auth/password/reset/inspect", {
        method: "POST",
        body: { token: tokenOf(newer.link) },
      })
    ).payload.valid,
    true,
    "PR-1: …and leaves the newest alive"
  );

  const supersededUse = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: tokenOf(older.link), newPassword: "Pr1SupersededPass2026!" },
  });
  assert.equal(
    supersededUse.payload.error.code,
    "INVALID_RESET_TOKEN",
    "PR-1: and it is refused, not merely reported invalid"
  );

  const reasons = await sql.query(
    "SELECT invalidated_reason FROM password_reset_tokens WHERE token_hash = $1",
    [sha256(tokenOf(older.link))]
  );
  assert.equal(
    reasons.rows[0].invalidated_reason,
    "superseded",
    "PR-1: every invalidation says why — an incident nobody can read is an incident nobody can answer"
  );
  summary.reissueInvalidates = { olderReason: "superseded" };

  // ==========================================================================
  // 2. EXPIRY. Backdated in the database rather than waited out — 45 minutes is
  //    the contract, and a suite that slept for it would never be run.
  // ==========================================================================
  const ageing = await requestLink({ kind: "merchant", email: merchantEmail });
  const ageingToken = tokenOf(ageing.link);
  assert.equal(
    (
      await request("/auth/password/reset/inspect", {
        method: "POST",
        body: { token: ageingToken },
      })
    ).payload.valid,
    true,
    "alive one second before"
  );
  await sql.query(
    "UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
    [sha256(ageingToken)]
  );
  assert.equal(
    (
      await request("/auth/password/reset/inspect", {
        method: "POST",
        body: { token: ageingToken },
      })
    ).payload.valid,
    false,
    "PR-1: past its window it is dead"
  );
  const expiredUse = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: ageingToken, newPassword: "Pr1ExpiredPass2026!" },
  });
  assert.equal(
    expiredUse.payload.error.code,
    "INVALID_RESET_TOKEN",
    "PR-1: …and refused, not merely marked"
  );
  assert.equal(
    (await loginMerchant("Pr1ExpiredPass2026!")).status,
    401,
    "PR-1: an expired link changes nothing"
  );
  summary.tokenLifetimeMinutes = RESET_TOKEN_TTL_MS / 60000;

  // ==========================================================================
  // 4. A PASSWORD CHANGE BY ANY OTHER ROUTE INVALIDATES OUTSTANDING LINKS.
  //
  //    The scenario is ordinary and the hole is severe: he asks for a link,
  //    then remembers his password and changes it from inside the dashboard.
  //    Without this, a live takeover primitive sits in his inbox for the rest
  //    of its 45 minutes, pointed at the password he just replaced — so whoever
  //    can read that mail undoes the very change he made to be safe.
  // ==========================================================================
  const currentPassword = "Pr1MerchantThird2026!";
  const outstanding = await requestLink({ kind: "merchant", email: merchantEmail });
  const outstandingToken = tokenOf(outstanding.link);
  assert.equal(
    (
      await request("/auth/password/reset/inspect", {
        method: "POST",
        body: { token: outstandingToken },
      })
    ).payload.valid,
    true,
    "the link is live before the change"
  );

  const session = (await loginMerchant(currentPassword)).payload.accessToken;
  const changed = await request("/auth/password", {
    method: "POST",
    token: session,
    body: { currentPassword, newPassword: "Pr1ChangedInside2026!" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));

  assert.equal(
    (
      await request("/auth/password/reset/inspect", {
        method: "POST",
        body: { token: outstandingToken },
      })
    ).payload.valid,
    false,
    "PR-1: changing the password from inside kills every outstanding link"
  );
  const afterChange = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: outstandingToken, newPassword: "Pr1UndoTheChange2026!" },
  });
  assert.equal(
    afterChange.payload.error.code,
    "INVALID_RESET_TOKEN",
    "PR-1: …and the mail in his inbox cannot undo it"
  );
  assert.equal(
    (await loginMerchant("Pr1ChangedInside2026!")).status,
    200,
    "PR-1: the password he chose is the password he has"
  );
  const changeReason = await sql.query(
    "SELECT invalidated_reason FROM password_reset_tokens WHERE token_hash = $1",
    [sha256(outstandingToken)]
  );
  assert.equal(changeReason.rows[0].invalidated_reason, "password_changed");
  summary.passwordChangeInvalidates = { reason: "password_changed" };

  // ==========================================================================
  // 7. THE SAME ANSWER FOR AN ADDRESS THAT EXISTS AND ONE THAT DOES NOT —
  //    status, body, AND the clock.
  //
  //    The timing half is not ceremony. This platform closed a 25×–59× oracle
  //    on its five sign-in doors this session, and a recovery door that answers
  //    a miss faster than a hit hands back the same account list one address at
  //    a time — from an endpoint that needs no account to knock on it.
  // ==========================================================================
  const unknownEmail = `${testId}-nobody@codiq.test`;
  const knownAnswer = await request("/auth/password/reset/request", {
    method: "POST",
    body: { kind: "merchant", email: merchantEmail },
  });
  const unknownAnswer = await request("/auth/password/reset/request", {
    method: "POST",
    body: { kind: "merchant", email: unknownEmail },
  });
  assert.equal(knownAnswer.status, unknownAnswer.status, "PR-1: the same status");
  assert.deepEqual(
    knownAnswer.payload,
    unknownAnswer.payload,
    "PR-1: the same body, byte for byte"
  );

  // An unknown address must leave NOTHING behind — the constant-work path rolls
  // its decoy back, so a row surviving here is a real leak of a different kind.
  const strayRows = await sql.query(
    "SELECT count(*)::int AS n FROM password_reset_tokens WHERE email_normalized = $1",
    [unknownEmail]
  );
  assert.equal(
    strayRows.rows[0].n,
    0,
    "PR-1: the constant-work decoy is rolled back, never committed"
  );
  const strayMail = await sql.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE recipient = $1",
    [unknownEmail]
  );
  assert.equal(
    strayMail.rows[0].n,
    0,
    "PR-1: …and no mail is queued to an address nobody registered"
  );

  const probes = {
    known: () =>
      request("/auth/password/reset/request", {
        method: "POST",
        body: { kind: "merchant", email: merchantEmail },
      }),
    unknown: () =>
      request("/auth/password/reset/request", {
        method: "POST",
        body: { kind: "merchant", email: unknownEmail },
      }),
  };
  // The house helper, unchanged: it holds the floor the five sign-in doors were
  // fixed to, so a miss can never answer measurably FASTER than a hit.
  const doorTiming = await assertNoEnumerationOracle("password reset request", probes);

  // …and the CEILING, which this door needs and the login doors did not.
  //
  // There, the expensive half was a bcrypt compare the miss branch skipped, so
  // the only way to fail was to be too fast. Here the miss branch does its work
  // in a transaction it rolls back, and an imitation that is heavier than the
  // real path is an oracle read backwards: «slow means nobody» enumerates
  // accounts exactly as well as «fast means nobody». Measured at 2.8× while the
  // decoy paid a `count()` in place of the third insert — a gap one request
  // wide, on a public endpoint that answers about any address.
  //
  // The band is loose for the same reason the floor is: bcrypt-free work at
  // this scale is a few milliseconds, CI hardware is noisy, and a number nobody
  // trusts gets widened until it catches nothing. 3× is far inside the defect it
  // is written to catch.
  const ENUMERATION_RATIO_CEILING = 3;
  assert.ok(
    doorTiming.ratio <= ENUMERATION_RATIO_CEILING,
    `PR-1: an unknown address answered in ${doorTiming.unknownMs} ms against ${doorTiming.knownMs} ms for a known one ` +
      `(${doorTiming.ratio}×; the ceiling is ${ENUMERATION_RATIO_CEILING}×). The constant-work path is heavier than the real one, which enumerates ` +
      "accounts just as well as being lighter. Make the decoy do the SAME writes — see constantWorkForMiss."
  );
  summary.enumeration = {
    statusesEqual: true,
    bodiesEqual: true,
    timing: doorTiming,
    ratioCeiling: ENUMERATION_RATIO_CEILING,
  };
  await sql.query("DELETE FROM storefront_rate_limits");
  await sql.query("DELETE FROM notification_outbox");
  provider.sent.length = 0;

  // ==========================================================================
  // 8. BOTH ENDS HAVE CEILINGS.
  // ==========================================================================

  // 8a. THE REQUEST, PER ADDRESS. Without it this endpoint is an
  //     unauthenticated «mail this person from CODIQ's own sending identity»
  //     button, repeatable forever — the deliverability catastrophe PG-3 exists
  //     to prevent, reachable by a stranger with no account at all.
  await sql.query("DELETE FROM storefront_rate_limits");
  const addressStatuses = [];
  for (let attempt = 0; attempt < RESET_REQUEST_ADDRESS_LIMIT + 2; attempt += 1) {
    const response = await request("/auth/password/reset/request", {
      method: "POST",
      keepRateLimits: true,
      body: { kind: "merchant", email: merchantEmail },
    });
    addressStatuses.push(response.status);
    if (response.status === 429) break;
  }
  assert.ok(
    addressStatuses.includes(429),
    `PR-1: unmetered recovery mail to one address — ${addressStatuses.length} requests and not one 429 (${addressStatuses.join(",")})`
  );
  assert.ok(
    addressStatuses.length <= RESET_REQUEST_ADDRESS_LIMIT + 1,
    `PR-1: the address ceiling must bite by attempt ${RESET_REQUEST_ADDRESS_LIMIT + 1}`
  );

  // …and the bucket is keyed on the NORMALIZED address, which is the half that
  // makes it bite. The merchant-login key carried a raw `storeSlug` and one
  // changed character minted a fresh bucket; here, varying the CASE of the same
  // address must land in the SAME bucket or the ceiling is decoration.
  const shouted = merchantEmail.toUpperCase();
  const casedAttempt = await request("/auth/password/reset/request", {
    method: "POST",
    keepRateLimits: true,
    body: { kind: "merchant", email: shouted },
  });
  assert.equal(
    casedAttempt.status,
    429,
    "PR-1: A@X.COM and a@x.com are one address and share one bucket — otherwise the ceiling is walked around by holding shift"
  );

  // 8b. THE REQUEST, PER IP. The address bucket alone is defeated by a sweep
  //     across addresses; this one bounds the sweep.
  await sql.query("DELETE FROM storefront_rate_limits");
  const ipStatuses = [];
  for (let attempt = 0; attempt < RESET_REQUEST_IP_LIMIT + 2; attempt += 1) {
    const response = await request("/auth/password/reset/request", {
      method: "POST",
      keepRateLimits: true,
      body: { kind: "merchant", email: `${testId}-sweep-${attempt}@codiq.test` },
    });
    ipStatuses.push(response.status);
    if (response.status === 429) break;
  }
  assert.ok(
    ipStatuses.includes(429),
    `PR-1: one host swept ${ipStatuses.length} candidate addresses with no ceiling (${ipStatuses.join(",")})`
  );

  // 8c. THE CONSUME, PER IP — and this is where the merchant-login lesson bites.
  //     The token is ENTIRELY attacker-supplied, so a per-token bucket alone
  //     mints a fresh bucket on every request and limits nothing. What is being
  //     protected is not the token (256 bits is not a threat model) but the CPU:
  //     every consume runs a cost-12 bcrypt hash — at the time pure-JS and
  //     BLOCKING the event loop for ~half a second; since D-36 on the threadpool,
  //     still CPU — on a public endpoint.
  await sql.query("DELETE FROM storefront_rate_limits");
  const consumeStatuses = [];
  for (let attempt = 0; attempt < RESET_CONSUME_IP_LIMIT + 2; attempt += 1) {
    // A DIFFERENT token every time — exactly the shape a per-token bucket
    // cannot see. If this loop never reaches 429 the ceiling is bypassable.
    const response = await request("/auth/password/reset/consume", {
      method: "POST",
      keepRateLimits: true,
      body: {
        token: crypto.randomBytes(32).toString("base64url"),
        newPassword: "Pr1GrindPass2026!",
      },
    });
    consumeStatuses.push(response.status);
    if (response.status === 429) break;
  }
  assert.ok(
    consumeStatuses.includes(429),
    `PR-1: the consume door is bypassable by varying the token — ${consumeStatuses.length} attempts, no 429 (${consumeStatuses.join(",")})`
  );
  assert.ok(
    consumeStatuses.length <= RESET_CONSUME_IP_LIMIT + 1,
    `PR-1: the consume ceiling must bite by attempt ${RESET_CONSUME_IP_LIMIT + 1}`
  );
  summary.ceilings = {
    requestPerAddress: { limit: RESET_REQUEST_ADDRESS_LIMIT, bitAt: addressStatuses.length },
    requestPerIp: { limit: RESET_REQUEST_IP_LIMIT, bitAt: ipStatuses.length },
    consumePerIp: { limit: RESET_CONSUME_IP_LIMIT, bitAt: consumeStatuses.length },
  };
  await sql.query("DELETE FROM storefront_rate_limits");

  // ==========================================================================
  // 9. THE SECOND FACTOR SURVIVES A RESET.
  //
  //    This is the genuine security decision of the feature. An owner or a
  //    platform-staff member may hold a TOTP enrolment; if a reset cleared it,
  //    or issued a session, then anyone who owns the mailbox owns the account
  //    and the second factor is a documented bypass rather than a control.
  //
  //    The reset is NOT refused for an enrolled account either — refusing would
  //    strand a person who lost his password and holds his phone, and the
  //    refusal itself would disclose that the account is enrolled.
  // ==========================================================================
  const ownerEmail = `${testId}-owner@codiq.test`;
  const ownerPassword = "Pr1OwnerPass2026!";
  const ownerReg = await request("/auth/platform/register", {
    method: "POST",
    body: { email: ownerEmail, password: ownerPassword, displayName: "مالك المنصة" },
  });
  assert.equal(ownerReg.status, 201, JSON.stringify(ownerReg.payload));
  const ownerId = ownerReg.payload.account.id;

  const ownerSession = (
    await request("/auth/platform/login", {
      method: "POST",
      body: { email: ownerEmail, password: ownerPassword },
    })
  ).payload.accessToken;
  const begun = await request("/platform/security/totp/begin", {
    method: "POST",
    token: ownerSession,
  });
  assert.equal(begun.status, 200, JSON.stringify(begun.payload));
  const secret = begun.payload.secret;
  const codeFor = () => totpForCounter(base32Decode(secret), currentStep());
  const confirmed = await request("/platform/security/totp/confirm", {
    method: "POST",
    token: ownerSession,
    body: { code: codeFor() },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.payload));
  const recoveryCodes = confirmed.payload.recoveryCodes;

  // The door demands the factor BEFORE the reset — otherwise the assertion
  // after it proves nothing.
  assert.equal(
    (
      await request("/auth/platform/login", {
        method: "POST",
        body: { email: ownerEmail, password: ownerPassword },
      })
    ).payload.error.code,
    "SECOND_FACTOR_REQUIRED",
    "the enrolled owner is asked for his code before any of this"
  );

  const totpBefore = await sql.query(
    "SELECT totp_secret, totp_enabled_at, totp_last_step FROM platform_owners WHERE id = $1",
    [ownerId]
  );
  const codesBefore = await sql.query(
    "SELECT count(*)::int AS n FROM platform_owner_recovery_codes WHERE platform_owner_id = $1 AND used_at IS NULL",
    [ownerId]
  );

  const ownerLink = await requestLink({ kind: "platform_owner", email: ownerEmail });
  const ownerNew = "Pr1OwnerFresh2026!";
  const ownerReset = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: tokenOf(ownerLink.link), newPassword: ownerNew },
  });
  assert.equal(ownerReset.status, 200, JSON.stringify(ownerReset.payload));
  assert.equal(
    ownerReset.payload.redirectTo,
    "/platform/login",
    "PR-1: he is sent to the door, not past it"
  );
  assert.ok(
    !("accessToken" in ownerReset.payload),
    "PR-1: NO session is issued — a mail link must not become the thing the second factor withholds"
  );

  const totpAfter = await sql.query(
    "SELECT totp_secret, totp_enabled_at, totp_last_step FROM platform_owners WHERE id = $1",
    [ownerId]
  );
  assert.deepEqual(
    totpAfter.rows[0],
    totpBefore.rows[0],
    "PR-1: a reset writes the password hash and NOTHING else — clearing the factor here would be a 2FA bypass reachable from a mailbox"
  );
  const codesAfter = await sql.query(
    "SELECT count(*)::int AS n FROM platform_owner_recovery_codes WHERE platform_owner_id = $1 AND used_at IS NULL",
    [ownerId]
  );
  assert.equal(
    codesAfter.rows[0].n,
    codesBefore.rows[0].n,
    "PR-1: …and no recovery code is spent or reissued by it"
  );

  // THE ASSERTION THAT MATTERS: the new password alone still does not get in.
  const withNewPasswordOnly = await request("/auth/platform/login", {
    method: "POST",
    body: { email: ownerEmail, password: ownerNew },
  });
  assert.equal(withNewPasswordOnly.status, 401, JSON.stringify(withNewPasswordOnly.payload));
  assert.equal(
    withNewPasswordOnly.payload.error.code,
    "SECOND_FACTOR_REQUIRED",
    "PR-1: a mailbox thief may set the password and STILL cannot sign in"
  );
  // …and the OLD password is genuinely gone, so the reset really happened
  // rather than merely appearing to. The code differs from the one above by
  // design: `loginPlatformOwner` verifies the password first and asks for the
  // factor only after it is correct, so reaching SECOND_FACTOR_REQUIRED already
  // means «this password is right» — which reveals nothing to an attacker who
  // supplied it, and is exactly how the door tells a client to show the field.
  assert.equal(
    (
      await request("/auth/platform/login", {
        method: "POST",
        body: { email: ownerEmail, password: ownerPassword },
      })
    ).payload.error.code,
    "INVALID_PLATFORM_OWNER_CREDENTIALS",
    "PR-1: the forgotten password no longer opens the owner door either"
  );

  // And the person who legitimately holds both walks in.
  //
  // The wait is not padding: a TOTP code is SINGLE USE (`totpLastStep`), and the
  // code that confirmed enrolment above may still belong to the current step —
  // whether it does depends on where in a 30-second window the suite happened to
  // start, which is precisely the shape of a test that passes on one run and
  // fails on the next. Blocking until the counter advances removes the race
  // instead of tolerating it. Same idiom as phase19b and ps1.
  await waitForFreshTotpStep();
  const withFactor = await request("/auth/platform/login", {
    method: "POST",
    body: { email: ownerEmail, password: ownerNew, totpCode: codeFor() },
  });
  assert.equal(withFactor.status, 200, JSON.stringify(withFactor.payload));
  // A recovery code still works too — the path for someone who lost the phone.
  const withRecovery = await request("/auth/platform/login", {
    method: "POST",
    body: { email: ownerEmail, password: ownerNew, totpCode: recoveryCodes[0] },
  });
  assert.equal(withRecovery.status, 200, JSON.stringify(withRecovery.payload));
  summary.totp = {
    enrolmentPreserved: true,
    sessionIssuedByReset: false,
    doorAfterReset: "SECOND_FACTOR_REQUIRED",
  };

  // ==========================================================================
  // 10. A CUSTOMER'S LINK LANDS ON HIS OWN STORE.
  //
  //     `customers_store_email_present_uq` is UNIQUE(store_id, email): ONE
  //     address is TWO different people at two different shops. A reset that
  //     resolved by address alone would hand store A's shopper a link into
  //     store B's account — and even resolving correctly but MAILING the wrong
  //     origin sends him to a host he has never seen, with no session cookie
  //     (which is path-scoped per store) and no reason to trust the form.
  // ==========================================================================
  const sharedEmail = `${testId}-shopper@codiq.test`;
  const storeA = await prisma.store.create({
    data: {
      merchantId,
      name: "متجر ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
      customDomain: `shop-${testId}-a.example`,
    },
  });
  const storeB = await prisma.store.create({
    data: { merchantId, name: "متجر باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` },
  });

  const registerShopper = (slug, phoneSuffix, password) =>
    request(`/store/${slug}/account/register`, {
      method: "POST",
      body: {
        fullName: "زبون الاختبار",
        phone: `+96475${phoneSuffix}`,
        password,
        email: sharedEmail,
      },
    });
  const shopperA = await registerShopper(
    storeA.slug,
    String(Date.now()).slice(-8),
    "Pr1ShopperAPass2026!"
  );
  assert.equal(shopperA.status, 201, JSON.stringify(shopperA.payload));
  const shopperB = await registerShopper(
    storeB.slug,
    String(Date.now() + 1).slice(-8),
    "Pr1ShopperBPass2026!"
  );
  assert.equal(shopperB.status, 201, JSON.stringify(shopperB.payload));
  assert.notEqual(
    shopperA.payload.account.id,
    shopperB.payload.account.id,
    "one address, two genuinely separate shoppers"
  );

  const customerLink = await requestLink(
    { email: sharedEmail },
    { path: `/store/${storeA.slug}/account/password/reset/request`, recipient: sharedEmail }
  );
  // THE ORIGIN. Store A has a custom domain, so that is where its shopper is
  // sent — never the platform host he has never used.
  assert.equal(
    new URL(customerLink.link).host,
    `shop-${testId}-a.example`,
    `PR-1: store A's shopper is sent to store A's own domain — got ${customerLink.link}`
  );
  assert.ok(
    customerLink.link.includes(`/store/${storeA.slug}/account/reset-password`),
    "PR-1: …on his own store's path"
  );
  assert.ok(!customerLink.link.includes(storeB.slug), "PR-1: …and store B appears nowhere in it");

  // THE ACCOUNT. The token resolves to store A's shopper, and only his password
  // moves — a reset that resolved by address alone would move both.
  const bHashBefore = (
    await prisma.customer.findUnique({
      where: { id: shopperB.payload.account.id },
      select: { passwordHash: true },
    })
  ).passwordHash;
  const shopperReset = await request("/auth/password/reset/consume", {
    method: "POST",
    body: { token: tokenOf(customerLink.link), newPassword: "Pr1ShopperFresh2026!" },
  });
  assert.equal(shopperReset.status, 200, JSON.stringify(shopperReset.payload));
  assert.equal(
    shopperReset.payload.redirectTo,
    `/store/${storeA.slug}/account/login`,
    "PR-1: back to HIS store's sign-in page"
  );

  const bHashAfter = (
    await prisma.customer.findUnique({
      where: { id: shopperB.payload.account.id },
      select: { passwordHash: true },
    })
  ).passwordHash;
  assert.equal(
    bHashAfter,
    bHashBefore,
    "PR-1: store B's shopper — same address, different person — is untouched"
  );
  const tokenStore = await sql.query(
    "SELECT store_id FROM password_reset_tokens WHERE token_hash = $1",
    [sha256(tokenOf(customerLink.link))]
  );
  assert.equal(
    tokenStore.rows[0].store_id,
    storeA.id,
    "PR-1: the token itself is scoped to the store it was asked at"
  );

  // A store WITHOUT a custom domain falls back to its own path on the platform
  // base — still the right STORE, which is the half that matters.
  const bLink = await requestLink(
    { email: sharedEmail },
    { path: `/store/${storeB.slug}/account/password/reset/request`, recipient: sharedEmail }
  );
  assert.equal(
    new URL(bLink.link).host,
    "pr1.codiqos.test",
    "PR-1: no custom domain ⇒ the platform base, never a guessed subdomain host"
  );
  assert.ok(
    bLink.link.includes(`/store/${storeB.slug}/account/reset-password`),
    "PR-1: …and still on store B's own path"
  );
  summary.customerOrigin = {
    withCustomDomain: new URL(customerLink.link).host,
    without: new URL(bLink.link).host,
    crossStoreLeak: false,
  };

  // ==========================================================================
  // 11. NO PROVIDER ⇒ NO PROMISE, AND NOTHING MINTED.
  //
  //     This is production's state until CODIQ_SMTP_PASS is pasted. The screen
  //     must never say «we sent you an email» while the outbox marks the row
  //     `skipped/no_provider_configured` — and minting a takeover primitive
  //     nobody can receive is pure attack surface with no recipient.
  // ==========================================================================
  const smtpHost = process.env.CODIQ_SMTP_HOST;
  delete process.env.CODIQ_SMTP_HOST;
  await sql.query("DELETE FROM storefront_rate_limits");
  const tokensBeforeOutage = (
    await sql.query("SELECT count(*)::int AS n FROM password_reset_tokens")
  ).rows[0].n;
  const mailBeforeOutage = (
    await sql.query(
      "SELECT count(*)::int AS n FROM notification_outbox WHERE event_type = 'auth.password_reset'"
    )
  ).rows[0].n;

  const degraded = await request("/auth/password/reset/request", {
    method: "POST",
    body: { kind: "merchant", email: merchantEmail },
  });
  assert.equal(degraded.status, 202, JSON.stringify(degraded.payload));
  assert.equal(
    degraded.payload.delivery,
    "unavailable",
    "PR-1: with no channel the platform says so instead of promising mail"
  );

  // The honest answer is the same for an address nobody registered, so the
  // degraded branch is not itself an oracle.
  const degradedUnknown = await request("/auth/password/reset/request", {
    method: "POST",
    body: { kind: "merchant", email: unknownEmail },
  });
  assert.deepEqual(
    degradedUnknown.payload,
    degraded.payload,
    "PR-1: …identically for an address that does not exist"
  );

  assert.equal(
    (await sql.query("SELECT count(*)::int AS n FROM password_reset_tokens")).rows[0].n,
    tokensBeforeOutage,
    "PR-1: nothing is minted when nothing can be delivered"
  );
  assert.equal(
    (
      await sql.query(
        "SELECT count(*)::int AS n FROM notification_outbox WHERE event_type = 'auth.password_reset'"
      )
    ).rows[0].n,
    mailBeforeOutage,
    "PR-1: …and nothing is queued to be skipped later"
  );
  process.env.CODIQ_SMTP_HOST = smtpHost;
  summary.noProvider = { status: 202, delivery: "unavailable", tokensMinted: 0, rowsQueued: 0 };

  // The same honesty when there is a provider but no public base URL: a
  // recovery mail without a working link is a dead letter, so it is refused
  // before anything is written rather than sent broken.
  const publicBase = process.env.CODIQ_PUBLIC_BASE_URL;
  delete process.env.CODIQ_PUBLIC_BASE_URL;
  await sql.query("DELETE FROM storefront_rate_limits");
  const linkless = await request("/auth/password/reset/request", {
    method: "POST",
    body: { kind: "merchant", email: merchantEmail },
  });
  assert.equal(
    linkless.payload.delivery,
    "unavailable",
    "PR-1: no base URL means no working link, and a link-less recovery mail is not sent"
  );
  process.env.CODIQ_PUBLIC_BASE_URL = publicBase;

  // ==========================================================================
  // A LAST STRUCTURAL CHECK: recovery mail drains AHEAD of everything else.
  //
  //     It is the only message on the platform with an EXPIRING payload, so
  //     minutes spent behind a backlog come straight out of the window the
  //     recipient has to use it.
  // ==========================================================================
  const priority = await sql.query(
    "SELECT priority, kind FROM notification_event_kinds WHERE event_type = 'auth.password_reset'"
  );
  assert.equal(
    priority.rows[0].kind,
    "operational",
    "PR-1: classified in the DATABASE — an unclassified event cannot be enqueued at all"
  );
  assert.ok(
    Number(priority.rows[0].priority) < 0,
    `PR-1: recovery mail must drain ahead of every other operational message (priority ${priority.rows[0].priority}); it is the only one whose payload expires`
  );
  summary.queuePriority = Number(priority.rows[0].priority);

  await sql.query("DELETE FROM storefront_rate_limits");
  summary.identitiesCovered = ["merchant", "platform_owner", "customer"];
  console.log(JSON.stringify({ pr1: summary }, null, 2));
  console.log("pr1 OK");
} finally {
  await sql.end().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  server.close();
}

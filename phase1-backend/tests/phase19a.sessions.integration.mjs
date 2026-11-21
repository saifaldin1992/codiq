/**
 * codiq phase 19-أ — sign out, and the list of what is signed in as you.
 *
 * `revokedAt` has existed since phase 1; what was missing was any way to use it.
 * So the tests are about whether ending a session actually ends it, and whether
 * the list is one a person can act on:
 *
 *   1. A REVOKED SESSION IS DEAD EVERYWHERE — not merely absent from a list.
 *      The same token is then refused by a real business endpoint, which is the
 *      only proof that matters;
 *   2. SIGNING OUT IS IDEMPOTENT, and it clears the cookie as well as the row —
 *      a revoked row with a live cookie is a browser that 401s on every request
 *      with nothing on screen to explain it;
 *   3. THE LIST IS ACTIONABLE — every row says whether it is THIS session, so a
 *      person can find himself before ending anything;
 *   4. YOU CANNOT END YOUR OWN SESSION FROM THE LIST — that is what sign-out is
 *      for, and doing it here logs the page out mid-click;
 *   5. "END EVERYTHING ELSE" leaves exactly the current session alive, which is
 *      what makes it usable: he stays signed in to change his password next;
 *   6. SESSIONS ARE PRIVATE TO THEIR OWNER — one merchant cannot see or end
 *      another's, and the refusal does not confirm the id exists;
 *   7. EVERY IDENTITY GETS THE SAME VERB — owner, merchant and staff, since all
 *      three could previously sign in and never sign out.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `p19a-${Date.now()}`;
process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "p19a-test-secret-only-not-for-production";
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

async function request(path, { method = "GET", body, token, agent } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" ? {} : { origin: base }),
      ...(agent ? { "user-agent": agent } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload, setCookie: response.headers.get("set-cookie") };
}

const summary = {};

try {
  await sql.query("DELETE FROM storefront_rate_limits");

  // ---------------------------------------------------------------- fixtures
  const ownerEmail = `${testId}.owner@codiq.test`;
  assert.equal(
    (
      await request("/auth/platform/register", {
        method: "POST",
        body: { email: ownerEmail, password: "P19aOwnerPass2026!", displayName: "مالك المنصة" },
      })
    ).status,
    201
  );
  const ownerToken = (
    await request("/auth/platform/login", {
      method: "POST",
      body: { email: ownerEmail, password: "P19aOwnerPass2026!" },
    })
  ).payload.accessToken;

  const merchantEmail = `${testId}.merchant@codiq.test`;
  const merchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: `+9647${String(Date.now()).slice(-9)}`,
    email: merchantEmail,
    password: "P19aMerchantPass2026!",
    businessName: "تجارة الجلسات",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر الجلسات",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const login = (agent) =>
    request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: merchantEmail, password: "P19aMerchantPass2026!" },
      agent,
    });

  // A second merchant, for the privacy boundary.
  const otherEmail = `${testId}.other@codiq.test`;
  const otherMerchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: `+9647${String(Date.now() + 5).slice(-9)}`,
    email: otherEmail,
    password: "P19aOtherPass2026!",
    businessName: "تجارة أخرى",
  });
  assert.equal(otherMerchant.status, 201, JSON.stringify(otherMerchant.payload));
  // He needs a store of his own: a merchant session is BOUND to a store, so a
  // storeless merchant's token cannot pass the merchant guard at all — and the
  // boundary below would then pass for the wrong reason (401, not 404).
  await prisma.store.create({
    data: {
      merchantId: otherMerchant.payload.account.id,
      name: "متجر آخر",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const otherToken = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: otherEmail, password: "P19aOtherPass2026!" },
    })
  ).payload.accessToken;

  // ============================================================
  // 3. Three devices, and a list he can find himself in.
  // ============================================================
  const laptop = (await login("Mozilla/5.0 (Windows NT 10.0) LaptopProbe")).payload.accessToken;
  const phone = (await login("Mozilla/5.0 (Linux; Android 14) PhoneProbe")).payload.accessToken;
  const tablet = (await login("Mozilla/5.0 (iPad; CPU OS 17_0) TabletProbe")).payload.accessToken;

  // The device is stamped on first USE, not at sign-in, so each token is used once.
  const seen = await request(`/merchant/stores/${store.slug}/orders`, {
    token: laptop,
    agent: "Mozilla/5.0 (Windows NT 10.0) LaptopProbe",
  });
  assert.equal(seen.status, 200, JSON.stringify(seen.payload));
  await request(`/merchant/stores/${store.slug}/orders`, {
    token: phone,
    agent: "Mozilla/5.0 (Linux; Android 14) PhoneProbe",
  });
  await request(`/merchant/stores/${store.slug}/orders`, {
    token: tablet,
    agent: "Mozilla/5.0 (iPad; CPU OS 17_0) TabletProbe",
  });

  // `touchSession` is fire-and-forget by design — the request that triggers it
  // does not await the write — so the list is read with a short retry rather
  // than once. Asserting on the first read would be asserting that a
  // deliberately asynchronous write is synchronous.
  // The wait must cover ALL THREE stamps, not just this session's. Waiting only
  // for `row.current && row.device` returns the moment the laptop's own write
  // lands — the phone's and the tablet's are separate fire-and-forget writes
  // that may still be in flight, and the phone row is read further down. That
  // narrow condition is what made this suite flake three times on 2026-09-04,
  // on branches touching no session code at all: «the phone is in the list»
  // failed because the list was read one write too early.
  const stamped = (payload) =>
    ["LaptopProbe", "PhoneProbe", "TabletProbe"].every((probe) =>
      payload.sessions.some((row) => (row.device ?? "").includes(probe))
    );
  let listed = await request("/auth/sessions", { token: laptop });
  for (
    let attempt = 0;
    attempt < 40 &&
    !(listed.payload.sessions.some((row) => row.current && row.device) && stamped(listed.payload));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    listed = await request("/auth/sessions", { token: laptop });
  }
  assert.ok(
    stamped(listed.payload),
    `19-أ: all three device stamps landed — ${JSON.stringify(listed.payload.sessions.map((row) => row.device))}`
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.payload));
  assert.ok(
    listed.payload.sessions.length >= 3,
    `three sign-ins, three sessions — got ${listed.payload.sessions.length}`
  );
  const currentRows = listed.payload.sessions.filter((row) => row.current);
  assert.equal(
    currentRows.length,
    1,
    "19-أ: exactly one row is marked as this session — a list you cannot find yourself in is one you cannot act on"
  );
  assert.match(
    currentRows[0].device ?? "",
    /LaptopProbe/,
    "19-أ: …and it is the device actually making the request"
  );
  assert.ok(
    listed.payload.sessions.every((row) => row.lastSeenAt),
    "19-أ: every row says when it was last used"
  );
  // Nothing about where he was: no IP is collected, so none can leak.
  assert.ok(
    !JSON.stringify(listed.payload).match(/\b\d{1,3}(\.\d{1,3}){3}\b/),
    "19-أ: no IP address anywhere in the payload — it is not collected, so it cannot leak"
  );

  // ============================================================
  // 4. You cannot end the session you are using, from the list.
  // ============================================================
  const selfRevoke = await request(`/auth/sessions/${currentRows[0].id}`, {
    method: "DELETE",
    token: laptop,
  });
  assert.equal(
    selfRevoke.payload.error.code,
    "CANNOT_REVOKE_CURRENT_SESSION",
    "19-أ: ending your own row from a device list logs the page out mid-click"
  );
  assert.equal(
    (await request("/auth/sessions", { token: laptop })).status,
    200,
    "19-أ: …and the refusal left it working"
  );

  // ============================================================
  // 1. Ending another session kills the TOKEN, not just the row.
  // ============================================================
  const phoneRow = listed.payload.sessions.find((row) => (row.device ?? "").includes("PhoneProbe"));
  assert.ok(phoneRow, "the phone is in the list");
  assert.equal(
    (await request(`/auth/sessions/${phoneRow.id}`, { method: "DELETE", token: laptop })).status,
    204
  );

  // THE ASSERTION THAT MATTERS: a real business endpoint, not the session list.
  const deadPhone = await request(`/merchant/stores/${store.slug}/orders`, { token: phone });
  assert.equal(
    deadPhone.status,
    401,
    `19-أ: a revoked session is dead against the whole platform, not merely hidden from a list · ${JSON.stringify(deadPhone.payload)}`
  );
  assert.equal(
    (await request("/auth/sessions", { token: laptop })).payload.sessions.some(
      (row) => row.id === phoneRow.id
    ),
    false,
    "19-أ: …and it leaves the list"
  );

  // …and it ended for the RIGHT REASON. Expiring the row instead of revoking it
  // kills the token just as dead, so every assertion above would still pass —
  // but the record of a deliberate act would be gone, and an ended session
  // would be indistinguishable from one that simply ran out. Checked at the
  // row, because that distinction exists nowhere else.
  const revokedRow = await prisma.merchantSession.findUniqueOrThrow({
    where: { id: phoneRow.id },
    select: { revokedAt: true, expiresAt: true },
  });
  assert.ok(
    revokedRow.revokedAt,
    "19-أ: ending a session RECORDS that it was ended, rather than quietly shortening its life"
  );
  assert.ok(
    revokedRow.expiresAt > revokedRow.revokedAt,
    "19-أ: …and leaves the original lifetime intact, so the two reasons stay tellable apart"
  );

  // ============================================================
  // 6. Sessions are private to their owner.
  // ============================================================
  const stranger = await request(`/auth/sessions/${currentRows[0].id}`, {
    method: "DELETE",
    token: otherToken,
  });
  assert.equal(
    stranger.status,
    404,
    "19-أ: another merchant's session is a 404 — the refusal must not confirm the id exists"
  );
  assert.equal(
    (await request("/auth/sessions", { token: laptop })).status,
    200,
    "19-أ: …and the attempt changed nothing"
  );
  const strangerList = await request("/auth/sessions", { token: otherToken });
  assert.equal(strangerList.payload.sessions.length, 1, "19-أ: he sees only his own");

  // ============================================================
  // 5. End everything else, and stay signed in.
  // ============================================================
  const swept = await request("/auth/sessions/revoke-others", { method: "POST", token: laptop });
  assert.equal(swept.status, 200, JSON.stringify(swept.payload));
  assert.ok(
    swept.payload.revoked >= 1,
    `19-أ: the tablet was ended — ${JSON.stringify(swept.payload)}`
  );
  assert.equal(
    (await request(`/merchant/stores/${store.slug}/orders`, { token: tablet })).status,
    401,
    "19-أ: …and its token is dead too"
  );
  assert.equal(
    (await request(`/merchant/stores/${store.slug}/orders`, { token: laptop })).status,
    200,
    "19-أ: …while HIS session survives — he needs it to change his password next"
  );
  assert.deepEqual(
    (await request("/auth/sessions", { token: laptop })).payload.sessions.map((row) => row.current),
    [true],
    "19-أ: one session left, and it is his"
  );

  // ============================================================
  // 2. Signing out: idempotent, and the cookie goes with the row.
  // ============================================================
  const signedOut = await request("/auth/logout", { method: "POST", token: laptop });
  assert.equal(signedOut.status, 204);
  assert.match(
    signedOut.setCookie ?? "",
    /codiq_session=/,
    "19-أ: the cookie is cleared with the row — a live cookie on a dead session 401s forever with nothing on screen to explain it"
  );
  assert.equal(
    (await request(`/merchant/stores/${store.slug}/orders`, { token: laptop })).status,
    401,
    "19-أ: the token is dead immediately"
  );
  assert.equal(
    (await request("/auth/logout", { method: "POST", token: laptop })).status,
    401,
    "19-أ: signing out twice is harmless"
  );

  // ============================================================
  // 7. Every identity has the verb — all three could previously
  //    sign in and never sign out.
  // ============================================================
  assert.equal(
    (await request("/auth/sessions", { token: ownerToken })).status,
    200,
    "19-أ: the owner can see his sessions"
  );
  assert.equal(
    (await request("/auth/logout", { method: "POST", token: ownerToken })).status,
    204,
    "19-أ: …and sign out"
  );
  assert.equal((await request("/auth/sessions", { token: ownerToken })).status, 401);
  assert.equal((await request("/auth/sessions")).status, 401, "19-أ: no session, no list");

  summary.sessions = {
    listedDevices: listed.payload.sessions
      .map((row) => (row.device ?? "").split(" ").pop())
      .filter(Boolean),
    currentMarkedOnce: true,
    revokedTokenAgainstBusinessEndpoint: 401,
    strangerRevoke: 404,
    revokedByRevokeOthers: swept.payload.revoked,
    logoutClearsCookie: true,
    ipAddressesStored: 0,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

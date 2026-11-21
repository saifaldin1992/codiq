/**
 * ق-180 — the daily message ceilings are read by the merchant and set by the owner.
 *
 * Three columns built «so the platform owner can tighten a particular store
 * without a deploy» had no writer but a test and reached no screen. This proves
 * the owner's door, the merchant's window, and that the merchant's own settings
 * route cannot loosen what the owner set.
 *
 * Run: pnpm messaging:caps
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const testId = `caps-${Date.now()}`;
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
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

const summary = {};
try {
  // ── an owner, a merchant, a store ────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  const ownerPassword = "CapsOwnerPass!2026";
  const ownerRegistered = await request("/auth/platform/register", {
    method: "POST",
    body: { email: ownerEmail, password: ownerPassword, displayName: "مالك السقوف" },
  });
  assert.equal(ownerRegistered.status, 201, JSON.stringify(ownerRegistered.payload));
  const ownerLogin = await request("/auth/platform/login", {
    method: "POST",
    body: { email: ownerEmail, password: ownerPassword },
  });
  assert.equal(ownerLogin.status, 200, JSON.stringify(ownerLogin.payload));
  const ownerToken = ownerLogin.payload.accessToken;

  const password = "CapsMerchantPass!2026";
  const merchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر السقوف",
    phone: `+96473${suffix}`,
    email: `${testId}.merchant@codiq.test`,
    password,
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر السقوف",
      slug: `${testId}-s`,
      defaultSubdomain: `${testId}-s`,
    },
  });
  const merchantToken = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.merchant@codiq.test`, password },
    })
  ).payload.accessToken;
  assert.ok(merchantToken);

  const ownerPath = `/platform/stores/${store.slug}/messaging-caps`;
  const merchantPath = `/merchant/stores/${store.slug}/notifications/settings`;

  // ── the defaults, from both windows, before any row exists ───────────────
  const defaults = await request(ownerPath, { token: ownerToken });
  assert.equal(defaults.status, 200, JSON.stringify(defaults.payload));
  assert.deepEqual(
    defaults.payload.caps,
    { marketingDailyCap: 200, operationalDailyCap: 5000, operationalRecipientDailyCap: 20 },
    "ق-180: PG-3 and 19-د seed values, read without a settings row"
  );
  assert.equal(defaults.payload.store.slug, store.slug);
  const merchantView = await request(merchantPath, { token: merchantToken });
  assert.equal(merchantView.status, 200, JSON.stringify(merchantView.payload));
  assert.deepEqual(
    merchantView.payload.settings.caps,
    defaults.payload.caps,
    "ق-180: the merchant reads the same three numbers the worker enforces"
  );
  summary.defaults = defaults.payload.caps;

  // ── the owner tightens one store, without a deploy ───────────────────────
  const tightened = await request(ownerPath, {
    method: "PUT",
    token: ownerToken,
    body: { operationalRecipientDailyCap: 2, marketingDailyCap: 50 },
  });
  assert.equal(tightened.status, 200, JSON.stringify(tightened.payload));
  assert.deepEqual(
    tightened.payload.caps,
    { marketingDailyCap: 50, operationalDailyCap: 5000, operationalRecipientDailyCap: 2 },
    "a partial PUT changes only what it names"
  );
  const row = await prisma.notificationSettings.findUniqueOrThrow({
    where: { storeId: store.id },
    select: { marketingDailyCap: true, operationalRecipientDailyCap: true },
  });
  assert.equal(
    row.operationalRecipientDailyCap,
    2,
    "ق-180: the column the worker reads is the column the owner wrote"
  );
  assert.equal(row.marketingDailyCap, 50);
  assert.equal(
    (await request(merchantPath, { token: merchantToken })).payload.settings.caps
      .operationalRecipientDailyCap,
    2,
    "ق-180: the merchant sees the tightening at once"
  );
  summary.tightened = tightened.payload.caps;

  // ── the merchant cannot loosen it through his own settings route ─────────
  const loosen = await request(merchantPath, {
    method: "PUT",
    token: merchantToken,
    body: {
      isEnabled: true,
      caps: { operationalRecipientDailyCap: 500 },
      operationalRecipientDailyCap: 500,
    },
  });
  assert.ok(
    loosen.status === 200 || loosen.status === 422,
    `the merchant route answers ${loosen.status}`
  );
  assert.equal(
    (
      await prisma.notificationSettings.findUniqueOrThrow({
        where: { storeId: store.id },
        select: { operationalRecipientDailyCap: true },
      })
    ).operationalRecipientDailyCap,
    2,
    "ق-180: the merchant settings schema does not admit the ceilings — they are the owner's, and 19-د's walls"
  );
  assert.equal(
    (
      await request(ownerPath, {
        method: "PUT",
        token: merchantToken,
        body: { marketingDailyCap: 9999 },
      })
    ).status,
    403,
    "…and his session is not the owner's at the owner's door"
  );

  // ── the bounds and the boundary ──────────────────────────────────────────
  assert.equal(
    (
      await request(ownerPath, {
        method: "PUT",
        token: ownerToken,
        body: { operationalDailyCap: 0 },
      })
    ).status,
    422,
    "an operational ceiling of zero would silence order confirmations — refused"
  );
  assert.equal(
    (
      await request(ownerPath, {
        method: "PUT",
        token: ownerToken,
        body: { marketingDailyCap: -1 },
      })
    ).status,
    422
  );
  assert.equal(
    (await request(ownerPath, { method: "PUT", token: ownerToken, body: {} })).status,
    422,
    "an empty PUT changes nothing and says so"
  );
  assert.equal(
    (await request(ownerPath, { method: "PUT", token: ownerToken, body: { marketingDailyCap: 0 } }))
      .status,
    200,
    "zero marketing is a legitimate off switch (PG-3)"
  );
  assert.equal(
    (await request(`/platform/stores/${testId}-nowhere/messaging-caps`, { token: ownerToken }))
      .status,
    404
  );
  assert.equal((await request(ownerPath)).status, 401, "needs a session");
  summary.walls = {
    merchantAtOwnerDoor: 403,
    zeroOperational: 422,
    zeroMarketing: 200,
    unknownStore: 404,
  };

  console.log(JSON.stringify({ suite: "messaging-caps", status: "passed", summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
}

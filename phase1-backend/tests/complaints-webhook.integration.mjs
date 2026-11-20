/**
 * ق-182 — a complaint at the mail provider becomes a row, a suppression, and a
 * line the owner can read.
 *
 * PG-3 built `notification_complaints` and nothing ever wrote to it. This proves
 * the Svix-signed door: a forged signature is refused, a stale timestamp is
 * refused, a real event is attributed to the store that mailed the address,
 * recorded once even when redelivered, suppresses the address for that store,
 * and shows up in the owner's list.
 *
 * Run: pnpm complaints:webhook
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { createHmac, randomBytes } from "node:crypto";

const secretBytes = randomBytes(24);
process.env.CODIQ_RESEND_WEBHOOK_SECRET = `whsec_${secretBytes.toString("base64")}`;
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const testId = `cmpl-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload };
}

/** Exactly what Resend (Svix) sends: headers over the raw bytes. */
function signed(id, rawBody, { timestamp = Math.floor(Date.now() / 1000), secret = secretBytes } = {}) {
  const signature = createHmac("sha256", secret).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` };
}

const summary = {};
try {
  // ── an owner, a merchant, a store, and one email the store sent ──────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  const ownerPassword = "ComplaintsOwner!2026";
  assert.equal((await request("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: ownerPassword, displayName: "مالك الشكاوى" } })).status, 201);
  const ownerToken = (await request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: ownerPassword } })).payload.accessToken;
  assert.ok(ownerToken);
  const merchant = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر الشكاوى", phone: `+96474${suffix}`, email: `${testId}.merchant@codiq.test`, password: "ComplaintsMerchant!2026" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: "متجر الشكاوى", slug: `${testId}-s`, defaultSubdomain: `${testId}-s` } });
  const complainer = `${testId}.shopper@example.com`;
  // The provider event ids below are literals, and `provider_event_id` is
  // unique: on a database that already ran this suite once, the second run's
  // «real complaint» would be absorbed as a duplicate and fail for the wrong
  // reason. Clear this suite's own ids first; CI's fresh database is unaffected.
  await prisma.notificationComplaint.deleteMany({ where: { providerEventId: { startsWith: "msg_" } } });
  const sent = await prisma.notificationOutbox.create({
    data: { storeId: store.id, eventType: "order.created", recipientKind: "customer", channel: "email", recipient: complainer, status: "sent", sentAt: new Date(), lastOutcome: "http_accepted" },
    select: { id: true },
  });

  const event = (id, to = [complainer]) => JSON.stringify({ type: "email.complained", created_at: new Date().toISOString(), data: { email_id: id, from: "Codiq <support@codiqos.com>", to, subject: "طلبك رقم 1001" } });

  // ── the door refuses what does not verify ────────────────────────────────
  const unsigned = await request("/webhooks/resend", { method: "POST", body: event("msg_unsigned") });
  assert.equal(unsigned.status, 401, "ق-182: no signature, no entry");
  assert.equal(unsigned.payload.error.code, "WEBHOOK_SIGNATURE_INVALID");
  const forged = await request("/webhooks/resend", { method: "POST", body: event("msg_forged"), headers: signed("msg_forged", event("msg_forged"), { secret: randomBytes(24) }) });
  assert.equal(forged.status, 401, "ق-182: a signature under another key is refused");
  const stale = await request("/webhooks/resend", { method: "POST", body: event("msg_stale"), headers: signed("msg_stale", event("msg_stale"), { timestamp: Math.floor(Date.now() / 1000) - 3600 }) });
  assert.equal(stale.status, 401, "ق-182: an hour-old timestamp is a replay, refused");
  const tampered = await request("/webhooks/resend", { method: "POST", body: event("msg_tampered", ["someone-else@example.com"]), headers: signed("msg_tampered", event("msg_tampered")) });
  assert.equal(tampered.status, 401, "ق-182: the signature covers the raw bytes — a changed recipient does not verify");
  assert.equal(await prisma.notificationComplaint.count({ where: { storeId: store.id } }), 0, "nothing above wrote a row");
  summary.refused = { unsigned: 401, forged: 401, stale: 401, tampered: 401 };

  // ── ق-206: a NEWER never-sent row at another store must not steal the blame ─
  // The shopper unsubscribed at store B, so B's next marketing row was written
  // `skipped` with no sentAt. Postgres sorts NULLs first on DESC, and before
  // ق-206 the webhook had no status filter — so B, which mailed him nothing,
  // took the complaint that store A earned.
  const bystander = await registerMerchantDirect({ ownerName: "تاجر آخر", businessName: "متجر الجار", phone: `+96475${suffix}`, email: `${testId}.bystander@codiq.test`, password: "ComplaintsBystander!2026" });
  assert.equal(bystander.status, 201, JSON.stringify(bystander.payload));
  const storeB = await prisma.store.create({ data: { merchantId: bystander.payload.account.id, name: "متجر الجار", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  await prisma.notificationOutbox.create({
    data: { storeId: storeB.id, eventType: "cart.abandoned", recipientKind: "customer", channel: "email", recipient: complainer, status: "skipped", sentAt: null, lastOutcome: "recipient_unsubscribed", createdAt: new Date(Date.now() + 60_000) },
    select: { id: true },
  });

  // ── a real complaint ─────────────────────────────────────────────────────
  const body = event("msg_real_1");
  const accepted = await request("/webhooks/resend", { method: "POST", body, headers: signed("msg_real_1", body) });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.recorded, true);
  assert.equal(accepted.payload.storeSlug, store.slug, "ق-182/ق-206: attributed to the store that SENT to the address — not the neighbour holding a newer never-sent row");
  assert.equal(await prisma.notificationComplaint.count({ where: { storeId: storeB.id } }), 0, "ق-206: the bystander store that mailed him nothing is not blamed");
  assert.equal(await prisma.notificationUnsubscribe.count({ where: { storeId: storeB.id, emailNormalized: complainer, source: "complaint" } }), 0, "ق-206: …and is not suppressed for a complaint it did not draw");
  const row = await prisma.notificationComplaint.findFirstOrThrow({ where: { storeId: store.id } });
  assert.equal(row.emailNormalized, complainer);
  assert.equal(row.outboxId, sent.id, "ق-182: linked to the message complained about");
  assert.equal(row.providerEventId, "msg_real_1");
  assert.equal(row.note, "طلبك رقم 1001");
  const suppressed = await prisma.notificationUnsubscribe.findUnique({ where: { storeId_emailNormalized: { storeId: store.id, emailNormalized: complainer } } });
  assert.equal(suppressed?.source, "complaint", "ق-182: the address is suppressed for that store, with the source the compliance service always accepted and nobody passed");
  summary.recorded = { store: store.slug, suppressedSource: "complaint" };

  // ── redelivery is absorbed, not doubled ──────────────────────────────────
  const again = await request("/webhooks/resend", { method: "POST", body, headers: signed("msg_real_1", body) });
  assert.equal(again.status, 202);
  assert.equal(again.payload.recorded, false);
  assert.equal(again.payload.reason, "duplicate", "ق-182: Svix redelivers on timeout; the same event id is one complaint");
  assert.equal(await prisma.notificationComplaint.count({ where: { storeId: store.id } }), 1);

  // ── an address this platform never mailed cannot be attributed ───────────
  const stranger = event("msg_stranger", [`${testId}.nobody@example.com`]);
  const ignored = await request("/webhooks/resend", { method: "POST", body: stranger, headers: signed("msg_stranger", stranger) });
  assert.equal(ignored.status, 202);
  assert.equal(ignored.payload.reason, "no_matching_message", "accepted (so Resend stops retrying) and recorded nowhere");
  const other = JSON.stringify({ type: "email.delivered", data: { to: [complainer] } });
  const delivered = await request("/webhooks/resend", { method: "POST", body: other, headers: signed("msg_delivered", other) });
  assert.equal(delivered.status, 202);
  assert.equal(delivered.payload.ignored, true, "other event types are acknowledged and ignored");

  // ── the owner reads it ───────────────────────────────────────────────────
  const list = await request("/platform/messaging/complaints?limit=10", { token: ownerToken });
  assert.equal(list.status, 200, JSON.stringify(list.payload));
  const mine = list.payload.complaints.find((entry) => entry.email === complainer);
  assert.ok(mine, "ق-182: the owner sees the complaint");
  assert.equal(mine.store.slug, store.slug);
  assert.equal(mine.store.name, "متجر الشكاوى");
  assert.ok(Object.hasOwn(list.payload, "nextCursor"), "every list carries nextCursor");
  assert.equal((await request("/platform/messaging/complaints")).status, 401, "reading needs a session");
  summary.ownerList = true;

  // ── with no secret, the door is closed, not open ─────────────────────────
  delete process.env.CODIQ_RESEND_WEBHOOK_SECRET;
  const closed = await request("/webhooks/resend", { method: "POST", body, headers: signed("msg_real_2", body) });
  assert.equal(closed.status, 503, "ق-182: an unconfigured webhook refuses rather than accepting unsigned");
  assert.equal(closed.payload.error.code, "WEBHOOK_NOT_CONFIGURED");
  summary.unconfigured = 503;

  console.log(JSON.stringify({ suite: "complaints-webhook", status: "passed", summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
}

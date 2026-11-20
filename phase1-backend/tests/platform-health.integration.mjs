/**
 * ق-188 — the owner is woken once, told once when it ends, and never spammed.
 *
 * The platform had structured logs and a /ready endpoint and NOTHING that
 * reached out. This proves the four behaviours that make an alert channel worth
 * reading: it fires on the real condition, it stays silent while that condition
 * persists, it says so when the condition clears, and it addresses a human who
 * can reply.
 *
 * Run: pnpm health:test
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
process.env.CODIQ_SUPPORT_EMAIL = "support@codiq.test";
const testId = `health-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

const { prisma } = await import("../src/db/prisma.ts");
const { runHealthWatch, evaluateHealth } = await import("../src/services/platform-health.service.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");

// This suite asserts on ABSENCE as much as presence — «a healthy platform says
// nothing» is only a claim if the platform really is healthy at the start. The
// outbox is shared with every other suite and they leave dead letters and
// overdue rows behind, so the baseline is established rather than assumed.
// Suites run sequentially, which is what makes this safe (the same reason
// phase1 truncates far more than this).
await prisma.platformHealthAlert.deleteMany();
await prisma.$executeRawUnsafe("TRUNCATE TABLE notification_outbox CASCADE");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const summary = {};
try {
  // ── an owner to wake, and a store to hang outbox rows on ─────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  const owner = await prisma.platformOwner.create({ data: { email: ownerEmail, passwordHash: "unused", displayName: "مالك التنبيهات" } });
  const merchant = await registerMerchantDirect({ ownerName: "صاحب المتجر", businessName: "متجر التنبيهات", phone: `+96475${suffix}`, email: `${testId}.merchant@codiq.test`, password: "HealthMerchant!2026" });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({ data: { merchantId: merchant.payload.account.id, name: "متجر التنبيهات", slug: `${testId}-s`, defaultSubdomain: `${testId}-s` } });

  // ── 1. a healthy platform says nothing at all ────────────────────────────
  const quiet = new FakeNotificationProvider();
  const first = await runHealthWatch(quiet);
  assert.deepEqual(first.opened, [], "ق-188: nothing is wrong, so nothing is sent");
  assert.equal(quiet.sent.length, 0, "silence is the correct output of a healthy pass");
  assert.equal(await prisma.platformHealthAlert.count(), 0);
  summary.healthyIsSilent = true;

  // ── 2. a message gives up, and the owner is told ─────────────────────────
  const dead = await prisma.notificationOutbox.create({
    data: { storeId: store.id, eventType: "order.created", recipientKind: "customer", channel: "email", recipient: `${testId}.shopper@example.com`, status: "dead_letter", lastOutcome: "http_failed:422:validation_error" },
  });
  const checks = await evaluateHealth();
  assert.equal(checks.find((check) => check.kind === "outbox_dead_letters")?.failing, true);

  const alarm = new FakeNotificationProvider();
  const opened = await runHealthWatch(alarm);
  assert.deepEqual(opened.opened, ["outbox_dead_letters"], "ق-188: the condition opens exactly one alert");
  // The database is shared with every other suite, so ASSERT ON MY OWNER, not
  // on the total. `sent.length === 1` passes alone and fails in the sweep the
  // moment another suite leaves an active owner behind — a test that only holds
  // in isolation is a test that will be re-run until it is believed.
  const mine = alarm.sent.filter((entry) => entry.to === ownerEmail);
  assert.equal(mine.length, 1, "ق-188: my owner is told exactly once");
  assert.equal(alarm.sent.length, await prisma.platformOwner.count({ where: { isActive: true } }), "…and every active owner is told, none twice");
  assert.match(mine[0].subject, /رسائل استسلمت/, "the subject names the condition in Arabic, not a code");
  assert.equal(mine[0].replyTo, "support@codiq.test", "ق-184: an alert a human can answer");
  assert.match(mine[0].body, /notification_outbox/, "…and it names where to look");
  const row = await prisma.platformHealthAlert.findUniqueOrThrow({ where: { kind: "outbox_dead_letters" } });
  assert.ok(row.detail.includes("١") || /\d/.test(row.detail));
  summary.opened = { kind: "outbox_dead_letters", mails: 1 };

  // ── 3. THE POINT: it does not repeat while the condition persists ────────
  const silent = new FakeNotificationProvider();
  const again = await runHealthWatch(silent);
  assert.deepEqual(again.opened, [], "ق-188: an open alert never re-opens");
  assert.deepEqual(again.stillOpen, ["outbox_dead_letters"]);
  assert.equal(silent.sent.length, 0, "ق-188: the fastest way to make an alert channel worthless is to repeat it");
  assert.ok((await prisma.platformOwner.count({ where: { isActive: true } })) >= 1, "the silence above must not be «nobody to tell»");
  assert.equal(await prisma.platformHealthAlert.count(), 1, "still exactly one row");
  summary.persistingIsSilent = true;

  // ── 4. the condition clears, and that is worth an email too ──────────────
  await prisma.notificationOutbox.update({ where: { id: dead.id }, data: { status: "sent", sentAt: new Date() } });
  const recovery = new FakeNotificationProvider();
  const resolved = await runHealthWatch(recovery);
  assert.deepEqual(resolved.resolved, ["outbox_dead_letters"], "ق-188: recovery is reported, not merely assumed");
  const recovered = recovery.sent.filter((entry) => entry.to === ownerEmail);
  assert.equal(recovered.length, 1);
  assert.match(recovered[0].subject, /^انتهت:/);
  assert.equal(await prisma.platformHealthAlert.count(), 0, "the row IS the state — cleared means gone");
  summary.resolved = true;

  // ── 5. a stalled queue is its own condition ──────────────────────────────
  await prisma.notificationOutbox.create({
    data: { storeId: store.id, eventType: "low_stock", recipientKind: "merchant", channel: "email", recipient: `${testId}.merchant@codiq.test`, status: "pending", nextAttemptAt: new Date(Date.now() - 60 * 60 * 1000), payload: { productName: "قميص", sku: "S1", stockQuantity: 1, lowStockThreshold: 2, storeName: store.name } },
  });
  const stalled = new FakeNotificationProvider();
  const stall = await runHealthWatch(stalled);
  assert.deepEqual(stall.opened, ["outbox_stalled"], "ق-188: a queue that stopped draining is a separate alert");
  assert.match(stalled.sent.find((entry) => entry.to === ownerEmail).subject, /طابور الرسائل متوقّف/);
  summary.stalled = true;

  // ── 6. with no provider the alert is still RECORDED ──────────────────────
  // A platform whose mail is unconfigured must not also lose the record; the
  // row is what a later reader (or a recovery notice) depends on.
  await prisma.platformHealthAlert.deleteMany();
  const recorded = await runHealthWatch(null);
  assert.deepEqual(recorded.opened.sort(), ["outbox_stalled"], "the row is written even when nothing can be sent");
  assert.equal(recorded.notified, 0);
  assert.equal(await prisma.platformHealthAlert.count(), 1);
  summary.recordedWithoutProvider = true;

  console.log(JSON.stringify({ suite: "platform-health", status: "passed", summary }, null, 2));
} finally {
  await prisma.platformHealthAlert.deleteMany();
  await prisma.$disconnect();
}

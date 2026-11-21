/**
 * ق-207 — the marketing channel has a per-RECIPIENT ceiling, platform-wide.
 *
 * The store cap bounded what one store could do to the shared sending domain
 * and said nothing about what reached one address. A hostile merchant needed
 * one self-registered store, one customer row carrying a stranger's email, and
 * up to 200 armed wishlist rows: every restock became a message whose subject
 * he chose, up to the STORE cap — and a second store reset both the cap and
 * the unsubscribe scope. This proves the ceiling is counted across stores,
 * refuses the flood with a named outcome, and touches nothing else: an honest
 * marketing message to someone else and an operational message to the very
 * same address both still go out, and tomorrow the address is reachable again.
 *
 * Run: pnpm marketing:recipient-cap
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `mrc-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.SESSION_JWT_SECRET ??= "mrc-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;
// A marketing message without an unsubscribe link is refused outright, so the
// worker needs a public base URL to render one.
process.env.CODIQ_PUBLIC_BASE_URL = "https://demo.codiqos.test";

const { prisma } = await import("../src/db/prisma.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");
const { MARKETING_RECIPIENT_DAILY_CAP, resetNotificationKindCache } = await import(
  "../src/notifications/messaging-compliance.service.ts"
);

const summary = {};
try {
  resetNotificationKindCache();
  const merchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر السقف",
    phone: `+96476${suffix}`,
    email: `${testId}.merchant@codiq.test`,
    password: "RecipientCap!2026",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر السقف ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر السقف باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  await prisma.notificationSettings.create({ data: { storeId: storeA.id, isEnabled: true } });
  await prisma.notificationSettings.create({ data: { storeId: storeB.id, isEnabled: true } });

  const victim = `${testId}.victim@example.com`;
  const bystander = `${testId}.bystander@example.com`;
  // One second ahead of the wall clock: `next_attempt_at` defaults to now() at
  // microsecond precision, and a drain in the same millisecond can claim nothing.
  const now = new Date(Date.now() + 1000);

  let sequence = 0;
  /** A superset payload every template in play can render from. */
  const payload = (storeSlug) => ({
    storeName: "متجر السقف",
    storeSlug,
    orderNumber: `MRC-${sequence}`,
    itemCount: 1,
    totalIqd: 9000,
    cartUrl: `/store/${storeSlug}/cart`,
    trackingUrl: `/store/${storeSlug}/track`,
    productName: "حذاء رياضي",
    priceIqd: 9000,
    productUrl: `/store/${storeSlug}/products/x`,
  });
  async function enqueue(store, eventType, recipient, extra = {}) {
    sequence += 1;
    return prisma.notificationOutbox.create({
      data: {
        storeId: store.id,
        eventType,
        recipientKind: "customer",
        channel: "email",
        recipient,
        dedupeKey: `${testId}-${sequence}`,
        payload: payload(store.slug),
        ...extra,
      },
      select: { id: true },
    });
  }

  // ── today, store A has already sent the victim the whole ceiling ─────────
  for (let index = 0; index < MARKETING_RECIPIENT_DAILY_CAP; index += 1) {
    await enqueue(storeA, "cart.abandoned", victim, {
      status: "sent",
      sentAt: new Date(now.valueOf() - 1000),
      lastOutcome: "fake_sent",
    });
  }

  // ── the flood continues from store B — the second store is the escape hatch ─
  const flood = await enqueue(storeB, "stock.back_in_stock", victim);
  // …while an honest marketing message to someone else, and an OPERATIONAL
  // message to the victim himself, ride the same batch.
  const honest = await enqueue(storeB, "cart.abandoned", bystander);
  const operational = await enqueue(storeB, "order.created", victim);

  const provider = new FakeNotificationProvider();
  await processOutboxBatch(provider, { now, batchSize: 50 });

  const floodRow = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { id: flood.id },
    select: { status: true, lastOutcome: true },
  });
  assert.equal(
    floodRow.status,
    "skipped",
    "ق-207: the message over the recipient's ceiling is refused, not sent"
  );
  assert.equal(
    floodRow.lastOutcome,
    `recipient_daily_cap:${MARKETING_RECIPIENT_DAILY_CAP}`,
    "ق-207: …with the reason on the row, terminal — not deferred to drip at him tomorrow"
  );
  assert.equal(
    (
      await prisma.notificationOutbox.findUniqueOrThrow({
        where: { id: honest.id },
        select: { status: true },
      })
    ).status,
    "sent",
    "an honest marketing message to another address is untouched"
  );
  assert.equal(
    (
      await prisma.notificationOutbox.findUniqueOrThrow({
        where: { id: operational.id },
        select: { status: true },
      })
    ).status,
    "sent",
    "the operational channel to the same address is untouched — he must still be told his order exists"
  );
  const toVictim = provider.sent.filter((message) => message.to === victim);
  assert.equal(
    toVictim.length,
    1,
    `exactly the operational message reached the victim, got ${JSON.stringify(toVictim.map((message) => message.subject))}`
  );
  summary.flood = {
    skipped: floodRow.lastOutcome,
    honestSent: true,
    operationalSent: true,
    cap: MARKETING_RECIPIENT_DAILY_CAP,
  };

  // ── tomorrow the ceiling resets: the same address is reachable again ──────
  const tomorrow = new Date(now.valueOf() + 24 * 60 * 60 * 1000);
  const later = await enqueue(storeB, "stock.back_in_stock", victim, { nextAttemptAt: tomorrow });
  const nextDay = new FakeNotificationProvider();
  await processOutboxBatch(nextDay, { now: new Date(tomorrow.valueOf() + 1000), batchSize: 50 });
  assert.equal(
    (
      await prisma.notificationOutbox.findUniqueOrThrow({
        where: { id: later.id },
        select: { status: true },
      })
    ).status,
    "sent",
    "ق-207: the ceiling is per DAY — a shopper is not silenced for good"
  );
  summary.tomorrow = "sent";

  console.log(
    JSON.stringify({ suite: "marketing-recipient-cap", status: "passed", summary }, null, 2)
  );
} finally {
  await prisma.$disconnect();
}

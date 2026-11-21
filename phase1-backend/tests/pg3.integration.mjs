/**
 * codiq PG-3 — messaging compliance.
 *
 * What is actually being protected is the OPERATIONAL channel: a domain listed
 * as a spam source stops delivering order confirmations, not just reminders. So
 * the tests are about the guarantees that keep the domain clean, and about the
 * one guarantee that keeps the feature honest — that suppressing marketing
 * never suppresses a customer's own order updates.
 *
 *   1. classification lives in the database: every event type in use is
 *      classified, and an UNCLASSIFIED type cannot be enqueued at all — the
 *      foreign key refuses it, so «we forgot to classify it» is unreachable;
 *   2. a marketing send carries a working unsubscribe link, and the link
 *      resolves to a real token for that store and address;
 *   3. with no public base URL there IS no working link, so the marketing
 *      message dead-letters instead of going out incomplete — while an
 *      operational message still sends, just without its link line;
 *   4. relative paths are absolutised: a link in an email is a URL, not
 *      «/store/x/track»;
 *   5. unsubscribing stops marketing for that store and NOTHING else — the same
 *      address still receives its operational mail, and another store's
 *      marketing is untouched;
 *   6. GET describes and POST acts, so a mail client pre-fetching the link
 *      cannot unsubscribe someone who never clicked;
 *   7. a forged or tampered token is refused;
 *   8. over the daily cap the message is DEFERRED to tomorrow, not dropped: it
 *      stays claimable, keeps its retry budget, and sends on the next day;
 *   9. a cap of 0 disables marketing for the store while operational continues;
 *  10. complaints are recorded against the store and survive the message.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `pg3-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "pg3-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { processOutboxBatch } = await import("../src/notifications/outbox-worker.ts");
const { FakeNotificationProvider } = await import("./helpers/fake-notification-provider.ts");
const compliance = await import("../src/notifications/messaging-compliance.service.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, headers = {} } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

/** The worker reads the base URL at render time, so each scenario sets its own. */
function withBaseUrl(value) {
  if (value === null) delete process.env.CODIQ_PUBLIC_BASE_URL;
  else process.env.CODIQ_PUBLIC_BASE_URL = value;
}

const PUBLIC_BASE = "https://demo.codiqos.test";
const summary = {};

try {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, notification_complaints, notification_unsubscribes, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, notification_settings, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE"
  );
  compliance.resetNotificationKindCache();

  // ---------------------------------------------------------------- fixtures
  const merchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100399001",
    email: `${testId}.merchant@codiq.test`,
    password: "Pg3MerchantPass2026!",
    businessName: "متجر الامتثال",
  });
  assert.equal(merchant.status, 201);
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر الامتثال ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر الامتثال باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  await prisma.notificationSettings.create({ data: { storeId: storeA.id, isEnabled: true } });
  await prisma.notificationSettings.create({ data: { storeId: storeB.id, isEnabled: true } });

  const shopper = "Shopper.PG3@Codiq.test";
  const shopperNormalized = "shopper.pg3@codiq.test";

  let sequence = 0;
  async function enqueue(storeId, eventType, extra = {}) {
    sequence += 1;
    return prisma.notificationOutbox.create({
      data: {
        storeId,
        eventType,
        recipientKind: "customer",
        channel: "email",
        recipient: shopper,
        dedupeKey: `${testId}-${sequence}`,
        payload: {
          storeName: "متجر الامتثال",
          orderNumber: `PG3-${sequence}`,
          itemCount: 2,
          totalIqd: 15000,
          cartUrl: `/store/${testId}-a/cart`,
          trackingUrl: `/store/${testId}-a/track`,
        },
        ...extra,
      },
    });
  }

  // A second ahead, deliberately. `next_attempt_at` defaults to now() at
  // MICROSECOND precision while a JS Date is milliseconds, so a drain called in
  // the same millisecond as the enqueue can compute `.494000 >= .494832` and
  // claim nothing — a flake that fires roughly one run in three. The real
  // worker polls on a 5s timer and never lands inside that window; the test
  // should not pretend to either.
  /**
   * A UTC day that is NOT today, at a fixed hour.
   *
   * WHY THIS EXISTS. Three drains below used to pin literal dates —
   * `2026-09-05`, `2026-09-06`, `2026-09-07`. They were all comfortably in the
   * past or future on the day they were written, and the suite passed for
   * weeks. On 2026-09-07 UTC the last of them became **today**, so the default
   * `drain()` calls earlier in this file — which run at the real clock — sent
   * operational mail to the same recipient inside the very day-window the
   * per-recipient flood test then assumes is empty. Two of its budget of two
   * were spent before it began, and the assertion read `sent: 0, deferred: 5`.
   *
   * It failed identically on `main`, on a freshly migrated database, and in CI
   * — recorded as D-89 while the cause was still open. Production was never
   * involved: `messaging-compliance.service.ts` computes both day boundaries
   * with `Date.UTC`, so the real cap is timezone- and date-independent. The
   * defect was only ever in this file's arithmetic.
   *
   * THE OFFSETS ARE NOT ARBITRARY. Each must avoid three collisions:
   *   · never day 0 — that is where the default `drain()` calls land;
   *   · strictly before day +2 (`capDay`), because rows deferred by those
   *     drains come due on day +3 and a later drain would sweep them up,
   *     changing counts the assertions depend on;
   *   · distinct from each other, since a shared day means one test's sends
   *     count against another's cap.
   * Days −2, −1 and +1 satisfy all three, and keep the original chronological
   * order of the three scenarios.
   */
  function utcDay(offsetDays, hour) {
    const day = new Date(Date.now() + offsetDays * 86_400_000);
    day.setUTCHours(hour, 0, 0, 0);
    return day;
  }

  async function drain(now = new Date(Date.now() + 1000)) {
    const provider = new FakeNotificationProvider();
    const result = await processOutboxBatch(provider, { now });
    return { result, provider };
  }

  // --- 1. classification is a database fact, and an unclassified type is refused ---
  const classified = await prisma.notificationEventKind.findMany({ orderBy: { eventType: "asc" } });
  const byType = Object.fromEntries(classified.map((row) => [row.eventType, row.kind]));
  assert.deepEqual(
    byType,
    {
      "cart.abandoned": "marketing",
      low_stock: "operational",
      // CD-2: the shopper asked for this one, and it is still classified
      // marketing — its timing is ours, its content promotes a purchase, and the
      // sending domain is shared with every store's order confirmations. Listed
      // here because this assertion is deliberately exhaustive: adding an event
      // type must force a decision about its kind, never let one default in.
      "stock.back_in_stock": "marketing",
      // MD-3: a merchant's daily summary of his OWN shop. Operational, so a
      // marketing unsubscribe never silences it. Listed here because this
      // assertion is deliberately exhaustive — adding an event type is meant to
      // force a decision about its kind rather than let one default in.
      "merchant.daily_digest": "operational",
      // ق-186 (D-90): the merchant's own trial is about to end and his plan will
      // change. Operational, and the reasoning is the same shape as the recovery
      // link below: a merchant who muted marketing has said nothing about wanting
      // his own subscription changed without notice. It must also never queue
      // behind a marketing backlog — the whole value of this message is that it
      // arrives BEFORE the date it is warning about.
      "trial.ending": "operational",
      "order.courier_dispatched": "operational",
      "order.created": "operational",
      "order.status_changed": "operational",
      // PR-1: the account-recovery link. Operational beyond argument — it is
      // about something the recipient did seconds ago, and no unsubscribe may
      // ever suppress it: a person who muted a store's marketing has said
      // nothing about his own ability to get back into his account. Listed here
      // for the same reason as the two above: this assertion is deliberately
      // exhaustive, so a new event type forces a decision instead of defaulting
      // into one. It is also the only type carrying a NEGATIVE priority and the
      // only one allowed a NULL store_id — see the migration for both.
      "auth.password_reset": "operational",
      // ق-250: the merchant is told a maintenance window was scheduled and that it ended. Operational —
      // it is about the platform he runs his shop on, and the second store must not send it twice
      // (storeless rows, like the two account types above). Drained AFTER order mail, before marketing.
      "maintenance.scheduled": "operational",
      "maintenance.ended": "operational",
    },
    "every event type in use carries an explicit kind"
  );

  let refused = false;
  try {
    await prisma.notificationOutbox.create({
      data: {
        storeId: storeA.id,
        eventType: "campaign.blast",
        recipientKind: "customer",
        channel: "email",
        recipient: shopper,
        payload: {},
      },
    });
  } catch {
    refused = true;
  }
  assert.ok(refused, "an unclassified event type cannot reach the outbox at all");
  summary.classification = { types: Object.keys(byType).length, unclassifiedRefused: true };

  // --- 2/4. a marketing send carries a working, ABSOLUTE unsubscribe link ---
  withBaseUrl(PUBLIC_BASE);
  await enqueue(storeA.id, "cart.abandoned");
  const marketing = await drain();
  assert.equal(marketing.result.sent, 1, JSON.stringify(marketing.result));
  const marketingBody = marketing.provider.sent[0].body;
  assert.ok(
    marketingBody.includes(`${PUBLIC_BASE}/unsubscribe/`),
    "the marketing message carries an absolute unsubscribe URL"
  );
  assert.ok(
    marketingBody.includes(`${PUBLIC_BASE}/store/${testId}-a/cart`),
    "the cart link is absolute, not a bare path"
  );
  assert.ok(!marketingBody.includes(" /store/"), "no relative path survives into the body");
  assert.ok(
    marketingBody.includes("إشعارات طلباتك"),
    "the message says plainly that order notices keep coming"
  );

  const linkToken = marketingBody.split(`${PUBLIC_BASE}/unsubscribe/`)[1].split(/\s/)[0];
  const decoded = compliance.verifyUnsubscribeToken(linkToken);
  assert.equal(decoded.storeId, storeA.id);
  assert.equal(
    decoded.emailNormalized,
    shopperNormalized,
    "the token normalises the address it was minted from"
  );
  summary.marketingLink = { absolute: true, tokenResolves: true };

  // --- 3. no base URL => no working link => the marketing message must NOT go out,
  //        while an operational message still sends without its link line. ---
  withBaseUrl(null);
  await enqueue(storeA.id, "cart.abandoned");
  const unlinked = await drain();
  assert.equal(unlinked.result.sent, 0, "a marketing message with no unsubscribe link never sends");
  assert.equal(unlinked.result.deadLettered, 1);
  assert.equal(unlinked.provider.sent.length, 0, "the provider was never called");
  const deadRow = await prisma.notificationOutbox.findFirstOrThrow({
    where: { storeId: storeA.id, status: "dead_letter" },
  });
  assert.equal(deadRow.lastOutcome, "missing_unsubscribe_link");

  await enqueue(storeA.id, "order.courier_dispatched");
  const operationalUnlinked = await drain();
  assert.equal(
    operationalUnlinked.result.sent,
    1,
    "operational mail is still worth sending without its link"
  );
  const operationalBody = operationalUnlinked.provider.sent[0].body;
  assert.ok(
    !operationalBody.includes("/store/"),
    "the broken relative path is dropped, not shipped"
  );
  assert.ok(
    !operationalBody.includes("إلغاء اشتراك"),
    "operational mail carries no unsubscribe footer"
  );
  summary.missingLink = { marketing: "dead_letter", operational: "sent" };

  // --- 5/6/7. unsubscribe: scope, method, and forgery ---
  withBaseUrl(PUBLIC_BASE);
  const token = compliance.unsubscribeToken(storeA.id, shopper);

  const described = await request(`/public/unsubscribe/${token}`);
  assert.equal(described.status, 200);
  assert.equal(described.payload.email, shopperNormalized);
  assert.equal(described.payload.alreadyUnsubscribed, false);
  assert.equal(described.payload.scope, "marketing_only");
  assert.equal(
    await prisma.notificationUnsubscribe.count(),
    0,
    "GET must not mutate — a pre-fetching mail client cannot unsubscribe anyone"
  );

  const acted = await request(`/public/unsubscribe/${token}`, { method: "POST" });
  assert.equal(acted.status, 200, JSON.stringify(acted.payload));
  assert.equal(acted.payload.unsubscribed, true);
  assert.equal(await prisma.notificationUnsubscribe.count(), 1);
  const twice = await request(`/public/unsubscribe/${token}`, { method: "POST" });
  assert.equal(twice.status, 200, "pressing twice is the same intent, not an error");
  assert.equal(await prisma.notificationUnsubscribe.count(), 1, "no duplicate suppression row");

  for (const forged of [
    `${token}x`,
    token.replace(/.$/, "z"),
    "not-a-token",
    `${token.split(".")[0]}.deadbeef`,
  ]) {
    const refusedToken = await request(`/public/unsubscribe/${forged}`, { method: "POST" });
    assert.equal(
      refusedToken.status,
      400,
      `a tampered token must be refused: ${forged.slice(0, 24)}`
    );
    assert.equal(refusedToken.payload.error.code, "INVALID_UNSUBSCRIBE_TOKEN");
  }

  // The suppression is narrow: this store's marketing only.
  await enqueue(storeA.id, "cart.abandoned");
  const suppressed = await drain();
  assert.equal(suppressed.result.sent, 0);
  assert.equal(suppressed.result.skipped, 1);
  const suppressedRow = await prisma.notificationOutbox.findFirstOrThrow({
    where: { storeId: storeA.id, lastOutcome: "recipient_unsubscribed" },
  });
  assert.equal(suppressedRow.status, "skipped");

  await enqueue(storeA.id, "order.created");
  const stillOperational = await drain();
  assert.equal(
    stillOperational.result.sent,
    1,
    "the same address still receives its own order notices"
  );

  await enqueue(storeB.id, "cart.abandoned");
  const otherStore = await drain();
  assert.equal(otherStore.result.sent, 1, "muting one store says nothing about another");
  summary.unsubscribe = {
    getMutates: false,
    idempotent: true,
    forgedRefused: 4,
    marketingStopped: true,
    operationalIntact: true,
    otherStoreIntact: true,
  };

  // --- 8. over the cap: deferred to tomorrow, not dropped ---
  //
  // NOTHING is rewritten by hand here. An earlier version of this scenario moved
  // `sentAt` into the cap day itself, and that fixture was what made the
  // assertion pass — the worker was stamping sends from the wall clock while the
  // window was measured against the injected `now`, so its own sends never
  // counted against its own cap. The property under test is exactly that they
  // do, so the test has to let the worker stamp them.
  // RELATIVE, never hardcoded. This was «2026-09-01T10:00Z» — a "safely
  // future" literal that detonated the day the calendar reached it: the
  // earlier sections' sends are stamped with the WALL clock, so once today
  // equalled capDay they fell inside the cap window and consumed the cap of
  // one before this section ran. Every PR on the platform failed CI that
  // morning. Two days ahead can never collide with this run's own wall-clock
  // stamps, and every later assertion below derives from capDay.
  const capDay = new Date(Date.now() + 2 * 86_400_000);
  capDay.setUTCHours(10, 0, 0, 0);
  await prisma.notificationSettings.update({
    where: { storeId: storeB.id },
    data: { marketingDailyCap: 1 },
  });
  await enqueue(storeB.id, "cart.abandoned");
  const underCap = await drain(capDay);
  assert.equal(underCap.result.sent, 1, "the first marketing message of the day goes out");

  const capped = await enqueue(storeB.id, "cart.abandoned");
  const overCap = await drain(capDay);
  assert.equal(overCap.result.sent, 0, "the second is over a cap of one");
  assert.equal(overCap.result.deferred, 1, JSON.stringify(overCap.result));
  const deferredRow = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { id: capped.id },
  });
  assert.equal(deferredRow.status, "retry_scheduled", "still claimable — late, not lost");
  assert.equal(
    deferredRow.attemptCount,
    0,
    "waiting for tomorrow is not a failed attempt and must not spend the retry budget"
  );
  assert.equal(deferredRow.lastOutcome, "daily_cap_deferred:1");
  // Spread across a window after midnight rather than stacked on it: scheduling
  // every deferral on one instant rebuilds the pile-up the cap exists to prevent.
  const nextMidnightDate = new Date(capDay);
  nextMidnightDate.setUTCHours(0, 0, 0, 0);
  const nextMidnight = nextMidnightDate.valueOf() + 86_400_000;
  const spreadMs = compliance.MARKETING_DEFER_SPREAD_MINUTES * 60 * 1000;
  assert.ok(deferredRow.nextAttemptAt.valueOf() >= nextMidnight, "never earlier than the next day");
  assert.ok(
    deferredRow.nextAttemptAt.valueOf() < nextMidnight + spreadMs,
    "and inside the spread window"
  );
  assert.equal(
    deferredRow.nextAttemptAt.valueOf(),
    compliance.deferredUntil(capDay, capped.id).valueOf(),
    "the offset is derived from the row id, so it is reproducible"
  );

  // The next day it goes out on its own, with no operator intervention.
  const nextDay = await drain(new Date(nextMidnight + 23 * 3_600_000));
  assert.equal(nextDay.result.sent, 1, "the deferred message sends itself the next day");
  summary.dailyCap = {
    firstSent: true,
    secondDeferred: true,
    retryBudgetIntact: true,
    spreadNotStacked: true,
    sentNextDay: true,
  };

  // --- 8b. operational mail never queues behind a marketing backlog ---
  //
  // A deferred marketing row carries an EARLIER nextAttemptAt than a row created
  // afterwards, so without a class priority the backlog sits at the head of the
  // queue and an unrelated store's order confirmation waits behind all of it.
  const backlogDay = utcDay(-2, 10);
  await prisma.notificationSettings.update({
    where: { storeId: storeB.id },
    data: { marketingDailyCap: 1 },
  });
  const backlog = [];
  for (let index = 0; index < 5; index += 1)
    backlog.push((await enqueue(storeB.id, "cart.abandoned")).id);
  await prisma.notificationOutbox.updateMany({
    where: { id: { in: backlog } },
    data: { nextAttemptAt: new Date(backlogDay.valueOf() - 60_000) },
  });
  const urgent = await enqueue(storeA.id, "order.created");
  // PIN THE DUE TIME. `enqueue` leaves `next_attempt_at` at its column default,
  // which is the REAL clock — while the drain below runs at a FIXED calendar
  // date. The two agreed only while that date was still in the future, so this
  // assertion passed every day until 2026-09-05T10:00Z and then failed forever:
  // CI ran at 10:02, the row became due at 10:02, the drain asked for 10:00, and
  // the message the test is about was simply not yet due. Not a flake — a date
  // that expired, which reads exactly like a fresh bug in the priority rule it
  // is testing.
  //
  // Pinned 30s before the drain and 30s AFTER the backlog, so the row is due and
  // still the NEWEST in the queue — which is the whole point: an operational
  // message must overtake an older marketing backlog on class, not on age.
  await prisma.notificationOutbox.update({
    where: { id: urgent.id },
    data: { nextAttemptAt: new Date(backlogDay.valueOf() - 30_000) },
  });
  const priority = await drain(backlogDay);
  const urgentRow = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: urgent.id } });
  assert.equal(
    urgentRow.status,
    "sent",
    "the operational message goes out in the same batch, ahead of the older marketing backlog"
  );
  summary.priority = { operationalAheadOfMarketingBacklog: true, batch: priority.result };

  // --- 9. a cap of 0 disables marketing: terminal, not an endless deferral ---
  await prisma.notificationSettings.update({
    where: { storeId: storeB.id },
    data: { marketingDailyCap: 0 },
  });
  // Same expiring pair as 8b above — this one had until 2026-09-06T08:00Z, so it
  // would have detonated tomorrow morning and looked like a brand-new defect in
  // the zero-cap rule. Both rows below are pinned relative to the drain instant
  // for the same reason.
  const zeroCapDay = utcDay(-1, 8);
  const disabled = await enqueue(storeB.id, "cart.abandoned");
  await prisma.notificationOutbox.update({
    where: { id: disabled.id },
    data: { nextAttemptAt: new Date(zeroCapDay.valueOf() - 60_000) },
  });
  const zeroCap = await drain(zeroCapDay);
  assert.equal(zeroCap.result.sent, 0);
  assert.equal(
    zeroCap.result.deferred,
    0,
    "a zero cap is not a deferral — that would queue forever and drain never"
  );
  const disabledRow = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { id: disabled.id },
  });
  assert.equal(disabledRow.status, "skipped");
  assert.equal(disabledRow.lastOutcome, "marketing_disabled_for_store");
  const operationalUnderZeroCap = await enqueue(storeB.id, "order.status_changed");
  await prisma.notificationOutbox.update({
    where: { id: operationalUnderZeroCap.id },
    data: { nextAttemptAt: new Date(zeroCapDay.valueOf() - 60_000) },
  });
  const zeroCapOperational = await drain(zeroCapDay);
  assert.equal(
    zeroCapOperational.result.sent,
    1,
    "a marketing cap of zero says nothing about operational mail"
  );
  summary.zeroCap = { marketing: "skipped_terminal", operational: "sent" };

  // --- 9b. (19-د, ATTACK-SURFACE) the OPERATIONAL channel has ceilings too ---
  //
  // Item 5 above asserts that operational mail survives an unsubscribe, and item
  // 9 that it survives a marketing cap of zero. Both are correct and both were
  // being used against the platform: they meant operational rows walked from the
  // claim straight to the provider with NO cap, NO opt-out, and a recipient
  // address nobody had proven belongs to the recipient — customer registration
  // takes any email and stores it unverified.
  //
  // A self-registered merchant could therefore aim the platform's own
  // CODIQ_SMTP_FROM identity at a stranger: seven customer messages per order,
  // checkout capped at 12 per ten minutes, the status route capped at nothing —
  // roughly 84 messages per ten minutes to one inbox, each carrying 120
  // characters of store name he chose, none carrying an unsubscribe line.
  //
  // Both dimensions are asserted, and so is the thing that makes the cap safe to
  // apply HERE of all places: it defers, it does not drop.
  const capsDay = utcDay(1, 9);
  await prisma.notificationSettings.update({
    where: { storeId: storeA.id },
    data: { operationalRecipientDailyCap: 2, operationalDailyCap: 5000 },
  });
  const floodIds = [];
  for (let index = 0; index < 5; index += 1)
    floodIds.push((await enqueue(storeA.id, "order.status_changed")).id);
  await prisma.notificationOutbox.updateMany({
    where: { id: { in: floodIds } },
    data: { nextAttemptAt: new Date(capsDay.valueOf() - 60_000) },
  });
  const flood = await drain(capsDay);
  assert.equal(
    flood.result.sent,
    2,
    `19-د: the per-recipient operational ceiling must hold at 2 — ${JSON.stringify(flood.result)}`
  );
  assert.equal(
    flood.result.deferred,
    3,
    "19-د: …and the rest are DEFERRED, never dropped — a discarded order confirmation is the outage this module exists to prevent"
  );
  // ق-214 — AND THE SAME CEILING DOES NOT APPLY TO THE STORE'S OWN OWNER.
  //
  // Everything the paragraph above reasons about is a message a store causes to
  // be sent to a THIRD PARTY at an address nobody proved belongs to him. The
  // merchant's own address is the login identity of the account that owns the
  // store. Counting both in one bucket meant a merchant's routine day spent the
  // twenty on his own copies, after which «طلب جديد» — the trigger for the COD
  // confirmation call — was deferred to tomorrow. The STORE ceiling still bounds
  // him, which is the dimension that protects the sending domain.
  const merchantFloodIds = [];
  for (let index = 0; index < 5; index += 1) {
    merchantFloodIds.push(
      (
        await enqueue(storeA.id, "order.status_changed", {
          recipientKind: "merchant",
          recipient: `${testId}.owner@codiq.test`,
        })
      ).id
    );
  }
  await prisma.notificationOutbox.updateMany({
    where: { id: { in: merchantFloodIds } },
    data: { nextAttemptAt: new Date(capsDay.valueOf() - 60_000) },
  });
  const merchantFlood = await drain(capsDay);
  assert.equal(
    merchantFlood.result.deferred,
    0,
    `ق-214: the merchant's own mail is not held by the shopper's ceiling — ${JSON.stringify(merchantFlood.result)}`
  );
  assert.equal(
    merchantFlood.result.sent,
    5,
    "ق-214: …all five reach him, on the same day, with the store ceiling still standing above them"
  );

  const floodRows = await prisma.notificationOutbox.findMany({
    where: { id: { in: floodIds } },
    select: { status: true, lastOutcome: true, attemptCount: true, nextAttemptAt: true },
  });
  const held = floodRows.filter((row) => row.status === "retry_scheduled");
  assert.equal(held.length, 3);
  assert.ok(
    held.every((row) => row.lastOutcome === "recipient_daily_cap_deferred:2"),
    JSON.stringify(held.map((row) => row.lastOutcome))
  );
  assert.ok(
    held.every((row) => row.attemptCount === 0),
    "19-د: waiting for tomorrow is not a failed attempt — the retry budget must be untouched"
  );
  // 19-د: the deferrals are SPREAD, not stacked on one instant.
  //
  // THIS ASSERTION USED TO DEMAND PAIRWISE DISTINCTNESS, AND IT WAS WRONG.
  // `deferredUntil` picks a minute as `sha256(outboxId) % 360` — a uniform draw
  // over a six-hour window, keyed on a RANDOM uuid. Three independent draws from
  // 360 buckets collide with probability 1 − (359/360)(358/360) ≈ **0.83%**, so
  // roughly one CI run in 120 failed on correct behaviour. It failed on
  // 2026-09-05 on a documentation-only pull request, which is how it was caught.
  //
  // Two of three sharing a minute is not the defect this line exists to catch.
  // The defect is all of them landing together — a thundering herd at midnight,
  // which is exactly what the spread was added to prevent. So that is what is
  // asserted, plus the window bound; and the distribution itself is proven
  // DETERMINISTICALLY below, over many ids, instead of being sampled three at a
  // time and hoped over.
  const heldAt = held.map((row) => row.nextAttemptAt.valueOf());
  assert.ok(
    new Set(heldAt).size > 1,
    `19-د: deferrals must not stack on one instant — ${JSON.stringify(heldAt)}`
  );
  // The day a deferral from `capsDay` lands on — DERIVED, never written down.
  // It was `Date.UTC(2026, 8, 8)`: correct only while `capsDay` was the 7th.
  const capsNextMidnight = new Date(capsDay);
  capsNextMidnight.setUTCHours(0, 0, 0, 0);
  const dayStart = capsNextMidnight.valueOf() + 86_400_000;
  for (const at of heldAt) {
    const offsetMinutes = (at - dayStart) / 60_000;
    assert.ok(
      Number.isInteger(offsetMinutes) &&
        offsetMinutes >= 0 &&
        offsetMinutes < compliance.MARKETING_DEFER_SPREAD_MINUTES,
      `19-د: a deferral lands on the next day inside the spread window, not at an arbitrary time — ${offsetMinutes}`
    );
  }

  // The property the three rows above can only sample: the spread is a pure
  // function of the id, and it actually uses its whole window. No randomness at
  // assertion time, so this can never flake.
  const spread = new Set();
  for (let index = 0; index < 2000; index += 1)
    spread.add(compliance.deferredUntil(capsDay, `id-${index}`).valueOf());
  assert.ok(
    spread.size > compliance.MARKETING_DEFER_SPREAD_MINUTES * 0.9,
    `19-د: the spread must use its whole six-hour window — only ${spread.size} distinct minutes out of ${compliance.MARKETING_DEFER_SPREAD_MINUTES}`
  );
  assert.equal(
    compliance.deferredUntil(capsDay, "id-7").valueOf(),
    compliance.deferredUntil(capsDay, "id-7").valueOf(),
    "19-د: …and it is a pure function of the id, so a re-claimed row does not jump its slot"
  );

  // A DIFFERENT address on the same store is unaffected — the ceiling is per
  // recipient, so one victim's flood cannot silence an honest shopper.
  const otherShopper = `other.${shopper}`;
  await enqueue(storeA.id, "order.status_changed", { recipient: otherShopper });
  const otherRecipient = await drain(new Date(capsDay.valueOf() + 60_000));
  assert.equal(
    otherRecipient.result.sent,
    1,
    "19-د: the per-recipient ceiling must not spill onto another address"
  );

  // The store-wide circuit breaker, proved with the same mechanism.
  await prisma.notificationSettings.update({
    where: { storeId: storeA.id },
    data: { operationalRecipientDailyCap: 20, operationalDailyCap: 3 },
  });
  await enqueue(storeA.id, "order.created", { recipient: `third.${shopper}` });
  const storeCapped = await drain(new Date(capsDay.valueOf() + 120_000));
  assert.equal(
    storeCapped.result.sent,
    0,
    "19-د: the store-wide operational ceiling must hold once the day's total is reached"
  );
  assert.equal(storeCapped.result.deferred, 1);
  const storeCappedRow = await prisma.notificationOutbox.findFirstOrThrow({
    where: { storeId: storeA.id, recipient: `third.${shopper}` },
    select: { status: true, lastOutcome: true },
  });
  assert.equal(storeCappedRow.status, "retry_scheduled");
  assert.equal(storeCappedRow.lastOutcome, "store_daily_cap_deferred:3");

  // And tomorrow the held messages go out on their own, with no intervention —
  // the same promise the marketing cap makes.
  await prisma.notificationSettings.update({
    where: { storeId: storeA.id },
    data: { operationalRecipientDailyCap: 20, operationalDailyCap: 5000 },
  });
  const capsNextDay = await drain(new Date(dayStart + 23 * 3_600_000));
  assert.ok(
    capsNextDay.result.sent >= 4,
    `19-د: everything held must send itself the next day — ${JSON.stringify(capsNextDay.result)}`
  );
  summary.operationalCaps = {
    perRecipientSent: 2,
    perRecipientDeferred: 3,
    otherRecipientUnaffected: 1,
    perStoreDeferred: 1,
    sentNextDay: capsNextDay.result.sent,
  };

  // --- 10. complaints are recorded and outlive the message ---
  const complained = await enqueue(storeA.id, "order.created");
  const complaint = await prisma.notificationComplaint.create({
    data: {
      storeId: storeA.id,
      outboxId: complained.id,
      emailNormalized: shopperNormalized,
      note: "شكوى تجريبية",
    },
  });
  await prisma.notificationOutbox.delete({ where: { id: complained.id } });
  const survivor = await prisma.notificationComplaint.findUniqueOrThrow({
    where: { id: complaint.id },
  });
  assert.equal(
    survivor.outboxId,
    null,
    "the complaint detaches from the deleted message rather than vanishing with it"
  );
  assert.equal(survivor.storeId, storeA.id);
  summary.complaints = { survivesMessageDeletion: true };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  withBaseUrl(null);
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

/**
 * codiq ق-128 — the free month, and the day after it.
 *
 * The owner cancelled the demo environment and replaced it with a real free
 * month on the real platform. Two sub-decisions were open and are settled here:
 * the month grants GROWTH, and when it ends the merchant DROPS TO FREE — never
 * suspended.
 *
 * THE ASSERTION THIS SUITE EXISTS FOR is the day after. `activePlanForMerchant`
 * resolves a subscription with `status: "active"` AND `endsAt IS NULL OR endsAt
 * > now()`. So a trial row whose `endsAt` merely lapses matches NOTHING, and
 * every call throws NO_ACTIVE_SUBSCRIPTION — a dead dashboard AND a dead
 * storefront checkout, for a merchant whose only crime was not deciding yet, in
 * a cash-on-delivery business with no email channel to warn anybody.
 *
 * So it is not enough to check that the trial expires. What has to be true is
 * that the merchant is STILL WORKING afterwards. That is the difference between
 * a downgrade and deleting an account by omission, and it is the one thing a
 * test of this can get wrong while looking correct.
 *
 *   1. A NEW MERCHANT GETS GROWTH, NOT FREE, and it carries an end date;
 *   2. …roughly thirty days out — the owner said «شهر»;
 *   3. A LAPSED TRIAL LANDS ON FREE, by an explicit row;
 *   4. AND THE MERCHANT STILL RESOLVES A PLAN — the assertion that matters;
 *   5. THE PASS IS IDEMPOTENT — running it twice does not leave two free rows,
 *      because two overlapping worker passes will happen eventually;
 *   6. AN OWNER'S HAND-ASSIGNED PLAN WINS over an expiry noticed first;
 *   7. NOTHING IS SUSPENDED — the store stays active, so shoppers with cash
 *      orders in flight keep being able to reach it.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `trial-${Date.now()}`;
process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET ?? "trial-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { expireLapsedTrials, remindEndingTrials } = await import("../src/notifications/trial-expiry-scanner.ts");
const { activePlanForMerchant, assignMerchantSubscription, merchantEntitlementsView, listMerchantsWithPlans, TRIAL_PLAN_CODE, TRIAL_DAYS } = await import("../src/services/entitlement.service.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
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

try {
  await sql.query("DELETE FROM storefront_rate_limits");

  const email = `${testId}@codiq.test`;
  const phone = `+9647${String(Date.now()).slice(-9)}`;
  const registered = await registerMerchantDirect({ email, password: "TrialMerchantPass2026!", businessName: "متجر التجربة", ownerName: "سيف الدين", phone });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const merchantId = registered.payload.account.id;
  const store = await prisma.store.create({
    data: { merchantId, name: "متجر التجربة", slug: `${testId}`, defaultSubdomain: `${testId}` },
  });

  // ============================================================
  // 1 & 2. The month is granted on growth, and it ends.
  // ============================================================
  const granted = await prisma.merchantSubscription.findFirstOrThrow({
    where: { merchantId, status: "active" },
    select: { id: true, endsAt: true, plan: { select: { code: true } } },
  });
  assert.equal(granted.plan.code, TRIAL_PLAN_CODE, "ق-128: a new merchant starts on the trial plan, not free");
  assert.equal(TRIAL_PLAN_CODE, "growth", "ق-128: …and the trial plan is growth — pro would halve the commission in his busiest month");
  assert.ok(granted.endsAt, "ق-128: the trial carries an end date — a free month with no end is a free plan");
  const days = Math.round((granted.endsAt.valueOf() - Date.now()) / 86_400_000);
  assert.ok(Math.abs(days - TRIAL_DAYS) <= 1, `ق-128: about a month (${days} days)`);

  // He can actually use the platform during the trial.
  const during = await activePlanForMerchant(prisma, merchantId);
  assert.equal(during.code, "growth", "ق-128: the trial plan resolves while it is live");
  // ق-181: the merchant is TOLD it is a trial, and when it ends. Before this he
  // read «خطة النمو» and a monthly price, and learned about the free month
  // only when day thirty-one moved him to the free plan in silence.
  const viewDuring = await merchantEntitlementsView(merchantId);
  assert.equal(viewDuring.subscription.isTrial, true, "ق-181: the view names the trial");
  assert.ok(viewDuring.subscription.endsAt, "ق-181: …with its end date");
  assert.ok(viewDuring.subscription.daysLeft >= TRIAL_DAYS - 1 && viewDuring.subscription.daysLeft <= TRIAL_DAYS, `ق-181: …and the days left (${viewDuring.subscription.daysLeft})`);
  assert.equal(viewDuring.subscription.afterTrialPlanCode, "free", "ق-181: …and where he lands after it");
  const listedDuring = (await listMerchantsWithPlans(100)).merchants.find((row) => row.id === merchantId);
  assert.equal(listedDuring?.isTrial, true, "ق-181: the owner sees who is on a free month");
  assert.ok(listedDuring?.subscriptionEndsAt, "…and when it ends");

  // ============================================================
  // 2ب (ق-186 / D-90). He is TOLD before it happens — once.
  // ============================================================
  // Outside the window first: a trial with twenty-nine days left is not news,
  // and a reminder that arrives a month early trains him to ignore the one that
  // matters. Then moved inside it, and the scanner run repeatedly — because it
  // wakes every ten minutes over a three-day window and will see this same
  // subscription some four hundred times.
  const quiet = await remindEndingTrials();
  assert.equal(quiet.due, 0, "ق-186: a trial with weeks left is not due for a reminder");

  await prisma.merchantSubscription.update({
    where: { id: granted.id },
    data: { endsAt: new Date(Date.now() + 2 * 86_400_000) },
  });
  const reminded = await remindEndingTrials();
  assert.equal(reminded.due, 1, "ق-186: two days out, he is due");
  assert.equal(reminded.enqueued, 1, "ق-186: …and the message is enqueued");

  const notice = await prisma.notificationOutbox.findFirstOrThrow({ where: { eventType: "trial.ending", recipient: email } });
  assert.equal(notice.storeId, null, "ق-186: the trial belongs to the MERCHANT — a two-store merchant is told once, not twice");
  assert.equal(notice.recipientKind, "account", "ق-186: an account message, so ق-184 gives it a reply path");
  assert.equal(notice.dedupeKey, `trial_ending:${granted.id}`);
  assert.equal(notice.payload.daysLeft, 2);

  const repeats = await Promise.all([remindEndingTrials(), remindEndingTrials(), remindEndingTrials()]);
  assert.deepEqual(repeats.map((pass) => pass.enqueued), [0, 0, 0], "ق-186: every later pass is a no-op — the once-only rule is the ق-185 index, not a flag this code remembers to set");
  assert.equal(await prisma.notificationOutbox.count({ where: { eventType: "trial.ending", recipient: email } }), 1, "ق-186: exactly one reminder exists after four passes");

  // The rendered Arabic must not frighten him: the fear this message creates
  // («هل أخسر متجري؟») is worse than the fact, and a merchant who is frightened
  // by his own platform does not read the second paragraph.
  const { renderMessage } = await import("../src/notifications/outbox-worker.ts");
  const rendered = renderMessage(notice);
  assert.match(rendered.subject, /تنتهي/, "ق-186: the subject says what is happening");
  assert.match(rendered.body, /الخطة المجانية/, "…where he lands");
  assert.match(rendered.body, /لا يُحذف شيء/, "…and that nothing is deleted");
  summary.reminder = { daysBefore: 2, enqueuedOnce: true, storeless: true };

  // ============================================================
  // 3 & 4. The day after. THIS is the pair that matters.
  // ============================================================
  // Backdated rather than waited for: thirty days is not a test.
  await prisma.merchantSubscription.update({
    where: { id: granted.id },
    data: { endsAt: new Date(Date.now() - 60_000) },
  });

  // ق-239 CHANGED WHAT THIS PAIR PROVES, AND THE CHANGE IS THE POINT.
  //
  // This used to assert that the merchant is ALREADY BROKEN before the job runs
  // — NO_ACTIVE_SUBSCRIPTION on every call, a dead dashboard and a dead
  // storefront checkout — and it was right to: the only thing standing between
  // him and that was how recently the sweeper had happened to run.
  //
  // That is no longer true, deliberately. The eight periodic jobs now share one
  // half-hourly tick (ق-239), which would have widened the window from ten
  // minutes to thirty, so the ANSWER stopped depending on the sweeper instead:
  // `activePlanForMerchant` resolves a lapsed trial to free by itself.
  //
  // THE JOB IS STILL NOT OPTIONAL — the reason moved. It no longer protects
  // AVAILABILITY; it protects the RECORD. The row is what the owner's own
  // screens read to know who is on which plan, and a merchant the platform
  // treats as free while his row still says «growth» is a report that lies.
  const beforeSweep = await activePlanForMerchant(prisma, merchantId);
  assert.equal(beforeSweep.code, "free", "ق-239: a lapsed trial resolves to free WITHOUT waiting for the sweeper");

  // And the row itself has not caught up yet — so the job has real work to do.
  const staleRow = await prisma.merchantSubscription.findUniqueOrThrow({
    where: { id: granted.id },
    select: { status: true, plan: { select: { code: true } } },
  });
  assert.equal(staleRow.status, "active", "the lapsed row is still the active one until the job runs");
  assert.equal(staleRow.plan.code, "growth", "…and still says growth — the record is what the sweeper fixes");

  const first = await expireLapsedTrials();
  assert.ok(first.expired >= 1, `ق-128: the lapsed trial is found (${first.expired})`);
  assert.ok(first.movedToFree >= 1, "ق-128: …and moved");

  const after = await activePlanForMerchant(prisma, merchantId);
  assert.equal(after.code, "free", "ق-128: he lands on FREE — explicitly written, not inferred");
  summary.landsOn = after.code;

  // 7. And nothing was suspended.
  const storeAfter = await prisma.store.findUniqueOrThrow({ where: { id: store.id }, select: { isActive: true } });
  assert.equal(storeAfter.isActive, true, "ق-128: the store stays ACTIVE — suspension would 404 shoppers with cash orders in flight");

  // The trial row is closed rather than deleted, so «كان لديه شهر مجاني» stays
  // a fact somebody can look up.
  const closed = await prisma.merchantSubscription.findUniqueOrThrow({ where: { id: granted.id }, select: { status: true } });
  assert.equal(closed.status, "expired", "ق-128: the trial is closed, not erased");

  // ============================================================
  // 5. Idempotent — two worker passes overlap eventually.
  // ============================================================
  const second = await expireLapsedTrials();
  assert.equal(second.expired, 0, "ق-128: a second pass finds nothing left to do");
  const activeRows = await prisma.merchantSubscription.count({ where: { merchantId, status: "active" } });
  assert.equal(activeRows, 1, "ق-128: exactly ONE active subscription — never two free rows");
  summary.idempotent = true;

  // ============================================================
  // 6. The owner's hand beats the job's clock.
  // ============================================================
  const other = await registerMerchantDirect({
      email: `${testId}-b@codiq.test`,
      password: "TrialMerchantPass2026!",
      businessName: "متجر ثانٍ",
      ownerName: "سيف الدين",
      phone: `+9647${String(Date.now() + 7).slice(-9)}`,
    });
  assert.equal(other.status, 201, JSON.stringify(other.payload));
  const secondMerchant = other.payload.account.id;
  const trialRow = await prisma.merchantSubscription.findFirstOrThrow({
    where: { merchantId: secondMerchant, status: "active" },
    select: { id: true },
  });
  await prisma.merchantSubscription.update({ where: { id: trialRow.id }, data: { endsAt: new Date(Date.now() - 60_000) } });
  // The owner assigns a paid plan by hand through the REAL service, the way he
  // would for a merchant who paid — not by inserting a row. `UNIQUE(merchant_id)
  // WHERE status = 'active'` means there is only ever one active row, so the
  // assignment closes the lapsed trial itself; writing a second active row
  // directly is a state the platform cannot reach, and a test that manufactures
  // it proves nothing about the platform.
  await assignMerchantSubscription(secondMerchant, { planCode: "pro" });

  await expireLapsedTrials();
  const decided = await activePlanForMerchant(prisma, secondMerchant);
  assert.equal(decided.code, "pro", "ق-128: the owner's decision wins — the job must not demote a merchant he just upgraded");
  const activeForSecond = await prisma.merchantSubscription.count({ where: { merchantId: secondMerchant, status: "active" } });
  assert.equal(activeForSecond, 1, "ق-128: …and it did not add a free row on top of the paid one");
  summary.ownerAssignmentWins = true;

  // ق-181: after the move to free, nothing calls itself a trial any more.
  const viewAfter = await merchantEntitlementsView(merchantId);
  assert.equal(viewAfter.subscription.isTrial, false, "ق-181: the free plan is not a trial");
  assert.equal(viewAfter.subscription.endsAt, null, "…and carries no end date");
  summary.trialPlan = TRIAL_PLAN_CODE;
  summary.trialDays = TRIAL_DAYS;
  summary.suspendsStore = false;

  console.log(JSON.stringify({ trialExpiry: summary }, null, 2));
  console.log("trial-expiry OK");
} finally {
  await sql.end().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  server.close();
}

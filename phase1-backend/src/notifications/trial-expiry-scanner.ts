/**
 * ق-128 — the free month ends, and the merchant lands on the free plan.
 *
 * ============================================================================
 * THIS JOB IS NOT AN OPTIMISATION. WITHOUT IT THE TRIAL IS A TRAP.
 * ============================================================================
 *
 * `activePlanForMerchant` (entitlement.service.ts) resolves a plan with
 * `status: "active"` AND `endsAt IS NULL OR endsAt > now()`. A trial row whose
 * `endsAt` simply lapses therefore matches NOTHING, and every call throws
 * `NO_ACTIVE_SUBSCRIPTION` (403).
 *
 * So on day thirty-one, a merchant who was never told anything would find his
 * dashboard dead AND his storefront's checkout dead — his shoppers included,
 * mid-delivery, in a cash-on-delivery business with no email channel to explain
 * it. Letting `ends_at` lapse is not "dropping to free"; it is deleting the
 * merchant's account by omission.
 *
 * The drop is therefore an EXPLICIT WRITE: the trial row is closed and a new
 * free-plan row is created, in one transaction. No merchant is ever without an
 * active subscription for even an instant.
 *
 * NEVER SUSPENSION. Suspension's only lever is `Store.isActive`, which turns
 * every storefront route into a 404 for shoppers who may have undelivered cash
 * orders, and locks the merchant out of the dashboard where he would fix it.
 * That is indefensible for a trial ending — a person who simply did not decide
 * yet is not a person to shut down.
 *
 * A SIXTH overlap-guarded interval in the standalone worker (ADR-004): never a
 * timer in a request path. A missed pass costs minutes, and the pass is
 * idempotent, so a merchant whose trial ended between two passes is moved on the
 * next one — he is over his trial by minutes, not stranded.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";
import { DEFAULT_PLAN_CODE, TRIAL_PLAN_CODE } from "../services/entitlement.service.js";

/**
 * Ten minutes. The trial is thirty days, so precision here is worth nothing and
 * a tighter interval would only add wake-ups; ten minutes is short enough that
 * nobody notices the gap and long enough to be invisible on the database.
 */
export const TRIAL_EXPIRY_SCAN_INTERVAL_MS = 10 * 60 * 1000;

const SCAN_PAGE_SIZE = 200;

export interface TrialExpiryResult {
  /** Subscriptions found lapsed this pass. */
  expired: number;
  /** …and successfully moved onto the free plan. */
  movedToFree: number;
}

export async function expireLapsedTrials(now = new Date()): Promise<TrialExpiryResult> {
  const result: TrialExpiryResult = { expired: 0, movedToFree: 0 };

  const freePlan = await prisma.plan.findUnique({ where: { code: DEFAULT_PLAN_CODE }, select: { id: true, isActive: true } });
  if (!freePlan?.isActive) {
    // Refusing to act is right: with no plan to land on, "expiring" the trial
    // would leave the merchant with no active subscription at all — the exact
    // outcome this job exists to prevent.
    logger.error("the free plan is missing or archived; no trial will be expired this pass", { job: "trial-expiry" });
    return result;
  }

  for (;;) {
    const lapsed = await prisma.merchantSubscription.findMany({
      where: { status: "active", endsAt: { not: null, lte: now } },
      orderBy: { id: "asc" },
      take: SCAN_PAGE_SIZE,
      select: { id: true, merchantId: true },
    });
    if (lapsed.length === 0) break;
    result.expired += lapsed.length;

    for (const subscription of lapsed) {
      try {
        await prisma.$transaction(async (tx) => {
          // Conditioned on still being active, so two overlapping passes cannot
          // both move the same merchant and leave him with two free rows.
          const closed = await tx.merchantSubscription.updateMany({
            where: { id: subscription.id, status: "active" },
            data: { status: "expired" },
          });
          if (closed.count === 0) return;
          // Re-checked INSIDE the transaction: the owner may have assigned a
          // paid plan by hand between the read above and this write, and that
          // decision must win over an expiry the job noticed first.
          const stillUncovered = await tx.merchantSubscription.findFirst({
            where: { merchantId: subscription.merchantId, status: "active", OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
            select: { id: true },
          });
          if (stillUncovered) return;
          await tx.merchantSubscription.create({
            data: { merchantId: subscription.merchantId, planId: freePlan.id, status: "active" },
          });
        });
        result.movedToFree += 1;
      } catch (error) {
        // One merchant's failure must not stop the pass: the others are equally
        // one query away from a dead dashboard.
        logger.error("job.row_failed", { job: "trial-expiry", merchantId: subscription.merchantId, err: error });
      }
    }

    if (lapsed.length < SCAN_PAGE_SIZE) break;
  }

  return result;
}

/**
 * ق-186 (D-90) — three days' notice, once.
 *
 * The job above is the safety net that keeps a lapsed trial from deleting an
 * account by omission. It is silent by design, and that silence is the gap:
 * ق-181 shows the end date to a merchant who opens his dashboard, and nothing
 * at all reaches the one who does not. He simply finds himself on a smaller
 * plan one morning, having never been asked.
 *
 * ONE ROW PER SUBSCRIPTION, ENFORCED BY THE DATABASE. The scanner wakes every
 * ten minutes and this window is three days wide, so it will see the same
 * merchant some four hundred times. `dedupeKey` + the partial unique index from
 * ق-185 make every pass after the first a no-op — the once-only rule is a
 * constraint, never a timer and never a flag this code has to remember to set.
 *
 * NO STORE ON THE ROW. The trial belongs to the merchant; a merchant with two
 * shops must be told once, not twice. That is why ق-186's migration widens
 * `notification_outbox_store_scope`.
 *
 * A merchant with no email address is skipped in the query rather than failed
 * in the loop: there is no channel to reach him, and a dead_letter row for a
 * message that was never sendable would be noise in his own log.
 */
export const TRIAL_REMINDER_DAYS_BEFORE = 3;

export interface TrialReminderResult {
  /** Subscriptions inside the reminder window this pass. */
  due: number;
  /** …newly enqueued. The rest were already reminded on an earlier pass. */
  enqueued: number;
}

export async function remindEndingTrials(now = new Date()): Promise<TrialReminderResult> {
  const result: TrialReminderResult = { due: 0, enqueued: 0 };
  const horizon = new Date(now.valueOf() + TRIAL_REMINDER_DAYS_BEFORE * 86_400_000);

  const ending = await prisma.merchantSubscription.findMany({
    where: {
      status: "active",
      endsAt: { gt: now, lte: horizon },
      plan: { code: TRIAL_PLAN_CODE },
      // `Merchant.email` is NOT NULL and unique, so there is no address-less
      // merchant to skip here; a disabled one is skipped because telling him his
      // trial is ending would be the first thing this platform said to him
      // after shutting his account off.
      merchant: { isActive: true },
    },
    orderBy: { id: "asc" },
    select: { id: true, endsAt: true, merchant: { select: { email: true, businessName: true } } },
  });
  result.due = ending.length;

  for (const subscription of ending) {
    const recipient = subscription.merchant.email;
    if (!recipient || !subscription.endsAt) continue;
    const daysLeft = Math.max(1, Math.ceil((subscription.endsAt.valueOf() - now.valueOf()) / 86_400_000));
    try {
      await prisma.notificationOutbox.create({
        data: {
          storeId: null,
          eventType: "trial.ending",
          recipientKind: "account",
          channel: "email",
          recipient,
          // The SUBSCRIPTION id, not the merchant's: a merchant who is granted a
          // second trial later is a second decision and deserves a second notice.
          dedupeKey: `trial_ending:${subscription.id}`,
          payload: {
            businessName: subscription.merchant.businessName,
            endsAt: subscription.endsAt.toISOString(),
            daysLeft,
            afterPlanCode: DEFAULT_PLAN_CODE,
          },
        },
      });
      result.enqueued += 1;
    } catch (error) {
      // The unique index IS the once-only rule; hitting it means an earlier pass
      // already told him, which is the outcome we want and not an error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      logger.error("job.row_failed", { job: "trial-expiry", subscriptionId: subscription.id, err: error });
    }
  }

  return result;
}

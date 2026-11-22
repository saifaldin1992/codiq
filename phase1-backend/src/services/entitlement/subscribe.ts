/**
 * Plans and entitlements — subscribe. Split verbatim from
 * entitlement.service.ts (review batch 4, ت-٢);
 * entitlement.service.ts re-exports what it always exported.
 */
import { HttpError } from "../../auth/auth.errors.js";
import { prisma } from "../../db/prisma.js";
import {
  type DbClient,
  activePlanForMerchant,
  PLAN_FEATURE_CODES,
  FEATURE_LABELS,
} from "./plans.js";
import { merchantUsage } from "./usage.js";

/** The plan auto-assigned to every new merchant; archiving it is refused (DEFAULT_PLAN_PROTECTED). */
export const DEFAULT_PLAN_CODE = "free";

/**
 * ق-128 — the plan the free month grants.
 *
 * GROWTH, NOT PRO, and the reason is revenue rather than generosity. Commission
 * is the only money this platform earns today, and the pro plan halves it during
 * exactly the month a new merchant is most active. Growth also caps image
 * storage at a level a later plan can still hold, so nothing a merchant uploads
 * during the trial can strand him afterwards — a pro-sized upload could.
 */
export const TRIAL_PLAN_CODE = "growth";

/** Thirty days. «شهر مجاني» — the owner's words, and what a merchant will expect. */
export const TRIAL_DAYS = 30;

/**
 * Every new merchant starts on the FREE MONTH (ق-128); idempotent inside the
 * creation transaction.
 *
 * The trial is a normal subscription row with an `endsAt` — no new column and no
 * new table, because `merchant_subscriptions.ends_at` already existed and was
 * unused on active rows.
 *
 * IT FALLS BACK TO FREE if growth is missing or archived, rather than throwing.
 * A merchant must never fail to register because a PLAN was archived; landing on
 * free is a smaller wrong than being unable to sign up at all.
 *
 * THE EXPIRY JOB IS NOT OPTIONAL. `activePlanForMerchant` refuses a row whose
 * `endsAt` has passed, so a lapsed trial with no replacement means
 * NO_ACTIVE_SUBSCRIPTION on every call — a dead dashboard AND a dead storefront
 * checkout. `trial-expiry-scanner.ts` is what makes this line safe to write.
 */
export async function subscribeMerchantToDefaultPlan(
  client: DbClient,
  merchantId: string,
  now = new Date()
): Promise<void> {
  const existing = await client.merchantSubscription.findFirst({
    where: { merchantId, status: "active" },
    select: { id: true },
  });
  if (existing) return;
  const trialPlan = await client.plan.findUnique({
    where: { code: TRIAL_PLAN_CODE },
    select: { id: true, isActive: true },
  });
  if (trialPlan?.isActive) {
    await client.merchantSubscription.create({
      data: {
        merchantId,
        planId: trialPlan.id,
        status: "active",
        endsAt: new Date(now.valueOf() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return;
  }
  const freePlan = await client.plan.findUnique({
    where: { code: DEFAULT_PLAN_CODE },
    select: { id: true, isActive: true },
  });
  if (!freePlan || !freePlan.isActive)
    throw new HttpError(
      500,
      "DEFAULT_PLAN_MISSING",
      "الخطة الافتراضية غير موجودة؛ تحقق من ترحيل قاعدة البيانات."
    );
  await client.merchantSubscription.create({
    data: { merchantId, planId: freePlan.id, status: "active" },
  });
}

/**
 * ق-181 — the trial is named, and its end is a date the merchant can read.
 *
 * A trial row is a normal subscription with `endsAt` (ق-128), so before this
 * the merchant saw «خطة النمو» and its monthly price, and was never told the
 * month was free, or when it ended, or that on the thirty-first day he would
 * be moved to the free plan in silence. `isTrial` is the trial plan WITH an
 * end date — an owner-assigned growth subscription has none.
 */
export function subscriptionSummary(
  row: { endsAt: Date | null; plan: { code: string } } | null,
  now = new Date()
) {
  const endsAt = row?.endsAt ?? null;
  const isTrial = row?.plan.code === TRIAL_PLAN_CODE && endsAt !== null;
  const daysLeft = endsAt
    ? Math.max(0, Math.ceil((endsAt.valueOf() - now.valueOf()) / 86_400_000))
    : null;
  return { endsAt, isTrial, daysLeft, afterTrialPlanCode: DEFAULT_PLAN_CODE };
}

export async function merchantEntitlementsView(merchantId: string) {
  const plan = await activePlanForMerchant(prisma, merchantId);
  const usage = await merchantUsage(prisma, merchantId);
  const row = await prisma.merchantSubscription.findFirst({
    where: { merchantId, status: "active", OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
    orderBy: { startedAt: "desc" },
    select: { endsAt: true, plan: { select: { code: true } } },
  });
  return {
    plan: {
      code: plan.code,
      name: plan.name,
      monthlyPriceIqd: plan.monthlyPriceIqd,
      version: plan.version,
    },
    subscription: subscriptionSummary(row),
    entitlements: PLAN_FEATURE_CODES.map((code) => ({
      feature: code,
      label: FEATURE_LABELS[code],
      limit: plan.limits[code],
      used: usage[code],
    })),
  };
}

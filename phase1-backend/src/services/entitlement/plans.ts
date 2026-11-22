/**
 * Plans and entitlements — plans. Split verbatim from
 * entitlement.service.ts (review batch 4, ت-٢);
 * entitlement.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { DEFAULT_PLAN_CODE } from "./subscribe.js";

export type DbClient = Prisma.TransactionClient | typeof prisma;

export const PLAN_FEATURE_CODES = [
  "max_stores",
  "max_products",
  "max_staff",
  "max_monthly_orders",
  "max_image_storage_mb",
] as const;

export type PlanFeatureCode = (typeof PLAN_FEATURE_CODES)[number];

export const FEATURE_LABELS: Record<PlanFeatureCode, string> = {
  max_stores: "عدد المتاجر",
  max_products: "عدد المنتجات",
  max_staff: "عدد الموظفين",
  max_monthly_orders: "طلبات الشهر",
  max_image_storage_mb: "مساحة الصور (ميغابايت)",
};

/**
 * ق-243 — the two terminal states an order reaches WITHOUT a delivery, and
 * therefore without ever passing through the platform's money path. Neither
 * spends the monthly quota. Exported so the test and the panel copy name the
 * same two words this meter does, rather than each keeping its own list.
 */
export const QUOTA_EXEMPT_STATUSES = ["cancelled", "rejected"] as const;

export interface PlanSummary {
  id: string;
  code: string;
  name: string;
  monthlyPriceIqd: number;
  commissionBps: number;
  limits: Record<PlanFeatureCode, number>;
  /** Phase 30: the published version these terms come from; null only for an unversioned fallback. */
  version: number | null;
}

/**
 * Phase 30 — terms come from the subscription's PINNED version, not the plan
 * row. The plan row (and plan_features) is the latest published terms, which is
 * what the catalogue sells; a merchant who subscribed earlier keeps what he
 * subscribed under until renewal.
 */
function versionSummary(
  plan: { id: string; code: string; name: string },
  version: { version: number; monthlyPriceIqd: number; commissionBps: number; limits: unknown }
): PlanSummary {
  const limits = Object.fromEntries(PLAN_FEATURE_CODES.map((code) => [code, 0])) as Record<
    PlanFeatureCode,
    number
  >;
  const stored = (
    version.limits && typeof version.limits === "object" ? version.limits : {}
  ) as Record<string, unknown>;
  for (const code of PLAN_FEATURE_CODES) {
    if (Number.isInteger(stored[code])) limits[code] = stored[code] as number;
  }
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    monthlyPriceIqd: version.monthlyPriceIqd,
    commissionBps: version.commissionBps,
    limits,
    version: version.version,
  };
}

/** The terms a plan currently sells, as a version snapshot (`limits` as stored on plan_versions). */
export async function currentTerms(tx: Prisma.TransactionClient, planId: string) {
  const plan = await tx.plan.findUniqueOrThrow({
    where: { id: planId },
    select: {
      monthlyPriceIqd: true,
      commissionBps: true,
      features: { select: { featureCode: true, limitValue: true } },
    },
  });
  return {
    monthlyPriceIqd: plan.monthlyPriceIqd,
    commissionBps: plan.commissionBps,
    limits: Object.fromEntries(
      plan.features.map((feature) => [feature.featureCode, feature.limitValue])
    ) as Record<string, number>,
  };
}

/** Publishes the plan's current terms as its next version. Called inside the transaction that changed them. */
export async function publishPlanVersion(tx: Prisma.TransactionClient, planId: string) {
  const latest = await tx.planVersion.findFirst({
    where: { planId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const terms = await currentTerms(tx, planId);
  return tx.planVersion.create({
    data: { planId, version: (latest?.version ?? 0) + 1, ...terms },
    select: { version: true },
  });
}

export function planSummary(plan: {
  id: string;
  code: string;
  name: string;
  monthlyPriceIqd: number;
  commissionBps: number;
  features: { featureCode: string; limitValue: number }[];
}): PlanSummary {
  const limits = Object.fromEntries(PLAN_FEATURE_CODES.map((code) => [code, 0])) as Record<
    PlanFeatureCode,
    number
  >;
  for (const feature of plan.features) {
    if ((PLAN_FEATURE_CODES as readonly string[]).includes(feature.featureCode))
      limits[feature.featureCode as PlanFeatureCode] = feature.limitValue;
  }
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    monthlyPriceIqd: plan.monthlyPriceIqd,
    commissionBps: plan.commissionBps,
    limits,
    version: null,
  };
}

export async function activePlanForMerchant(
  client: DbClient,
  merchantId: string
): Promise<PlanSummary> {
  const subscription = await client.merchantSubscription.findFirst({
    where: { merchantId, status: "active", OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
    orderBy: { startedAt: "desc" },
    select: {
      plan: { select: { id: true, code: true, name: true } },
      planVersion: {
        select: { version: true, monthlyPriceIqd: true, commissionBps: true, limits: true },
      },
    },
  });
  if (subscription) return versionSummary(subscription.plan, subscription.planVersion);

  /**
   * ق-239 — A READ MUST NOT DEPEND ON A SWEEPER HAVING RUN.
   *
   * The line above refuses a subscription whose `endsAt` has passed, and until
   * now the only thing standing between a merchant and NO_ACTIVE_SUBSCRIPTION on
   * every single call — a dead dashboard AND a dead storefront checkout — was
   * how recently `trial-expiry` happened to have swept. That was a ten-minute
   * window. ق-239 put the eight periodic jobs on one half-hourly tick, which
   * would have widened it to thirty; the honest fix is not to run the sweeper
   * faster but to stop the ANSWER depending on it.
   *
   * So a lapsed trial resolves to the free plan HERE, which is exactly the row
   * the sweeper would write. The job still runs and still writes it — it
   * materialises the state rather than producing it, which is what a background
   * job should ever be.
   *
   * NARROW ON PURPOSE. Only an `active` row whose `endsAt` has passed earns the
   * fallback. A subscription the owner deliberately deactivated is not a lapsed
   * trial, and must keep refusing: silently handing it the free plan would undo
   * a deliberate act by the one person entitled to make it.
   */
  const lapsed = await client.merchantSubscription.findFirst({
    where: { merchantId, status: "active", endsAt: { lte: new Date() } },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (lapsed) {
    const fallback = await client.plan.findFirst({
      where: { code: DEFAULT_PLAN_CODE, isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        monthlyPriceIqd: true,
        commissionBps: true,
        features: { select: { featureCode: true, limitValue: true } },
      },
    });
    // And if the free plan itself is missing or archived, the refusal below is
    // the right answer: that is a platform misconfiguration, not a lapsed trial.
    if (fallback) return planSummary(fallback);
  }
  throw new HttpError(
    403,
    "NO_ACTIVE_SUBSCRIPTION",
    "لا يوجد اشتراك نشط لهذا التاجر؛ راجِع إدارة المنصة."
  );
}

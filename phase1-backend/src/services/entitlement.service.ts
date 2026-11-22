/**
 * codiq phase 16 — plan entitlement resolver (ADR-005).
 * One server-side service answers every gated write: usage is computed live from
 * the database against the merchant's ACTIVE subscription, and exceeding a limit
 * returns 403 PLAN_LIMIT_EXCEEDED with a clear Arabic message. The client never
 * supplies plan, merchant, or usage context.
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { platformActorLabelFor, recordPlatformAuditEvent } from "./platform-audit.service.js";
import { LIVE } from "./soft-delete/constants.js";
import { domainEvents } from "../events/domain-events.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export const PLAN_FEATURE_CODES = [
  "max_stores",
  "max_products",
  "max_staff",
  "max_monthly_orders",
  "max_image_storage_mb",
] as const;
export type PlanFeatureCode = (typeof PLAN_FEATURE_CODES)[number];

const FEATURE_LABELS: Record<PlanFeatureCode, string> = {
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
function versionSummary(plan: { id: string; code: string; name: string }, version: { version: number; monthlyPriceIqd: number; commissionBps: number; limits: unknown }): PlanSummary {
  const limits = Object.fromEntries(PLAN_FEATURE_CODES.map((code) => [code, 0])) as Record<PlanFeatureCode, number>;
  const stored = (version.limits && typeof version.limits === "object" ? version.limits : {}) as Record<string, unknown>;
  for (const code of PLAN_FEATURE_CODES) {
    if (Number.isInteger(stored[code])) limits[code] = stored[code] as number;
  }
  return { id: plan.id, code: plan.code, name: plan.name, monthlyPriceIqd: version.monthlyPriceIqd, commissionBps: version.commissionBps, limits, version: version.version };
}

/** The terms a plan currently sells, as a version snapshot (`limits` as stored on plan_versions). */
async function currentTerms(tx: Prisma.TransactionClient, planId: string) {
  const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId }, select: { monthlyPriceIqd: true, commissionBps: true, features: { select: { featureCode: true, limitValue: true } } } });
  return {
    monthlyPriceIqd: plan.monthlyPriceIqd,
    commissionBps: plan.commissionBps,
    limits: Object.fromEntries(plan.features.map((feature) => [feature.featureCode, feature.limitValue])) as Record<string, number>,
  };
}

/** Publishes the plan's current terms as its next version. Called inside the transaction that changed them. */
async function publishPlanVersion(tx: Prisma.TransactionClient, planId: string) {
  const latest = await tx.planVersion.findFirst({ where: { planId }, orderBy: { version: "desc" }, select: { version: true } });
  const terms = await currentTerms(tx, planId);
  return tx.planVersion.create({ data: { planId, version: (latest?.version ?? 0) + 1, ...terms }, select: { version: true } });
}

function planSummary(plan: { id: string; code: string; name: string; monthlyPriceIqd: number; commissionBps: number; features: { featureCode: string; limitValue: number }[] }): PlanSummary {
  const limits = Object.fromEntries(PLAN_FEATURE_CODES.map((code) => [code, 0])) as Record<PlanFeatureCode, number>;
  for (const feature of plan.features) {
    if ((PLAN_FEATURE_CODES as readonly string[]).includes(feature.featureCode)) limits[feature.featureCode as PlanFeatureCode] = feature.limitValue;
  }
  return { id: plan.id, code: plan.code, name: plan.name, monthlyPriceIqd: plan.monthlyPriceIqd, commissionBps: plan.commissionBps, limits, version: null };
}

export async function activePlanForMerchant(client: DbClient, merchantId: string): Promise<PlanSummary> {
  const subscription = await client.merchantSubscription.findFirst({
    where: { merchantId, status: "active", OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
    orderBy: { startedAt: "desc" },
    select: {
      plan: { select: { id: true, code: true, name: true } },
      planVersion: { select: { version: true, monthlyPriceIqd: true, commissionBps: true, limits: true } },
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
      select: { id: true, code: true, name: true, monthlyPriceIqd: true, commissionBps: true, features: { select: { featureCode: true, limitValue: true } } },
    });
    // And if the free plan itself is missing or archived, the refusal below is
    // the right answer: that is a platform misconfiguration, not a lapsed trial.
    if (fallback) return planSummary(fallback);
  }
  throw new HttpError(403, "NO_ACTIVE_SUBSCRIPTION", "لا يوجد اشتراك نشط لهذا التاجر؛ راجِع إدارة المنصة.");
}

function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function merchantUsage(client: DbClient, merchantId: string): Promise<Record<PlanFeatureCode, number>> {
  const [stores, products, staff, monthlyOrders, storage, prescriptionStorage, bannerStorage, logoStorage, reelStorage] = await Promise.all([
    client.store.count({ where: { merchantId } }),
    // PG-2: a product in the trash bin does NOT spend the plan quota — otherwise a
    // merchant at his limit could not replace a product for thirty days. Staff is
    // already isActive-filtered, and the image aggregate below deliberately stays
    // unfiltered: those bytes really are still stored until the purge (plan §6.6).
    client.product.count({ where: { store: { merchantId }, ...LIVE } }),
    client.storeStaffMembership.count({ where: { isActive: true, store: { merchantId }, deletedAt: null } }),
    // ق-135: a COUNTER sale does not spend the monthly-order quota. The cap is
    // B-08's upgrade trigger for platform-carried volume; a POS sale never
    // passes through the platform's money path — counting it would let a busy
    // till silently block the merchant's own online shoppers at checkout.
    //
    // ق-243: NEITHER DOES AN ORDER THAT CARRIED NO MONEY. `cancelled` and
    // `rejected` are the two terminal states a row reaches WITHOUT a delivery —
    // the shopper changed his mind, or the merchant refused a fake COD order.
    // They used to spend the quota exactly like a sale, which turned the
    // merchant's own act of rejecting junk into the thing that closed his shop:
    // one phone with a script, inside the deliberately loose 40-per-address
    // checkout wall, filled a free shop's whole month in under an hour, and
    // every honest shopper after that read «المتجر لا يستقبل طلبات جديدة
    // حالياً» until the 1st. The merchant's bar said 200/200 and never that
    // sixty of those were the ones he refused.
    //
    // `returned` STAYS COUNTED, on purpose: a returned order was a real
    // delivery that passed through the platform's money path and was booked —
    // ق-135's definition of what the quota measures. The line is «did the
    // platform carry it», not «did the merchant keep the money».
    client.storeOrder.count({
      where: { store: { merchantId }, createdAt: { gte: monthStartUtc() }, source: { not: "pos" }, status: { notIn: [...QUOTA_EXEMPT_STATUSES] } },
    }),
    client.productImage.aggregate({ where: { store: { merchantId } }, _sum: { byteSize: true } }),
    // 19-د: prescriptions ride the same bucket and the same 5 MB ceiling as
    // product images, and until now they were charged to NOBODY — a shopper on
    // a pharmacy store could push megabytes into the merchant's bucket for
    // free, and no plan ever noticed. Counting them here is what makes the
    // `assertWithinPlanLimit` call in the upload path a real limit rather than
    // a check against a number that never moves.
    client.orderPrescription.aggregate({ where: { store: { merchantId } }, _sum: { byteSize: true } }),
    // ق-198/ق-199: the storefront's own images — the front-page slides and the
    // logo — ride the same bucket and are charged at upload time against THIS
    // meter. Until they were summed here the charge was against a number that
    // never moved: a merchant could fill his plan with slides and the meter
    // would still read the product images alone.
    client.storeBanner.aggregate({ where: { store: { merchantId } }, _sum: { byteSize: true } }),
    client.store.aggregate({ where: { merchantId }, _sum: { logoByteSize: true } }),
    // Marketplace M10: the store's reels (up to 30 MB each) sit in the same bucket.
    // Pending, approved and rejected ones are all still stored; only a removed
    // reel's video has been deleted.
    client.marketReel.aggregate({ where: { store: { merchantId }, status: { not: "removed" } }, _sum: { videoByteSize: true } }),
  ]);
  return {
    max_stores: stores,
    max_products: products,
    max_staff: staff,
    max_monthly_orders: monthlyOrders,
    max_image_storage_mb: Math.ceil(((storage._sum.byteSize ?? 0) + (prescriptionStorage._sum.byteSize ?? 0) + (bannerStorage._sum.byteSize ?? 0) + (logoStorage._sum.logoByteSize ?? 0) + (reelStorage._sum.videoByteSize ?? 0)) / (1024 * 1024)),
  };
}

/**
 * Rejects the write when current usage + increment would exceed the plan limit.
 * Runs inside the caller's transaction when one is provided so the check and the
 * write see the same snapshot.
 */
/** The platform setting that caps each plan feature above every plan. */
const PLATFORM_CAP_SETTING: Record<PlanFeatureCode, string> = {
  max_stores: "stores.max",
  max_products: "catalog.products_max",
  max_staff: "team.staff_max",
  max_monthly_orders: "orders.monthly_max",
  max_image_storage_mb: "storage.image_mb_max",
};

/**
 * The platform's own ceiling over every plan («stores.max» and friends), read
 * here directly rather than through config.service, which itself reads plans.
 * Absent means «the plan decides».
 */
async function platformCapFor(client: DbClient, feature: PlanFeatureCode): Promise<number | null> {
  const row = await client.platformSetting.findUnique({ where: { key: `config.${PLATFORM_CAP_SETTING[feature]}` }, select: { value: true } });
  if (!row) return null;
  try {
    const value = JSON.parse(row.value);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** The limit that actually applies: the plan's, tightened by the platform's cap. */
export async function effectiveLimit(client: DbClient, plan: PlanSummary, feature: PlanFeatureCode): Promise<number> {
  const cap = await platformCapFor(client, feature);
  return cap === null ? plan.limits[feature] : Math.min(plan.limits[feature], cap);
}

export async function assertWithinPlanLimit(client: DbClient, merchantId: string, feature: PlanFeatureCode, increment = 1, action = "لمتابعة الإضافة"): Promise<void> {
  // COUNT-THEN-INSERT is a race under READ COMMITTED: two writes at the limit
  // each count limit−1 and both pass. Inside a transaction the check takes a
  // per-(merchant, feature) lock held to commit, so the second waits for the
  // first's row and counts it. A caller outside a transaction (the image
  // uploads) keeps the plain check — storage is measured, not inserted here.
  // The monthly order count is exempt on purpose: checkout already accepts «one
  // more order» in a race (storefront.service, ق-222), and a lock there would
  // serialize every checkout of every store a merchant owns.
  if (client !== prisma && feature !== "max_monthly_orders") await (client as Prisma.TransactionClient).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${merchantId}:${feature}`}))`;
  const plan = await activePlanForMerchant(client, merchantId);
  const limit = await effectiveLimit(client, plan, feature);
  const usage = await merchantUsage(client, merchantId);
  if (usage[feature] + increment > limit) {
    throw new HttpError(
      403,
      "PLAN_LIMIT_EXCEEDED",
      `وصلت إلى حد «${FEATURE_LABELS[feature]}» في خطة «${plan.name}» (${limit}). قم بالترقية ${action}.`,
    );
  }
}

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
export async function subscribeMerchantToDefaultPlan(client: DbClient, merchantId: string, now = new Date()): Promise<void> {
  const existing = await client.merchantSubscription.findFirst({ where: { merchantId, status: "active" }, select: { id: true } });
  if (existing) return;
  const trialPlan = await client.plan.findUnique({ where: { code: TRIAL_PLAN_CODE }, select: { id: true, isActive: true } });
  if (trialPlan?.isActive) {
    await client.merchantSubscription.create({
      data: { merchantId, planId: trialPlan.id, status: "active", endsAt: new Date(now.valueOf() + TRIAL_DAYS * 24 * 60 * 60 * 1000) },
    });
    return;
  }
  const freePlan = await client.plan.findUnique({ where: { code: DEFAULT_PLAN_CODE }, select: { id: true, isActive: true } });
  if (!freePlan || !freePlan.isActive) throw new HttpError(500, "DEFAULT_PLAN_MISSING", "الخطة الافتراضية غير موجودة؛ تحقق من ترحيل قاعدة البيانات.");
  await client.merchantSubscription.create({ data: { merchantId, planId: freePlan.id, status: "active" } });
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
export function subscriptionSummary(row: { endsAt: Date | null; plan: { code: string } } | null, now = new Date()) {
  const endsAt = row?.endsAt ?? null;
  const isTrial = row?.plan.code === TRIAL_PLAN_CODE && endsAt !== null;
  const daysLeft = endsAt ? Math.max(0, Math.ceil((endsAt.valueOf() - now.valueOf()) / 86_400_000)) : null;
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
    plan: { code: plan.code, name: plan.name, monthlyPriceIqd: plan.monthlyPriceIqd, version: plan.version },
    subscription: subscriptionSummary(row),
    entitlements: await Promise.all(PLAN_FEATURE_CODES.map(async (code) => ({ feature: code, label: FEATURE_LABELS[code], limit: await effectiveLimit(prisma, plan, code), used: usage[code] }))),
  };
}

// ---------- platform-owner operations ----------

const planInclude = { features: { select: { featureCode: true, limitValue: true } } } as const;

export async function listPlans() {
  const plans = await prisma.plan.findMany({ include: planInclude, orderBy: { sortOrder: "asc" } });
  // Phase 30: per plan, its current version and how many ACTIVE subscriptions
  // still run on an older one — what the owner must know before re-assigning.
  const counts = await prisma.$queryRaw<Array<{ plan_id: string; current_version: number | null; on_current: bigint; on_older: bigint }>>(Prisma.sql`
    SELECT p.id AS plan_id,
           (SELECT max(v.version) FROM plan_versions v WHERE v.plan_id = p.id) AS current_version,
           count(s.id) FILTER (WHERE sv.version = (SELECT max(v.version) FROM plan_versions v WHERE v.plan_id = p.id)) AS on_current,
           count(s.id) FILTER (WHERE sv.version < (SELECT max(v.version) FROM plan_versions v WHERE v.plan_id = p.id)) AS on_older
      FROM plans p
      LEFT JOIN merchant_subscriptions s ON s.plan_id = p.id AND s.status = 'active'
      LEFT JOIN plan_versions sv ON sv.id = s.plan_version_id
     GROUP BY p.id`);
  const byPlan = new Map(counts.map((row) => [row.plan_id, row]));
  return plans.map((plan) => {
    const count = byPlan.get(plan.id);
    return {
      ...planSummary(plan),
      version: count?.current_version ?? null,
      subscribers: { onCurrentVersion: Number(count?.on_current ?? 0), onOlderVersions: Number(count?.on_older ?? 0) },
      isActive: plan.isActive,
      isRecommended: plan.isRecommended,
      sortOrder: plan.sortOrder,
    };
  });
}

/**
 * At most one plan may carry «توصية المنصة» on the public pricing grid, so
 * recommending one clears every other inside the SAME transaction as the write.
 * The partial unique index `plans_single_recommended` backs the same invariant
 * at the database layer, so two racing owner sessions cannot both win.
 * Recommending an archived plan is refused: an archived plan is not published.
 */
async function applyRecommendation(tx: Prisma.TransactionClient, planId: string, recommended: boolean): Promise<void> {
  if (!recommended) {
    await tx.plan.update({ where: { id: planId }, data: { isRecommended: false } });
    return;
  }
  const target = await tx.plan.findUnique({ where: { id: planId }, select: { isActive: true } });
  if (!target?.isActive) throw new HttpError(409, "ARCHIVED_PLAN_NOT_RECOMMENDABLE", "لا يمكن ترشيح خطة مؤرشفة — أعِد تفعيلها أولاً ثم رشّحه.");
  await tx.plan.updateMany({ where: { isRecommended: true, id: { not: planId } }, data: { isRecommended: false } });
  await tx.plan.update({ where: { id: planId }, data: { isRecommended: true } });
}

/** Shared field validation for create/update; entries are [featureCode, limitValue]. */
function validatedLimitEntries(limits: unknown): [string, number][] {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) throw new HttpError(422, "INVALID_INPUT", "limits يجب أن يكون كائناً.");
  const entries: [string, number][] = [];
  for (const [featureCode, limitValue] of Object.entries(limits as Record<string, unknown>)) {
    if (!(PLAN_FEATURE_CODES as readonly string[]).includes(featureCode)) throw new HttpError(422, "INVALID_INPUT", `ميزة غير معروفة: ${featureCode}`);
    if (!Number.isInteger(limitValue) || (limitValue as number) < 0) throw new HttpError(422, "INVALID_INPUT", `حد ${featureCode} يجب أن يكون عدداً صحيحاً غير سالب.`);
    entries.push([featureCode, limitValue as number]);
  }
  return entries;
}

export async function updatePlan(planId: string, actor: PlatformActor, body: Record<string, unknown>) {
  const plan = await prisma.plan.findUnique({ where: { id: planId }, select: { id: true, code: true, name: true } });
  if (!plan) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة غير موجودة.");
  const data: Prisma.PlanUpdateInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length < 2 || body.name.trim().length > 120) throw new HttpError(422, "INVALID_INPUT", "اسم الخطة غير صالح.");
    data.name = body.name.trim();
  }
  if (body.monthlyPriceIqd !== undefined) {
    if (!Number.isInteger(body.monthlyPriceIqd) || (body.monthlyPriceIqd as number) < 0) throw new HttpError(422, "INVALID_INPUT", "سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.");
    data.monthlyPriceIqd = body.monthlyPriceIqd as number;
  }
  if (body.commissionBps !== undefined) {
    if (!Number.isInteger(body.commissionBps) || (body.commissionBps as number) < 0 || (body.commissionBps as number) > 10000) throw new HttpError(422, "INVALID_INPUT", "عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.");
    data.commissionBps = body.commissionBps as number;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw new HttpError(422, "INVALID_INPUT", "isActive يجب أن يكون قيمة منطقية.");
    if (body.isActive === false && plan.code === DEFAULT_PLAN_CODE) throw new HttpError(409, "DEFAULT_PLAN_PROTECTED", "لا يمكن أرشفة الخطة الافتراضية — تُسند تلقائياً لكل تاجر جديد عند التسجيل.");
    data.isActive = body.isActive;
  }
  if (body.isRecommended !== undefined && typeof body.isRecommended !== "boolean") {
    throw new HttpError(422, "INVALID_INPUT", "isRecommended يجب أن يكون قيمة منطقية.");
  }
  const limitEntries = body.limits === undefined ? undefined : validatedLimitEntries(body.limits);
  let publishedVersion: number | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.plan.update({ where: { id: planId }, data });
    // Applied after the field write so an isActive:false in the same PATCH is
    // already visible to the archived-plan check below.
    if (body.isRecommended !== undefined) await applyRecommendation(tx, planId, body.isRecommended as boolean);
    if (limitEntries) {
      for (const [featureCode, limitValue] of limitEntries) {
        await tx.planFeature.upsert({
          where: { planId_featureCode: { planId, featureCode } },
          create: { planId, featureCode, limitValue },
          update: { limitValue },
        });
      }
    }
    // Phase 30: a change to what the plan SELLS (price, commission, limits) is a
    // new published version; current subscribers keep theirs until renewal.
    // Name, archive and recommendation are presentation, not terms.
    const termsChanged = body.monthlyPriceIqd !== undefined || body.commissionBps !== undefined || limitEntries !== undefined;
    if (termsChanged) {
      const latest = await tx.planVersion.findFirst({ where: { planId }, orderBy: { version: "desc" }, select: { monthlyPriceIqd: true, commissionBps: true, limits: true } });
      const now = await currentTerms(tx, planId);
      const same = latest && latest.monthlyPriceIqd === now.monthlyPriceIqd && latest.commissionBps === now.commissionBps
        && JSON.stringify(Object.entries(latest.limits as Record<string, number>).sort()) === JSON.stringify(Object.entries(now.limits).sort());
      if (!same) publishedVersion = (await publishPlanVersion(tx, planId)).version;
    }
    // 19-ب: the change and its record commit together.
    await recordPlatformAuditEvent(tx, {
      entityType: "plan",
      entityId: planId,
      entityLabel: typeof body.name === "string" && body.name.trim() ? body.name.trim() : plan.name,
      action: "plan_updated",
      actor,
      metadata: { changed: Object.keys(body), ...(publishedVersion ? { publishedVersion } : {}) },
    });
  });
  if (publishedVersion) domainEvents.emit("plan.version_published", { planId, version: publishedVersion });
  const updated = await prisma.plan.findUnique({ where: { id: planId }, include: planInclude });
  return { ...planSummary(updated!), isActive: updated!.isActive, isRecommended: updated!.isRecommended, sortOrder: updated!.sortOrder, ...(publishedVersion ? { publishedVersion } : {}) };
}

/** Exported so `schemas/platform.schema.ts` asserts THIS rule rather than a copy of it. */
export const PLAN_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Owner-created plan (approved addition 2026-08-26); same validation rules as updatePlan. */
export async function createPlan(actor: PlatformActor, body: Record<string, unknown>) {
  if (typeof body.code !== "string" || !PLAN_CODE_PATTERN.test(body.code)) {
    throw new HttpError(422, "INVALID_INPUT", "رمز الخطة يجب أن يكون بأحرف إنجليزية صغيرة وأرقام وشرطات فقط (حتى 40 حرفاً).");
  }
  if (typeof body.name !== "string" || body.name.trim().length < 2 || body.name.trim().length > 120) throw new HttpError(422, "INVALID_INPUT", "اسم الخطة غير صالح.");
  if (body.monthlyPriceIqd !== undefined && (!Number.isInteger(body.monthlyPriceIqd) || (body.monthlyPriceIqd as number) < 0)) {
    throw new HttpError(422, "INVALID_INPUT", "سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.");
  }
  if (body.commissionBps !== undefined && (!Number.isInteger(body.commissionBps) || (body.commissionBps as number) < 0 || (body.commissionBps as number) > 10000)) {
    throw new HttpError(422, "INVALID_INPUT", "عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.");
  }
  if (body.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || (body.sortOrder as number) < 0)) {
    throw new HttpError(422, "INVALID_INPUT", "ترتيب الخطة يجب أن يكون عدداً صحيحاً غير سالب.");
  }
  const limitEntries = body.limits === undefined ? [] : validatedLimitEntries(body.limits);
  const occupied = await prisma.plan.findUnique({ where: { code: body.code }, select: { id: true } });
  if (occupied) throw new HttpError(409, "DUPLICATE_PLAN_CODE", "رمز الخطة مستخدم بالفعل لخطة أخرى.");
  const name = body.name.trim();
  // 19-ب: creation and its audit record commit together.
  const created = await prisma.$transaction(async (tx) => {
    const plan = await tx.plan.create({
      data: {
        code: body.code as string,
        name,
        monthlyPriceIqd: (body.monthlyPriceIqd as number | undefined) ?? 0,
        commissionBps: (body.commissionBps as number | undefined) ?? 0,
        sortOrder: (body.sortOrder as number | undefined) ?? 0,
        features: { createMany: { data: limitEntries.map(([featureCode, limitValue]) => ({ featureCode, limitValue })) } },
      },
      include: planInclude,
    });
    // Phase 30: a new plan is published as version 1 of its terms.
    await publishPlanVersion(tx, plan.id);
    await recordPlatformAuditEvent(tx, {
      entityType: "plan",
      entityId: plan.id,
      entityLabel: name,
      action: "plan_created",
      actor,
      metadata: { code: plan.code },
    });
    return plan;
  });
  return { ...planSummary(created), isActive: created.isActive, isRecommended: created.isRecommended, sortOrder: created.sortOrder };
}

/**
 * Archive instead of delete (approved addition 2026-08-26): an archived plan
 * leaves the public pricing list and refuses NEW subscriptions, while existing
 * subscribers keep their entitlements untouched. The default plan is protected.
 */
export async function setPlanArchived(planId: string, actor: PlatformActor, archived: boolean) {
  const plan = await prisma.plan.findUnique({ where: { id: planId }, select: { id: true, code: true, name: true } });
  if (!plan) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة غير موجودة.");
  if (archived && plan.code === DEFAULT_PLAN_CODE) {
    throw new HttpError(409, "DEFAULT_PLAN_PROTECTED", "لا يمكن أرشفة الخطة الافتراضية — تُسند تلقائياً لكل تاجر جديد عند التسجيل.");
  }
  // Archiving drops the recommendation with it: an archived plan leaves the public
  // pricing grid, so it must not stay the platform's published recommendation.
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.plan.update({
      where: { id: planId },
      data: archived ? { isActive: false, isRecommended: false } : { isActive: true },
      include: planInclude,
    });
    // 19-ب: the route is owner-only, and his acts are on the record too — a
    // log that only watches the staff is a log the staff will not trust.
    await recordPlatformAuditEvent(tx, {
      entityType: "plan",
      entityId: planId,
      entityLabel: plan.name,
      action: "plan_updated",
      actor,
      metadata: { archived },
    });
    return row;
  });
  return { ...planSummary(updated), isActive: updated.isActive, isRecommended: updated.isRecommended, sortOrder: updated.sortOrder };
}

/** The cursor's list kinds. One per list, so a cursor cannot cross lists. */
const MERCHANTS_KIND = "platform.merchants";
const UPGRADE_REQUESTS_KIND = "platform.upgrade-requests";

/**
 * D-74: this took NO ARGUMENTS and returned every merchant on the platform, so
 * the owner's directory grew one row per signup forever and the query had no
 * ceiling at all. Newest first now, which is also the order the directory is
 * read in — the newest merchant is the one being looked for.
 */
export async function listMerchantsWithPlans(rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(MERCHANTS_KIND, rawCursor);
  const rows = await prisma.merchant.findMany({
    where: { ...keysetWhere("createdAt", "desc", cursor) },
    select: {
      id: true, email: true, businessName: true, isActive: true, createdAt: true,
      // ق-167: written by every creation path, read by nothing until now.
      ownerName: true, phoneNormalized: true,
      subscriptions: { where: { status: "active" }, orderBy: { startedAt: "desc" }, take: 1, select: { plan: { select: { code: true, name: true } }, startedAt: true, endsAt: true } },
      _count: { select: { stores: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(MERCHANTS_KIND, last.createdAt, last.id));
  const merchants = page.map((merchant) => ({
    id: merchant.id,
    email: merchant.email,
    businessName: merchant.businessName,
    ownerName: merchant.ownerName,
    phone: merchant.phoneNormalized,
    isActive: merchant.isActive,
    storeCount: merchant._count.stores,
    plan: merchant.subscriptions[0]?.plan ?? null,
    subscribedAt: merchant.subscriptions[0]?.startedAt ?? null,
    // ق-181: the owner sees who is on a free month and when it ends.
    subscriptionEndsAt: merchant.subscriptions[0]?.endsAt ?? null,
    isTrial: subscriptionSummary(merchant.subscriptions[0] ?? null).isTrial,
  }));
  return { merchants, nextCursor };
}

/** The single write path for changing a merchant's active subscription; runs inside the caller's transaction. */
async function replaceActiveSubscription(tx: Prisma.TransactionClient, merchantId: string, planId: string) {
  await tx.merchantSubscription.updateMany({ where: { merchantId, status: "active" }, data: { status: "cancelled", endsAt: new Date() } });
  await tx.merchantSubscription.create({ data: { merchantId, planId, status: "active" } });
}

/**
 * Owner-driven manual assignment (billing automation arrives in phase 25).
 * 19-ب: `actor` is OPTIONAL because internal callers (the trial-expiry sweep)
 * assign plans with no platform actor behind them; the HTTP routes always pass
 * one, and when one is present the audit row commits with the assignment.
 */
export async function assignMerchantSubscription(merchantId: string, body: Record<string, unknown>, actor?: PlatformActor) {
  if (typeof body.planCode !== "string") throw new HttpError(422, "INVALID_INPUT", "planCode مطلوب.");
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, businessName: true, email: true } });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  const plan = await prisma.plan.findUnique({ where: { code: body.planCode }, select: { id: true, isActive: true, name: true } });
  if (!plan || !plan.isActive) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة المطلوبة غير متاحة.");
  await prisma.$transaction(async (tx) => {
    await replaceActiveSubscription(tx, merchantId, plan.id);
    if (actor) {
      await recordPlatformAuditEvent(tx, {
        entityType: "subscription",
        entityId: merchantId,
        entityLabel: merchant.businessName || merchant.email,
        action: "subscription_assigned",
        actor,
        metadata: { merchantId, planCode: body.planCode as string },
      });
    }
  });
  return merchantEntitlementsView(merchantId);
}

// ---------- plan upgrade requests (approved addition 2026-08-26) ----------

const upgradeRequestSelect = {
  id: true,
  status: true,
  note: true,
  createdAt: true,
  decidedAt: true,
  merchant: { select: { id: true, email: true, businessName: true } },
  requestedPlan: { select: { code: true, name: true, monthlyPriceIqd: true } },
} satisfies Prisma.PlanUpgradeRequestSelect;

/** Merchant-initiated upgrade (or downgrade) request; one pending request at a time. */
export async function createUpgradeRequest(merchantId: string, body: Record<string, unknown>) {
  if (typeof body.planCode !== "string") throw new HttpError(422, "INVALID_INPUT", "planCode مطلوب.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500)) {
    throw new HttpError(422, "INVALID_INPUT", "الملاحظة يجب أن تكون نصاً لا يتجاوز 500 حرف.");
  }
  const plan = await prisma.plan.findUnique({ where: { code: body.planCode }, select: { id: true, isActive: true } });
  if (!plan || !plan.isActive) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة المطلوبة غير متاحة.");
  const currentPlan = await activePlanForMerchant(prisma, merchantId);
  if (currentPlan.id === plan.id) throw new HttpError(422, "SAME_PLAN_REQUESTED", "أنت مشتركة بهذه الخطة بالفعل — لا حاجة لطلب جديد.");
  const pending = await prisma.planUpgradeRequest.findFirst({ where: { merchantId, status: "pending" }, select: { id: true } });
  if (pending) throw new HttpError(409, "DUPLICATE_UPGRADE_REQUEST", "لديك طلب ترقية قيد المراجعة بالفعل — يُحسم أولاً ثم يمكن إرسال طلب جديد.");
  return prisma.planUpgradeRequest.create({
    data: { merchantId, requestedPlanId: plan.id, note: typeof body.note === "string" ? body.note.trim() || null : null },
    select: upgradeRequestSelect,
  });
}

/** Owner queue: pending requests first (oldest first), then decided ones (newest decision first). */
/**
 * D-18: this read EVERY upgrade request ever made — decided ones are never
 * removed — and then re-sorted them in JavaScript into «pending first, then
 * decided newest-first».
 *
 * That arrangement cannot survive pagination and is not worth saving: a
 * partition computed over one page reorders rows differently on every page,
 * which is worse than one honest order. So the queue is newest-first, like
 * every other queue on the platform, and `pendingCount` travels with it so the
 * owner still sees at a glance how many are waiting — a number that used to be
 * derivable only by loading the entire history. `?status=pending` narrows to
 * exactly the ones needing a decision.
 */
export async function listUpgradeRequests(rawLimit?: unknown, rawCursor?: unknown, rawStatus?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(UPGRADE_REQUESTS_KIND, rawCursor);
  const status = typeof rawStatus === "string" && rawStatus ? rawStatus : undefined;
  const [rows, pendingCount] = await Promise.all([
    prisma.planUpgradeRequest.findMany({
      where: { ...(status ? { status } : {}), ...keysetWhere("createdAt", "desc", cursor) },
      select: upgradeRequestSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    prisma.planUpgradeRequest.count({ where: { status: "pending" } }),
  ]);
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(UPGRADE_REQUESTS_KIND, last.createdAt, last.id));
  return { requests: page, nextCursor, pendingCount };
}

/**
 * Approval assigns the plan through the same subscription write path,
 * atomically with the decision. 19-ب: the deciding actor is recorded HONESTLY —
 * a staff decision fills decided_by_staff_id and the label snapshot, never the
 * owner's column.
 */
export async function decideUpgradeRequest(requestId: string, actor: PlatformActor, action: "approve" | "reject") {
  const request = await prisma.planUpgradeRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, merchantId: true, merchant: { select: { businessName: true, email: true } }, requestedPlan: { select: { id: true, isActive: true, code: true } } },
  });
  if (!request) throw new HttpError(404, "RESOURCE_NOT_FOUND", "طلب الترقية غير موجود.");
  if (request.status !== "pending") throw new HttpError(409, "ALREADY_DECIDED", "هذا الطلب محسوم بالفعل.");
  return prisma.$transaction(async (tx) => {
    // The guarded claim comes FIRST, inside the transaction: the read above is
    // only a friendly early answer. An approve and a reject racing on one request
    // both passed it, so the merchant could be moved to the new plan by one while
    // the other stamped the request «rejected». The loser now matches nothing,
    // and its transaction rolls back before touching the subscription.
    const claimed = await tx.planUpgradeRequest.updateMany({ where: { id: requestId, status: "pending" }, data: { status: action === "approve" ? "approved" : "rejected" } });
    if (claimed.count !== 1) throw new HttpError(409, "ALREADY_DECIDED", "هذا الطلب محسوم بالفعل.");
    if (action === "approve") {
      // Re-checked inside the transaction: an archive racing this approval must
      // not assign a just-archived plan.
      const plan = await tx.plan.findUnique({ where: { id: request.requestedPlan.id }, select: { isActive: true } });
      if (!plan?.isActive) {
        throw new HttpError(409, "PLAN_NOT_AVAILABLE", "الخطة المطلوبة لم تعد متاحة — أُرشفت بعد إرسال الطلب.");
      }
      await replaceActiveSubscription(tx, request.merchantId, request.requestedPlan.id);
    }
    const decided = await tx.planUpgradeRequest.update({
      where: { id: requestId },
      data: {
        status: action === "approve" ? "approved" : "rejected",
        decidedAt: new Date(),
        ...(actor.kind === "platform_owner"
          ? { decidedById: actor.id }
          : { decidedByStaffId: actor.id, decidedByLabel: await platformActorLabelFor(tx, actor) }),
      },
      select: upgradeRequestSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "upgrade_request",
      entityId: requestId,
      entityLabel: request.merchant.businessName || request.merchant.email,
      action: "upgrade_request_decided",
      actor,
      metadata: { decision: action, planCode: request.requestedPlan.code },
    });
    return decided;
  });
}

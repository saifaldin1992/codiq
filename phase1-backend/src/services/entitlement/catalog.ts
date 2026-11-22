/**
 * Plans and entitlements — catalog. Split verbatim from
 * entitlement.service.ts (review batch 4, ت-٢);
 * entitlement.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "../platform-audit.service.js";
import { domainEvents } from "../../events/domain-events.js";
import { planSummary, PLAN_FEATURE_CODES, currentTerms, publishPlanVersion } from "./plans.js";
import { DEFAULT_PLAN_CODE } from "./subscribe.js";

// ---------- platform-owner operations ----------

const planInclude = { features: { select: { featureCode: true, limitValue: true } } } as const;

export async function listPlans() {
  const plans = await prisma.plan.findMany({ include: planInclude, orderBy: { sortOrder: "asc" } });
  // Phase 30: per plan, its current version and how many ACTIVE subscriptions
  // still run on an older one — what the owner must know before re-assigning.
  const counts = await prisma.$queryRaw<
    Array<{ plan_id: string; current_version: number | null; on_current: bigint; on_older: bigint }>
  >(Prisma.sql`
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
      subscribers: {
        onCurrentVersion: Number(count?.on_current ?? 0),
        onOlderVersions: Number(count?.on_older ?? 0),
      },
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
async function applyRecommendation(
  tx: Prisma.TransactionClient,
  planId: string,
  recommended: boolean
): Promise<void> {
  if (!recommended) {
    await tx.plan.update({ where: { id: planId }, data: { isRecommended: false } });
    return;
  }
  const target = await tx.plan.findUnique({ where: { id: planId }, select: { isActive: true } });
  if (!target?.isActive)
    throw new HttpError(
      409,
      "ARCHIVED_PLAN_NOT_RECOMMENDABLE",
      "لا يمكن ترشيح خطة مؤرشفة — أعِد تفعيلها أولاً ثم رشّحه."
    );
  await tx.plan.updateMany({
    where: { isRecommended: true, id: { not: planId } },
    data: { isRecommended: false },
  });
  await tx.plan.update({ where: { id: planId }, data: { isRecommended: true } });
}

/** Shared field validation for create/update; entries are [featureCode, limitValue]. */
function validatedLimitEntries(limits: unknown): [string, number][] {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits))
    throw new HttpError(422, "INVALID_INPUT", "limits يجب أن يكون كائناً.");
  const entries: [string, number][] = [];
  for (const [featureCode, limitValue] of Object.entries(limits as Record<string, unknown>)) {
    if (!(PLAN_FEATURE_CODES as readonly string[]).includes(featureCode))
      throw new HttpError(422, "INVALID_INPUT", `ميزة غير معروفة: ${featureCode}`);
    if (!Number.isInteger(limitValue) || (limitValue as number) < 0)
      throw new HttpError(
        422,
        "INVALID_INPUT",
        `حد ${featureCode} يجب أن يكون عدداً صحيحاً غير سالب.`
      );
    entries.push([featureCode, limitValue as number]);
  }
  return entries;
}

export async function updatePlan(
  planId: string,
  actor: PlatformActor,
  body: Record<string, unknown>
) {
  const plan = await prisma.plan.findUnique({
    where: { id: planId },
    select: { id: true, code: true, name: true },
  });
  if (!plan) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة غير موجودة.");
  const data: Prisma.PlanUpdateInput = {};
  if (body.name !== undefined) {
    if (
      typeof body.name !== "string" ||
      body.name.trim().length < 2 ||
      body.name.trim().length > 120
    )
      throw new HttpError(422, "INVALID_INPUT", "اسم الخطة غير صالح.");
    data.name = body.name.trim();
  }
  if (body.monthlyPriceIqd !== undefined) {
    if (!Number.isInteger(body.monthlyPriceIqd) || (body.monthlyPriceIqd as number) < 0)
      throw new HttpError(422, "INVALID_INPUT", "سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.");
    data.monthlyPriceIqd = body.monthlyPriceIqd as number;
  }
  if (body.commissionBps !== undefined) {
    if (
      !Number.isInteger(body.commissionBps) ||
      (body.commissionBps as number) < 0 ||
      (body.commissionBps as number) > 10000
    )
      throw new HttpError(422, "INVALID_INPUT", "عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.");
    data.commissionBps = body.commissionBps as number;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean")
      throw new HttpError(422, "INVALID_INPUT", "isActive يجب أن يكون قيمة منطقية.");
    if (body.isActive === false && plan.code === DEFAULT_PLAN_CODE)
      throw new HttpError(
        409,
        "DEFAULT_PLAN_PROTECTED",
        "لا يمكن أرشفة الخطة الافتراضية — تُسند تلقائياً لكل تاجر جديد عند التسجيل."
      );
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
    if (body.isRecommended !== undefined)
      await applyRecommendation(tx, planId, body.isRecommended as boolean);
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
    const termsChanged =
      body.monthlyPriceIqd !== undefined ||
      body.commissionBps !== undefined ||
      limitEntries !== undefined;
    if (termsChanged) {
      const latest = await tx.planVersion.findFirst({
        where: { planId },
        orderBy: { version: "desc" },
        select: { monthlyPriceIqd: true, commissionBps: true, limits: true },
      });
      const now = await currentTerms(tx, planId);
      const same =
        latest &&
        latest.monthlyPriceIqd === now.monthlyPriceIqd &&
        latest.commissionBps === now.commissionBps &&
        JSON.stringify(Object.entries(latest.limits as Record<string, number>).sort()) ===
          JSON.stringify(Object.entries(now.limits).sort());
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
  if (publishedVersion)
    domainEvents.emit("plan.version_published", { planId, version: publishedVersion });
  const updated = await prisma.plan.findUnique({ where: { id: planId }, include: planInclude });
  return {
    ...planSummary(updated!),
    isActive: updated!.isActive,
    isRecommended: updated!.isRecommended,
    sortOrder: updated!.sortOrder,
    ...(publishedVersion ? { publishedVersion } : {}),
  };
}

/** Exported so `schemas/platform.schema.ts` asserts THIS rule rather than a copy of it. */
export const PLAN_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Owner-created plan (approved addition 2026-08-26); same validation rules as updatePlan. */
export async function createPlan(actor: PlatformActor, body: Record<string, unknown>) {
  if (typeof body.code !== "string" || !PLAN_CODE_PATTERN.test(body.code)) {
    throw new HttpError(
      422,
      "INVALID_INPUT",
      "رمز الخطة يجب أن يكون بأحرف إنجليزية صغيرة وأرقام وشرطات فقط (حتى 40 حرفاً)."
    );
  }
  if (typeof body.name !== "string" || body.name.trim().length < 2 || body.name.trim().length > 120)
    throw new HttpError(422, "INVALID_INPUT", "اسم الخطة غير صالح.");
  if (
    body.monthlyPriceIqd !== undefined &&
    (!Number.isInteger(body.monthlyPriceIqd) || (body.monthlyPriceIqd as number) < 0)
  ) {
    throw new HttpError(422, "INVALID_INPUT", "سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.");
  }
  if (
    body.commissionBps !== undefined &&
    (!Number.isInteger(body.commissionBps) ||
      (body.commissionBps as number) < 0 ||
      (body.commissionBps as number) > 10000)
  ) {
    throw new HttpError(422, "INVALID_INPUT", "عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.");
  }
  if (
    body.sortOrder !== undefined &&
    (!Number.isInteger(body.sortOrder) || (body.sortOrder as number) < 0)
  ) {
    throw new HttpError(422, "INVALID_INPUT", "ترتيب الخطة يجب أن يكون عدداً صحيحاً غير سالب.");
  }
  const limitEntries = body.limits === undefined ? [] : validatedLimitEntries(body.limits);
  const occupied = await prisma.plan.findUnique({
    where: { code: body.code },
    select: { id: true },
  });
  if (occupied)
    throw new HttpError(409, "DUPLICATE_PLAN_CODE", "رمز الخطة مستخدم بالفعل لخطة أخرى.");
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
        features: {
          createMany: {
            data: limitEntries.map(([featureCode, limitValue]) => ({ featureCode, limitValue })),
          },
        },
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
  return {
    ...planSummary(created),
    isActive: created.isActive,
    isRecommended: created.isRecommended,
    sortOrder: created.sortOrder,
  };
}

/**
 * Archive instead of delete (approved addition 2026-08-26): an archived plan
 * leaves the public pricing list and refuses NEW subscriptions, while existing
 * subscribers keep their entitlements untouched. The default plan is protected.
 */
export async function setPlanArchived(planId: string, actor: PlatformActor, archived: boolean) {
  const plan = await prisma.plan.findUnique({
    where: { id: planId },
    select: { id: true, code: true, name: true },
  });
  if (!plan) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الخطة غير موجودة.");
  if (archived && plan.code === DEFAULT_PLAN_CODE) {
    throw new HttpError(
      409,
      "DEFAULT_PLAN_PROTECTED",
      "لا يمكن أرشفة الخطة الافتراضية — تُسند تلقائياً لكل تاجر جديد عند التسجيل."
    );
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
  return {
    ...planSummary(updated),
    isActive: updated.isActive,
    isRecommended: updated.isRecommended,
    sortOrder: updated.sortOrder,
  };
}

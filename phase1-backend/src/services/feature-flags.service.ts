/**
 * المرحلة 29 (ق-249) — feature flags: a ROLLOUT mechanism, nothing more.
 *
 * A flag says «this capability is switched on for these tenants already»; it
 * never says «this tenant may do this» (RBAC), «this plan includes this»
 * (entitlement) or «the platform turned this off» (availability). The
 * resolver in availability.service reads the flag LAST, so a flag can only
 * hold a capability back as COMING_SOON — it cannot open what the layers above
 * it closed.
 *
 * Rule precedence, most specific first: store → merchant/beta → plan →
 * percentage (a stable bucket of the merchant id) → global → the flag's
 * default. A flag nobody created returns `null`: «no rollout governs this».
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { prisma } from "../db/prisma.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export const FLAG_RULE_SCOPES = [
  "global",
  "plan",
  "merchant",
  "store",
  "beta",
  "percentage",
] as const;
export type FlagRuleScope = (typeof FLAG_RULE_SCOPES)[number];
export const FLAG_CODE_PATTERN = /^[a-z][a-z0-9_.]{1,59}$/;

const ruleSelect = {
  id: true,
  scope: true,
  enabled: true,
  percentage: true,
  createdAt: true,
  plan: { select: { code: true, name: true } },
  merchant: { select: { id: true, email: true, businessName: true } },
  store: { select: { id: true, slug: true, name: true } },
} as const;
const flagSelect = {
  id: true,
  code: true,
  description: true,
  enabledDefault: true,
  updatedAt: true,
  rules: { select: ruleSelect, orderBy: { createdAt: "asc" as const } },
} as const;

function flagView(flag: Prisma.FeatureFlagGetPayload<{ select: typeof flagSelect }>) {
  return {
    code: flag.code,
    description: flag.description,
    enabledDefault: flag.enabledDefault,
    updatedAt: flag.updatedAt.toISOString(),
    rules: flag.rules.map((rule) => ({
      id: rule.id,
      scope: rule.scope,
      enabled: rule.enabled,
      percentage: rule.percentage,
      createdAt: rule.createdAt.toISOString(),
      plan: rule.plan,
      merchant: rule.merchant,
      store: rule.store,
    })),
  };
}

export async function listFeatureFlags() {
  const flags = await prisma.featureFlag.findMany({ select: flagSelect, orderBy: { code: "asc" } });
  return flags.map(flagView);
}

export async function upsertFeatureFlag(
  actor: PlatformActor,
  code: string,
  input: { description?: unknown; enabledDefault?: unknown }
) {
  if (!FLAG_CODE_PATTERN.test(code))
    throw new HttpError(
      422,
      "INVALID_FLAG_CODE",
      "رمز العلم: حروف صغيرة وأرقام ونقاط وشرطات سفليّة، حتى 60 حرفاً."
    );
  const description =
    input.description === undefined
      ? undefined
      : typeof input.description === "string" && input.description.length <= 300
        ? input.description.trim()
        : (() => {
            throw new HttpError(422, "INVALID_FLAG_DESCRIPTION", "وصف العلم حتى 300 حرف.");
          })();
  const enabledDefault =
    input.enabledDefault === undefined
      ? undefined
      : typeof input.enabledDefault === "boolean"
        ? input.enabledDefault
        : (() => {
            throw new HttpError(422, "INVALID_FLAG_DEFAULT", "enabledDefault قيمة منطقيّة.");
          })();
  return prisma.$transaction(async (tx) => {
    const before = await tx.featureFlag.findUnique({
      where: { code },
      select: { enabledDefault: true, description: true },
    });
    const flag = await tx.featureFlag.upsert({
      where: { code },
      create: { code, description: description ?? "", enabledDefault: enabledDefault ?? false },
      update: {
        ...(description !== undefined ? { description } : {}),
        ...(enabledDefault !== undefined ? { enabledDefault } : {}),
      },
      select: flagSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "feature_flag",
      entityId: flag.id,
      entityLabel: code,
      action: "feature_flag_changed",
      actor,
      metadata: {
        before: before ?? null,
        after: { enabledDefault: flag.enabledDefault, description: flag.description },
      },
    });
    return flagView(flag);
  });
}

export async function addFeatureFlagRule(
  actor: PlatformActor,
  code: string,
  input: {
    scope: unknown;
    enabled: unknown;
    planId?: string | null;
    merchantId?: string | null;
    storeId?: string | null;
    percentage?: unknown;
  }
) {
  if (
    typeof input.scope !== "string" ||
    !(FLAG_RULE_SCOPES as readonly string[]).includes(input.scope)
  )
    throw new HttpError(
      422,
      "INVALID_FLAG_RULE",
      `نطاق القاعدة إحدى: ${FLAG_RULE_SCOPES.join("، ")}.`
    );
  if (typeof input.enabled !== "boolean")
    throw new HttpError(422, "INVALID_FLAG_RULE", "enabled قيمة منطقيّة.");
  const enabled = input.enabled;
  const scope = input.scope as FlagRuleScope;
  const percentage = scope === "percentage" ? Number(input.percentage) : null;
  if (
    scope === "percentage" &&
    (!Number.isInteger(percentage) || percentage! < 0 || percentage! > 100)
  )
    throw new HttpError(422, "INVALID_FLAG_RULE", "النسبة عدد صحيح بين 0 و100.");
  if (scope === "plan" && !input.planId)
    throw new HttpError(422, "INVALID_FLAG_RULE", "قاعدة الخطّة تحتاج الخطّة.");
  if ((scope === "merchant" || scope === "beta") && !input.merchantId)
    throw new HttpError(422, "INVALID_FLAG_RULE", "قاعدة التاجر تحتاج التاجر.");
  if (scope === "store" && !input.storeId)
    throw new HttpError(422, "INVALID_FLAG_RULE", "قاعدة المتجر تحتاج المتجر.");
  return prisma.$transaction(async (tx) => {
    const flag = await tx.featureFlag.findUnique({ where: { code }, select: { id: true } });
    if (!flag) throw new HttpError(404, "FLAG_NOT_FOUND", "العلم المطلوب غير موجود.");
    const rule = await tx.featureFlagRule.create({
      data: {
        flagId: flag.id,
        scope,
        enabled,
        percentage,
        planId: scope === "plan" ? input.planId! : null,
        merchantId: scope === "merchant" || scope === "beta" ? input.merchantId! : null,
        storeId: scope === "store" ? input.storeId! : null,
      },
      select: { id: true },
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "feature_flag",
      entityId: flag.id,
      entityLabel: code,
      action: "feature_flag_changed",
      actor,
      metadata: {
        rule: rule.id,
        scope,
        enabled,
        percentage,
        planId: input.planId ?? null,
        merchantId: input.merchantId ?? null,
        storeId: input.storeId ?? null,
      },
    });
    const fresh = await tx.featureFlag.findUniqueOrThrow({ where: { code }, select: flagSelect });
    return flagView(fresh);
  });
}

export async function removeFeatureFlagRule(actor: PlatformActor, code: string, ruleId: string) {
  return prisma.$transaction(async (tx) => {
    const flag = await tx.featureFlag.findUnique({ where: { code }, select: { id: true } });
    if (!flag) throw new HttpError(404, "FLAG_NOT_FOUND", "العلم المطلوب غير موجود.");
    const deleted = await tx.featureFlagRule.deleteMany({ where: { id: ruleId, flagId: flag.id } });
    if (deleted.count === 0)
      throw new HttpError(404, "FLAG_RULE_NOT_FOUND", "القاعدة المطلوبة غير موجودة.");
    await recordPlatformAuditEvent(tx, {
      entityType: "feature_flag",
      entityId: flag.id,
      entityLabel: code,
      action: "feature_flag_changed",
      actor,
      metadata: { removedRule: ruleId },
    });
    const fresh = await tx.featureFlag.findUniqueOrThrow({ where: { code }, select: flagSelect });
    return flagView(fresh);
  });
}

/** A stable 0–99 bucket per merchant, so a 20% rollout is the same 20% on every request. */
export function rolloutBucket(merchantId: string): number {
  return parseInt(createHash("sha256").update(merchantId).digest("hex").slice(0, 8), 16) % 100;
}

/**
 * `null` — no flag governs this code; `true`/`false` — the rollout decision for
 * this tenant. Reads the merchant's active plan only when a plan rule exists.
 */
export async function flagDecisionFor(
  code: string,
  tenant: { merchantId: string; storeId: string | null },
  client: DbClient = prisma
): Promise<boolean | null> {
  const flag = await client.featureFlag.findUnique({
    where: { code },
    select: {
      enabledDefault: true,
      rules: {
        select: {
          scope: true,
          enabled: true,
          percentage: true,
          planId: true,
          merchantId: true,
          storeId: true,
        },
      },
    },
  });
  if (!flag) return null;
  const rules = flag.rules;
  const storeRule = tenant.storeId
    ? rules.find((r) => r.scope === "store" && r.storeId === tenant.storeId)
    : undefined;
  if (storeRule) return storeRule.enabled;
  const merchantRule = rules.find(
    (r) => (r.scope === "merchant" || r.scope === "beta") && r.merchantId === tenant.merchantId
  );
  if (merchantRule) return merchantRule.enabled;
  const planRules = rules.filter((r) => r.scope === "plan");
  if (planRules.length) {
    const subscription = await client.merchantSubscription.findFirst({
      where: { merchantId: tenant.merchantId, status: "active" },
      orderBy: { startedAt: "desc" },
      select: { planId: true },
    });
    const planRule = subscription
      ? planRules.find((r) => r.planId === subscription.planId)
      : undefined;
    if (planRule) return planRule.enabled;
  }
  const percentageRule = rules.find((r) => r.scope === "percentage");
  if (percentageRule)
    return percentageRule.enabled
      ? rolloutBucket(tenant.merchantId) < (percentageRule.percentage ?? 0)
      : false;
  const globalRule = rules.find((r) => r.scope === "global");
  if (globalRule) return globalRule.enabled;
  return flag.enabledDefault;
}

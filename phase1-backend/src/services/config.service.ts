/**
 * ق-251 (المرحلة 29-3) — تسلسل التهيئة كدالّةٍ واحدة.
 *
 *   افتراض المنصّة ← الخطّة ← تجاوز التاجر ← إعداد المتجر ← تفضيل الزبون   (01 §14)
 *
 * The settings are a CLOSED registry — `SETTINGS` below — not a key/value bag.
 * Each has a type, a default, the levels that may hold an opinion about it, and
 * a RULE that says how the levels combine:
 *
 *   cap    a ceiling; every level may only TIGHTEN — the effective value is the
 *          smallest value any level set (the plan's limit, the platform's hard
 *          maximum, the merchant's own restraint …).
 *   allow  a permission; every level may only SWITCH OFF — true only while every
 *          level that spoke said true.
 *   pref   a preference; the most specific level that spoke wins (the customer
 *          over the store over the merchant …).
 *
 * That is «المستويات الدنيا لا تكسر قيود الأمان العليا» made executable: the
 * rule is evaluated at READ time by `resolveFromLevels` (pure, unit-tested), so a
 * store column that was edited before a platform ceiling existed still reads
 * under the ceiling. Writes at the platform and merchant levels ALSO refuse by
 * name (SETTING_ABOVE_CEILING, SETTING_NOT_ALLOWED) so the screen never shows a
 * value the resolver would override.
 *
 * Where each level lives (nothing new for the levels that already had a home):
 *   platform  `platform_settings` under `config.<code>` — registry codes only
 *   plan      `plan_features` (limit_value) through entitlement's plan summary
 *   merchant  `merchant_settings` (ق-251) — the level that was missing
 *   store     the store's own columns (guest checkout, loyalty, marketing cap)
 *   customer  `notification_unsubscribes` (marketing opt-in)
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { normalizeEmail } from "../auth/identity.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { prisma } from "../db/prisma.js";
import {
  activePlanForMerchant,
  PLAN_FEATURE_CODES,
  type PlanFeatureCode,
} from "./entitlement.service.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export const CONFIG_LEVELS = ["platform", "plan", "merchant", "store", "customer"] as const;
export type ConfigLevel = (typeof CONFIG_LEVELS)[number];
export type ConfigRule = "cap" | "allow" | "pref";
export type SettingValue = number | boolean;

export interface SettingDefinition {
  code: string;
  label: string;
  description: string;
  type: "integer" | "boolean";
  rule: ConfigRule;
  default: SettingValue;
  /** The levels that may hold an opinion; `platform` always may. */
  levels: readonly ConfigLevel[];
  /** For `cap` settings the plan speaks through this plan feature (entitlement). */
  planFeature?: PlanFeatureCode;
  /** Integer bounds accepted at the platform and merchant levels. */
  min?: number;
  max?: number;
}

export const SETTINGS = [
  {
    code: "stores.max",
    label: "عدد المتاجر",
    description: "كم متجراً يفتح التاجر — الخطّة تقول، والمنصّة تستطيع أن تضع سقفاً فوق كلّ الخطط.",
    type: "integer",
    rule: "cap",
    default: 3,
    levels: ["platform", "plan"],
    planFeature: "max_stores",
    min: 0,
    max: 10_000,
  },
  {
    code: "catalog.products_max",
    label: "عدد المنتجات",
    description: "سقف المنتجات في المتجر الواحد.",
    type: "integer",
    rule: "cap",
    default: 500,
    levels: ["platform", "plan"],
    planFeature: "max_products",
    min: 0,
    max: 1_000_000,
  },
  {
    code: "team.staff_max",
    label: "عدد الموظّفين",
    description: "سقف حسابات الموظّفين للتاجر.",
    type: "integer",
    rule: "cap",
    default: 5,
    levels: ["platform", "plan"],
    planFeature: "max_staff",
    min: 0,
    max: 10_000,
  },
  {
    code: "orders.monthly_max",
    label: "طلبات الشهر",
    description: "سقف الطلبات المحسوبة في الشهر.",
    type: "integer",
    rule: "cap",
    default: 1_000,
    levels: ["platform", "plan"],
    planFeature: "max_monthly_orders",
    min: 0,
    max: 10_000_000,
  },
  {
    code: "storage.image_mb_max",
    label: "مساحة الصور (ميغابايت)",
    description: "سقف ما يرفعه المتجر من صور.",
    type: "integer",
    rule: "cap",
    default: 500,
    levels: ["platform", "plan"],
    planFeature: "max_image_storage_mb",
    min: 0,
    max: 1_000_000,
  },
  {
    code: "marketing.daily_cap",
    label: "رسائل التسويق في اليوم",
    description:
      "كم رسالةً تسويقيّة يرسل المتجر في اليوم. المنصّة تضع السقف، والتاجر يضيّقه لكلّ متاجره، والمتجر يضيّقه لنفسه.",
    type: "integer",
    rule: "cap",
    default: 200,
    levels: ["platform", "merchant", "store"],
    min: 0,
    max: 100_000,
  },
  {
    code: "checkout.guest_allowed",
    label: "إتمام الطلب دون حساب",
    description:
      "هل يشتري الزبون دون تسجيل؟ إن أغلقتها المنصّة لم يفتحها تاجر، وإن أغلقها التاجر لم يفتحها متجر.",
    type: "boolean",
    rule: "allow",
    default: true,
    levels: ["platform", "merchant", "store"],
  },
  {
    code: "loyalty.enabled",
    label: "نقاط الولاء",
    description: "هل يكسب الزبون نقاطاً؟ تُغلق من أعلى ولا تُفتح من أسفل.",
    type: "boolean",
    rule: "allow",
    default: true,
    levels: ["platform", "merchant", "store"],
  },
  {
    code: "marketing.opt_in",
    label: "الرسائل التسويقيّة للزبون",
    description:
      "هل يتلقّى هذا الزبون رسائل المتجر التسويقيّة؟ كلمته الأخيرة له — رابط إلغاء الاشتراك.",
    type: "boolean",
    rule: "pref",
    default: true,
    levels: ["platform", "customer"],
  },
] as const satisfies readonly SettingDefinition[];

export type SettingCode = (typeof SETTINGS)[number]["code"];
export const SETTING_CODES: readonly SettingCode[] = SETTINGS.map((setting) => setting.code);
export const PLATFORM_SETTING_PREFIX = "config.";
export const LEVEL_LABELS_AR: Record<ConfigLevel | "default", string> = {
  default: "الافتراضيّ",
  platform: "المنصّة",
  plan: "الخطّة",
  merchant: "حساب التاجر",
  store: "المتجر",
  customer: "الزبون",
};
export const RULE_LABELS_AR: Record<ConfigRule, string> = {
  cap: "سقف — يضيق ولا يتّسع",
  allow: "سماح — يُغلق ولا يُفتح",
  pref: "تفضيل — الأدنى يقرّر",
};

export function settingDefinition(code: string): SettingDefinition {
  const definition = SETTINGS.find((setting) => setting.code === code);
  if (!definition)
    throw new HttpError(422, "UNKNOWN_SETTING", `لا إعداد بالرمز ${code} — الإعدادات سجلٌّ مغلق.`);
  return definition;
}

// ─────────────────────────────────────────────────────────── the pure resolver
export interface LevelValue {
  level: ConfigLevel;
  value: SettingValue;
}
export interface ResolvedSetting {
  code: string;
  value: SettingValue;
  /** Which level decided — for a cap, the tightest; for allow, the first to say no; for pref, the most specific. */
  source: ConfigLevel | "default";
  chain: LevelValue[];
}

const levelRank = (level: ConfigLevel) => CONFIG_LEVELS.indexOf(level);

/** Pure, so the rule table is a unit test. `levels` may arrive in any order; only levels the definition admits count. */
export function resolveFromLevels(
  definition: SettingDefinition,
  levels: LevelValue[]
): ResolvedSetting {
  const chain = levels
    .filter((entry) => definition.levels.includes(entry.level))
    .sort((a, b) => levelRank(a.level) - levelRank(b.level));
  if (chain.length === 0)
    return { code: definition.code, value: definition.default, source: "default", chain };
  if (definition.rule === "cap") {
    const min = Math.min(...chain.map((entry) => Number(entry.value)));
    const tightest = chain.find((entry) => Number(entry.value) === min)!;
    return { code: definition.code, value: min, source: tightest.level, chain };
  }
  if (definition.rule === "allow") {
    const refused = chain.find((entry) => entry.value === false);
    if (refused) return { code: definition.code, value: false, source: refused.level, chain };
    return { code: definition.code, value: true, source: chain[chain.length - 1].level, chain };
  }
  const last = chain[chain.length - 1];
  return { code: definition.code, value: last.value, source: last.level, chain };
}

// ─────────────────────────────────────────────────────────── values: parsing
export function parseSettingValue(definition: SettingDefinition, raw: unknown): SettingValue {
  if (definition.type === "boolean") {
    if (typeof raw !== "boolean")
      throw new HttpError(422, "INVALID_SETTING_VALUE", `«${definition.label}» نعم أو لا.`);
    return raw;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw))
    throw new HttpError(422, "INVALID_SETTING_VALUE", `«${definition.label}» عددٌ صحيح.`);
  const min = definition.min ?? 0;
  const max = definition.max ?? Number.MAX_SAFE_INTEGER;
  if (raw < min || raw > max)
    throw new HttpError(422, "INVALID_SETTING_VALUE", `«${definition.label}» بين ${min} و${max}.`);
  return raw;
}

function storedValue(definition: SettingDefinition, raw: unknown): SettingValue | null {
  try {
    return parseSettingValue(definition, raw);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────── values: the levels' homes
export interface ConfigContext {
  merchantId?: string | null;
  storeId?: string | null;
  customerEmail?: string | null;
}

async function platformLevel(client: DbClient): Promise<Map<string, SettingValue>> {
  const rows = await client.platformSetting.findMany({
    where: { key: { startsWith: PLATFORM_SETTING_PREFIX } },
    select: { key: true, value: true },
  });
  const values = new Map<string, SettingValue>();
  for (const row of rows) {
    const code = row.key.slice(PLATFORM_SETTING_PREFIX.length);
    const definition = SETTINGS.find((setting) => setting.code === code);
    if (!definition) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const value = storedValue(definition, parsed);
    if (value !== null) values.set(code, value);
  }
  return values;
}

async function planLevel(client: DbClient, merchantId: string): Promise<Map<string, SettingValue>> {
  const plan = await activePlanForMerchant(client, merchantId);
  const values = new Map<string, SettingValue>();
  for (const definition of SETTINGS) {
    if (!("planFeature" in definition) || !definition.planFeature) continue;
    const limit = plan.limits[definition.planFeature];
    // A plan that names no limit (0) has no opinion — it is not «zero allowed».
    if (Number.isInteger(limit) && limit > 0) values.set(definition.code, limit);
  }
  return values;
}

async function merchantLevel(
  client: DbClient,
  merchantId: string
): Promise<Map<string, SettingValue>> {
  const rows = await client.merchantSetting.findMany({
    where: { merchantId },
    select: { code: true, value: true },
  });
  const values = new Map<string, SettingValue>();
  for (const row of rows) {
    const definition = SETTINGS.find((setting) => setting.code === row.code);
    if (!definition) continue;
    const value = storedValue(definition, row.value);
    if (value !== null) values.set(row.code, value);
  }
  return values;
}

async function storeLevel(client: DbClient, storeId: string): Promise<Map<string, SettingValue>> {
  const [store, notifications] = await Promise.all([
    client.store.findUnique({
      where: { id: storeId },
      select: { guestCheckoutEnabled: true, loyaltyEnabled: true },
    }),
    client.notificationSettings.findUnique({
      where: { storeId },
      select: { marketingDailyCap: true },
    }),
  ]);
  const values = new Map<string, SettingValue>();
  if (store) {
    values.set("checkout.guest_allowed", store.guestCheckoutEnabled);
    values.set("loyalty.enabled", store.loyaltyEnabled);
  }
  if (notifications) values.set("marketing.daily_cap", notifications.marketingDailyCap);
  return values;
}

async function customerLevel(
  client: DbClient,
  storeId: string,
  customerEmail: string
): Promise<Map<string, SettingValue>> {
  const values = new Map<string, SettingValue>();
  const emailNormalized = normalizeEmail(customerEmail);
  const unsubscribed = await client.notificationUnsubscribe.findUnique({
    where: { storeId_emailNormalized: { storeId, emailNormalized } },
    select: { storeId: true },
  });
  if (unsubscribed) values.set("marketing.opt_in", false);
  return values;
}

async function collectLevels(
  ctx: ConfigContext,
  client: DbClient
): Promise<Map<ConfigLevel, Map<string, SettingValue>>> {
  const levels = new Map<ConfigLevel, Map<string, SettingValue>>();
  const [platform, plan, merchant, store, customer] = await Promise.all([
    platformLevel(client),
    ctx.merchantId
      ? planLevel(client, ctx.merchantId)
      : Promise.resolve(new Map<string, SettingValue>()),
    ctx.merchantId
      ? merchantLevel(client, ctx.merchantId)
      : Promise.resolve(new Map<string, SettingValue>()),
    ctx.storeId
      ? storeLevel(client, ctx.storeId)
      : Promise.resolve(new Map<string, SettingValue>()),
    ctx.storeId && ctx.customerEmail
      ? customerLevel(client, ctx.storeId, ctx.customerEmail)
      : Promise.resolve(new Map<string, SettingValue>()),
  ]);
  levels.set("platform", platform);
  levels.set("plan", plan);
  levels.set("merchant", merchant);
  levels.set("store", store);
  levels.set("customer", customer);
  return levels;
}

function levelsFor(
  code: string,
  collected: Map<ConfigLevel, Map<string, SettingValue>>
): LevelValue[] {
  const entries: LevelValue[] = [];
  for (const level of CONFIG_LEVELS) {
    const value = collected.get(level)?.get(code);
    if (value !== undefined) entries.push({ level, value });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────── the one function
/** THE function: every reader of a setting asks here and gets the value, who decided it, and the whole chain. */
export async function resolveSetting(
  code: string,
  ctx: ConfigContext,
  client: DbClient = prisma
): Promise<ResolvedSetting> {
  const definition = settingDefinition(code);
  const collected = await collectLevels(ctx, client);
  return resolveFromLevels(definition, levelsFor(code, collected));
}

export async function resolveSettings(
  ctx: ConfigContext,
  client: DbClient = prisma
): Promise<ResolvedSetting[]> {
  const collected = await collectLevels(ctx, client);
  return SETTINGS.map((definition) =>
    resolveFromLevels(definition, levelsFor(definition.code, collected))
  );
}

// ─────────────────────────────────────────────────────────── the platform's door
export async function platformConfigView(client: DbClient = prisma) {
  const platform = await platformLevel(client);
  return SETTINGS.map((definition) => ({
    code: definition.code,
    label: definition.label,
    description: definition.description,
    type: definition.type,
    rule: definition.rule,
    ruleLabel: RULE_LABELS_AR[definition.rule],
    default: definition.default,
    levels: definition.levels,
    levelLabels: definition.levels.map((level) => LEVEL_LABELS_AR[level]),
    platformValue: platform.get(definition.code) ?? null,
    ...("min" in definition ? { min: definition.min, max: definition.max } : {}),
  }));
}

export async function setPlatformSetting(actor: PlatformActor, code: string, rawValue: unknown) {
  const definition = settingDefinition(code);
  const key = `${PLATFORM_SETTING_PREFIX}${code}`;
  const before = (await platformLevel(prisma)).get(code) ?? null;
  const value =
    rawValue === null || rawValue === undefined ? null : parseSettingValue(definition, rawValue);
  await prisma.$transaction(async (tx) => {
    if (value === null) await tx.platformSetting.deleteMany({ where: { key } });
    else
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(value) },
        update: { value: JSON.stringify(value) },
      });
    await recordPlatformAuditEvent(tx, {
      // A setting is not a row with a uuid; the audit row names it by code in its label (like the platform's other singletons).
      entityType: "setting",
      entityId: null,
      entityLabel: `${definition.label} — ${code}`,
      action: "setting_changed",
      actor,
      metadata: { level: "platform", before, after: value },
    });
  });
  return { code, platformValue: value };
}

// ─────────────────────────────────────────────────────────── the merchant's door
export interface StoreActorRef {
  kind: "merchant" | "staff";
  id: string;
}

export async function merchantConfigView(
  merchantId: string,
  storeId: string,
  client: DbClient = prisma
) {
  const collected = await collectLevels({ merchantId, storeId }, client);
  return SETTINGS.map((definition) => {
    const resolved = resolveFromLevels(definition, levelsFor(definition.code, collected));
    return {
      code: definition.code,
      label: definition.label,
      description: definition.description,
      type: definition.type,
      rule: definition.rule,
      ruleLabel: RULE_LABELS_AR[definition.rule],
      value: resolved.value,
      source: resolved.source,
      sourceLabel: LEVEL_LABELS_AR[resolved.source],
      chain: resolved.chain.map((entry) => ({ ...entry, label: LEVEL_LABELS_AR[entry.level] })),
      merchantValue: collected.get("merchant")?.get(definition.code) ?? null,
      canOverride: (definition.levels as readonly ConfigLevel[]).includes("merchant"),
      ...("min" in definition ? { min: definition.min, max: definition.max } : {}),
    };
  });
}

/**
 * The merchant's word for all his stores. Refused by name when it would loosen
 * what the platform or the plan set — the resolver would win anyway, and a
 * screen must not show a number the platform ignores.
 */
export async function setMerchantSetting(
  merchantId: string,
  actor: StoreActorRef,
  code: string,
  rawValue: unknown
) {
  const definition = settingDefinition(code);
  if (!definition.levels.includes("merchant"))
    throw new HttpError(
      422,
      "SETTING_LEVEL_NOT_ALLOWED",
      `«${definition.label}» ليس للتاجر رأيٌ فيه — تقرّره المنصّة${"planFeature" in definition && definition.planFeature ? " والخطّة" : ""}.`
    );
  if (rawValue === null || rawValue === undefined) {
    await prisma.merchantSetting.deleteMany({ where: { merchantId, code } });
    return resolveSetting(definition.code, { merchantId });
  }
  const value = parseSettingValue(definition, rawValue);
  const collected = await collectLevels({ merchantId }, prisma);
  const above = levelsFor(code, collected).filter(
    (entry) => entry.level === "platform" || entry.level === "plan"
  );
  if (above.length) {
    const ceiling = resolveFromLevels(definition, above);
    if (definition.rule === "cap" && Number(value) > Number(ceiling.value))
      throw new HttpError(
        422,
        "SETTING_ABOVE_CEILING",
        `«${definition.label}» لا يتجاوز ${ceiling.value} — سقفُ ${LEVEL_LABELS_AR[ceiling.source as ConfigLevel]}.`,
        { ceiling: ceiling.value, source: ceiling.source }
      );
    if (definition.rule === "allow" && value === true && ceiling.value === false)
      throw new HttpError(
        422,
        "SETTING_NOT_ALLOWED",
        `«${definition.label}» أغلقته ${LEVEL_LABELS_AR[ceiling.source as ConfigLevel]} — لا يُفتح من هنا.`,
        { source: ceiling.source }
      );
  }
  await prisma.merchantSetting.upsert({
    where: { merchantId_code: { merchantId, code } },
    create: { merchantId, code, value, updatedByKind: actor.kind, updatedById: actor.id },
    update: { value, updatedByKind: actor.kind, updatedById: actor.id },
  });
  return resolveSetting(definition.code, { merchantId });
}

// ─────────────────────────────────────────────────────────── the customer's view
export async function customerPreferencesView(
  store: { id: string; merchantId: string },
  customerEmail: string | null,
  client: DbClient = prisma
) {
  const ctx: ConfigContext = { merchantId: store.merchantId, storeId: store.id, customerEmail };
  const collected = await collectLevels(ctx, client);
  const pick = (code: SettingCode) => {
    const resolved = resolveFromLevels(settingDefinition(code), levelsFor(code, collected));
    return {
      value: resolved.value,
      source: resolved.source,
      sourceLabel: LEVEL_LABELS_AR[resolved.source],
    };
  };
  return {
    marketingOptIn: pick("marketing.opt_in"),
    guestCheckout: pick("checkout.guest_allowed"),
    loyalty: pick("loyalty.enabled"),
  };
}

/** For the unit test: the registry's own consistency (codes unique, plan features real). */
export function registryInvariants(): { merchantCodes: string[]; planFeatures: string[] } {
  const codes = SETTINGS.map((setting) => setting.code);
  if (new Set(codes).size !== codes.length) throw new Error("duplicate setting code");
  const planFeatures = SETTINGS.flatMap((setting) =>
    "planFeature" in setting && setting.planFeature ? [setting.planFeature] : []
  );
  for (const feature of planFeatures)
    if (!(PLAN_FEATURE_CODES as readonly string[]).includes(feature))
      throw new Error(`unknown plan feature ${feature}`);
  return {
    merchantCodes: SETTINGS.filter((setting) =>
      (setting.levels as readonly string[]).includes("merchant")
    ).map((setting) => setting.code),
    planFeatures,
  };
}

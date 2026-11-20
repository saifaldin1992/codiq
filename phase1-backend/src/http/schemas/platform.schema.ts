/**
 * Phase 19-ج — the platform-owner write surface in `routes/platform.ts` (ق-49).
 *
 * This is the file the phase was written for. Nine of these ten routes refused
 * bad input with the SAME anonymous code — `INVALID_INPUT` — for eleven
 * different reasons: a plan name, a commission in basis points, an unknown
 * feature limit, a registration mode, an approval verb. A client could not map
 * any of them to a field and a translator could not enumerate them, which is
 * precisely the case `http/validate.ts` states for doing this before payments
 * (25أ) and i18n (22) rather than after.
 *
 * THE ARABIC IS CARRIED OVER WORD FOR WORD. Where the hand-rolled check already
 * said «سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.», the schema says it too:
 * the owner must read the same sentence he read yesterday, and only the machine
 * code underneath it changes — from an `INVALID_INPUT` that meant nothing to
 * `VALIDATION_FAILED` plus a `fields` entry naming the offending path.
 *
 * WHAT IS DELIBERATELY LEFT LOOSE, and why each one is not an oversight:
 *   · `ownerName` / `phone` on manual provisioning — `normalizeOwnerName` and
 *     `normalizeIraqiMobile` answer with their own codes and their own Arabic,
 *     and the owner's form renders `error.code` directly.
 *   · `businessName`, `firstStoreName`, `email`, `temporaryPassword` are typed
 *     but carry NO length rule: `requiredText` still answers
 *     `INVALID_BUSINESS_NAME` / `INVALID_STORE_NAME` for an empty field, which
 *     is what that form shows.
 *   · `periodFrom` / `periodTo` on a settlement are typed as required strings
 *     (19-د — an unstated period used to settle month-to-date silently), but
 *     their MEANING is still `settlementPeriod`'s: it owns `INVALID_DATE_FILTER`
 *     and shares `parseReportRange` with the report reads.
 *   · every `note` the service TRUNCATES rather than refuses. A schema that
 *     rejected a 600-character note would refuse what the platform accepts today.
 */
import { z } from "zod";
import { PLAN_CODE_PATTERN, PLAN_FEATURE_CODES } from "../../services/entitlement.service.js";

/**
 * The per-plan limits. `partialRecord` rather than a fixed object because a
 * PATCH may carry one feature or all five, and the key set is the domain's own
 * `PLAN_FEATURE_CODES` rather than a second list here — two copies of that list
 * are two lists waiting to disagree.
 */
const planLimitValueSchema = z
  .number("حد الميزة يجب أن يكون عدداً صحيحاً غير سالب.")
  .int("حد الميزة يجب أن يكون عدداً صحيحاً غير سالب.")
  .min(0, "حد الميزة يجب أن يكون عدداً صحيحاً غير سالب.");

const planLimitsSchema = z.partialRecord(z.enum(PLAN_FEATURE_CODES), planLimitValueSchema, {
  // Two refusals arrive through the same door — «limits is not an object at all»
  // and «this feature code is not one of ours» — and they are not the same
  // sentence. The offending code itself is named by the issue's PATH.
  error: (issue) => (issue.code === "invalid_key" ? "ميزة غير معروفة." : "limits يجب أن يكون كائناً."),
});

const planNameSchema = z.string("اسم الخطة غير صالح.").trim().min(2, "اسم الخطة غير صالح.").max(120, "اسم الخطة غير صالح.");
const planPriceSchema = z.number("سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.").int("سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.").min(0, "سعر الخطة يجب أن يكون عدداً صحيحاً غير سالب.");
const planCommissionSchema = z.number("عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.").int("عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.").min(0, "عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.").max(10_000, "عمولة الخطة يجب أن تكون بين 0 و10000 نقطة أساس.");

/**
 * Creating a merchant by hand (the third creation path, and the easiest to
 * forget). Typed only — see the head of this file for why no field carries a
 * length rule.
 */
export const createManualMerchantSchema = z.object({
  businessName: z.string(),
  firstStoreName: z.string(),
  email: z.string(),
  temporaryPassword: z.string(),
  ownerName: z.unknown(),
  phone: z.unknown(),
});

/**
 * Editing a plan. `isActive: false` on the default plan is still the service's
 * `DEFAULT_PLAN_PROTECTED` 409 — a schema cannot know which plan is the default,
 * and pretending otherwise would move a real decision somewhere nobody looks.
 */
export const updatePlanSchema = z.object({
  name: planNameSchema.optional(),
  monthlyPriceIqd: planPriceSchema.optional(),
  commissionBps: planCommissionSchema.optional(),
  isActive: z.boolean("isActive يجب أن يكون قيمة منطقية.").optional(),
  isRecommended: z.boolean("isRecommended يجب أن يكون قيمة منطقية.").optional(),
  limits: planLimitsSchema.optional(),
});

/** Creating a plan — OWNER-ONLY at the route, for the reason stated there. */
export const createPlanSchema = z.object({
  code: z.string("رمز الخطة يجب أن يكون بأحرف إنجليزية صغيرة وأرقام وشرطات فقط (حتى 40 حرفاً).").regex(PLAN_CODE_PATTERN, "رمز الخطة يجب أن يكون بأحرف إنجليزية صغيرة وأرقام وشرطات فقط (حتى 40 حرفاً)."),
  name: planNameSchema,
  monthlyPriceIqd: planPriceSchema.optional(),
  commissionBps: planCommissionSchema.optional(),
  sortOrder: z.number("ترتيب الخطة يجب أن يكون عدداً صحيحاً غير سالب.").int("ترتيب الخطة يجب أن يكون عدداً صحيحاً غير سالب.").min(0, "ترتيب الخطة يجب أن يكون عدداً صحيحاً غير سالب.").optional(),
  limits: planLimitsSchema.optional(),
});

/** Moving a merchant onto a plan. Whether the plan EXISTS is still a 404 from the service. */
export const assignMerchantSubscriptionSchema = z.object({
  planCode: z.string("planCode مطلوب."),
});

/** The merchant's own upgrade request. `SAME_PLAN_REQUESTED` and the pending-request rule stay in the service. */
export const createUpgradeRequestSchema = z.object({
  planCode: z.string("planCode مطلوب."),
  note: z.string("الملاحظة يجب أن تكون نصاً لا يتجاوز 500 حرف.").max(500, "الملاحظة يجب أن تكون نصاً لا يتجاوز 500 حرف.").optional(),
});

/**
 * A settlement over the append-only ledger. WHICH period is still
 * `settlementPeriod`'s to judge — it owns `INVALID_DATE_FILTER`, the clamp to
 * now, and the overlap refusal, and it is shared with the report reads.
 *
 * 19-د: but THAT there is a period is the schema's business. Both fields were
 * `z.unknown()`, so `POST /platform/finance/settlements {"merchantId":"…"}`
 * with no period at all fell through to `parseReportRange`'s defaults and
 * settled month-to-date — a settlement over a range nobody chose, paid out of
 * real money. A settlement is not a report: the operator must say what he is
 * paying for.
 */
export const createSettlementSchema = z.object({
  merchantId: z.string("merchantId مطلوب."),
  periodFrom: z.string("periodFrom مطلوب."),
  periodTo: z.string("periodTo مطلوب."),
  note: z.unknown(),
  /** Audit 17-ب: the payout the operator saw in the preview; a different live amount is refused (409). */
  expectedNetPayoutIqd: z.number().int("expectedNetPayoutIqd عدد صحيح.").optional(),
});

/** Audit 17-ب: the exact settlement a confirm would record — same period rules, read only. */
export const settlementPreviewQuerySchema = z.object({
  periodFrom: z.string("periodFrom مطلوب."),
  periodTo: z.string("periodTo مطلوب."),
});

/** The manual reversal of a late return — real money, so the id is asserted before anything is read. */
export const createReturnAdjustmentSchema = z.object({
  orderId: z.string("orderId مطلوب."),
  note: z.unknown(),
});

/** The one flag that decides whether strangers become merchants unattended. */
export const setRegistrationModeSchema = z.object({
  mode: z.enum(["auto", "manual"], { error: "mode يجب أن يكون auto أو manual." }),
});

export const decideMerchantApprovalSchema = z.object({
  action: z.enum(["approve", "reject"], { error: "action يجب أن يكون approve أو reject." }),
});

/**
 * ق-225 — stopping (or restarting) an APPROVED merchant.
 *
 * `reason` stays `z.unknown()` because its refusal is the service's own named
 * code — `SUSPENSION_REASON_REQUIRED`, which the platform actor reads on screen —
 * and because the rule is conditional: a reason is demanded to STOP a shop and
 * not to restart one. zod owns arrival and type; the meaning stays where the one
 * definition of a valid suspension lives.
 */
export const setMerchantSuspensionSchema = z.object({
  suspended: z.boolean({ error: "suspended يجب أن يكون true أو false." }),
  reason: z.unknown(),
});

/**
 * PC-1 — «معلومات التواصل»: the three strings the landing page publishes.
 *
 * Typed and PRESENT only. The FORMAT rules stay in `platform-contact.service.ts`
 * for the reason stated at the head of this file: `normalizeEmail` answers
 * `INVALID_EMAIL` and `normalizeContactMobile` answers
 * `INVALID_PLATFORM_CONTACT_PHONE`, each with its own Arabic sentence, and the
 * owner's form renders those. A regex here would produce a second, blunter
 * refusal for the same mistake.
 *
 * `whatsapp` is nullable on purpose — «اتركه فارغاً» is the way the owner says
 * «واتساب على رقم التواصل نفسه», and it must survive the schema to reach the
 * service that deletes the row.
 */
export const updatePlatformContactSchema = z.object({
  email: z.string("بريد التواصل مطلوب."),
  phone: z.string("رقم التواصل مطلوب."),
  whatsapp: z.string("رقم واتساب يجب أن يكون نصاً.").nullable().optional(),
});

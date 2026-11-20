/**
 * codiq phase 17 — public merchant self-registration with owner approval policy
 * (ADR-006). The platform setting `merchant_self_registration_mode` decides:
 * "auto" (default) activates the merchant and first store immediately, "manual"
 * parks the application as pending — login is refused and the store stays
 * inactive until the platform owner approves.
 */
import { assertPhoneIsFree } from "../auth/auth.service.js";
import { HttpError } from "../auth/auth.errors.js";
import { createPasswordHash, normalizeEmail, normalizeIraqiMobile, normalizeOwnerName } from "../auth/identity.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";
import { DEFAULT_PLAN_CODE, subscribeMerchantToDefaultPlan } from "./entitlement.service.js";
import { assertStoreSlugNotReserved, isReservedStoreSlug } from "./reserved-slugs.js";
import { createStoreFoundation } from "./store-bootstrap.service.js";

const STORE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;
export const SELF_REGISTRATION_MODE_KEY = "merchant_self_registration_mode";

export async function selfRegistrationMode(): Promise<"auto" | "manual"> {
  const setting = await prisma.platformSetting.findUnique({ where: { key: SELF_REGISTRATION_MODE_KEY } });
  return setting?.value === "manual" ? "manual" : "auto";
}

export async function setSelfRegistrationMode(actor: PlatformActor, body: Record<string, unknown>) {
  if (body.mode !== "auto" && body.mode !== "manual") throw new HttpError(422, "INVALID_INPUT", "mode يجب أن يكون auto أو manual.");
  const mode = body.mode;
  // 19-ب: the switch and its record commit together — this one flag decides
  // whether strangers become merchants unattended.
  await prisma.$transaction(async (tx) => {
    await tx.platformSetting.upsert({
      where: { key: SELF_REGISTRATION_MODE_KEY },
      create: { key: SELF_REGISTRATION_MODE_KEY, value: mode },
      update: { value: mode },
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "registration_mode",
      entityLabel: "وضع تسجيل التجار",
      action: "registration_mode_changed",
      actor,
      metadata: { mode },
    });
  });
  return { mode };
}

/**
 * Public landing-page flow: merchant + subscription + first store in one
 * transaction.
 *
 * 19-ج: the HTTP edge asserts the seven fields are strings
 * (`registerMerchantSchema`) and stops there on purpose — every FORMAT rule
 * below owns a named code whose Arabic sentence the landing page shows verbatim,
 * and an empty box arrives as `""`, so it is these refusals a stranger actually
 * meets. The typeof branches stay for callers other than that route.
 */
export async function registerMerchantWithStore(input: { businessName: unknown; email: unknown; password: unknown; storeName: unknown; storeSlug: unknown; ownerName: unknown; phone: unknown }) {
  if (typeof input.businessName !== "string" || input.businessName.trim().length < 2) {
    throw new HttpError(400, "INVALID_BUSINESS_NAME", "اسم النشاط يجب أن يتكون من حرفين على الأقل.");
  }
  if (typeof input.storeName !== "string" || input.storeName.trim().length < 2 || input.storeName.trim().length > 120) {
    throw new HttpError(422, "INVALID_STORE_NAME", "اسم المتجر يجب أن يتكون من حرفين إلى 120 حرفاً.");
  }
  if (typeof input.storeSlug !== "string" || !STORE_SLUG_PATTERN.test(input.storeSlug)) {
    throw new HttpError(422, "INVALID_STORE_SLUG", "يجب أن يكون رابط المتجر بأحرف إنجليزية صغيرة وأرقام وشرطات فقط.");
  }
  // 19-د: this endpoint is unauthenticated and self-approving by default, so it
  // is the door the hostname squat came through. Refused BEFORE any write, so
  // the name is not burned by a registration that then fails for another reason.
  assertStoreSlugNotReserved(input.storeSlug);
  const email = normalizeEmail(input.email);
  // P27-12 (ق-100) — and this is the form a stranger fills, so its errors have to
  // be the clearest of the three.
  const ownerName = normalizeOwnerName(input.ownerName);
  const phone = normalizeIraqiMobile(input.phone);
  await assertPhoneIsFree(phone);
  const existingOwner = await prisma.platformOwner.findUnique({ where: { email }, select: { id: true } });
  if (existingOwner) throw new HttpError(409, "EMAIL_RESERVED_FOR_PLATFORM_OWNER", "هذا البريد محجوز لهوية أخرى في المنصة.");
  const passwordHash = await createPasswordHash(input.password);
  const mode = await selfRegistrationMode();
  const approved = mode === "auto";
  const slug = input.storeSlug;
  const storeName = input.storeName.trim();
  const businessName = input.businessName.trim();

  const result = await prisma.$transaction(async (tx) => {
    const occupiedSlug = await tx.store.findUnique({ where: { slug }, select: { id: true } });
    if (occupiedSlug) throw new HttpError(409, "DUPLICATE_STORE_SLUG", "رابط المتجر مستخدم بالفعل.");
    const merchant = await tx.merchant.create({
      data: { email, passwordHash, businessName, approvalStatus: approved ? "approved" : "pending", ownerName, phone, phoneNormalized: phone },
      select: { id: true, email: true, businessName: true, approvalStatus: true, ownerName: true, phone: true },
    });
    await subscribeMerchantToDefaultPlan(tx, merchant.id);
    const store = await createStoreFoundation({ merchantId: merchant.id, name: storeName, slug, defaultSubdomain: slug }, tx);
    if (!approved) await tx.store.update({ where: { id: store.id }, data: { isActive: false } });
    return { merchant, store: { slug: store.slug, name: store.name } };
  });
  return { ...result, approvalStatus: approved ? "approved" : "pending", mode };
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const REGISTRATION_REQUESTS_KIND = "platform.registration-requests";

/**
 * D-18: every pending application, in one query. Self-registration is open to
 * the internet, so the size of this list is decided by whoever is signing up —
 * which is exactly the list that must not be unbounded. Oldest first: the
 * applicant who has been waiting longest is the one the queue exists for.
 */
export async function listRegistrationRequests(rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(REGISTRATION_REQUESTS_KIND, rawCursor);
  const rows = await prisma.merchant.findMany({
    where: { approvalStatus: "pending", ...keysetWhere("createdAt", "asc", cursor) },
    // ق-167: `ownerName` and the normalised phone were WRITTEN by all three
    // creation paths and read by nothing in the platform. You approve who
    // sells cash-on-delivery under your name; a number to call is the
    // minimum that decision needs.
    select: { id: true, email: true, ownerName: true, phoneNormalized: true, businessName: true, createdAt: true, stores: { select: { slug: true, name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(REGISTRATION_REQUESTS_KIND, last.createdAt, last.id));
  return { requests: page, nextCursor };
}

export async function decideMerchantApproval(merchantId: string, actor: PlatformActor, body: Record<string, unknown>) {
  if (body.action !== "approve" && body.action !== "reject") throw new HttpError(422, "INVALID_INPUT", "action يجب أن يكون approve أو reject.");
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, approvalStatus: true, businessName: true, email: true } });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "التاجر غير موجود.");
  if (merchant.approvalStatus !== "pending") throw new HttpError(409, "ALREADY_DECIDED", "طلب هذا التاجر محسوم بالفعل.");
  const approve = body.action === "approve";
  await prisma.$transaction(async (tx) => {
    await tx.merchant.update({ where: { id: merchantId }, data: { approvalStatus: approve ? "approved" : "rejected", isActive: approve } });
    await tx.store.updateMany({ where: { merchantId }, data: { isActive: approve } });
    // 19-ب: the decision and its record commit together.
    await recordPlatformAuditEvent(tx, {
      entityType: "merchant",
      entityId: merchantId,
      entityLabel: merchant.businessName || merchant.email,
      action: "registration_decided",
      actor,
      metadata: { decision: approve ? "approved" : "rejected" },
    });
  });
  return { merchantId, approvalStatus: approve ? "approved" : "rejected" };
}

/** Host → store resolution for subdomains and custom domains (read-only, public). */
export async function storeForHost(rawHost: unknown) {
  if (typeof rawHost !== "string" || !rawHost.trim()) throw new HttpError(400, "INVALID_HOST", "host مطلوب.");
  const host = rawHost.trim().toLowerCase().split(":")[0]!;
  const byCustomDomain = await prisma.store.findFirst({ where: { customDomain: host, isActive: true }, select: { slug: true, name: true } });
  if (byCustomDomain) return { slug: byCustomDomain.slug, name: byCustomDomain.name, matchedBy: "custom_domain" as const };
  const firstLabel = host.split(".")[0]!;
  // 19-د: a reserved label never resolves to a store, whatever the table says.
  //
  // The slug validators refuse these at creation, but this line is the half that
  // protects a database where a squat was planted BEFORE the rule shipped — and
  // the trigger deliberately grandfathers such a row rather than renaming it
  // behind its owner's back. Refusing here means the row keeps its name and
  // stops being able to answer for `www.codiq.iq` or the apex.
  if (firstLabel && host.includes(".") && !isReservedStoreSlug(firstLabel)) {
    const bySubdomain = await prisma.store.findFirst({ where: { defaultSubdomain: firstLabel, isActive: true }, select: { slug: true, name: true } });
    if (bySubdomain) return { slug: bySubdomain.slug, name: bySubdomain.name, matchedBy: "default_subdomain" as const };
  }
  throw new HttpError(404, "STORE_NOT_FOUND", "لا يوجد متجر مرتبط بهذا النطاق.");
}

/**
 * Public, secret-free plan listing for the marketing site pricing section.
 *
 * Two flags travel with each plan so the landing page never has to guess from
 * array position:
 *   - `isRecommended` — the owner's own «توصية المنصة» pick (at most one, see
 *     entitlement.service.ts). The page shows no badge when nobody is picked.
 *   - `isDefault` — the plan `subscribeMerchantToDefaultPlan` actually assigns
 *     at registration, read from DEFAULT_PLAN_CODE rather than inferred from
 *     `plans[0]`, so re-sorting the grid can never mislabel the signup CTA.
 */
export async function publicPlans() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: { code: true, name: true, monthlyPriceIqd: true, commissionBps: true, isRecommended: true, features: { select: { featureCode: true, limitValue: true } } },
  });
  return plans.map((plan) => ({
    code: plan.code,
    name: plan.name,
    monthlyPriceIqd: plan.monthlyPriceIqd,
    commissionPercent: plan.commissionBps / 100,
    isRecommended: plan.isRecommended,
    isDefault: plan.code === DEFAULT_PLAN_CODE,
    limits: Object.fromEntries(plan.features.map((feature) => [feature.featureCode, feature.limitValue])),
  }));
}

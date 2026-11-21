import { verifySecondFactor } from "../services/owner-totp.service.js";
import { config } from "../config.js";
import { prisma } from "../db/prisma.js";
import { DEMO_MERCHANT_EMAIL, DEMO_STORE_SLUG } from "../demo/demo-mode.js";
import { subscribeMerchantToDefaultPlan } from "../services/entitlement.service.js";
import { HttpError } from "./auth.errors.js";
import {
  ABSENT_IDENTITY_HASH,
  createPasswordHash,
  createTypedSession,
  normalizeEmail,
  normalizeOptionalEmail,
  normalizePhone,
  verifyPassword,
  normalizeIraqiMobile,
  normalizeOwnerName,
  toE164,
} from "./identity.js";
import {
  merchantStoreDashboardPath,
  platformOwnerDashboardPath,
  staffStoreDashboardPath,
} from "./redirects.js";
import { domainEvents } from "../events/domain-events.js";

export async function registerPlatformOwner(input: {
  email: unknown;
  password: unknown;
  displayName: unknown;
}) {
  if (typeof input.displayName !== "string" || input.displayName.trim().length < 2) {
    throw new HttpError(
      400,
      "INVALID_DISPLAY_NAME",
      "Display name must contain at least 2 characters."
    );
  }
  const email = normalizeEmail(input.email);
  const existingMerchant = await prisma.merchant.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingMerchant) {
    throw new HttpError(
      409,
      "EMAIL_RESERVED_FOR_MERCHANT",
      "This email already belongs to a merchant and cannot be registered as a platform owner."
    );
  }
  return prisma.platformOwner.create({
    data: {
      email,
      passwordHash: await createPasswordHash(input.password),
      displayName: input.displayName.trim(),
    },
    select: { id: true, email: true, displayName: true },
  });
}

export async function registerMerchant(input: {
  email: unknown;
  password: unknown;
  businessName: unknown;
  ownerName: unknown;
  phone: unknown;
}) {
  if (typeof input.businessName !== "string" || input.businessName.trim().length < 2) {
    throw new HttpError(
      400,
      "INVALID_BUSINESS_NAME",
      "Business name must contain at least 2 characters."
    );
  }
  // P27-12 (ق-100). «متجر النور» does not answer a phone, and a cash-on-delivery
  // platform whose merchants have no number cannot resolve a single dispute.
  // The number is also the sign-in identity in P27-21, which is why it has to be
  // unique across the platform rather than per store.
  const ownerName = normalizeOwnerName(input.ownerName);
  const phone = normalizeIraqiMobile(input.phone);
  const email = normalizeEmail(input.email);
  const existingOwner = await prisma.platformOwner.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingOwner) {
    throw new HttpError(
      409,
      "EMAIL_RESERVED_FOR_PLATFORM_OWNER",
      "This email already belongs to a platform owner and cannot be registered as a merchant."
    );
  }
  const passwordHash = await createPasswordHash(input.password);
  const businessName = input.businessName.trim();
  await assertPhoneIsFree(phone);
  // Phase 16: every merchant starts on the free plan within the same transaction.
  return prisma.$transaction(async (tx) => {
    const merchant = await tx.merchant.create({
      data: { email, passwordHash, businessName, ownerName, phone, phoneNormalized: phone },
      select: { id: true, email: true, businessName: true, ownerName: true, phone: true },
    });
    await subscribeMerchantToDefaultPlan(tx, merchant.id);
    return merchant;
  });
}

/**
 * P27-12 — the friendly half of the platform-unique phone.
 *
 * `merchants_contact_phone_uq` is the real guarantee and it is never bypassed;
 * this read only turns the race-losing case into a message the merchant can act
 * on — the loser of a concurrent pair still hits the index.
 *
 * ⚠️ CORRECTION. An earlier version of this comment, and the comment in
 * migration 20260829090000, claimed the index NAME keeps this collision out of
 * the customer-phone branch in http/errors.ts. That is false: Prisma reports the
 * COLUMN in `meta.target`, not the index, so the branch matched and answered
 * with a customer's English message about «this store». The real defence is the
 * `modelName` check now in errors.ts. The migration file is left untouched on
 * purpose — Prisma checksums it, and editing an applied migration reports drift
 * against production; the correction is recorded in the debt register instead.
 */
export async function assertPhoneIsFree(
  phoneNormalized: string,
  exceptMerchantId?: string
): Promise<void> {
  const holder = await prisma.merchant.findFirst({
    where: { phoneNormalized, ...(exceptMerchantId ? { id: { not: exceptMerchantId } } : {}) },
    select: { id: true },
  });
  if (holder)
    throw new HttpError(
      409,
      "DUPLICATE_MERCHANT_PHONE",
      "رقم الهاتف مسجَّل لحساب تاجر آخر على المنصة."
    );
}

/**
 * Phase 19 (ق-123): the second factor joins here, and the shape is ADDITIVE.
 *
 * With TOTP off — which is the default and the state of every account until an
 * owner enrols — this returns exactly what it always returned, key for key. Only
 * an enrolled account takes the second branch, so no existing client or test
 * sees a different login.
 *
 * The code travels in the SAME request as the password rather than through a
 * two-call challenge. A challenge would need a short-lived half-authenticated
 * token, which is a new credential to mint, store, expire and revoke — a real
 * attack surface bought for the convenience of a second screen. One request
 * carries both, and the failure message never says which half was wrong.
 */
export async function loginPlatformOwner(input: {
  email: unknown;
  password: unknown;
  totpCode?: unknown;
}) {
  const owner = await prisma.platformOwner.findUnique({
    where: { email: normalizeEmail(input.email) },
  });
  // 19-د: constant work. The compare runs before the branch so an unknown
  // address costs exactly what a wrong password costs — see ABSENT_IDENTITY_HASH.
  // This door names the ONE account with no tenant boundary above it, so the
  // address it would otherwise leak is the highest-value phishing target here.
  const passwordOk = await verifyPassword(
    input.password,
    owner?.passwordHash ?? ABSENT_IDENTITY_HASH
  );
  if (!owner || !owner.isActive || !passwordOk) {
    throw new HttpError(
      401,
      "INVALID_PLATFORM_OWNER_CREDENTIALS",
      "Invalid platform owner credentials."
    );
  }
  if (owner.totpEnabledAt) {
    // A distinct code, deliberately: the client must know to ASK for the second
    // factor rather than repeat "wrong password" at someone whose password was
    // right. It reveals nothing an attacker does not already have — he supplied
    // the correct password to reach this line.
    if (input.totpCode === undefined || input.totpCode === null || input.totpCode === "") {
      throw new HttpError(401, "SECOND_FACTOR_REQUIRED", "أدخل رمز تطبيق المصادقة.");
    }
    const factor = await verifySecondFactor(owner.id, input.totpCode);
    if (!factor.ok) {
      throw new HttpError(401, "INVALID_SECOND_FACTOR", "الرمز غير صحيح أو مستعمل مسبقاً.");
    }
    return {
      accessToken: await createTypedSession("platform_owner", owner.id),
      redirectTo: platformOwnerDashboardPath(),
      // Said out loud so he knows one of his ten is gone. A recovery code spent
      // silently is a count he discovers at zero, on the day he needs one.
      ...(factor.usedRecoveryCode ? { usedRecoveryCode: true } : {}),
    };
  }
  return {
    accessToken: await createTypedSession("platform_owner", owner.id),
    redirectTo: platformOwnerDashboardPath(),
  };
}

/**
 * P27-21 (ق-108) — the merchant signs in with WHO HE IS, not with the address of
 * a store he may have forgotten. The store link used to be a required field on
 * every sign-in, and a merchant whose store the owner had created for him often
 * did not know it at all.
 *
 * WHAT DOES NOT CHANGE, and it is the important half: the session is still bound
 * to exactly ONE store, and `requireMerchantStore` still checks both conditions —
 * that the store is the session's store AND that this merchant owns it. A session
 * issued for store A cannot act on store B without an explicit switch. The store
 * is simply resolved AFTER authentication instead of being typed before it.
 */
export async function loginMerchant(input: { identifier: unknown; password: unknown }) {
  // The format decides the lookup BEFORE any query runs, so a malformed input is
  // a pure shape error that reveals nothing about who exists.
  const raw = typeof input.identifier === "string" ? input.identifier.trim() : "";
  const asPhone = toE164(raw);
  const looksLikeEmail = raw.includes("@");
  if (!raw || (!looksLikeEmail && !asPhone)) {
    throw new HttpError(
      400,
      "INVALID_MERCHANT_IDENTIFIER",
      "أدخل بريداً إلكترونياً صحيحاً أو رقم هاتف عراقي يبدأ بـ 07."
    );
  }
  const merchant = looksLikeEmail
    ? await prisma.merchant.findUnique({ where: { email: normalizeEmail(input.identifier) } })
    : // `asPhone` is a non-empty string here by construction. Passing null would
      // match the first legacy merchant with no phone and hand over his account —
      // a hole closed by the shape of the code, not by remembering to check.
      await prisma.merchant.findFirst({ where: { phoneNormalized: asPhone! } });
  // 19-د: this door was the only one of five that already equalised, and the
  // constant it used privately is now the platform's single ABSENT_IDENTITY_HASH.
  const passwordOk = await verifyPassword(
    input.password,
    merchant?.passwordHash ?? ABSENT_IDENTITY_HASH
  );
  if (!merchant || !passwordOk) {
    throw new HttpError(
      401,
      "INVALID_MERCHANT_CREDENTIALS",
      "بيانات الدخول غير صحيحة. تحقق من البريد أو رقم الهاتف وكلمة المرور."
    );
  }
  // Phase 17 (ADR-006): a self-registered merchant awaiting the owner's decision cannot sign in.
  if (merchant.approvalStatus === "pending") {
    throw new HttpError(
      403,
      "MERCHANT_PENDING_APPROVAL",
      "طلب تسجيلك قيد مراجعة إدارة المنصة؛ ستصلك الموافقة قريباً."
    );
  }
  // A REJECTED merchant has all his stores deactivated, so this check must stay
  // ABOVE the store resolution below. Reordering them would answer him with
  // «no active store» instead of a plain 401 — telling a stranger that this
  // account exists and was refused.
  if (merchant.approvalStatus === "rejected" || !merchant.isActive) {
    throw new HttpError(
      401,
      "INVALID_MERCHANT_CREDENTIALS",
      "بيانات الدخول غير صحيحة. تحقق من البريد أو رقم الهاتف وكلمة المرور."
    );
  }
  // Only ACTIVE stores, ordered exactly as the phase-13 switcher orders them, so
  // «the default store» and «the first row in the switcher» are the same store.
  const stores = await prisma.store.findMany({
    where: { merchantId: merchant.id, isActive: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, slug: true },
  });
  if (!stores.length) {
    throw new HttpError(
      403,
      "MERCHANT_NO_ACTIVE_STORE",
      "حسابك سليم، لكن لا يوجد متجر نشط مرتبط به حالياً. تواصل مع إدارة المنصة لإعادة تفعيل متجرك."
    );
  }
  // More than one store: the session binds to the oldest and the dashboard opens
  // with the switcher already open. Issuing a session with NO store is not an
  // option — `createTypedSession`, `verifyTypedSession` and the NOT NULL
  // `merchant_sessions.store_id` all require one, and the switcher's own routes
  // sit behind a merchant session, so a store-less session could not even read
  // the list of its stores.
  const target = stores[0]!;
  const dashboard = merchantStoreDashboardPath(target.slug);
  // ق-218: he signs in normally — the session is real — but every merchant
  // surface except «change my password» is refused while the credential is one a
  // platform actor chose for him, so the door he is sent to is that one.
  const mustChangePassword = Boolean(merchant.passwordSetByProvisionerAt);
  return {
    accessToken: await createTypedSession("merchant", merchant.id, target.id),
    redirectTo: mustChangePassword
      ? "/merchant/dashboard/account/security"
      : stores.length > 1
        ? `${dashboard}?stores=switch`
        : dashboard,
    storeCount: stores.length,
    ...(mustChangePassword ? { mustChangePassword: true } : {}),
  };
}

/**
 * P27-7 — one-click guest entry for the demo environment.
 *
 * Deliberately NOT a privileged back door: it issues the ordinary merchant session
 * (`createTypedSession("merchant", …)`) for the ONE seeded demo merchant, bound to
 * the ONE seeded demo store, with the same 8-hour lifetime and the same store
 * boundary every other merchant session gets. No password is bypassed for anyone
 * else: the merchant is looked up by the hard-coded seeded email only, and a miss
 * is a plain 404 rather than a fallback to "some merchant".
 *
 * Two independent gates keep it out of every other environment: the route is only
 * registered when the flag is on, and this function refuses when the flag is off.
 */
export async function loginDemoMerchantGuest() {
  if (!config.demoMode)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found.");
  const merchant = await prisma.merchant.findUnique({
    where: { email: DEMO_MERCHANT_EMAIL },
    select: { id: true, isActive: true, approvalStatus: true },
  });
  if (!merchant || !merchant.isActive || merchant.approvalStatus !== "approved") {
    throw new HttpError(404, "DEMO_NOT_SEEDED", "لم تُبذر بيانات النسخة التجريبية بعد.");
  }
  const store = await prisma.store.findFirst({
    where: { slug: DEMO_STORE_SLUG, merchantId: merchant.id, isActive: true },
    select: { id: true, slug: true },
  });
  if (!store) throw new HttpError(404, "DEMO_NOT_SEEDED", "لم تُبذر بيانات النسخة التجريبية بعد.");
  return {
    accessToken: await createTypedSession("merchant", merchant.id, store.id),
    redirectTo: merchantStoreDashboardPath(store.slug),
  };
}

/**
 * Phase 14 (D14-06): staff sign in with an explicit store choice; the issued session is
 * bound to exactly one active membership and never reuses the merchant login path.
 */
export async function loginStaff(input: { email: unknown; password: unknown; storeSlug: string }) {
  // ق-227: the LIVING only. An identity whose last membership was removed has
  // released its address — it may already belong to a merchant or to another
  // shop's employee, and the row that remains is history, not a door.
  const staff = await prisma.staff.findFirst({
    where: { email: normalizeEmail(input.email), deletedAt: null },
  });
  // 19-د: constant work — see ABSENT_IDENTITY_HASH. A sweep over candidate
  // addresses at this door used to sort «is a staff member on CODIQ» from «is
  // not» in one request each, and hand that list to a password-guessing run.
  const passwordOk = await verifyPassword(
    input.password,
    staff?.passwordHash ?? ABSENT_IDENTITY_HASH
  );
  if (!staff || !staff.isActive || !passwordOk) {
    throw new HttpError(401, "INVALID_STAFF_CREDENTIALS", "Invalid staff credentials.");
  }
  const membership = await prisma.storeStaffMembership.findFirst({
    // PG-2: sign-in must never see a membership that was removed from the team.
    where: {
      staffId: staff.id,
      isActive: true,
      deletedAt: null,
      store: { slug: input.storeSlug, isActive: true },
    },
    select: { id: true, storeId: true, store: { select: { slug: true } } },
  });
  if (!membership)
    throw new HttpError(
      404,
      "STAFF_STORE_CONTEXT_NOT_FOUND",
      "This staff account has no active membership in the requested store."
    );
  // Audit 14-ب: like ق-218 for merchants — the session is real, but the only door
  // open while the password is the merchant's choice is «change my password».
  const mustChangePassword = Boolean(staff.passwordSetByProvisionerAt);
  return {
    accessToken: await createTypedSession("staff", staff.id, membership.storeId, membership.id),
    redirectTo: mustChangePassword
      ? `${staffStoreDashboardPath(membership.store.slug)}/security`
      : staffStoreDashboardPath(membership.store.slug),
    ...(mustChangePassword ? { mustChangePassword: true } : {}),
  };
}

export async function registerCustomer(input: {
  storeSlug: string;
  email?: unknown;
  password: unknown;
  fullName: unknown;
  phone: unknown;
}) {
  const store = await prisma.store.findUnique({ where: { slug: input.storeSlug } });
  if (!store || !store.isActive)
    throw new HttpError(404, "STORE_NOT_FOUND", "Store was not found.");
  if (typeof input.fullName !== "string" || input.fullName.trim().length < 2)
    throw new HttpError(400, "INVALID_FULL_NAME", "Full name must contain at least 2 characters.");
  const phoneNormalized = normalizePhone(input.phone);
  const data = {
    email: normalizeOptionalEmail(input.email),
    passwordHash: await createPasswordHash(input.password),
    fullName: input.fullName.trim(),
    phone: typeof input.phone === "string" ? input.phone.trim() : null,
  };
  const select = {
    id: true,
    storeId: true,
    email: true,
    fullName: true,
    phoneNormalized: true,
    isGuest: true,
  } as const;
  // ق-201 let a shopper who bought here as a GUEST register with the same phone
  // and receive HIS row — orders, addresses and points included. The intent was
  // right: one person must not become two identities. The mechanism was not:
  // nothing proved the phone was his, so anyone who knew a shopper's number
  // could set a password on that shopper's row and own everything on it.
  //
  // ق-232: a guest row is never claimed by typing its number. The row's owner
  // has two doors that prove something — the password he sets from his own
  // first order (`setGuestPassword`, on the session minted when the row was
  // created), and password recovery by the email the row already holds. The
  // refusal names whichever applies, so the honest shopper is sent somewhere
  // and the stranger is sent nowhere. (ق-212's hand-added customer is the same
  // case: the address the shop recorded is not the stranger's to read.)
  // Only the GUEST row is decided here. A number that already belongs to an
  // ACCOUNT keeps the answer it has always had — `customers_store_phone_present_uq`
  // rejects the insert below and `errors.ts` maps it to DUPLICATE_CUSTOMER_PHONE.
  // Naming that case a second time from here would be a new code for a refusal
  // the platform already names, and `phase1:test` pins the old one: one rule,
  // one code, and the database is where this one lives.
  const guest = await prisma.customer.findFirst({
    where: { storeId: store.id, phoneNormalized, isGuest: true, passwordHash: null },
    select: { email: true },
  });
  if (guest) {
    throw new HttpError(
      409,
      "CUSTOMER_PHONE_UNVERIFIED",
      guest.email
        ? "هذا الرقم اشترى من هنا سابقاً. لحماية طلباته لا نفتح حساباً عليه بالرقم وحده — استعمل «نسيت كلمة المرور» بالبريد المسجّل لديك، أو اطلب من المتجر ربط حسابك."
        : "هذا الرقم اشترى من هنا سابقاً. لحماية طلباته لا نفتح حساباً عليه بالرقم وحده — اطلب من المتجر ربط حسابك."
    );
  }
  const customer = await prisma.customer.create({
    data: { storeId: store.id, ...data, phoneNormalized },
    select,
  });
  domainEvents.emit("customer.registered", { storeId: store.id, customerId: customer.id });
  return customer;
}

/**
 * ق-201 — a guest chooses a password and becomes an account, with everything
 * his shadow row already holds. Refused for a row that has one: changing a
 * password is the account-settings path, with the old password asked for.
 */
export async function setGuestPassword(customerId: string, password: unknown) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { isGuest: true, passwordHash: true },
  });
  // ق-232: a hash set by password recovery makes this an account too, flag or no flag.
  if (!customer?.isGuest || customer.passwordHash)
    throw new HttpError(409, "ACCOUNT_HAS_PASSWORD", "هذا الحساب يملك كلمة مرور بالفعل.");
  return prisma.customer.update({
    where: { id: customerId },
    data: { passwordHash: await createPasswordHash(password), isGuest: false },
    select: {
      id: true,
      storeId: true,
      email: true,
      fullName: true,
      phoneNormalized: true,
      isGuest: true,
    },
  });
}

export async function loginCustomer(input: {
  storeSlug: string;
  phone: unknown;
  password: unknown;
}) {
  const store = await prisma.store.findUnique({ where: { slug: input.storeSlug } });
  if (!store || !store.isActive)
    throw new HttpError(404, "STORE_NOT_FOUND", "Store was not found.");
  const customer = await prisma.customer.findFirst({
    where: { storeId: store.id, phoneNormalized: normalizePhone(input.phone) },
  });
  // 19-د: constant work — see ABSENT_IDENTITY_HASH. This is the door with no
  // account needed to knock on it: the lookup is scoped to ONE store, so a fast
  // answer used to mean «this Iraqi mobile number does not shop here» and a slow
  // one meant it does. That is a named person's relationship to a named
  // merchant, disclosed to a stranger, one number at a time.
  const passwordOk = await verifyPassword(
    input.password,
    customer?.passwordHash ?? ABSENT_IDENTITY_HASH
  );
  if (!customer || !customer.isActive || !passwordOk) {
    throw new HttpError(
      401,
      "INVALID_CUSTOMER_CREDENTIALS",
      "Invalid customer credentials for this store."
    );
  }
  return { accessToken: await createTypedSession("customer", customer.id) };
}

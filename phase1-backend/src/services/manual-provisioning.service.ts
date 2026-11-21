import { assertPhoneIsFree } from "../auth/auth.service.js";
import { HttpError } from "../auth/auth.errors.js";
import {
  createPasswordHash,
  normalizeEmail,
  normalizeIraqiMobile,
  normalizeOptionalEmail,
  normalizeOwnerName,
  normalizePhone,
} from "../auth/identity.js";
import { prisma } from "../db/prisma.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";
import { subscribeMerchantToDefaultPlan } from "./entitlement.service.js";
import { createStoreFoundation } from "./store-bootstrap.service.js";
import { domainEvents } from "../events/domain-events.js";

function requiredText(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new HttpError(400, code, `${label} must contain at least 2 characters.`);
  }
  return value.trim();
}

/** Creates an active merchant and its first store atomically; only a permitted platform actor's route may call it (19-ب: merchants.manage). */
export async function createManualMerchant(
  actor: PlatformActor,
  input: {
    businessName: unknown;
    email: unknown;
    temporaryPassword: unknown;
    firstStoreName: unknown;
    ownerName: unknown;
    phone: unknown;
  }
) {
  const businessName = requiredText(input.businessName, "INVALID_BUSINESS_NAME", "Merchant name");
  const firstStoreName = requiredText(
    input.firstStoreName,
    "INVALID_STORE_NAME",
    "First store name"
  );
  const email = normalizeEmail(input.email);
  // P27-12 (ق-100): the owner creating a merchant by hand must collect the same
  // identity the merchant would have given himself. This is the third creation
  // path, and the easiest to forget.
  const ownerName = normalizeOwnerName(input.ownerName);
  const phone = normalizeIraqiMobile(input.phone);
  await assertPhoneIsFree(phone);
  const passwordHash = await createPasswordHash(input.temporaryPassword);

  const created = await prisma.$transaction(async (transaction) => {
    const existingOwner = await transaction.platformOwner.findUnique({
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

    const merchant = await transaction.merchant.create({
      // ق-218: the password was typed by whoever is provisioning this account, so
      // it is his until the merchant replaces it. Until then every merchant
      // surface except «change my password» is refused — otherwise the person who
      // typed it keeps a working key to a live merchant account for as long as the
      // merchant never thinks to change a password nobody told him was temporary.
      data: {
        email,
        passwordHash,
        businessName,
        isActive: true,
        ownerName,
        phone,
        phoneNormalized: phone,
        passwordSetByProvisionerAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        businessName: true,
        isActive: true,
        ownerName: true,
        phone: true,
      },
    });
    await subscribeMerchantToDefaultPlan(transaction, merchant.id);
    // Generated from the immutable UUID rather than the display name, avoiding transliteration and slug-collision ambiguity.
    const suffix = merchant.id.replace(/-/g, "").slice(0, 16);
    const store = await createStoreFoundation(
      {
        merchantId: merchant.id,
        name: firstStoreName,
        slug: `store-${suffix}`,
        defaultSubdomain: `store-${suffix}`,
      },
      transaction
    );

    // 19-ب: an account brought into existence by hand is on the record, with
    // whoever actually did it — owner or staff.
    await recordPlatformAuditEvent(transaction, {
      entityType: "merchant",
      entityId: merchant.id,
      entityLabel: businessName,
      action: "merchant_created_manually",
      actor,
      metadata: { email },
    });

    return {
      merchant,
      store: {
        id: store.id,
        merchantId: store.merchantId,
        name: store.name,
        slug: store.slug,
        isActive: store.isActive,
      },
    };
  });
  domainEvents.emit("merchant.registered", {
    merchantId: created.merchant.id,
    storeId: created.store.id,
    via: "manual",
  });
  return created;
}

/**
 * ق-212 — a customer the shop adds by hand is a REAL row of the shop's own kind.
 *
 * ============================================================================
 * WHAT WAS WRONG
 * ============================================================================
 *
 * This function wrote `phone` as the raw typed text and never wrote
 * `phone_normalized` — the one column the customer sign-in door reads
 * (`auth.service.ts` resolves a shopper by `phoneNormalized`). Every row it
 * created was therefore an account that could never be signed into, while the
 * screen told the merchant «تم ربط الزبون بالمتجر» and the recovery flow would
 * cheerfully mail the person a link that set a password he still could not use.
 * It also inverted the platform's identity model: the EMAIL was mandatory — on a
 * cash-on-delivery platform where most shoppers have none, so staff invented one
 * per customer — and the PHONE, the thing a courier actually dials, was accepted
 * as any string of five characters.
 *
 * ============================================================================
 * WHAT IT IS NOW, AND WHY
 * ============================================================================
 *
 * A GUEST ROW (ق-201), not a credential-holding account. ق-201 already built
 * exactly this shape for the shopper who buys without choosing a password:
 * `is_guest` with a null `password_hash`, claimed by phone the moment the person
 * registers himself. So the hand-created row now:
 *
 *   · carries `phoneNormalized` and is therefore findable, mergeable and — the
 *     moment the shopper registers with his own number — HIS row, orders and
 *     addresses included, by the path `registerCustomer` already implements;
 *   · mints NO credential. The 32 random bytes this used to bcrypt were a
 *     password nobody would ever hold, hashed at cost 12, and the only thing
 *     they achieved was to make the row look like an account to the recovery
 *     flow;
 *   · takes the email as OPTIONAL, exactly as the storefront's own registration
 *     does, so nobody has to invent one.
 *
 * A number already on the shop's books is refused by NAME rather than merged
 * silently: two rows for one shopper split his loyalty balance and his ق-179
 * block, and a merge the merchant did not ask for is not this route's decision.
 */
export async function createManualCustomer(input: {
  storeId: string;
  fullName: unknown;
  email: unknown;
  phone: unknown;
}) {
  const fullName = requiredText(input.fullName, "INVALID_FULL_NAME", "Customer name");
  // The same helper the storefront's own registration uses, so the needle and
  // the column are produced by one function: 07XXXXXXXXX and +9647XXXXXXXXX both
  // land as E.164, and anything else is a named 400 that says what to type.
  const phoneNormalized = normalizePhone(input.phone);
  const email = normalizeOptionalEmail(input.email);

  const existing = await prisma.customer.findFirst({
    where: { storeId: input.storeId, phoneNormalized },
    select: { id: true, fullName: true },
  });
  if (existing) {
    throw new HttpError(
      409,
      "CUSTOMER_PHONE_TAKEN",
      `هذا الرقم مسجَّل في متجرك باسم «${existing.fullName}» — افتحه من دليل العملاء بدل إنشاء صفٍّ ثانٍ له.`
    );
  }

  return prisma.customer.create({
    data: {
      storeId: input.storeId,
      email,
      fullName,
      phone: typeof input.phone === "string" ? input.phone.trim() : null,
      phoneNormalized,
      // No password, and honest about it: the shopper chooses his own the first
      // time he registers or buys, and `registerCustomer` claims this row by its
      // number rather than refusing him as a duplicate.
      isGuest: true,
      isActive: true,
    },
    select: {
      id: true,
      storeId: true,
      email: true,
      fullName: true,
      phone: true,
      phoneNormalized: true,
      isGuest: true,
      isActive: true,
    },
  });
}

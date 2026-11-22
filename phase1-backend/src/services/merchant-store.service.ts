import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { assertDemoWritable } from "../demo/demo-mode.js";
import { assertWithinPlanLimit } from "./entitlement.service.js";
import { assertStoreSlugNotReserved } from "./reserved-slugs.js";
import { createStoreFoundation } from "./store-bootstrap.service.js";

const STORE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

export type MerchantStoreSummary = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
};

function storeSummary(store: MerchantStoreSummary): MerchantStoreSummary {
  return { id: store.id, name: store.name, slug: store.slug, isActive: store.isActive };
}

function requiredStoreName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 120) {
    throw new HttpError(422, "INVALID_STORE_NAME", "اسم المتجر يجب أن يتكون من حرفين إلى 120 حرفاً.");
  }
  return value.trim();
}

function normalizedStoreSlug(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || value !== value.toLowerCase() || !STORE_SLUG_PATTERN.test(value)) {
    throw new HttpError(422, "INVALID_STORE_SLUG", "يجب أن يكون رابط المتجر بأحرف إنجليزية صغيرة وأرقام وشرطات فقط.");
  }
  // 19-د: shape first, then ownership. `createStoreFoundation` refuses this too;
  // the check is repeated here so the merchant gets the reserved-label sentence
  // rather than a generic failure from three layers down.
  assertStoreSlugNotReserved(value);
  return value;
}

/**
 * ق-226 — what the merchant shell needs to know before it draws anything.
 *
 * Identity and nothing else: who is signed in, which store the session is bound
 * to, and the two facts that decide whether the shell may render at all. It is
 * the merchant's equivalent of `/platform/staff/session`, and like that one it
 * answers for a session that is not yet allowed to WORK — a merchant still
 * holding the password his provisioner typed (ق-218) gets `mustChangePassword`
 * so the shell can send him to the one screen that fixes it, rather than a 403
 * that would bounce him back to a login he has already passed.
 *
 * A SUSPENDED merchant (ق-225) is refused here with the same code every other
 * guard gives him, so his own browser shows him the door instead of a dashboard
 * of failed cards.
 */
export async function merchantSessionView(merchantId: string, storeId: string) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true, email: true, businessName: true, ownerName: true, isActive: true, passwordSetByProvisionerAt: true },
  });
  if (!merchant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");
  if (!merchant.isActive) throw new HttpError(403, "MERCHANT_DISABLED", "حساب التاجر موقوف — تواصل مع إدارة المنصة.");
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId }, select: { id: true, name: true, slug: true, isActive: true } });
  return {
    merchant: { id: merchant.id, email: merchant.email, businessName: merchant.businessName, ownerName: merchant.ownerName },
    store: store ? storeSummary(store) : null,
    mustChangePassword: Boolean(merchant.passwordSetByProvisionerAt),
  };
}

export async function listMerchantStores(merchantId: string): Promise<MerchantStoreSummary[]> {
  const stores = await prisma.store.findMany({
    where: { merchantId },
    select: { id: true, name: true, slug: true, isActive: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return stores.map(storeSummary);
}

export async function merchantStoreForSwitch(merchantId: string, storeSlug: unknown): Promise<MerchantStoreSummary> {
  if (typeof storeSlug !== "string" || !storeSlug) {
    throw new HttpError(422, "INVALID_STORE_SLUG", "معرّف المتجر مطلوب.");
  }
  const store = await prisma.store.findFirst({
    where: { merchantId, slug: storeSlug, isActive: true },
    select: { id: true, name: true, slug: true, isActive: true },
  });
  if (!store) {
    throw new HttpError(404, "MERCHANT_STORE_CONTEXT_NOT_FOUND", "المتجر النشط غير متاح لهذا التاجر.");
  }
  return storeSummary(store);
}

/** Menus pass A: rename only — the slug is a public identity and never changes here. */
export async function renameMerchantStore(storeId: string, input: { name: unknown }, storeSlug?: string): Promise<MerchantStoreSummary> {
  // P27-7: the seeded demo store's name is the demo's public identity — it is what
  // the prospect sees in the storefront header and in the link the owner sent. A
  // visitor renaming it defaces the shared demo for everyone until the nightly
  // reseed, so this one row is refused; any store the visitor creates renames freely.
  assertDemoWritable("demo_store", storeSlug);
  const name = requiredStoreName(input.name);
  const store = await prisma.store.update({ where: { id: storeId }, data: { name }, select: { id: true, name: true, slug: true, isActive: true } });
  return storeSummary(store);
}

// ---------- MD-1: «وضع الإجازة» (temporary closed-for-orders switch) ----------

export const VACATION_MESSAGE_MAX_LENGTH = 500;

/**
 * ق-249: the vacation SWITCH moved into the named store status (`availability.service`:
 * `paused` is the vacation). Only the public banner reader remains here — the
 * storefront still spreads `vacation` while the status is `paused`, and the
 * `stores_status_sync` trigger keeps `vacation_mode` true exactly then.
 */
/** Public banner payload — present ONLY while vacation mode is on. */
export async function storeVacationBanner(storeId: string): Promise<{ message: string } | null> {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { vacationMode: true, vacationMessage: true } });
  if (!store?.vacationMode) return null;
  return { message: store.vacationMessage?.trim() || "المتجر في إجازة مؤقتة — يمكنك التصفّح، وسنستأنف استقبال الطلبات قريباً." };
}

export async function createMerchantStore(merchantId: string, input: { name: unknown; slug: unknown }): Promise<MerchantStoreSummary> {
  const name = requiredStoreName(input.name);
  const slug = normalizedStoreSlug(input.slug);

  return prisma.$transaction(async (transaction) => {
    // Phase 16: the temporary fixed cap is replaced by the merchant's plan limit (ADR-005).
    await assertWithinPlanLimit(transaction, merchantId, "max_stores");
    const occupiedSlug = await transaction.store.findUnique({ where: { slug }, select: { id: true } });
    if (occupiedSlug) {
      throw new HttpError(409, "DUPLICATE_STORE_SLUG", "رابط المتجر مستخدم بالفعل.");
    }
    const store = await createStoreFoundation({ merchantId, name, slug, defaultSubdomain: slug }, transaction);
    return storeSummary(store);
  });
}

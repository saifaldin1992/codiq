/**
 * Market checkout — customer. Split verbatim from checkout.service.ts (review batch 2, ت-١٢);
 * checkout.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";

export type ShopperRef = { id: string; phoneNormalized: string; fullName: string | null };

export async function shopperAddress(shopperId: string, addressId: string) {
  const address = await prisma.shopperAddress.findFirst({
    where: { id: addressId, shopperId },
    include: { district: { select: { nameAr: true } } },
  });
  if (!address) throw new HttpError(404, "ADDRESS_NOT_FOUND", "العنوان غير موجود.");
  return address;
}

/** The store's customer row for this shopper, created or linked on first use. */
export async function customerForShopper(
  storeId: string,
  shopper: ShopperRef,
  nameFallback: string
) {
  const linked = await prisma.customer.findFirst({
    where: { storeId, shopperId: shopper.id },
    select: { id: true, isActive: true },
  });
  if (linked) {
    if (!linked.isActive)
      throw new HttpError(
        403,
        "CUSTOMER_DISABLED",
        "لا يمكنك الطلب من هذا المتجر حالياً. تواصل مع المتجر."
      );
    return linked.id;
  }
  const known = await prisma.customer.findFirst({
    where: {
      storeId,
      phoneNormalized: shopper.phoneNormalized,
      shopperId: null,
      isGuest: false,
      isActive: true,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (known) {
    const claimed = await prisma.customer.updateMany({
      where: { id: known.id, shopperId: null },
      data: { shopperId: shopper.id },
    });
    if (claimed.count === 1) return known.id;
  }
  try {
    const created = await prisma.customer.create({
      data: {
        storeId,
        shopperId: shopper.id,
        fullName: shopper.fullName ?? nameFallback,
        phoneNormalized: shopper.phoneNormalized,
        phoneVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    // Two first orders at once: the other request created the row; use it.
    const raced = await prisma.customer.findFirst({
      where: { storeId, shopperId: shopper.id },
      select: { id: true },
    });
    if (raced) return raced.id;
    throw error;
  }
}

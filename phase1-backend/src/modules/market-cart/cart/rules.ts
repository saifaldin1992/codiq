/**
 * The market cart — rules. Split verbatim from cart.service.ts (review batch 2, ت-١٥);
 * cart.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";

export const MAX_LINE_QUANTITY = 99;

export const MAX_LINES = 100;

export async function cartFor(
  shopperId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  return client.marketCart.upsert({
    where: { shopperId },
    update: {},
    create: { shopperId },
    select: { id: true, version: true },
  });
}

type VariantFacts = {
  id: string;
  productId: string;
  storeId: string;
  priceIqd: number;
  stockQuantity: number;
  isActive: boolean;
  product: {
    isActive: boolean;
    deletedAt: Date | null;
    maxPerOrder: number | null;
    isPreorder: boolean;
    name: string;
    store: { marketStatus: string; isActive: boolean };
  };
};

export const VARIANT_FACTS = {
  id: true,
  productId: true,
  storeId: true,
  priceIqd: true,
  stockQuantity: true,
  isActive: true,
  product: {
    select: {
      isActive: true,
      deletedAt: true,
      maxPerOrder: true,
      isPreorder: true,
      name: true,
      store: { select: { marketStatus: true, isActive: true } },
    },
  },
} as const;

/** Stock that is not already spoken for by an open order. */
async function availableOf(
  client: Prisma.TransactionClient | typeof prisma,
  variantId: string,
  stockQuantity: number
) {
  const reserved = await client.inventoryReservation.aggregate({
    where: { variantId, status: "active" },
    _sum: { quantity: true },
  });
  return Math.max(0, stockQuantity - (reserved._sum.quantity ?? 0));
}

export function assertSellable(variant: VariantFacts | null): asserts variant is VariantFacts {
  if (
    !variant ||
    !variant.isActive ||
    !variant.product.isActive ||
    variant.product.deletedAt ||
    variant.product.store.marketStatus !== "listed" ||
    !variant.product.store.isActive
  ) {
    throw new HttpError(404, "PRODUCT_NOT_FOUND", "هذا المنتج غير متوفّر حالياً.");
  }
}

export async function addonsTotal(
  client: Prisma.TransactionClient | typeof prisma,
  productId: string,
  addonIds: string[]
) {
  if (!addonIds.length) return 0;
  const rows = await client.productAddon.findMany({
    where: { id: { in: addonIds }, productId, isActive: true },
    select: { priceIqd: true },
  });
  if (rows.length !== addonIds.length)
    throw new HttpError(422, "ADDON_UNAVAILABLE", "إحدى الإضافات المختارة غير متاحة لهذا المنتج.");
  return rows.reduce((sum, row) => sum + row.priceIqd, 0);
}

/** The line would hold `quantity`: within 99, within the product's per-order cap (all its variants together), within stock unless pre-order. */
export async function assertQuantity(
  client: Prisma.TransactionClient | typeof prisma,
  cartId: string,
  variant: VariantFacts,
  quantity: number,
  exceptLineId: string | null
) {
  if (quantity > MAX_LINE_QUANTITY)
    throw new HttpError(
      422,
      "INVALID_CART_QUANTITY",
      `الحدّ الأقصى ${MAX_LINE_QUANTITY} قطعة في السطر الواحد.`
    );
  if (variant.product.maxPerOrder) {
    const others = await client.marketCartItem.aggregate({
      where: {
        cartId,
        productId: variant.productId,
        ...(exceptLineId ? { id: { not: exceptLineId } } : {}),
      },
      _sum: { quantity: true },
    });
    if ((others._sum.quantity ?? 0) + quantity > variant.product.maxPerOrder) {
      throw new HttpError(
        422,
        "ORDER_LIMIT_EXCEEDED",
        `الحدّ الأقصى لهذا المنتج ${variant.product.maxPerOrder} لكل طلب.`,
        { maxPerOrder: variant.product.maxPerOrder }
      );
    }
  }
  if (!variant.product.isPreorder) {
    const available = await availableOf(client, variant.id, variant.stockQuantity);
    if (available < quantity)
      throw new HttpError(
        422,
        "INSUFFICIENT_AVAILABLE_STOCK",
        available ? `المتوفّر من هذا الخيار ${available} فقط.` : "نفد هذا الخيار.",
        { available }
      );
  }
}

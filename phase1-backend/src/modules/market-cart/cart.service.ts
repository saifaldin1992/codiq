/**
 * The market cart: one basket across every store, shown grouped by store.
 *
 * It is a LIST, never a second checkout. Prices are snapshotted when a line is
 * added (and when its quantity rises, or its options change), exactly as the
 * store cart does, so checkout can refuse a price that moved instead of
 * charging a number the shopper never saw. Stock, the per-order cap and the
 * add-ons are checked here for a fast, honest answer, and checked AGAIN under
 * lock by the store's checkout — which is the only place that decides.
 */
import { livePriceOf, livePrices } from "../../services/live-price.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";

export const MAX_LINE_QUANTITY = 99;
const MAX_LINES = 100;

async function cartFor(shopperId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  return client.marketCart.upsert({ where: { shopperId }, update: {}, create: { shopperId }, select: { id: true, version: true } });
}

type VariantFacts = {
  id: string; productId: string; storeId: string; priceIqd: number; stockQuantity: number; isActive: boolean;
  product: { isActive: boolean; deletedAt: Date | null; maxPerOrder: number | null; isPreorder: boolean; name: string; store: { marketStatus: string; isActive: boolean } };
};

const VARIANT_FACTS = {
  id: true, productId: true, storeId: true, priceIqd: true, stockQuantity: true, isActive: true,
  product: { select: { isActive: true, deletedAt: true, maxPerOrder: true, isPreorder: true, name: true, store: { select: { marketStatus: true, isActive: true } } } },
} as const;

/** Stock that is not already spoken for by an open order. */
async function availableOf(client: Prisma.TransactionClient | typeof prisma, variantId: string, stockQuantity: number) {
  const reserved = await client.inventoryReservation.aggregate({ where: { variantId, status: "active" }, _sum: { quantity: true } });
  return Math.max(0, stockQuantity - (reserved._sum.quantity ?? 0));
}

function assertSellable(variant: VariantFacts | null): asserts variant is VariantFacts {
  if (!variant || !variant.isActive || !variant.product.isActive || variant.product.deletedAt || variant.product.store.marketStatus !== "listed" || !variant.product.store.isActive) {
    throw new HttpError(404, "PRODUCT_NOT_FOUND", "هذا المنتج غير متوفّر حالياً.");
  }
}

async function addonsTotal(client: Prisma.TransactionClient | typeof prisma, productId: string, addonIds: string[]) {
  if (!addonIds.length) return 0;
  const rows = await client.productAddon.findMany({ where: { id: { in: addonIds }, productId, isActive: true }, select: { priceIqd: true } });
  if (rows.length !== addonIds.length) throw new HttpError(422, "ADDON_UNAVAILABLE", "إحدى الإضافات المختارة غير متاحة لهذا المنتج.");
  return rows.reduce((sum, row) => sum + row.priceIqd, 0);
}

/** The line would hold `quantity`: within 99, within the product's per-order cap (all its variants together), within stock unless pre-order. */
async function assertQuantity(client: Prisma.TransactionClient | typeof prisma, cartId: string, variant: VariantFacts, quantity: number, exceptLineId: string | null) {
  if (quantity > MAX_LINE_QUANTITY) throw new HttpError(422, "INVALID_CART_QUANTITY", `الحدّ الأقصى ${MAX_LINE_QUANTITY} قطعة في السطر الواحد.`);
  if (variant.product.maxPerOrder) {
    const others = await client.marketCartItem.aggregate({ where: { cartId, productId: variant.productId, ...(exceptLineId ? { id: { not: exceptLineId } } : {}) }, _sum: { quantity: true } });
    if ((others._sum.quantity ?? 0) + quantity > variant.product.maxPerOrder) {
      throw new HttpError(422, "ORDER_LIMIT_EXCEEDED", `الحدّ الأقصى لهذا المنتج ${variant.product.maxPerOrder} لكل طلب.`, { maxPerOrder: variant.product.maxPerOrder });
    }
  }
  if (!variant.product.isPreorder) {
    const available = await availableOf(client, variant.id, variant.stockQuantity);
    if (available < quantity) throw new HttpError(422, "INSUFFICIENT_AVAILABLE_STOCK", available ? `المتوفّر من هذا الخيار ${available} فقط.` : "نفد هذا الخيار.", { available });
  }
}

export async function addCartLine(shopperId: string, input: { productId?: string; variantId?: string; quantity: number; addonIds: string[] }) {
  return prisma.$transaction(async (tx) => {
    const cart = await cartFor(shopperId, tx);
    const variant = input.variantId
      ? await tx.productVariant.findFirst({ where: { id: input.variantId, deletedAt: null, ...(input.productId ? { productId: input.productId } : {}) }, select: VARIANT_FACTS })
      : await tx.productVariant.findFirst({ where: { productId: input.productId, isDefault: true, deletedAt: null }, select: VARIANT_FACTS });
    assertSellable(variant);
    const addons = await addonsTotal(tx, variant.productId, input.addonIds);
    const existing = await tx.marketCartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } } });
    if (!existing && (await tx.marketCartItem.count({ where: { cartId: cart.id } })) >= MAX_LINES) throw new HttpError(422, "CART_FULL", "السلة ممتلئة.");
    const quantity = (existing?.quantity ?? 0) + input.quantity;
    await assertQuantity(tx, cart.id, variant, quantity, existing?.id ?? null);
    // Adding again re-prices the line at what the shopper sees right now (the store cart's rule, 19-د).
    // Marketplace M8a: the LIVE price — an hourly deal's while it runs.
    const data = { quantity, addonIds: input.addonIds, priceSnapshotIqd: await livePriceOf(tx, variant.id, variant.priceIqd), addonsSnapshotIqd: addons };
    if (existing) await tx.marketCartItem.update({ where: { id: existing.id }, data });
    else await tx.marketCartItem.create({ data: { ...data, cartId: cart.id, storeId: variant.storeId, productId: variant.productId, variantId: variant.id } });
    await tx.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).then(() => marketCartView(shopperId));
}

export async function updateCartLine(shopperId: string, lineId: string, input: { quantity?: number; variantId?: string; addonIds?: string[] }) {
  return prisma.$transaction(async (tx) => {
    const cart = await cartFor(shopperId, tx);
    const line = await tx.marketCartItem.findFirst({ where: { id: lineId, cartId: cart.id } });
    if (!line) throw new HttpError(404, "CART_LINE_NOT_FOUND", "هذا المنتج لم يعد في سلتك.");
    const variantId = input.variantId ?? line.variantId;
    if (variantId !== line.variantId && (await tx.marketCartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } }))) {
      throw new HttpError(409, "CART_LINE_EXISTS", "هذا الاختيار موجود في سلتك بالفعل.");
    }
    const variant = await tx.productVariant.findFirst({ where: { id: variantId, productId: line.productId, deletedAt: null }, select: VARIANT_FACTS });
    assertSellable(variant);
    const addonIds = input.addonIds ?? line.addonIds;
    const quantity = input.quantity ?? line.quantity;
    await assertQuantity(tx, cart.id, variant, quantity, line.id);
    const changedChoice = variantId !== line.variantId || input.addonIds !== undefined;
    // Re-price when the shopper raises the quantity or changes what he is buying; a decrease keeps his price.
    const reprice = changedChoice || quantity > line.quantity;
    await tx.marketCartItem.update({
      where: { id: line.id },
      data: { quantity, variantId, addonIds, ...(reprice ? { priceSnapshotIqd: await livePriceOf(tx, variant.id, variant.priceIqd), addonsSnapshotIqd: await addonsTotal(tx, line.productId, addonIds) } : {}) },
    });
    await tx.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).then(() => marketCartView(shopperId));
}

export async function removeCartLine(shopperId: string, lineId: string) {
  const cart = await cartFor(shopperId);
  const removed = await prisma.marketCartItem.deleteMany({ where: { id: lineId, cartId: cart.id } });
  if (removed.count === 0) throw new HttpError(404, "CART_LINE_NOT_FOUND", "هذا المنتج لم يعد في سلتك.");
  await prisma.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
  return marketCartView(shopperId);
}

export async function clearCart(shopperId: string) {
  const cart = await cartFor(shopperId);
  await prisma.marketCartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
  return marketCartView(shopperId);
}

const logoUrl = (slug: string, key: string | null) => (key ? `/api/store/${encodeURIComponent(slug)}/logo?v=${encodeURIComponent(key.split("/").pop()?.split(".")[0] ?? "0")}` : null);

/**
 * The cart as the shopper sees it: by store, each line with what it costs now,
 * whether it can still be bought, and why not. Bounded: a hundred lines.
 */
export async function marketCartView(shopperId: string, onlyStoreId?: string) {
  const cart = await cartFor(shopperId);
  const lines = await prisma.marketCartItem.findMany({
    where: { cartId: cart.id, ...(onlyStoreId ? { storeId: onlyStoreId } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_LINES,
    include: {
      variant: {
        select: {
          id: true, name: true, isDefault: true, priceIqd: true, stockQuantity: true, isActive: true, deletedAt: true,
          product: {
            select: {
              id: true, name: true, isActive: true, deletedAt: true, maxPerOrder: true, isPreorder: true,
              images: { select: { id: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 1 },
              addons: { where: { isActive: true }, select: { id: true, name: true, priceIqd: true } },
              store: { select: { id: true, slug: true, name: true, logoObjectKey: true, marketStatus: true, isActive: true, pickupEnabled: true } },
            },
          },
        },
      },
    },
  });
  const reserved = lines.length
    ? await prisma.inventoryReservation.groupBy({ by: ["variantId"], where: { variantId: { in: lines.map((line) => line.variantId) }, status: "active" }, _sum: { quantity: true } })
    : [];
  const reservedBy = new Map(reserved.map((row) => [row.variantId, row._sum.quantity ?? 0]));
  const livePriceBy = await livePrices(prisma, lines.map((line) => line.variantId));
  const groups = new Map<string, { store: { slug: string; name: string; logoUrl: string | null; pickupEnabled: boolean }; lines: unknown[]; subtotalIqd: number; ready: boolean }>();
  for (const line of lines) {
    const product = line.variant.product;
    const store = product.store;
    const live = line.variant.isActive && !line.variant.deletedAt && product.isActive && !product.deletedAt && store.marketStatus === "listed" && store.isActive;
    const addonById = new Map(product.addons.map((addon) => [addon.id, addon]));
    const addons = line.addonIds.map((id) => addonById.get(id)).filter((addon): addon is { id: string; name: string; priceIqd: number } => Boolean(addon));
    const liveAddons = addons.reduce((sum, addon) => sum + addon.priceIqd, 0);
    const available = Math.max(0, line.variant.stockQuantity - (reservedBy.get(line.variantId) ?? 0));
    const livePrice = livePriceBy.get(line.variantId) ?? line.variant.priceIqd;
    const problem = !live ? "unavailable"
      : addons.length !== line.addonIds.length ? "addon_unavailable"
      : !product.isPreorder && available < line.quantity ? (available === 0 ? "out_of_stock" : "insufficient_stock")
      : livePrice !== line.priceSnapshotIqd || liveAddons !== line.addonsSnapshotIqd ? "price_changed"
      : null;
    const unitPriceIqd = line.priceSnapshotIqd + line.addonsSnapshotIqd;
    const group = groups.get(store.id) ?? { store: { slug: store.slug, name: store.name, logoUrl: logoUrl(store.slug, store.logoObjectKey), pickupEnabled: store.pickupEnabled }, lines: [], subtotalIqd: 0, ready: true };
    group.lines.push({
      id: line.id,
      product: { id: product.id, name: product.name, imageUrl: product.images[0] ? `/api/store/${encodeURIComponent(store.slug)}/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(product.images[0].id)}` : null, isPreorder: product.isPreorder, maxPerOrder: product.maxPerOrder },
      variant: { id: line.variant.id, name: line.variant.isDefault ? null : line.variant.name },
      addons,
      quantity: line.quantity,
      unitPriceIqd,
      livePriceIqd: livePrice + liveAddons,
      // Marketplace M8a: the list price while an hourly deal lowers it, for the struck-through price.
      listPriceIqd: livePrice < line.variant.priceIqd ? line.variant.priceIqd + liveAddons : null,
      lineTotalIqd: unitPriceIqd * line.quantity,
      available: product.isPreorder ? null : available,
      problem,
    });
    if (problem === null) group.subtotalIqd += unitPriceIqd * line.quantity;
    else group.ready = false;
    groups.set(store.id, group);
  }
  return {
    version: cart.version,
    count: lines.reduce((sum, line) => sum + line.quantity, 0),
    stores: Array.from(groups.values()),
  };
}

/** After a checkout refused a moved price: the market lines take the live prices too, so the next tap succeeds. */
export async function repriceMarketLines(shopperId: string, storeId: string) {
  const cart = await cartFor(shopperId);
  const lines = await prisma.marketCartItem.findMany({ where: { cartId: cart.id, storeId }, include: { variant: { select: { priceIqd: true } } } });
  const livePriceBy = await livePrices(prisma, lines.map((line) => line.variantId));
  for (const line of lines) {
    const addons = line.addonIds.length ? await prisma.productAddon.findMany({ where: { id: { in: line.addonIds }, isActive: true }, select: { priceIqd: true } }) : [];
    await prisma.marketCartItem.update({ where: { id: line.id }, data: { priceSnapshotIqd: livePriceBy.get(line.variantId) ?? line.variant.priceIqd, addonsSnapshotIqd: addons.reduce((sum, row) => sum + row.priceIqd, 0) } });
  }
  await prisma.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
}

/** A line the shopper confirmed at the new price: the snapshot moves to the live price. */
export async function acceptCartPrices(shopperId: string) {
  const cart = await cartFor(shopperId);
  const storeIds = await prisma.marketCartItem.findMany({ where: { cartId: cart.id }, distinct: ["storeId"], select: { storeId: true } });
  for (const { storeId } of storeIds) await repriceMarketLines(shopperId, storeId);
  return marketCartView(shopperId);
}

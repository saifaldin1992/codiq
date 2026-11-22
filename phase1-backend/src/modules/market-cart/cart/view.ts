/**
 * The market cart — view. Split verbatim from cart.service.ts (review batch 2, ت-١٥);
 * cart.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";
import { livePrices } from "../../../services/live-price.js";
import { cartFor, MAX_LINES } from "./rules.js";

const logoUrl = (slug: string, key: string | null) =>
  key
    ? `/api/store/${encodeURIComponent(slug)}/logo?v=${encodeURIComponent(key.split("/").pop()?.split(".")[0] ?? "0")}`
    : null;

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
          id: true,
          name: true,
          isDefault: true,
          priceIqd: true,
          stockQuantity: true,
          isActive: true,
          deletedAt: true,
          product: {
            select: {
              id: true,
              name: true,
              isActive: true,
              deletedAt: true,
              maxPerOrder: true,
              isPreorder: true,
              images: {
                select: { id: true },
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                take: 1,
              },
              addons: {
                where: { isActive: true },
                select: { id: true, name: true, priceIqd: true },
              },
              store: {
                select: {
                  id: true,
                  slug: true,
                  name: true,
                  logoObjectKey: true,
                  marketStatus: true,
                  isActive: true,
                  pickupEnabled: true,
                },
              },
            },
          },
        },
      },
    },
  });
  const reserved = lines.length
    ? await prisma.inventoryReservation.groupBy({
        by: ["variantId"],
        where: { variantId: { in: lines.map((line) => line.variantId) }, status: "active" },
        _sum: { quantity: true },
      })
    : [];
  const reservedBy = new Map(reserved.map((row) => [row.variantId, row._sum.quantity ?? 0]));
  const livePriceBy = await livePrices(
    prisma,
    lines.map((line) => line.variantId)
  );
  const groups = new Map<
    string,
    {
      store: { slug: string; name: string; logoUrl: string | null; pickupEnabled: boolean };
      lines: unknown[];
      subtotalIqd: number;
      ready: boolean;
    }
  >();
  for (const line of lines) {
    const product = line.variant.product;
    const store = product.store;
    const live =
      line.variant.isActive &&
      !line.variant.deletedAt &&
      product.isActive &&
      !product.deletedAt &&
      store.marketStatus === "listed" &&
      store.isActive;
    const addonById = new Map(product.addons.map((addon) => [addon.id, addon]));
    const addons = line.addonIds
      .map((id) => addonById.get(id))
      .filter((addon): addon is { id: string; name: string; priceIqd: number } => Boolean(addon));
    const liveAddons = addons.reduce((sum, addon) => sum + addon.priceIqd, 0);
    const available = Math.max(
      0,
      line.variant.stockQuantity - (reservedBy.get(line.variantId) ?? 0)
    );
    const livePrice = livePriceBy.get(line.variantId) ?? line.variant.priceIqd;
    const problem = !live
      ? "unavailable"
      : addons.length !== line.addonIds.length
        ? "addon_unavailable"
        : !product.isPreorder && available < line.quantity
          ? available === 0
            ? "out_of_stock"
            : "insufficient_stock"
          : livePrice !== line.priceSnapshotIqd || liveAddons !== line.addonsSnapshotIqd
            ? "price_changed"
            : null;
    const unitPriceIqd = line.priceSnapshotIqd + line.addonsSnapshotIqd;
    const group = groups.get(store.id) ?? {
      store: {
        slug: store.slug,
        name: store.name,
        logoUrl: logoUrl(store.slug, store.logoObjectKey),
        pickupEnabled: store.pickupEnabled,
      },
      lines: [],
      subtotalIqd: 0,
      ready: true,
    };
    group.lines.push({
      id: line.id,
      product: {
        id: product.id,
        name: product.name,
        imageUrl: product.images[0]
          ? `/api/store/${encodeURIComponent(store.slug)}/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(product.images[0].id)}`
          : null,
        isPreorder: product.isPreorder,
        maxPerOrder: product.maxPerOrder,
      },
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
  const lines = await prisma.marketCartItem.findMany({
    where: { cartId: cart.id, storeId },
    include: { variant: { select: { priceIqd: true } } },
  });
  const livePriceBy = await livePrices(
    prisma,
    lines.map((line) => line.variantId)
  );
  for (const line of lines) {
    const addons = line.addonIds.length
      ? await prisma.productAddon.findMany({
          where: { id: { in: line.addonIds }, isActive: true },
          select: { priceIqd: true },
        })
      : [];
    await prisma.marketCartItem.update({
      where: { id: line.id },
      data: {
        priceSnapshotIqd: livePriceBy.get(line.variantId) ?? line.variant.priceIqd,
        addonsSnapshotIqd: addons.reduce((sum, row) => sum + row.priceIqd, 0),
      },
    });
  }
  await prisma.marketCart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } });
}

/** A line the shopper confirmed at the new price: the snapshot moves to the live price. */
export async function acceptCartPrices(shopperId: string) {
  const cart = await cartFor(shopperId);
  const storeIds = await prisma.marketCartItem.findMany({
    where: { cartId: cart.id },
    distinct: ["storeId"],
    select: { storeId: true },
  });
  for (const { storeId } of storeIds) await repriceMarketLines(shopperId, storeId);
  return marketCartView(shopperId);
}

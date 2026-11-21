/**
 * The merchant's side of the market catalog: mapping his categories onto the
 * market's tree, and each product's market details (price before discount,
 * condition, tags, specifications, pre-order, per-order cap) and add-ons.
 * Everything is scoped by storeId first — a product or category of another
 * store answers 404, the same as one that does not exist.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { marketCategoryExists, marketCategoryTree } from "./categories.service.js";
import type { ProductMarketFieldsInput } from "./schema.js";

export async function storeCategoryMappings(storeId: string) {
  // Bounded: a store's own categories (three levels, a few dozen at most) beside the market tree.
  const categories = await prisma.productCategory.findMany({
    where: { storeId, deletedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, parentCategoryId: true, marketCategoryId: true },
  });
  return { categories, marketCategories: (await marketCategoryTree()).categories };
}

async function assertMarketCategory(id: number | null) {
  if (id !== null && !(await marketCategoryExists(id))) throw new HttpError(422, "UNKNOWN_MARKET_CATEGORY", "فئة السوق غير موجودة.");
}

export async function mapStoreCategory(storeId: string, categoryId: string, marketCategoryId: number | null) {
  await assertMarketCategory(marketCategoryId);
  const moved = await prisma.productCategory.updateMany({ where: { id: categoryId, storeId, deletedAt: null }, data: { marketCategoryId } });
  if (moved.count === 0) throw new HttpError(404, "CATEGORY_NOT_FOUND", "التصنيف غير موجود في هذا المتجر.");
  return { categoryId, marketCategoryId };
}

const FIELDS_SELECT = {
  id: true, name: true, priceIqd: true, isActive: true, createdAt: true,
  marketCategoryId: true, compareAtPriceIqd: true, condition: true, tags: true, specs: true,
  isPreorder: true, preorderReleaseOn: true, preorderShipsBy: true, maxPerOrder: true,
  category: { select: { name: true, marketCategoryId: true } },
  addons: { select: { id: true, name: true, priceIqd: true, isActive: true }, orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
} satisfies Prisma.ProductSelect;

type FieldsRow = Prisma.ProductGetPayload<{ select: typeof FIELDS_SELECT }>;
const dateOnly = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

function fieldsView(row: FieldsRow) {
  return {
    id: row.id,
    name: row.name,
    priceIqd: row.priceIqd,
    isActive: row.isActive,
    storeCategory: row.category?.name ?? null,
    // What the market will file it under: its own choice, else its store category's mapping.
    effectiveMarketCategoryId: row.marketCategoryId ?? row.category?.marketCategoryId ?? null,
    marketCategoryId: row.marketCategoryId,
    compareAtPriceIqd: row.compareAtPriceIqd,
    condition: row.condition,
    tags: row.tags,
    specs: Array.isArray(row.specs) ? row.specs : [],
    isPreorder: row.isPreorder,
    preorderReleaseOn: dateOnly(row.preorderReleaseOn),
    preorderShipsBy: dateOnly(row.preorderShipsBy),
    maxPerOrder: row.maxPerOrder,
    addons: row.addons,
  };
}

const LIMIT_MAX = 100;
export async function marketProductFieldsPage(storeId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, LIMIT_MAX, 25);
  const cursor = decodeListCursor("merchant-market-products", rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.product.findMany({
    where: { storeId, deletedAt: null, ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: FIELDS_SELECT,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor("merchant-market-products", last.createdAt, last.id));
  return { products: page.map(fieldsView), nextCursor };
}

async function loadOwn(storeId: string, productId: string) {
  const row = await prisma.product.findFirst({ where: { id: productId, storeId, deletedAt: null }, select: FIELDS_SELECT });
  if (!row) throw new HttpError(404, "PRODUCT_NOT_FOUND", "المنتج غير موجود في هذا المتجر.");
  return row;
}

export async function updateProductMarketFields(storeId: string, productId: string, input: ProductMarketFieldsInput) {
  const current = await loadOwn(storeId, productId);
  await assertMarketCategory(input.marketCategoryId);
  if (input.compareAtPriceIqd !== null && input.compareAtPriceIqd <= current.priceIqd) {
    throw new HttpError(422, "COMPARE_AT_NOT_ABOVE_PRICE", `السعر قبل الخصم يجب أن يكون أعلى من سعر المنتج (${current.priceIqd.toLocaleString("en-US")} د.ع).`);
  }
  const updated = await prisma.product.update({
    where: { id: current.id },
    data: {
      marketCategoryId: input.marketCategoryId,
      compareAtPriceIqd: input.compareAtPriceIqd,
      condition: input.condition,
      tags: input.tags,
      specs: input.specs,
      isPreorder: input.isPreorder,
      preorderReleaseOn: input.preorderReleaseOn ? new Date(`${input.preorderReleaseOn}T00:00:00Z`) : null,
      preorderShipsBy: input.preorderShipsBy ? new Date(`${input.preorderShipsBy}T00:00:00Z`) : null,
      maxPerOrder: input.maxPerOrder,
    },
    select: FIELDS_SELECT,
  });
  return { product: fieldsView(updated) };
}

/** Replaces the whole add-on list at once: a short list edited on one screen, in its own order. */
export async function replaceProductAddons(storeId: string, productId: string, addons: { name: string; priceIqd: number; isActive: boolean }[]) {
  const current = await loadOwn(storeId, productId);
  await prisma.$transaction([
    prisma.productAddon.deleteMany({ where: { storeId, productId: current.id } }),
    prisma.productAddon.createMany({ data: addons.map((addon, index) => ({ storeId, productId: current.id, name: addon.name, priceIqd: addon.priceIqd, isActive: addon.isActive, sortOrder: index })) }),
  ]);
  return { product: fieldsView(await loadOwn(storeId, productId)) };
}

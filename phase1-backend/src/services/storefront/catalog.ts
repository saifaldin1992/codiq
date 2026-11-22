/**
 * Storefront — catalog. Split verbatim from storefront.service.ts (review batch 2, ت-٣);
 * storefront.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../../auth/auth.errors.js";
// 19-د: UUID_PATTERN moved out of this file so every keyset list validates its
// cursor the same way — see services/keyset-cursor.ts. 20-2 replaced the cursor
// helpers themselves with the one dialect in services/list-page.ts.
import { UUID_PATTERN } from "../keyset-cursor.js";
import { prisma } from "../../db/prisma.js";
import {
  parseListLimit,
  readListCursor,
  keysetWhere,
  pageOf,
  encodeListCursor,
  type ListCursor,
} from "../list-page.js";
import { livePrices } from "../live-price.js";
import { searchEngine } from "../search/index.js";
import { isAvailable } from "./shared.js";

/**
 * PG-6 / owner decision 6: the public storefront search gets the SAME
 * two-character floor the merchant palette has had since MD-1, and the same
 * Arabic sentence (ق-96 — masculine address).
 *
 * It had a ceiling and no floor, on an UNAUTHENTICATED endpoint: a single
 * character carries no full trigram, so the index cannot serve it and the query
 * degrades to a scan of the store. That is the exact reason the palette's floor
 * exists; the shopper-facing surface had simply never been given one.
 */
function optionalProductQuery(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > 120)
    throw new HttpError(400, "INVALID_PRODUCT_FILTER", "Search query is invalid.");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < 2)
    throw new HttpError(422, "INVALID_SEARCH_QUERY", "أدخل حرفين على الأقل للبحث.");
  return trimmed;
}

function optionalCategoryId(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !UUID_PATTERN.test(value))
    throw new HttpError(400, "INVALID_PRODUCT_FILTER", "Category filter is invalid.");
  return value;
}

// 19-د: the shape rule this function WAS is now the shared one every list uses;
// the public product cursor keeps its own error code because the storefront
// client already distinguishes it from a bad page cursor.
/** The cursor's list kinds. One per list, so a cursor cannot cross lists. */
const PUBLIC_PRODUCTS_KIND = "storefront.products";

const PUBLIC_SEARCH_KIND = "storefront.products.search";

/**
 * How many ranked matches a storefront `q` may reach in total.
 *
 * Before 20-2 a search answered with ONE page and `nextCursor: null`, so a shop
 * with 300 shirts showed a shopper searching «قميص» the first 24 and told him
 * that was all of them. The engine's ranking is total and stable (its `id DESC`
 * tiebreaker makes it so, asserted by pg6 §8), so the ranked list can be
 * re-derived identically on every request and paged by POSITION — which is what
 * keeps relevance order, the one thing a shopper's search must not lose.
 */
const STOREFRONT_SEARCH_CAP = 200;

// ق-200: the front page's rails. Each is an ORDERING of the public list: ids are
// ranked here, then re-read through the same projection as every other card.
// Own cursor kinds, so a cursor from one rail can never page another.
const PUBLIC_BEST_SELLING_KIND = "storefront.products.best_selling";

const PUBLIC_TOP_RATED_KIND = "storefront.products.top_rated";

/** Nobody scrolls past four dozen of «the best» — and a rail is a handful anyway. */
const PUBLIC_RAIL_CAP = 48;

type PublicProductSort = "newest" | "best_selling" | "top_rated";

function optionalProductSort(raw: unknown): PublicProductSort {
  if (raw === undefined || raw === null || raw === "" || raw === "newest") return "newest";
  if (raw === "best_selling" || raw === "top_rated") return raw;
  throw new HttpError(
    422,
    "INVALID_PRODUCT_SORT",
    "sort must be newest, best_selling or top_rated."
  );
}

function categorySql(categoryIds: readonly string[] | undefined) {
  return categoryIds
    ? Prisma.sql`AND p.category_id IN (${Prisma.join(categoryIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
}

/**
 * Units sold per product, all time, platform-carried orders only — the same
 * two exclusions `analytics.service` applies: a cancelled or rejected order is
 * not a sale, and a counter sale (POS) never had a storefront.
 */
async function bestSellingIds(
  storeId: string,
  categoryIds: readonly string[] | undefined,
  cap: number
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string }>>(Prisma.sql`
    SELECT oi.product_id
      FROM order_items oi
      JOIN store_orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id AND p.store_id = o.store_id
     WHERE o.store_id = ${storeId}::uuid
       AND o.status NOT IN ('cancelled', 'rejected')
       AND o.source <> 'pos'
       AND oi.product_id IS NOT NULL
       AND p.is_active = true AND p.deleted_at IS NULL
       ${categorySql(categoryIds)}
     GROUP BY oi.product_id
     ORDER BY SUM(oi.quantity) DESC, MAX(p.name) ASC
     LIMIT ${cap}`);
  return rows.map((row) => row.product_id);
}

/**
 * Average rating per product (D-98): a withdrawn review does not count; a
 * hidden review's TEXT is hidden but its rating still counts, exactly as the
 * product page's own summary counts it. Ties break on how many rated it.
 */
async function topRatedIds(
  storeId: string,
  categoryIds: readonly string[] | undefined,
  cap: number
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string }>>(Prisma.sql`
    SELECT r.product_id
      FROM product_reviews r
      JOIN products p ON p.id = r.product_id AND p.store_id = r.store_id
     WHERE r.store_id = ${storeId}::uuid
       AND r.withdrawn_at IS NULL
       AND p.is_active = true AND p.deleted_at IS NULL
       ${categorySql(categoryIds)}
     GROUP BY r.product_id
     ORDER BY AVG(r.rating) DESC, COUNT(*) DESC, MAX(p.name) ASC
     LIMIT ${cap}`);
  return rows.map((row) => row.product_id);
}

export async function publicCategories(storeId: string) {
  // Nested category tree (2026-08-26): a category is public when it or any of
  // its descendants (max depth 3) carries an active product, so parents of
  // browsable subcategories stay visible even without direct products. Flat
  // categories keep the exact pre-hierarchy behavior.
  const withActiveProducts = { products: { some: { isActive: true } } } as const;
  return prisma.productCategory.findMany({
    where: {
      storeId,
      OR: [
        withActiveProducts,
        { children: { some: withActiveProducts } },
        { children: { some: { children: { some: withActiveProducts } } } },
      ],
    },
    select: { id: true, name: true, parentCategoryId: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Nested category tree (2026-08-26): a category filter includes the products of
 * every descendant category. Resolved iteratively level by level — store-scoped
 * at each hop and cheap because the service caps the tree at 3 levels.
 */
export async function categoryFilterIds(storeId: string, categoryId: string) {
  const ids = [categoryId];
  const seen = new Set(ids);
  let frontier = ids;
  while (frontier.length) {
    const children = await prisma.productCategory.findMany({
      where: { storeId, parentCategoryId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
    for (const id of frontier) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export async function publicProducts(
  storeId: string,
  rawLimit: unknown,
  rawCursor: unknown,
  rawCategoryId?: unknown,
  rawQuery?: unknown,
  rawSort?: unknown
) {
  const limit = parseListLimit(rawLimit, 100, 24);
  const categoryId = optionalCategoryId(rawCategoryId);
  const query = optionalProductQuery(rawQuery);
  // ق-200: the front page's rails are ORDERINGS of this one list, not lists of
  // their own — «الأكثر مبيعاً» and «الأعلى تقييماً» rank ids first and then
  // re-read them through the projection below, so a card is byte-identical
  // whichever rail it sits on. A search still answers in relevance order.
  const sort = optionalProductSort(rawSort);
  const categoryIds = categoryId ? await categoryFilterIds(storeId, categoryId) : undefined;
  const rankedKind = query
    ? PUBLIC_SEARCH_KIND
    : sort === "best_selling"
      ? PUBLIC_BEST_SELLING_KIND
      : sort === "top_rated"
        ? PUBLIC_TOP_RATED_KIND
        : null;
  // Two lists share this route and they are NOT interchangeable: an unfiltered
  // catalog paged by `(createdAt, id)`, and a ranked search paged by position
  // in the ranking. Each has its own kind, so a cursor cannot be carried from
  // one into the other — which would silently return the wrong page.
  const cursor = rankedKind
    ? await readListCursor(rankedKind, rawCursor)
    : await readListCursor(PUBLIC_PRODUCTS_KIND, rawCursor, {
        legacy: async (id) => {
          const row = await prisma.product.findFirst({
            where: { id, storeId, isActive: true },
            select: { createdAt: true },
          });
          return row ? { value: row.createdAt } : null;
        },
      });
  // PG-6 (ق-74): the `name OR description` filter is split into two
  // single-column engine statements — the planner refuses a BitmapOr across two
  // columns and falls straight back to a sequential scan (39.4 ms vs 1.0 ms on
  // 8,013 products, migration 20260827190000 lines 33-40) — and NAME OUTRANKS
  // DESCRIPTION: a shopper who types a product's name must get that product
  // first, not a different one that happens to mention the word in its blurb.
  // The search takes the WHOLE ranked list up to the cap, then serves the slice
  // this cursor asks for. Recomputing it per page is one indexed statement pair
  // and is what lets the answer stay in relevance order across pages.
  const rankedIds = query
    ? await storefrontSearchIds(storeId, query, STOREFRONT_SEARCH_CAP)
    : sort === "best_selling"
      ? await bestSellingIds(storeId, categoryIds, PUBLIC_RAIL_CAP)
      : sort === "top_rated"
        ? await topRatedIds(storeId, categoryIds, PUBLIC_RAIL_CAP)
        : undefined;
  const offset = rankedIds ? searchOffset(cursor) : 0;
  const searchIds = rankedIds?.slice(offset, offset + limit + 1);
  const where: Prisma.ProductWhereInput = {
    storeId,
    isActive: true,
    ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    ...(searchIds ? { id: { in: searchIds } } : {}),
    ...(searchIds ? {} : keysetWhere("createdAt", "desc", cursor)),
  };
  const rows = await prisma.product.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      category: { select: { id: true, name: true, parentCategoryId: true } },
      images: { select: { id: true, sortOrder: true }, orderBy: { sortOrder: "asc" }, take: 1 },
      variants: {
        where: { isActive: true },
        select: { id: true, priceIqd: true, stockQuantity: true },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  // A search answers in RELEVANCE order; the unfiltered catalog keeps its
  // `(createdAt, id)` keyset scroll byte for byte. One envelope either way.
  const ordered = searchIds ? orderProductsBySearch(searchIds, rows) : rows;
  const cut = pageOf(ordered, limit, (last) =>
    searchIds
      ? encodeListCursor(rankedKind ?? PUBLIC_SEARCH_KIND, offset + limit, last.id)
      : encodeListCursor(PUBLIC_PRODUCTS_KIND, last.createdAt, last.id)
  );
  const page = cut.page;
  // Phase 20A: availability is variant-level — a product is available when ANY
  // active variant still has unreserved stock; prices surface as a min–max range.
  const variantIds = page.flatMap((product) => product.variants.map((variant) => variant.id));
  const reservations = variantIds.length
    ? await prisma.inventoryReservation.groupBy({
        by: ["variantId"],
        where: { storeId, variantId: { in: variantIds }, status: "active" },
        _sum: { quantity: true },
      })
    : [];
  const reservedByVariant = new Map(
    reservations.map((reservation) => [reservation.variantId, reservation._sum.quantity ?? 0])
  );
  // Marketplace M8a: the range is of LIVE prices — an hourly deal shows where it runs.
  const livePriceByVariant = await livePrices(prisma, variantIds);
  return {
    products: page.map((product) => {
      const prices = product.variants.map(
        (variant) => livePriceByVariant.get(variant.id) ?? variant.priceIqd
      );
      return {
        id: product.id,
        name: product.name,
        sku: product.sku,
        description: product.description,
        priceIqd: product.priceIqd,
        minPriceIqd: prices.length ? Math.min(...prices) : product.priceIqd,
        maxPriceIqd: prices.length ? Math.max(...prices) : product.priceIqd,
        category: product.category,
        image: product.images[0] ?? null,
        // ق-200: the «جديد» badge is a client-side age threshold over this —
        // a stored flag goes stale and nobody clears it.
        createdAt: product.createdAt,
        requiresPrescription: product.requiresPrescription,
        isAvailable: product.variants.some((variant) =>
          isAvailable(variant.stockQuantity, reservedByVariant.get(variant.id))
        ),
        // Audit 12-أ: a card's quick «add» puts the DEFAULT variant in the cart.
        // With options to choose, «available» may mean another size is in stock,
        // so the card must send the shopper to choose instead of choosing for him.
        hasOptions: product.variants.length > 1,
      };
    }),
    nextCursor: cut.nextCursor,
  };
}

/**
 * Where in the ranking this page starts.
 *
 * The cursor's value is the offset and its id is the last row of the previous
 * page. The offset is bounded by the cap, so a forged cursor cannot become an
 * arbitrary skip — beyond the cap the list simply ends. A product created or
 * deactivated between two pages shifts the ranking by one row; that is the
 * ordinary cost of a live ranked list, it can repeat or drop a single row, and
 * it can never surface a row the filters exclude.
 */
function searchOffset(cursor: ListCursor | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor.value);
  if (!Number.isInteger(offset) || offset < 0 || offset > STOREFRONT_SEARCH_CAP) {
    throw new HttpError(
      400,
      "INVALID_CURSOR",
      "مؤشر الصفحة غير صالح — أعِد فتح القائمة من بدايتها."
    );
  }
  return offset;
}

/**
 * PG-6: the storefront's two search statements, name ranked above description.
 *
 * Merging by rank alone would let a product whose BLURB mentions «قميص» outrank
 * the product actually called «قميص», because an exact substring scores the
 * same in either column. So the two lists are concatenated rather than merged:
 * every name hit, in engine order, then the description-only hits behind them.
 */
async function storefrontSearchIds(
  storeId: string,
  needle: string,
  limit: number
): Promise<string[]> {
  const [byName, byDescription] = await Promise.all([
    searchEngine.search("products.name", { storeId, needle, limit }),
    searchEngine.search("products.description", { storeId, needle, limit }),
  ]);
  const ids = byName.hits.map((hit) => hit.id);
  const seen = new Set(ids);
  for (const hit of byDescription.hits)
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      ids.push(hit.id);
    }
  return ids.slice(0, limit);
}

/** Restores the engine's ranking after Prisma's `id IN (…)` returned the rows in its own order. */
function orderProductsBySearch<T extends { id: string }>(
  ids: readonly string[],
  rows: readonly T[]
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  // A hit with no row is normal, not an error: `isActive: true` and the category
  // filter legitimately drop rows the engine returned.
  for (const id of ids) {
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}

export async function publicProduct(storeId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, storeId, isActive: true },
    include: {
      category: { select: { id: true, name: true, parentCategoryId: true } },
      images: {
        select: { id: true, contentType: true, byteSize: true, sortOrder: true },
        orderBy: { sortOrder: "asc" },
      },
      variants: {
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!product)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "The requested product was not found in this store."
    );
  // Phase 20A: each variant reports its own availability without exposing raw
  // stock quantities to the public storefront.
  const reservations = product.variants.length
    ? await prisma.inventoryReservation.groupBy({
        by: ["variantId"],
        where: {
          storeId,
          variantId: { in: product.variants.map((variant) => variant.id) },
          status: "active",
        },
        _sum: { quantity: true },
      })
    : [];
  const reservedByVariant = new Map(
    reservations.map((reservation) => [reservation.variantId, reservation._sum.quantity ?? 0])
  );
  // Marketplace M8a: `priceIqd` is what the variant sells at now; `listPriceIqd` is set only while a deal lowers it.
  const livePriceByVariant = await livePrices(
    prisma,
    product.variants.map((variant) => variant.id)
  );
  const variants = product.variants.map((variant) => ({
    id: variant.id,
    name: variant.name,
    sku: variant.sku,
    priceIqd: livePriceByVariant.get(variant.id) ?? variant.priceIqd,
    listPriceIqd:
      (livePriceByVariant.get(variant.id) ?? variant.priceIqd) < variant.priceIqd
        ? variant.priceIqd
        : null,
    options: variant.options,
    position: variant.position,
    isDefault: variant.isDefault,
    isAvailable: isAvailable(variant.stockQuantity, reservedByVariant.get(variant.id)),
  }));
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    description: product.description,
    priceIqd: product.priceIqd,
    category: product.category,
    images: product.images,
    isActive: product.isActive,
    requiresPrescription: product.requiresPrescription,
    isAvailable: variants.some((variant) => variant.isAvailable),
    variants,
    createdAt: product.createdAt,
    attributes: product.attributes,
  };
}

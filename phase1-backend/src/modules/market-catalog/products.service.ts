/**
 * The market's product list and product page — every listed store at once.
 *
 * ONE STATEMENT per page: the match (from the search engine), the filters, the
 * sort key and the keyset all in one query, so a filter never hides a page
 * boundary. Live facts (price, stock) are read from the variants under the
 * same statement; slow-moving ones (sold, viewed, rated) from
 * product_market_stats, which the hourly job writes.
 *
 * Every sort is a single float8 key ordered DESC with id DESC as tie-break —
 * «cheapest first» is the negated price — so one cursor shape pages them all,
 * and the cursor's kind names the sort (and period) it belongs to.
 */
import { livePrices } from "../../services/live-price.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { marketProductMatch, type MarketProductMatch } from "../../services/search/index.js";
import { toGovernorateKey } from "../../services/governorates.js";
import { baghdadDay, recordVisit } from "../../services/store-traffic.service.js";
import { shrunkRating } from "../market-stores/market-score.js";
import { listedStoreTenant } from "../market-stores/directory.service.js";
import { categoryWithDescendants } from "./categories.service.js";
import { recordSearch } from "./search.service.js";
import type { MarketProductQuery, MarketProductSort } from "./schema.js";

const LIMIT_MAX = 60;
const SOLD_COLUMN: Record<string, Prisma.Sql> = {
  day: Prisma.sql`s.sold_1d`, week: Prisma.sql`s.sold_7d`, month: Prisma.sql`s.sold_30d`, quarter: Prisma.sql`s.sold_90d`,
};

type Row = {
  id: string; name: string; created_at: Date; compare_at_price_iqd: number | null; deal_percent: number | null; deal_ends_at: Date | null; condition: string; tags: string[];
  is_preorder: boolean; preorder_release_on: Date | null; preorder_ships_by: Date | null; max_per_order: number | null;
  store_id: string; store_slug: string; store_name: string; store_verified: boolean;
  min_price: number; max_price: number; in_stock: boolean; low_stock: boolean; variant_count: number; image_id: string | null;
  rating_avg: Prisma.Decimal | null; rating_count: number | null; sold_30d: number | null;
  discount_percent: number; match_rank: number | null; sort_key: number;
};

function sortKey(sort: MarketProductSort, period: string, match: MarketProductMatch | null): Prisma.Sql {
  switch (sort) {
    case "relevance":
      // Exact substring hits above every fuzzy hit, then closeness; without a query it is «recommended».
      return match ? Prisma.sql`(CASE WHEN ${match.exact} THEN 1 ELSE 0 END + ${match.rank})::float8` : sortKey("recommended", period, null);
    case "recommended":
      // Selling and being looked at, a boosted store's products ahead.
      return Prisma.sql`(ln(1 + COALESCE(s.sold_30d, 0)) * 2 + ln(1 + COALESCE(s.views_30d, 0)) + CASE WHEN st.boosted_until > now() THEN 3 ELSE 0 END)::float8`;
    case "newest": return Prisma.sql`extract(epoch FROM p.created_at)::float8`;
    case "price_asc": return Prisma.sql`(-v.min_price)::float8`;
    case "price_desc": return Prisma.sql`v.min_price::float8`;
    case "rating": return Prisma.sql`(CASE WHEN COALESCE(s.rating_count, 0) > 0 THEN (s.rating_avg::float8 * s.rating_count + 20) / (s.rating_count + 5) ELSE 0 END)`;
    case "best_selling": return Prisma.sql`COALESCE(${SOLD_COLUMN[period] ?? SOLD_COLUMN.month}, 0)::float8`;
    case "trending": return Prisma.sql`COALESCE(s.views_7d, 0)::float8`;
    case "discount": return Prisma.sql`(CASE WHEN ${COMPARE} > v.min_price THEN (${COMPARE} - v.min_price)::float8 / ${COMPARE} ELSE 0 END)`;
  }
}

const imageUrl = (storeSlug: string, productId: string, imageId: string | null) =>
  imageId ? `/api/store/${encodeURIComponent(storeSlug)}/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}` : null;

function cardOf(row: Row) {
  const rating = row.rating_avg === null ? null : Number(row.rating_avg);
  const count = row.rating_count ?? 0;
  const shrunk = shrunkRating(rating, count);
  return {
    id: row.id,
    name: row.name,
    store: { slug: row.store_slug, name: row.store_name, verified: row.store_verified },
    imageUrl: imageUrl(row.store_slug, row.id, row.image_id),
    priceIqd: row.min_price,
    maxPriceIqd: row.max_price,
    compareAtPriceIqd: row.compare_at_price_iqd !== null && row.compare_at_price_iqd > row.min_price ? row.compare_at_price_iqd : null,
    // Marketplace M8a: «عرض الساعة» — its percentage and when the price ends.
    deal: row.deal_percent !== null ? { percentOff: row.deal_percent, endsAt: row.deal_ends_at } : null,
    discountPercent: row.discount_percent,
    rating,
    ratingCount: count,
    // «تقييم المنتج من 100»: the shrunk stars on a 100 scale, only once there are reviews.
    productScore: shrunk === null ? null : Math.round(((shrunk - 1) / 4) * 100),
    sold30d: row.sold_30d ?? 0,
    isAvailable: row.in_stock || row.is_preorder,
    sellsFast: row.in_stock && row.low_stock,
    hasOptions: row.variant_count > 1,
    isPreorder: row.is_preorder,
    condition: row.condition,
    tags: row.tags,
    // «مطابقة البحث X%»: only when there was a query.
    matchPercent: row.match_rank === null ? null : Math.round(Math.min(1, Number(row.match_rank)) * 100),
    createdAt: row.created_at,
  };
}
export type MarketProductCard = ReturnType<typeof cardOf>;

const BASE_FROM = Prisma.sql`
  FROM products p
  JOIN stores st ON st.id = p.store_id
  JOIN merchants m_acc ON m_acc.id = st.merchant_id
  LEFT JOIN product_categories pc ON pc.id = p.category_id AND pc.store_id = p.store_id
  LEFT JOIN product_market_stats s ON s.product_id = p.id
  JOIN LATERAL (
    SELECT min(codiq_live_price(pv.product_id, pv.price_iqd, now())) AS min_price,
           max(codiq_live_price(pv.product_id, pv.price_iqd, now())) AS max_price,
           min(pv.price_iqd) AS list_min_price,
           bool_or(pv.stock_quantity > 0) AS in_stock,
           bool_or(pv.stock_quantity > 0 AND pv.stock_quantity <= GREATEST(pv.low_stock_threshold, 3)) AS low_stock,
           count(*)::int AS variant_count
      FROM product_variants pv
     WHERE pv.product_id = p.id AND pv.store_id = p.store_id AND pv.is_active AND pv.deleted_at IS NULL
  ) v ON v.min_price IS NOT NULL
  LEFT JOIN LATERAL (
    -- Marketplace M8a: the hourly deal running on this product now, if any.
    SELECT d.percent_off AS deal_percent, ds.ends_at AS deal_ends_at
      FROM market_deals d
      JOIN market_deal_slots ds ON ds.id = d.slot_id
      JOIN market_campaigns dc ON dc.id = ds.campaign_id
     WHERE d.product_id = p.id AND d.status = 'approved' AND dc.is_published AND ds.starts_at <= now() AND ds.ends_at > now()
     ORDER BY d.percent_off DESC, ds.ends_at ASC
     LIMIT 1
  ) dl ON true
  LEFT JOIN LATERAL (
    SELECT pi.id FROM product_images pi WHERE pi.product_id = p.id AND pi.store_id = p.store_id ORDER BY pi.sort_order, pi.id LIMIT 1
  ) img ON true`;

/** Visible in the market: listed store, active store and merchant, live product. */
const VISIBLE = Prisma.sql`st.market_status = 'listed' AND st.is_active AND m_acc.is_active AND st.status NOT IN ('suspended', 'closed') AND p.is_active AND p.deleted_at IS NULL`;

/** The «before» price: the store's compare-at, or during an hourly deal at least the list price. */
const COMPARE = Prisma.sql`(CASE WHEN dl.deal_percent IS NOT NULL THEN GREATEST(COALESCE(p.compare_at_price_iqd, 0), v.list_min_price) ELSE p.compare_at_price_iqd END)`;
const DISCOUNT = Prisma.sql`(CASE WHEN ${COMPARE} > v.min_price THEN round((${COMPARE} - v.min_price) * 100.0 / ${COMPARE})::int ELSE 0 END)`;

function selectCard(match: MarketProductMatch | null, key: Prisma.Sql) {
  return Prisma.sql`
    SELECT p.id, p.name, p.created_at, ${COMPARE} AS compare_at_price_iqd, dl.deal_percent, dl.deal_ends_at, p.condition, p.tags, p.is_preorder, p.preorder_release_on, p.preorder_ships_by, p.max_per_order,
           st.id AS store_id, st.slug AS store_slug, st.name AS store_name, (st.verified_at IS NOT NULL) AS store_verified,
           v.min_price, v.max_price, COALESCE(v.in_stock, false) AS in_stock, COALESCE(v.low_stock, false) AS low_stock, v.variant_count, img.id AS image_id,
           s.rating_avg, s.rating_count, s.sold_30d,
           ${DISCOUNT} AS discount_percent,
           ${match ? Prisma.sql`${match.rank}::float8` : Prisma.sql`NULL::float8`} AS match_rank,
           ${key} AS sort_key`;
}

export async function listMarketProducts(query: MarketProductQuery) {
  const limit = parseListLimit(query.limit, LIMIT_MAX, 24);
  const match = query.q ? await marketProductMatch(query.q) : null;
  // A query that normalizes away to nothing finds nothing — not «everything».
  if (query.q && !match) return { products: [], nextCursor: null, sort: query.sort ?? "relevance" };
  const sort: MarketProductSort = query.sort ?? (match ? "relevance" : "recommended");
  const kind = `market-products.${sort}${sort === "best_selling" ? `.${query.period}` : ""}`;
  const cursor = decodeListCursor(kind, query.cursor);
  const cursorValue = cursor ? Number(cursor.value) : null;
  if (cursor && !Number.isFinite(cursorValue)) throw new HttpError(400, "INVALID_CURSOR", "مؤشّر الصفحة غير صالح.");

  const key = sortKey(sort, query.period, match);
  const where: Prisma.Sql[] = [VISIBLE];
  if (match) where.push(match.where);
  if (query.category) {
    const { ids } = await categoryWithDescendants(query.category);
    where.push(Prisma.sql`COALESCE(p.market_category_id, pc.market_category_id) = ANY(${ids}::int[])`);
  }
  if (query.store) where.push(Prisma.sql`st.slug = ${query.store}`);
  if (query.deliverTo) {
    const governorate = toGovernorateKey(query.deliverTo);
    if (!governorate) throw new HttpError(422, "UNKNOWN_GOVERNORATE", "المحافظة غير معروفة.");
    where.push(Prisma.sql`EXISTS (SELECT 1 FROM delivery_rates dr WHERE dr.store_id = st.id AND dr.governorate = ${governorate} AND dr.is_enabled)`);
  }
  if (query.minPrice !== undefined) where.push(Prisma.sql`v.min_price >= ${query.minPrice}`);
  if (query.maxPrice !== undefined) where.push(Prisma.sql`v.min_price <= ${query.maxPrice}`);
  if (query.discount === "any") where.push(Prisma.sql`${DISCOUNT} > 0`);
  if (query.discount === "30") where.push(Prisma.sql`${DISCOUNT} >= 30`);
  if (query.discount === "50") where.push(Prisma.sql`${DISCOUNT} >= 50`);
  if (query.rating === "3") where.push(Prisma.sql`s.rating_avg >= 3`);
  // «ممتاز»: high stars WITH enough reviews to mean it.
  if (query.rating === "excellent") where.push(Prisma.sql`s.rating_count >= 5 AND (s.rating_avg::float8 * s.rating_count + 20) / (s.rating_count + 5) >= 4.5`);
  if (query.condition) where.push(Prisma.sql`p.condition = ${query.condition}`);
  if (query.tag) where.push(Prisma.sql`${query.tag} = ANY(p.tags)`);
  if (query.preorder) where.push(Prisma.sql`p.is_preorder`);
  if (query.inStock) where.push(Prisma.sql`(v.in_stock OR p.is_preorder)`);
  if (query.exclude) where.push(Prisma.sql`p.id <> ${query.exclude}::uuid`);
  if (query.collection) {
    // Only a collection that is live now; an expired event shows nothing rather than stale prices.
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM market_collection_items ci JOIN market_collections mc ON mc.id = ci.collection_id
       WHERE ci.product_id = p.id AND mc.slug = ${query.collection} AND mc.is_active
         AND (mc.starts_at IS NULL OR mc.starts_at <= now()) AND (mc.ends_at IS NULL OR mc.ends_at > now()))`);
  }
  if (query.mall) {
    where.push(Prisma.sql`EXISTS (SELECT 1 FROM market_mall_stores ms JOIN market_malls mm ON mm.id = ms.mall_id WHERE ms.store_id = st.id AND mm.slug = ${query.mall} AND mm.is_active)`);
  }
  if (query.ids) where.push(Prisma.sql`p.id = ANY(${query.ids}::uuid[])`);
  if (query.relatedTo) {
    // Same market category as any of these products, and not one of them.
    where.push(Prisma.sql`COALESCE(p.market_category_id, pc.market_category_id) IN (
      SELECT COALESCE(rp.market_category_id, rpc.market_category_id) FROM products rp
        LEFT JOIN product_categories rpc ON rpc.id = rp.category_id AND rpc.store_id = rp.store_id
       WHERE rp.id = ANY(${query.relatedTo}::uuid[]) AND rp.deleted_at IS NULL)
      AND NOT (p.id = ANY(${query.relatedTo}::uuid[]))`);
  }
  if (query.sellsFast) where.push(Prisma.sql`v.low_stock`);
  if (cursor) where.push(Prisma.sql`(${key}, p.id) < (${cursorValue}::float8, ${cursor.id}::uuid)`);

  const rows = await prisma.$queryRaw<Row[]>`
    ${selectCard(match, key)}
    ${BASE_FROM}
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY sort_key DESC, p.id DESC
    LIMIT ${limit + 1}`;
  // Counted once per search, on its first page — paging deeper is not a new search.
  // Awaited (one small upsert) so the count is never lost to a racing response;
  // a failure to count never fails the search.
  if (match && !cursor) await recordSearch(match.normalized).catch(() => undefined);
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(kind, last.sort_key, last.id));
  return { products: page.map(cardOf), nextCursor, sort };
}

const SPEC_SHAPE = (value: unknown): { name: string; value: string }[] =>
  Array.isArray(value) ? value.filter((row): row is { name: string; value: string } => typeof row?.name === "string" && typeof row?.value === "string") : [];
const dateOnly = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

/** One product's market page. 404 unless its store is in the market and the product is live. */
export async function marketProductPage(productId: string, options: { countView: boolean }) {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new HttpError(404, "PRODUCT_NOT_FOUND", "هذا المنتج غير موجود.");
  const [row] = await prisma.$queryRaw<Row[]>`
    ${selectCard(null, Prisma.sql`0::float8`)}
    ${BASE_FROM}
    WHERE ${VISIBLE} AND p.id = ${productId}::uuid
    LIMIT 1`;
  if (!row) throw new HttpError(404, "PRODUCT_NOT_FOUND", "يبدو أنّ المتجر أزال هذا المنتج أو أوقف بيعه مؤقتاً.");
  const [product, store] = await Promise.all([
    prisma.product.findUniqueOrThrow({
      where: { id: row.id },
      select: {
        description: true, specs: true, requiresPrescription: true,
        marketCategory: { select: { slug: true, nameAr: true } },
        category: { select: { marketCategory: { select: { slug: true, nameAr: true } } } },
        images: { select: { id: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 12 },
        variants: { where: { isActive: true, deletedAt: null }, select: { id: true, name: true, priceIqd: true, stockQuantity: true, isDefault: true, options: true }, orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }] },
        addons: { where: { isActive: true }, select: { id: true, name: true, priceIqd: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
    }),
    listedStoreTenant(row.store_slug),
  ]);
  if (options.countView) void recordVisit(store.id, { day: baghdadDay(), newVisitor: false, productId: row.id }).catch(() => undefined);
  const category = product.marketCategory ?? product.category?.marketCategory ?? null;
  const livePriceBy = await livePrices(prisma, product.variants.map((variant) => variant.id));
  return {
    product: {
      ...cardOf(row),
      description: product.description,
      specs: SPEC_SHAPE(product.specs),
      requiresPrescription: product.requiresPrescription,
      category: category ? { slug: category.slug, name: category.nameAr } : null,
      images: product.images.map((image) => imageUrl(row.store_slug, row.id, image.id) as string),
      variants: product.variants.map((variant) => ({ id: variant.id, name: variant.name, isDefault: variant.isDefault, priceIqd: livePriceBy.get(variant.id) ?? variant.priceIqd, listPriceIqd: (livePriceBy.get(variant.id) ?? variant.priceIqd) < variant.priceIqd ? variant.priceIqd : null, options: variant.options, isAvailable: variant.stockQuantity > 0 })),
      addons: product.addons,
      preorder: row.is_preorder ? { releaseOn: dateOnly(row.preorder_release_on), shipsBy: dateOnly(row.preorder_ships_by) } : null,
      maxPerOrder: row.max_per_order,
      storefrontPath: `/store/${encodeURIComponent(row.store_slug)}/products/${encodeURIComponent(row.id)}`,
    },
  };
}

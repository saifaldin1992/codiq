/**
 * The shopper's side of the stores directory: the paged list behind every shelf
 * and filter, one store's page, its reviews, and its cover bytes.
 *
 * VISIBILITY, in one place (`LISTED`): a store is in the market when the owner
 * listed it AND the store and its merchant are active. A delisted, suspended or
 * closed store answers 404 here exactly as if it never existed.
 *
 * ONE KEYSET FOR SEVEN SORTS. Every sort is expressed as a single float8 key
 * ordered DESC, tie-broken by id DESC — «fastest response» is the NEGATED
 * minutes, «nearest» the negated distance — so one cursor shape (value, id)
 * pages them all, and the cursor's kind names the sort so a «views» cursor
 * cannot be replayed against «rating».
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { governorateLabel } from "../../services/governorates.js";
import { getStoreLogoBytes } from "../../services/product-image-storage.service.js";
import { CRITERIA, MIN_ORDERS_FOR_SCORE, shrunkRating, type MarketTier } from "./market-score.js";
import { badgeViews, grantedMarks, hoursView, parseEarnedBadges, storeCoverUrl, storeLogoUrl, TIER_LABELS } from "./presentation.js";
import type { MarketStoreQuery, MarketStoreSort } from "./schema.js";

const LISTED = Prisma.sql`st.market_status = 'listed' AND st.is_active AND m_acc.is_active`;
const DIRECTORY_LIMIT_MAX = 50;

/** Distance in km from (lat, lng), haversine on a 6371 km sphere. */
function distanceSql(lat: number, lng: number) {
  return Prisma.sql`(6371 * 2 * asin(sqrt(
    power(sin(radians(st.latitude - ${lat}::float8) / 2), 2)
    + cos(radians(${lat}::float8)) * cos(radians(st.latitude)) * power(sin(radians(st.longitude - ${lng}::float8) / 2), 2))))`;
}

function sortKeySql(sort: MarketStoreSort, query: MarketStoreQuery) {
  switch (sort) {
    // Boosted stores lead, then the score; a store not yet scored sits at 0.
    case "recommended": return Prisma.sql`(COALESCE(m.score, 0)::float8 + CASE WHEN st.boosted_until > now() THEN 1000 ELSE 0 END)`;
    // The same shrinkage as the score itself: three 5★ reviews do not outrank three hundred 4.8★ ones.
    case "rating": return Prisma.sql`(CASE WHEN m.rating_count > 0 THEN (m.rating_avg::float8 * m.rating_count + 20) / (m.rating_count + 5) ELSE 0 END)`;
    case "response": return Prisma.sql`(-COALESCE(m.median_response_minutes, 1000000))::float8`;
    case "views": return Prisma.sql`COALESCE(m.views_30d, 0)::float8`;
    case "sales": return Prisma.sql`COALESCE(m.completed_orders_30d, 0)::float8`;
    case "newest": return Prisma.sql`extract(epoch FROM st.market_listed_at)::float8`;
    case "nearest": return Prisma.sql`(-${distanceSql(query.lat as number, query.lng as number)})`;
  }
}

type DirectoryRow = {
  id: string; merchant_id: string; slug: string; name: string; business_type: string | null;
  logo_object_key: string | null; cover_object_key: string | null;
  governorate_key: string | null; district_id: number | null; district_name: string | null;
  latitude: number | null; longitude: number | null; pickup_enabled: boolean;
  verified_at: Date | null; is_brand: boolean; boosted_until: Date | null; ambassador_until: Date | null; market_listed_at: Date | null;
  score: Prisma.Decimal | null; tier: MarketTier | null; rating_avg: Prisma.Decimal | null; rating_count: number | null;
  median_response_minutes: number | null; views_30d: number | null; product_count: number | null; completed_orders_30d: number | null;
  badges: unknown; distance_km: number | null; sort_key: number;
};

const num = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));

function cardOf(row: DirectoryRow, now: Date) {
  return {
    slug: row.slug,
    name: row.name,
    businessType: row.business_type,
    logoUrl: storeLogoUrl(row.slug, row.logo_object_key),
    coverUrl: storeCoverUrl(row.slug, row.cover_object_key),
    governorate: row.governorate_key ? { key: row.governorate_key, name: governorateLabel(row.governorate_key) } : null,
    district: row.district_id && row.district_name ? { id: row.district_id, name: row.district_name } : null,
    location: row.latitude !== null && row.longitude !== null ? { latitude: row.latitude, longitude: row.longitude } : null,
    pickupEnabled: row.pickup_enabled,
    marks: grantedMarks({ verifiedAt: row.verified_at, isBrand: row.is_brand, ambassadorUntil: row.ambassador_until, boostedUntil: row.boosted_until, marketListedAt: row.market_listed_at }, now),
    badges: parseEarnedBadges(row.badges),
    score: num(row.score),
    tier: row.tier,
    rating: num(row.rating_avg),
    ratingCount: row.rating_count ?? 0,
    medianResponseMinutes: row.median_response_minutes,
    views30d: row.views_30d ?? 0,
    productCount: row.product_count ?? 0,
    completedOrders30d: row.completed_orders_30d ?? 0,
    distanceKm: row.distance_km === null ? null : Math.round(row.distance_km * 10) / 10,
  };
}

export type MarketStoreCard = ReturnType<typeof cardOf>;

const SELECT_CARD = Prisma.sql`
  st.id, st.merchant_id, st.slug, st.name, st.business_type, st.logo_object_key, st.cover_object_key,
  st.governorate_key, st.district_id, d.name_ar AS district_name, st.latitude, st.longitude, st.pickup_enabled,
  st.verified_at, st.is_brand, st.boosted_until, st.ambassador_until, st.market_listed_at,
  m.score, m.tier, m.rating_avg, m.rating_count, m.median_response_minutes, m.views_30d, m.product_count, m.completed_orders_30d, m.badges`;

const FROM_LISTED = Prisma.sql`
  FROM stores st
  JOIN merchants m_acc ON m_acc.id = st.merchant_id
  LEFT JOIN districts d ON d.id = st.district_id
  LEFT JOIN store_market_metrics m ON m.store_id = st.id`;

export async function listMarketStores(query: MarketStoreQuery) {
  const limit = parseListLimit(query.limit, DIRECTORY_LIMIT_MAX, 20);
  const kind = `market-stores.${query.sort}`;
  const cursor = decodeListCursor(kind, query.cursor);
  const cursorValue = cursor ? Number(cursor.value) : null;
  if (cursor && !Number.isFinite(cursorValue)) throw new HttpError(400, "INVALID_CURSOR", "مؤشّر الصفحة غير صالح.");

  const key = sortKeySql(query.sort, query);
  const filters: Prisma.Sql[] = [LISTED];
  if (query.governorate) filters.push(Prisma.sql`st.governorate_key = ${query.governorate}`);
  if (query.district) filters.push(Prisma.sql`st.district_id = ${query.district}`);
  if (query.type) filters.push(Prisma.sql`st.business_type = ${query.type}`);
  if (query.verified) filters.push(Prisma.sql`st.verified_at IS NOT NULL`);
  if (query.brand) filters.push(Prisma.sql`st.is_brand`);
  if (query.ambassador) filters.push(Prisma.sql`st.ambassador_until > now()`);
  if (query.q) filters.push(Prisma.sql`codiq_ar_normalize_v1(st.name) LIKE '%' || codiq_like_escape(codiq_ar_normalize_v1(${query.q})) || '%'`);
  if (query.sort === "nearest") filters.push(Prisma.sql`st.latitude IS NOT NULL`);
  if (query.sort === "newest") filters.push(Prisma.sql`st.market_listed_at IS NOT NULL`);
  if (cursor) filters.push(Prisma.sql`(${key}, st.id) < (${cursorValue}::float8, ${cursor.id}::uuid)`);

  const distance = query.lat !== undefined && query.lng !== undefined ? distanceSql(query.lat, query.lng) : Prisma.sql`NULL::float8`;
  const rows = await prisma.$queryRaw<DirectoryRow[]>`
    SELECT ${SELECT_CARD}, ${distance} AS distance_km, ${key} AS sort_key
    ${FROM_LISTED}
    WHERE ${Prisma.join(filters, " AND ")}
    ORDER BY sort_key DESC, st.id DESC
    LIMIT ${limit + 1}`;

  const now = new Date();
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(kind, last.sort_key, last.id));
  return { stores: page.map((row) => cardOf(row, now)), nextCursor, sort: query.sort };
}

/** Store cards for given ids (favourites, «اشتريت منها»), in the order asked. Unlisted stores drop out. */
export async function marketStoreCardsByIds(ids: string[]) {
  if (!ids.length) return [];
  const rows = await prisma.$queryRaw<DirectoryRow[]>`
    SELECT ${SELECT_CARD}, NULL::float8 AS distance_km, 0::float8 AS sort_key
    ${FROM_LISTED}
    WHERE ${LISTED} AND st.id = ANY(${ids}::uuid[])`;
  const now = new Date();
  const byId = new Map(rows.map((row) => [row.id, cardOf(row, now)]));
  return ids.map((id) => byId.get(id)).filter((card): card is NonNullable<typeof card> => Boolean(card));
}

async function listedStoreRow(slug: string): Promise<DirectoryRow> {
  const [row] = await prisma.$queryRaw<DirectoryRow[]>`
    SELECT ${SELECT_CARD}, NULL::float8 AS distance_km, 0::float8 AS sort_key
    ${FROM_LISTED}
    WHERE ${LISTED} AND st.slug = ${slug}
    LIMIT 1`;
  if (!row) throw new HttpError(404, "STORE_NOT_FOUND", "هذا المتجر غير موجود في السوق.");
  return row;
}

/** The tenant behind a listed store — what a capability check needs. 404 for anything not in the market. */
export async function listedStoreTenant(slug: string): Promise<{ id: string; merchantId: string; slug: string }> {
  const row = await listedStoreRow(slug);
  return { id: row.id, merchantId: row.merchant_id, slug: row.slug };
}

/** «كيف نرتّب المتاجر؟» — the criteria and their weights, so the explanation is the formula itself. */
export function rankingExplanation() {
  return { criteria: CRITERIA.map(({ code, title, weight }) => ({ code, title, weight })), minimumOrders: MIN_ORDERS_FOR_SCORE, tiers: TIER_LABELS };
}

export async function marketStorePage(slug: string) {
  const row = await listedStoreRow(slug);
  const now = new Date();
  const [store, hours, methods, metrics] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: row.id }, select: { headline: true, subline: true, supportWhatsapp: true, supportPhone: true, addressLine: true, createdAt: true, vacationMode: true, vacationMessage: true } }),
    prisma.storeOpeningHour.findMany({ where: { storeId: row.id }, select: { weekday: true, opensAt: true, closesAt: true } }),
    prisma.paymentMethod.findMany({ where: { storeId: row.id, isEnabled: true }, select: { code: true, displayName: true }, orderBy: { code: "asc" } }),
    prisma.storeMarketMetrics.findUnique({ where: { storeId: row.id }, select: { completedOrders: true, cancelRate: true, repeatRate: true, computedAt: true } }),
  ]);
  const card = cardOf(row, now);
  return {
    storeSlug: row.slug,
    store: {
      ...card,
      headline: store.headline,
      about: store.subline,
      addressLine: store.addressLine,
      whatsapp: store.supportWhatsapp,
      phone: store.supportPhone,
      joinedAt: store.createdAt,
      closedForOrders: store.vacationMode ? (store.vacationMessage?.trim() || "المتجر لا يستقبل طلبات حالياً.") : null,
      storefrontPath: `/store/${encodeURIComponent(row.slug)}`,
    },
    reputation: {
      score: card.score,
      tier: card.tier,
      tierLabel: card.tier ? TIER_LABELS[card.tier] : null,
      rating: card.rating,
      ratingCount: card.ratingCount,
      shrunkRating: shrunkRating(card.rating, card.ratingCount),
      completedOrders: metrics?.completedOrders ?? 0,
      cancelRate: num(metrics?.cancelRate),
      repeatRate: num(metrics?.repeatRate),
      medianResponseMinutes: card.medianResponseMinutes,
      computedAt: metrics?.computedAt ?? null,
    },
    badges: badgeViews(card.badges, card.marks),
    hours: hoursView(hours, now),
    paymentMethods: methods,
  };
}

const REVIEW_LIMIT_MAX = 50;
/** The store's reviews across all its products, newest first. Hidden text stays hidden; the stars still count. */
export async function marketStoreReviews(row: { id: string; slug: string }, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, REVIEW_LIMIT_MAX, 10);
  const cursor = decodeListCursor("market-store-reviews", rawCursor);
  const rows = await prisma.productReview.findMany({
    where: {
      storeId: row.id,
      withdrawnAt: null,
      ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.value) } }, { createdAt: new Date(cursor.value), id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, rating: true, body: true, hiddenAt: true, createdAt: true, product: { select: { id: true, name: true } }, customer: { select: { fullName: true } } },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor("market-store-reviews", last.createdAt, last.id));
  return {
    storeSlug: row.slug,
    reviews: page.map((review) => ({
      id: review.id,
      rating: review.rating,
      body: review.hiddenAt ? null : review.body,
      createdAt: review.createdAt,
      product: review.product,
      // First name only: a public page never shows a shopper's full name.
      author: review.customer.fullName?.trim().split(/\s+/)[0] || "زبون",
    })),
    nextCursor,
  };
}

/** The cover bytes, for listed stores only — the same visibility as the page that links to them. */
export async function marketStoreCover(slug: string) {
  const row = await listedStoreRow(slug);
  const cover = await prisma.store.findUniqueOrThrow({ where: { id: row.id }, select: { coverObjectKey: true, coverContentType: true } });
  if (!cover.coverObjectKey || !cover.coverContentType) throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا توجد صورة غلاف لهذا المتجر.");
  return { contentType: cover.coverContentType, bytes: await getStoreLogoBytes(cover.coverObjectKey) };
}

// ── Marketplace M11: «خريطة المتاجر» and «على طريقك» ─────────────────────────

const MAP_PIN_LIMIT = 300;
type MapPinRow = { slug: string; name: string; business_type: string | null; logo_object_key: string | null; latitude: number; longitude: number; rating_avg: Prisma.Decimal | null; rating_count: number | null; tier: MarketTier | null; verified_at: Date | null; pickup_enabled: boolean };

/**
 * The pins inside the visible box. Bounded (300), the best-scored first, and
 * `truncated` says when a zoomed-out view held more — the map then asks the
 * shopper to zoom in rather than drawing a smear of a thousand markers.
 */
export async function marketStoresInBox(box: { south: number; west: number; north: number; east: number }) {
  if (box.south >= box.north || box.west >= box.east) throw new HttpError(422, "MAP_BOX_INVALID", "حدود الخريطة غير صالحة.");
  const rows = await prisma.$queryRaw<MapPinRow[]>`
    SELECT st.slug, st.name, st.business_type, st.logo_object_key, st.latitude, st.longitude, st.verified_at, st.pickup_enabled, m.rating_avg, m.rating_count, m.tier
    ${FROM_LISTED}
    WHERE ${LISTED} AND st.latitude IS NOT NULL AND st.longitude IS NOT NULL
      AND st.latitude BETWEEN ${box.south}::float8 AND ${box.north}::float8
      AND st.longitude BETWEEN ${box.west}::float8 AND ${box.east}::float8
    ORDER BY (COALESCE(m.score, 0)::float8 + CASE WHEN st.boosted_until > now() THEN 1000 ELSE 0 END) DESC, st.id DESC
    LIMIT ${MAP_PIN_LIMIT + 1}`;
  return {
    pins: rows.slice(0, MAP_PIN_LIMIT).map((row) => ({
      slug: row.slug, name: row.name, businessType: row.business_type, logoUrl: storeLogoUrl(row.slug, row.logo_object_key),
      latitude: row.latitude, longitude: row.longitude, rating: num(row.rating_avg), ratingCount: row.rating_count ?? 0, tier: row.tier,
      verified: row.verified_at !== null, pickupEnabled: row.pickup_enabled,
    })),
    truncated: rows.length > MAP_PIN_LIMIT,
  };
}

const ROUTE_STORE_LIMIT = 50;
export const ROUTE_MAX_KM = 200;
const KM_PER_DEGREE = 6371 * Math.PI / 180;

/**
 * «على طريقك»: listed stores within `corridorKm` of the straight line from one
 * point to another — the shopper's errand, not a road route — ordered by where
 * along the line they fall, so the list reads in the order he passes them.
 *
 * The geometry is a local flat projection centred on the start (x east, y
 * north, in km). Over the 200 km this allows the error is far below the
 * corridor's width. Candidates come from the box around the line widened by
 * the corridor (the geo index); the exact distance to the segment is computed
 * on those rows only.
 */
export async function marketStoresOnRoute(input: { from: { lat: number; lng: number }; to: { lat: number; lng: number }; corridorKm: number }) {
  const { from, to, corridorKm } = input;
  const cosLat = Math.cos((from.lat * Math.PI) / 180);
  const bx = (to.lng - from.lng) * KM_PER_DEGREE * cosLat;
  const by = (to.lat - from.lat) * KM_PER_DEGREE;
  const routeKm = Math.hypot(bx, by);
  if (routeKm < 0.2) throw new HttpError(422, "ROUTE_TOO_SHORT", "نقطتا البداية والنهاية متقاربتان جدّاً.");
  if (routeKm > ROUTE_MAX_KM) throw new HttpError(422, "ROUTE_TOO_LONG", `المشوار أطول من ${ROUTE_MAX_KM} كم — اختر نقطتين أقرب.`);
  const padLat = corridorKm / KM_PER_DEGREE;
  const padLng = corridorKm / (KM_PER_DEGREE * Math.max(Math.min(Math.cos((from.lat * Math.PI) / 180), Math.cos((to.lat * Math.PI) / 180)), 0.1));
  const south = Math.min(from.lat, to.lat) - padLat, north = Math.max(from.lat, to.lat) + padLat;
  const west = Math.min(from.lng, to.lng) - padLng, east = Math.max(from.lng, to.lng) + padLng;
  const len2 = bx * bx + by * by;
  const px = Prisma.sql`((st.longitude - ${from.lng}::float8) * ${KM_PER_DEGREE * cosLat}::float8)`;
  const py = Prisma.sql`((st.latitude - ${from.lat}::float8) * ${KM_PER_DEGREE}::float8)`;
  const t = Prisma.sql`GREATEST(0::float8, LEAST(1::float8, (${px} * ${bx}::float8 + ${py} * ${by}::float8) / ${len2}::float8))`;
  const rows = await prisma.$queryRaw<(DirectoryRow & { along_km: number })[]>`
    SELECT * FROM (
      SELECT ${SELECT_CARD},
        sqrt(power(${px} - ${t} * ${bx}::float8, 2) + power(${py} - ${t} * ${by}::float8, 2)) AS distance_km,
        ${t} * ${routeKm}::float8 AS along_km,
        0::float8 AS sort_key
      ${FROM_LISTED}
      WHERE ${LISTED} AND st.latitude IS NOT NULL AND st.longitude IS NOT NULL
        AND st.latitude BETWEEN ${south}::float8 AND ${north}::float8
        AND st.longitude BETWEEN ${west}::float8 AND ${east}::float8
    ) candidates
    WHERE distance_km <= ${corridorKm}::float8
    ORDER BY along_km ASC, id ASC
    LIMIT ${ROUTE_STORE_LIMIT + 1}`;
  const now = new Date();
  return {
    routeKm: Math.round(routeKm * 10) / 10,
    corridorKm,
    stores: rows.slice(0, ROUTE_STORE_LIMIT).map((row) => ({ ...cardOf(row, now), alongKm: Math.round(row.along_km * 10) / 10 })),
    truncated: rows.length > ROUTE_STORE_LIMIT,
  };
}

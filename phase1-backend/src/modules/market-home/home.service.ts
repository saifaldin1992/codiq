/**
 * The shopper's side of the market's editorial content: the front page in the
 * owner's order, live banners, collections and malls.
 *
 * «Live» is decided by the clock at read time — a banner scheduled for Friday
 * appears on Friday without a job flipping a flag, exactly as maintenance
 * windows work (ق-250).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { marketCategoryTree } from "../market-catalog/categories.service.js";

const live = (now: Date) => ({
  isActive: true,
  AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
});

const versionOf = (objectKey: string) => objectKey.split("/").pop()?.split(".")[0] ?? "0";
export const bannerImageUrl = (id: string, objectKey: string | null) => (objectKey ? `/api/market/banners/${id}/image?v=${encodeURIComponent(versionOf(objectKey))}` : null);

/** Live banners of one placement, in the owner's order. Bounded: twelve per placement. */
export async function liveBanners(placement: string, now = new Date()) {
  const rows = await prisma.marketBanner.findMany({
    where: { placement, ...live(now) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    take: 12,
    select: { id: true, title: true, subtitle: true, imageObjectKey: true, linkKind: true, linkTarget: true, isAd: true },
  });
  return rows.map((row) => ({ id: row.id, title: row.title, subtitle: row.subtitle, imageUrl: bannerImageUrl(row.id, row.imageObjectKey), link: row.linkKind === "none" ? null : { kind: row.linkKind, target: row.linkTarget }, isAd: row.isAd }));
}

/** Live collections and discount events, for the front page's shelf. Bounded: twenty. */
export async function liveCollections(now = new Date()) {
  const rows = await prisma.marketCollection.findMany({
    where: live(now),
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    take: 20,
    select: { slug: true, kind: true, title: true, subtitle: true, headlineDiscountPercent: true, endsAt: true, _count: { select: { items: true } } },
  });
  return rows.map((row) => ({ slug: row.slug, kind: row.kind, title: row.title, subtitle: row.subtitle, headlineDiscountPercent: row.headlineDiscountPercent, endsAt: row.endsAt, products: row._count.items }));
}

/** Active malls with the logos of their first listed stores. Bounded: twenty malls, four logos each. */
export async function activeMalls() {
  const malls = await prisma.marketMall.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 20, select: { id: true, slug: true, name: true, description: true } });
  if (!malls.length) return [];
  const members = await prisma.$queryRaw<Array<{ mall_id: string; slug: string; name: string; logo_object_key: string | null; n: number }>>`
    SELECT ms.mall_id, st.slug, st.name, st.logo_object_key, count(*) OVER (PARTITION BY ms.mall_id)::int AS n
      FROM market_mall_stores ms
      JOIN stores st ON st.id = ms.store_id
      JOIN merchants m_acc ON m_acc.id = st.merchant_id
     WHERE ms.mall_id = ANY(${malls.map((mall) => mall.id)}::uuid[])
       AND st.market_status = 'listed' AND st.is_active AND m_acc.is_active AND st.status NOT IN ('suspended', 'closed')
     ORDER BY ms.mall_id, ms.sort_order, st.name`;
  return malls.map((mall) => {
    const stores = members.filter((row) => row.mall_id === mall.id);
    return {
      slug: mall.slug, name: mall.name, description: mall.description, stores: stores[0]?.n ?? 0,
      logos: stores.slice(0, 4).map((row) => ({ slug: row.slug, name: row.name, logoUrl: row.logo_object_key ? `/api/store/${encodeURIComponent(row.slug)}/logo?v=${encodeURIComponent(versionOf(row.logo_object_key))}` : null })),
    };
  });
}

/** The whole front page in one answer: the blocks in order, each with what it can resolve server-side. */
export async function marketHome() {
  const now = new Date();
  const sections = await prisma.marketHomeSection.findMany({ where: { isActive: true }, orderBy: { position: "asc" }, take: 40 });
  const kinds = new Set(sections.map((section) => section.kind));
  const placements = Array.from(new Set(sections.filter((section) => section.kind === "banners").map((section) => String((section.config as { placement?: string }).placement ?? "home_hero"))));
  const [banners, categories, collections, malls] = await Promise.all([
    Promise.all(placements.map(async (placement) => [placement, await liveBanners(placement, now)] as const)),
    kinds.has("categories") ? marketCategoryTree() : null,
    kinds.has("collections") ? liveCollections(now) : null,
    kinds.has("malls") ? activeMalls() : null,
  ]);
  const bannersBy = new Map(banners);
  return {
    sections: sections.map((section) => {
      const config = section.config as Record<string, unknown>;
      const base = { id: section.id, kind: section.kind, title: section.title, config };
      switch (section.kind) {
        case "banners": return { ...base, banners: bannersBy.get(String(config.placement ?? "home_hero")) ?? [] };
        case "categories": return { ...base, categories: categories?.categories.map((root) => ({ slug: root.slug, name: root.name })) ?? [] };
        case "collections": return { ...base, collections: collections ?? [] };
        case "malls": return { ...base, malls: malls ?? [] };
        default: return base;
      }
    }),
  };
}

export async function collectionPage(slug: string) {
  const now = new Date();
  const row = await prisma.marketCollection.findFirst({ where: { slug, ...live(now) }, select: { slug: true, kind: true, title: true, subtitle: true, headlineDiscountPercent: true, endsAt: true } });
  if (!row) throw new HttpError(404, "COLLECTION_NOT_FOUND", "هذه المجموعة غير موجودة أو انتهى عرضها.");
  return { collection: row };
}

export async function mallPage(slug: string) {
  const mall = await prisma.marketMall.findFirst({ where: { slug, isActive: true }, select: { id: true, slug: true, name: true, description: true } });
  if (!mall) throw new HttpError(404, "MALL_NOT_FOUND", "هذا المول غير موجود.");
  // Bounded: a mall holds at most a hundred stores (mallStoresSchema); only those in the market are shown.
  const stores = await prisma.$queryRaw<Array<{ slug: string; name: string; business_type: string | null; logo_object_key: string | null }>>`
    SELECT st.slug, st.name, st.business_type, st.logo_object_key
      FROM market_mall_stores ms
      JOIN stores st ON st.id = ms.store_id
      JOIN merchants m_acc ON m_acc.id = st.merchant_id
     WHERE ms.mall_id = ${mall.id}::uuid AND st.market_status = 'listed' AND st.is_active AND m_acc.is_active AND st.status NOT IN ('suspended', 'closed')
     ORDER BY ms.sort_order, st.name`;
  return {
    mall: { slug: mall.slug, name: mall.name, description: mall.description },
    stores: stores.map((row) => ({ slug: row.slug, name: row.name, businessType: row.business_type, logoUrl: row.logo_object_key ? `/api/store/${encodeURIComponent(row.slug)}/logo?v=${encodeURIComponent(versionOf(row.logo_object_key))}` : null })),
  };
}

/** Counts one view or tap. A plain increment: the numbers are a guide for the owner, not money. */
export async function recordBannerEvent(id: string, kind: "view" | "click") {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "BANNER_NOT_FOUND", "البنر غير موجود.");
  const column = kind === "view" ? Prisma.sql`views = views + 1` : Prisma.sql`clicks = clicks + 1`;
  const updated = await prisma.$executeRaw`UPDATE market_banners SET ${column} WHERE id = ${id}::uuid AND is_active`;
  if (updated === 0) throw new HttpError(404, "BANNER_NOT_FOUND", "البنر غير موجود.");
  return { ok: true };
}

export async function bannerImage(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الصورة غير موجودة.");
  const row = await prisma.marketBanner.findUnique({ where: { id }, select: { imageObjectKey: true, imageContentType: true, isActive: true } });
  if (!row?.isActive || !row.imageObjectKey || !row.imageContentType) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الصورة غير موجودة.");
  return { objectKey: row.imageObjectKey, contentType: row.imageContentType };
}

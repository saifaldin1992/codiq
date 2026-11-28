/**
 * Marketplace M10 — short videos.
 *
 * A store uploads a reel (optionally of one of its products); the owner approves
 * it before anyone sees it (R4). The feed shows approved reels of listed stores,
 * newest first, each with its product card so the shopper can buy from the video.
 *
 * Counts are honest by construction: a like is a row (one per shopper), a view is
 * a row per viewer per Baghdad day (one per person, however often the request is
 * replayed), and the counters on the reel only move when such a row is created.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import {
  decodeListCursor,
  encodeListCursor,
  pageOf,
  parseListLimit,
} from "../../services/list-page.js";
import {
  deleteMarketImageObjects,
  getObjectRange,
  getStoreLogoBytes,
  putMarketImage,
  putReelVideo,
} from "../../services/product-image-storage.service.js";
import { listMarketProducts } from "../market-catalog/products.service.js";
import type { MarketProductQuery } from "../market-catalog/schema.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING_PER_STORE = 10;
const VISIBLE = { status: "approved", store: { marketStatus: "listed", isActive: true } } as const;

const videoUrl = (id: string) => `/api/market/reels/${id}/video`;
const posterUrl = (id: string, key: string | null) =>
  key ? `/api/market/reels/${id}/poster` : null;

type ReelRow = Prisma.MarketReelGetPayload<{
  include: { store: { select: { slug: true; name: true; logoObjectKey: true } } };
}>;

async function present(rows: ReelRow[], shopperId: string | null) {
  const productIds = rows.map((row) => row.productId).filter((id): id is string => Boolean(id));
  const [cards, liked] = await Promise.all([
    productIds.length
      ? listMarketProducts({
          ids: Array.from(new Set(productIds)).slice(0, 24),
          limit: 24,
          period: "month",
        } as MarketProductQuery).then((page) => page.products)
      : Promise.resolve([]),
    shopperId && rows.length
      ? prisma.marketReelLike.findMany({
          where: { shopperId, reelId: { in: rows.map((row) => row.id) } },
          select: { reelId: true },
        })
      : Promise.resolve([]),
  ]);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const likedSet = new Set(liked.map((row) => row.reelId));
  return rows.map((row) => ({
    id: row.id,
    caption: row.caption,
    videoUrl: videoUrl(row.id),
    posterUrl: posterUrl(row.id, row.posterObjectKey),
    store: {
      slug: row.store.slug,
      name: row.store.name,
      logoUrl: row.store.logoObjectKey
        ? `/api/store/${encodeURIComponent(row.store.slug)}/logo`
        : null,
    },
    product: row.productId ? (cardById.get(row.productId) ?? null) : null,
    views: row.viewCount,
    likes: row.likeCount,
    liked: likedSet.has(row.id),
    publishedAt: row.publishedAt,
  }));
}

const FEED_KIND = "market-reels";
/** The feed, or one store's reels (R3). Approved reels of stores in the market, newest first. */
export async function reelsFeed(
  input: { storeSlug?: string; cursor?: unknown; limit?: unknown },
  shopperId: string | null
) {
  const limit = parseListLimit(input.limit, 20, 8);
  const kind = `${FEED_KIND}.${input.storeSlug ?? "all"}`;
  const cursor = decodeListCursor(kind, input.cursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.marketReel.findMany({
    where: {
      ...VISIBLE,
      ...(input.storeSlug ? { store: { ...VISIBLE.store, slug: input.storeSlug } } : {}),
      ...(cursor && at
        ? { OR: [{ publishedAt: { lt: at } }, { publishedAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { store: { select: { slug: true, name: true, logoObjectKey: true } } },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(kind, last.publishedAt!, last.id)
  );
  return { reels: await present(page, shopperId), nextCursor };
}

/** The deep link (R2): one reel, whatever its place in the feed. */
export async function reelPage(reelId: string, shopperId: string | null) {
  if (!UUID.test(reelId)) throw new HttpError(404, "REEL_NOT_FOUND", "هذا المقطع غير موجود.");
  const row = await prisma.marketReel.findFirst({
    where: { id: reelId, ...VISIBLE },
    include: { store: { select: { slug: true, name: true, logoObjectKey: true } } },
  });
  if (!row) throw new HttpError(404, "REEL_NOT_FOUND", "هذا المقطع غير موجود أو أُزيل.");
  return { reel: (await present([row], shopperId))[0] };
}

async function visibleReel(reelId: string) {
  if (!UUID.test(reelId)) throw new HttpError(404, "REEL_NOT_FOUND", "هذا المقطع غير موجود.");
  const row = await prisma.marketReel.findFirst({
    where: { id: reelId, ...VISIBLE },
    select: {
      id: true,
      videoObjectKey: true,
      videoContentType: true,
      posterObjectKey: true,
      posterContentType: true,
    },
  });
  if (!row) throw new HttpError(404, "REEL_NOT_FOUND", "هذا المقطع غير موجود أو أُزيل.");
  return row;
}

/** The bytes. Only an approved reel is served to the public; the store and the owner preview theirs below. */
export async function reelVideo(
  reelId: string,
  range: string | undefined,
  scope: { storeId?: string; owner?: boolean } = {}
) {
  const row =
    scope.storeId || scope.owner
      ? await prisma.marketReel.findFirst({
          where: { id: reelId, ...(scope.storeId ? { storeId: scope.storeId } : {}) },
          select: { videoObjectKey: true, videoContentType: true },
        })
      : await visibleReel(reelId);
  if (!row) throw new HttpError(404, "REEL_NOT_FOUND", "هذا المقطع غير موجود.");
  return {
    contentType: row.videoContentType,
    ...(await getObjectRange(row.videoObjectKey, range)),
  };
}

export async function reelPoster(reelId: string) {
  const row = await visibleReel(reelId);
  if (!row.posterObjectKey || !row.posterContentType)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا صورة غلاف.");
  return {
    contentType: row.posterContentType,
    bytes: await getStoreLogoBytes(row.posterObjectKey),
  };
}

/** «مشاهدة»: once per viewer per day. The viewer is the shopper, or a hash of the address — never the address itself. */
export async function recordView(
  reelId: string,
  viewer: { shopperId: string | null; ip: string },
  now = new Date()
) {
  const row = await visibleReel(reelId);
  const key = createHash("sha256")
    .update(viewer.shopperId ? `s:${viewer.shopperId}` : `ip:${viewer.ip}`)
    .digest("hex");
  const day = new Date(
    `${new Date(now.valueOf() + 3 * 3_600_000).toISOString().slice(0, 10)}T00:00:00Z`
  );
  const counted = await prisma.$transaction(async (tx) => {
    const created = await tx.marketReelView.createMany({
      data: [{ reelId: row.id, viewerKey: key, day }],
      skipDuplicates: true,
    });
    if (created.count)
      await tx.marketReel.update({ where: { id: row.id }, data: { viewCount: { increment: 1 } } });
    return created.count === 1;
  });
  return { counted };
}

export async function setLike(reelId: string, shopperId: string, liked: boolean) {
  const row = await visibleReel(reelId);
  const likes = await prisma.$transaction(async (tx) => {
    if (liked) {
      const created = await tx.marketReelLike.createMany({
        data: [{ reelId: row.id, shopperId }],
        skipDuplicates: true,
      });
      if (created.count)
        await tx.marketReel.update({
          where: { id: row.id },
          data: { likeCount: { increment: 1 } },
        });
    } else {
      const removed = await tx.marketReelLike.deleteMany({ where: { reelId: row.id, shopperId } });
      if (removed.count)
        await tx.$executeRaw`UPDATE market_reels SET like_count = GREATEST(0, like_count - 1) WHERE id = ${row.id}::uuid`;
    }
    return (
      await tx.marketReel.findUniqueOrThrow({ where: { id: row.id }, select: { likeCount: true } })
    ).likeCount;
  });
  return { liked, likes };
}

// ── the store ──────────────────────────────────────────────────────────────

export async function uploadReel(
  storeId: string,
  input: { caption?: string; productId?: string },
  files: { video?: Express.Multer.File; poster?: Express.Multer.File }
) {
  if (!files.video) throw new HttpError(422, "REEL_VIDEO_REQUIRED", "اختر المقطع.");
  if (
    (await prisma.marketReel.count({ where: { storeId, status: "pending" } })) >=
    MAX_PENDING_PER_STORE
  ) {
    throw new HttpError(
      409,
      "REEL_QUEUE_FULL",
      `لديك ${MAX_PENDING_PER_STORE} مقاطع بانتظار المراجعة. انتظر قرار المراجعة أوّلاً.`
    );
  }
  if (
    input.productId &&
    !(await prisma.product.findFirst({
      where: { id: input.productId, storeId, deletedAt: null },
      select: { id: true },
    }))
  ) {
    throw new HttpError(404, "PRODUCT_NOT_FOUND", "المنتج غير موجود في متجرك.");
  }
  const video = await putReelVideo(storeId, files.video);
  const poster = files.poster
    ? await putMarketImage("reel-posters", files.poster).catch(async (error) => {
        await deleteMarketImageObjects([video.objectKey]).catch(() => undefined);
        throw error;
      })
    : null;
  try {
    const reel = await prisma.marketReel.create({
      data: {
        storeId,
        productId: input.productId ?? null,
        caption: input.caption?.trim() || null,
        videoObjectKey: video.objectKey,
        videoContentType: video.contentType,
        videoByteSize: video.byteSize,
        posterObjectKey: poster?.objectKey ?? null,
        posterContentType: poster?.contentType ?? null,
      },
      select: { id: true, status: true },
    });
    return { reel };
  } catch (error) {
    await deleteMarketImageObjects([video.objectKey, ...(poster ? [poster.objectKey] : [])]).catch(
      () => undefined
    );
    throw error;
  }
}

const STORE_KIND = "merchant-market-reels";
export async function storeReels(storeId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(STORE_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.marketReel.findMany({
    where: {
      storeId,
      status: { not: "removed" },
      ...(cursor && at
        ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      caption: true,
      status: true,
      decisionNote: true,
      viewCount: true,
      likeCount: true,
      createdAt: true,
      product: { select: { id: true, name: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(STORE_KIND, last.createdAt, last.id)
  );
  return { reels: page, nextCursor };
}

/** The store takes its reel down (soft: the row stays for the counts; the bytes go). */
export async function deleteReel(storeId: string, reelId: string) {
  if (!UUID.test(reelId)) throw new HttpError(404, "REEL_NOT_FOUND", "المقطع غير موجود.");
  const row = await prisma.marketReel.findFirst({
    where: { id: reelId, storeId, status: { not: "removed" } },
    select: { id: true, videoObjectKey: true, posterObjectKey: true },
  });
  if (!row) throw new HttpError(404, "REEL_NOT_FOUND", "المقطع غير موجود.");
  const removed = await prisma.marketReel.updateMany({
    where: { id: row.id, status: { not: "removed" } },
    data: { status: "removed", publishedAt: null },
  });
  if (removed.count !== 1) throw new HttpError(404, "REEL_NOT_FOUND", "المقطع غير موجود.");
  await deleteMarketImageObjects([
    row.videoObjectKey,
    ...(row.posterObjectKey ? [row.posterObjectKey] : []),
  ]).catch(() => undefined);
  return { ok: true };
}

// ── the owner ──────────────────────────────────────────────────────────────

const QUEUE_KIND = "platform-market-reels";
export async function reelQueue(status: string | undefined, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const which = status ?? "pending";
  const cursor = decodeListCursor(`${QUEUE_KIND}.${which}`, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.marketReel.findMany({
    where: {
      status: which,
      ...(cursor && at
        ? { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      caption: true,
      status: true,
      decisionNote: true,
      createdAt: true,
      videoByteSize: true,
      store: { select: { slug: true, name: true } },
      product: { select: { id: true, name: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(`${QUEUE_KIND}.${which}`, last.createdAt, last.id)
  );
  return {
    reels: page.map((row) => ({
      ...row,
      previewUrl: `/api/platform/market/reels/${row.id}/video`,
    })),
    nextCursor,
  };
}

export async function decideReel(reelId: string, input: { approve: boolean; note?: string }) {
  if (!UUID.test(reelId)) throw new HttpError(404, "REEL_NOT_FOUND", "المقطع غير موجود.");
  const row = await prisma.marketReel.findUnique({
    where: { id: reelId },
    select: { id: true, status: true },
  });
  if (!row || row.status === "removed")
    throw new HttpError(404, "REEL_NOT_FOUND", "المقطع غير موجود.");
  if (!input.approve && !input.note?.trim())
    throw new HttpError(422, "REEL_REJECTION_NOTE_REQUIRED", "اكتب سبب الرفض — يراه المتجر.");
  const now = new Date();
  // Review batch 6, ت-٧: decided on the status it was read with — racing the store's deletion,
  // an approval used to put a removed reel (its bytes already gone) back in the feed.
  const decided = await prisma.marketReel.updateMany({
    where: { id: row.id, status: row.status },
    data: input.approve
      ? {
          status: "approved",
          publishedAt: now,
          decidedAt: now,
          decisionNote: input.note?.trim() || null,
        }
      : { status: "rejected", publishedAt: null, decidedAt: now, decisionNote: input.note!.trim() },
  });
  if (decided.count !== 1)
    throw new HttpError(409, "REEL_CHANGED", "تغيّر هذا المقطع للتوّ — حدّث القائمة.");
  const updated = await prisma.marketReel.findUniqueOrThrow({
    where: { id: row.id },
    select: { id: true, status: true, decisionNote: true, publishedAt: true },
  });
  return { reel: updated };
}

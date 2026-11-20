/**
 * The owner's side: the queue of stores asking to join, the decision, and the
 * three marks only the platform grants (brand, boost, «سفير»). Verification
 * («موثّق») keeps its existing owner route (store-verification.service.ts).
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { governorateLabel } from "../../services/governorates.js";
import { recomputeMarketMetrics } from "./metrics.service.js";
import { storeLogoUrl } from "./presentation.js";
import { MARKET_QUEUE_FILTERS } from "./schema.js";

type QueueStatus = (typeof MARKET_QUEUE_FILTERS)[number];

export async function marketQueue(rawStatus: unknown, rawCursor: unknown, rawLimit: unknown) {
  const status: QueueStatus = MARKET_QUEUE_FILTERS.includes(rawStatus as QueueStatus) ? (rawStatus as QueueStatus) : "pending";
  const limit = parseListLimit(rawLimit, 100, 25);
  const kind = `market-queue.${status}`;
  const cursor = decodeListCursor(kind, rawCursor);
  // The queue is oldest-first (fair to whoever asked first); the other lists newest decision first.
  const ascending = status === "pending";
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.store.findMany({
    where: {
      marketStatus: status,
      ...(cursor && at ? { OR: [{ marketStatusAt: ascending ? { gt: at } : { lt: at } }, { marketStatusAt: at, id: ascending ? { gt: cursor.id } : { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ marketStatusAt: ascending ? "asc" : "desc" }, { id: ascending ? "asc" : "desc" }],
    take: limit + 1,
    select: {
      id: true, slug: true, name: true, businessType: true, logoObjectKey: true, governorateKey: true, district: { select: { nameAr: true } },
      marketStatus: true, marketStatusAt: true, marketStatusNote: true, marketListedAt: true, verifiedAt: true, isBrand: true, boostedUntil: true, ambassadorUntil: true,
      merchant: { select: { ownerName: true, businessName: true } },
      _count: { select: { products: { where: { isActive: true, deletedAt: null } } } },
      marketMetrics: { select: { score: true, tier: true, completedOrders: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(kind, last.marketStatusAt ?? new Date(0), last.id));
  return {
    status,
    stores: page.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      businessType: row.businessType,
      logoUrl: storeLogoUrl(row.slug, row.logoObjectKey),
      location: row.governorateKey ? [governorateLabel(row.governorateKey), row.district?.nameAr].filter(Boolean).join(" · ") : null,
      merchantName: row.merchant.ownerName,
      businessName: row.merchant.businessName,
      activeProducts: row._count.products,
      status: row.marketStatus,
      statusAt: row.marketStatusAt,
      note: row.marketStatusNote,
      listedAt: row.marketListedAt,
      verified: row.verifiedAt !== null,
      isBrand: row.isBrand,
      boostedUntil: row.boostedUntil,
      ambassadorUntil: row.ambassadorUntil,
      score: row.marketMetrics?.score === null || row.marketMetrics?.score === undefined ? null : Number(row.marketMetrics.score),
      tier: row.marketMetrics?.tier ?? null,
      completedOrders: row.marketMetrics?.completedOrders ?? 0,
    })),
    nextCursor,
  };
}

const ALLOWED_FROM: Record<"list" | "reject" | "delist", string[]> = {
  list: ["pending", "rejected", "delisted"],
  reject: ["pending"],
  delist: ["listed"],
};
const RESULT: Record<"list" | "reject" | "delist", string> = { list: "listed", reject: "rejected", delist: "delisted" };

export async function decideMarketListing(storeId: string, input: { decision: "list" | "reject" | "delist"; note?: string }) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, marketStatus: true, marketListedAt: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر غير موجود.");
  const now = new Date();
  // The status test sits in the WHERE so two owners deciding at once cannot both win.
  const moved = await prisma.store.updateMany({
    where: { id: storeId, marketStatus: { in: ALLOWED_FROM[input.decision] } },
    data: {
      marketStatus: RESULT[input.decision],
      marketStatusAt: now,
      marketStatusNote: input.decision === "list" ? null : input.note ?? null,
      // The first listing date survives a delist and relist: «جديد» means new to the market, once.
      ...(input.decision === "list" && !store.marketListedAt ? { marketListedAt: now } : {}),
    },
  });
  if (moved.count === 0) throw new HttpError(409, "MARKET_DECISION_NOT_ALLOWED", "لا يمكن اتّخاذ هذا القرار على حالة المتجر الحاليّة.", { status: store.marketStatus });
  if (input.decision === "list") await recomputeMarketMetrics([storeId]);
  return { storeId, status: RESULT[input.decision] };
}

export async function setMarketFlags(storeId: string, input: { isBrand?: boolean; boostedUntil?: string | null; ambassadorUntil?: string | null }) {
  const exists = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
  if (!exists) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر غير موجود.");
  const updated = await prisma.store.update({
    where: { id: storeId },
    data: {
      ...(input.isBrand !== undefined ? { isBrand: input.isBrand } : {}),
      ...(input.boostedUntil !== undefined ? { boostedUntil: input.boostedUntil === null ? null : new Date(input.boostedUntil) } : {}),
      ...(input.ambassadorUntil !== undefined ? { ambassadorUntil: input.ambassadorUntil === null ? null : new Date(input.ambassadorUntil) } : {}),
    },
    select: { id: true, isBrand: true, boostedUntil: true, ambassadorUntil: true },
  });
  return { storeId: updated.id, isBrand: updated.isBrand, boostedUntil: updated.boostedUntil, ambassadorUntil: updated.ambassadorUntil };
}

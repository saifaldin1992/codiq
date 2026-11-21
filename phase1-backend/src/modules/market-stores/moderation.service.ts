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
import { recordPlatformAuditEvent } from "../../services/platform-audit.service.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";

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

/**
 * Listing, rejecting or delisting a store is a decision about a merchant's
 * business, so it is written to the platform audit log in the same transaction
 * as the status change: «who delisted this store, and why» is answered from
 * the log months later, or not at all.
 */
export async function decideMarketListing(storeId: string, input: { decision: "list" | "reject" | "delist"; note?: string }, actor: PlatformActor) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, slug: true, marketStatus: true, marketListedAt: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر غير موجود.");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // The status test sits in the WHERE so two owners deciding at once cannot both win.
    const moved = await tx.store.updateMany({
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
    await recordPlatformAuditEvent(tx, {
      entityType: "store", entityId: storeId, entityLabel: `${store.name} (${store.slug})`, action: "store_status_changed", actor,
      metadata: { scope: "market_listing", decision: input.decision, before: store.marketStatus, after: RESULT[input.decision], note: input.note ?? null },
    });
  });
  if (input.decision === "list") await recomputeMarketMetrics([storeId]);
  return { storeId, status: RESULT[input.decision] };
}

/** The platform's marks move a store up the market, so each change is audited with its before and after. */
export async function setMarketFlags(storeId: string, input: { isBrand?: boolean; boostedUntil?: string | null; ambassadorUntil?: string | null }, actor: PlatformActor) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, slug: true, isBrand: true, boostedUntil: true, ambassadorUntil: true } });
    if (!before) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر غير موجود.");
    const updated = await tx.store.update({
      where: { id: storeId },
      data: {
        ...(input.isBrand !== undefined ? { isBrand: input.isBrand } : {}),
        ...(input.boostedUntil !== undefined ? { boostedUntil: input.boostedUntil === null ? null : new Date(input.boostedUntil) } : {}),
        ...(input.ambassadorUntil !== undefined ? { ambassadorUntil: input.ambassadorUntil === null ? null : new Date(input.ambassadorUntil) } : {}),
      },
      select: { id: true, isBrand: true, boostedUntil: true, ambassadorUntil: true },
    });
    const view = (row: { isBrand: boolean; boostedUntil: Date | null; ambassadorUntil: Date | null }) => ({ isBrand: row.isBrand, boostedUntil: row.boostedUntil?.toISOString() ?? null, ambassadorUntil: row.ambassadorUntil?.toISOString() ?? null });
    await recordPlatformAuditEvent(tx, {
      entityType: "store", entityId: storeId, entityLabel: `${before.name} (${before.slug})`, action: "setting_changed", actor,
      metadata: { setting: "market_flags", before: view(before), after: view(updated) },
    });
    return { storeId: updated.id, isBrand: updated.isBrand, boostedUntil: updated.boostedUntil, ambassadorUntil: updated.ambassadorUntil };
  });
}

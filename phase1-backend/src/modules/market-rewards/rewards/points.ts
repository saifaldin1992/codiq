/**
 * Market rewards — points. Split verbatim from rewards.service.ts (review batch 2, ت-١٣);
 * rewards.service.ts re-exports what it always exported.
 */
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";
import {
  pointsBalance,
  yearPoints,
  tierFor,
  POINT_TIERS,
  IQD_PER_POINT,
} from "../../../services/platform-rewards.service.js";
import { prisma } from "../../../db/prisma.js";

// ── «نقاطي» ────────────────────────────────────────────────────────────────

const POINTS_KIND = "market-points-history";

const REASON_LABEL: Record<string, string> = {
  earned: "نقاط طلب",
  clawback: "خصم نقاط طلب مُرجع",
  spent: "استبدال بكوبون",
  granted: "هديّة من السوق",
};

export async function pointsPage(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(POINTS_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const [balance, year, rows] = await Promise.all([
    pointsBalance(prisma, shopperId),
    yearPoints(prisma, shopperId),
    prisma.shopperPointsEntry.findMany({
      where: {
        shopperId,
        ...(cursor && at
          ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        delta: true,
        reason: true,
        orderId: true,
        createdAt: true,
        coupon: { select: { title: true } },
      },
    }),
  ]);
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(POINTS_KIND, last.createdAt, last.id)
  );
  const { tier, next, toNext } = tierFor(year);
  return {
    balance: Math.max(0, balance),
    owed: balance < 0 ? -balance : 0,
    tier: { code: tier.code, label: tier.label, multiplierPct: tier.multiplierPct },
    next: next ? { code: next.code, label: next.label, minPoints: next.minPoints, toNext } : null,
    yearPoints: year,
    tiers: POINT_TIERS,
    earnRule: { iqdPerPoint: IQD_PER_POINT },
    history: page.map((row) => ({
      ...row,
      label: row.coupon
        ? `${REASON_LABEL[row.reason]}: ${row.coupon.title}`
        : (REASON_LABEL[row.reason] ?? row.reason),
    })),
    nextCursor,
  };
}

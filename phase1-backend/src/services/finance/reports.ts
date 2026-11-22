/**
 * Finance — reports. Split verbatim from finance.service.ts (review batch 2, ت-١٠);
 * finance.service.ts re-exports what it always exported.
 */
import { HttpError } from "../../auth/auth.errors.js";
import { prisma } from "../../db/prisma.js";
import {
  parseListLimit,
  readListCursor,
  keysetWhere,
  pageOf,
  encodeListCursor,
} from "../list-page.js";

export function parseReportRange(query: Record<string, unknown>) {
  const parse = (value: unknown, fallback: Date) => {
    if (value === undefined || value === "") return fallback;
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.valueOf()))
      throw new HttpError(400, "INVALID_DATE_FILTER", "from/to must be ISO dates.");
    return parsed;
  };
  const now = new Date();
  const from = parse(query.from, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const to = parse(query.to, now);
  if (to <= from) throw new HttpError(400, "INVALID_DATE_FILTER", "to must be after from.");
  return { from, to };
}

/** Aggregated signed totals computed in the database, so they stay exact past any page size. */
function totalsFromGroups(
  groups: {
    entryType: string;
    _count: { _all: number };
    _sum: {
      subtotalIqd: number | null;
      deliveryFeeIqd: number | null;
      loyaltyDiscountIqd: number | null;
      commissionIqd: number | null;
    };
  }[]
) {
  const totals = {
    completedOrders: 0,
    reversedOrders: 0,
    subtotalIqd: 0,
    deliveryFeeIqd: 0,
    loyaltyDiscountIqd: 0,
    commissionIqd: 0,
  };
  for (const group of groups) {
    const sign = group.entryType === "order_completed" ? 1 : -1;
    if (sign === 1) totals.completedOrders += group._count._all;
    else totals.reversedOrders += group._count._all;
    totals.subtotalIqd += sign * (group._sum.subtotalIqd ?? 0);
    totals.deliveryFeeIqd += sign * (group._sum.deliveryFeeIqd ?? 0);
    totals.loyaltyDiscountIqd += sign * (group._sum.loyaltyDiscountIqd ?? 0);
    totals.commissionIqd += sign * (group._sum.commissionIqd ?? 0);
  }
  return totals;
}

/**
 * 19-د — the delivery fee as a share of the goods it delivered, in basis points.
 *
 * `commissionFor` is fed the subtotal only and the delivery fee is remitted
 * whole (ADR-006), which is a deliberate split. Its abuse is not: a merchant
 * pricing goods at 1,000 and delivery at 99,000 books almost no commission and
 * is still paid everything, and this report showed delivery and commission side
 * by side without ever relating them. `MAX_DELIVERY_RATE_IQD` bounds the
 * absurd version; a 30/70 shift is legal and this number is how it becomes
 * legible to whoever settles him.
 *
 * Basis points rather than a float — a ratio is not money, but a rounded
 * integer is what the rest of this file speaks and what a screen can print. A
 * period with no sales has no ratio, and reports null rather than a number
 * invented from a division by zero.
 */
function deliveryShareBps(totals: { subtotalIqd: number; deliveryFeeIqd: number }): number | null {
  if (totals.subtotalIqd <= 0) return null;
  return Math.round((totals.deliveryFeeIqd * 10000) / totals.subtotalIqd);
}

export async function merchantFinanceReport(merchantId: string, query: Record<string, unknown>) {
  const { from, to } = parseReportRange(query);
  const where = { store: { merchantId }, createdAt: { gte: from, lte: to } };
  const [entries, groups] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
      select: {
        id: true,
        storeId: true,
        orderId: true,
        entryType: true,
        subtotalIqd: true,
        deliveryFeeIqd: true,
        loyaltyDiscountIqd: true,
        commissionIqd: true,
        commissionBps: true,
        planCode: true,
        note: true,
        createdAt: true,
        store: { select: { slug: true, name: true } },
        order: { select: { orderNumber: true } },
      },
    }),
    prisma.ledgerEntry.groupBy({
      by: ["entryType"],
      where,
      _count: { _all: true },
      _sum: {
        subtotalIqd: true,
        deliveryFeeIqd: true,
        loyaltyDiscountIqd: true,
        commissionIqd: true,
      },
    }),
  ]);
  return { period: { from, to }, totals: totalsFromGroups(groups), entries };
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const SETTLEMENTS_KIND = "finance.settlements";

/**
 * D-18: capped at 100 with no page 2. A settlement is written every payout
 * cycle and nothing ever removes one, so a merchant in his third year could no
 * longer reach his first year's payouts — on the screen that exists to prove
 * what he was paid.
 */
export async function merchantSettlements(
  merchantId: string,
  rawLimit?: unknown,
  rawCursor?: unknown
) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(SETTLEMENTS_KIND, rawCursor);
  const rows = await prisma.settlement.findMany({
    where: { merchantId, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(SETTLEMENTS_KIND, last.createdAt, last.id)
  );
  return { settlements: page, nextCursor };
}

export async function platformFinanceReport(query: Record<string, unknown>) {
  const { from, to } = parseReportRange(query);
  const groups = await prisma.ledgerEntry.groupBy({
    by: ["storeId", "entryType"],
    where: { createdAt: { gte: from, lte: to } },
    _count: { _all: true },
    _sum: {
      subtotalIqd: true,
      deliveryFeeIqd: true,
      loyaltyDiscountIqd: true,
      commissionIqd: true,
    },
  });
  const stores = await prisma.store.findMany({
    where: { id: { in: Array.from(new Set(groups.map((group) => group.storeId))) } },
    select: {
      id: true,
      merchantId: true,
      merchant: { select: { email: true, businessName: true } },
    },
  });
  const storeById = new Map(stores.map((store) => [store.id, store]));
  const byMerchant = new Map<
    string,
    { merchantId: string; email: string; businessName: string; groups: typeof groups }
  >();
  for (const group of groups) {
    const store = storeById.get(group.storeId);
    if (!store) continue;
    if (!byMerchant.has(store.merchantId))
      byMerchant.set(store.merchantId, {
        merchantId: store.merchantId,
        email: store.merchant.email,
        businessName: store.merchant.businessName,
        groups: [],
      });
    byMerchant.get(store.merchantId)!.groups.push(group);
  }
  return {
    period: { from, to },
    totals: totalsFromGroups(groups),
    merchants: Array.from(byMerchant.values())
      .map((row) => {
        const totals = totalsFromGroups(row.groups);
        return {
          merchantId: row.merchantId,
          email: row.email,
          businessName: row.businessName,
          totals,
          deliveryToSubtotalBps: deliveryShareBps(totals),
        };
      })
      .sort((a, b) => b.totals.commissionIqd - a.totals.commissionIqd),
  };
}

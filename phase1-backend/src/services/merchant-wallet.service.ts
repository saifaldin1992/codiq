/**
 * MD-5 «محفظتي» (ق-70) — what the merchant is owed right now, and what his next
 * settlement will contain.
 *
 * This is a READ over the ledger that already exists. It writes nothing, adds no
 * table and no state that could disagree with the ledger — the ledger is
 * append-only and immutable by trigger, so the only honest wallet is one derived
 * from it on every request.
 *
 * THE NUMBER THAT MATTERS IS «SINCE THE LAST SETTLEMENT», not «since the
 * beginning». A merchant who has been paid three times does not want his
 * lifetime total; he wants to know what the next payment will be. So the window
 * opens at the end of his most recent settlement period and runs to now, and the
 * screen says which date it starts from — a figure whose window is invisible is
 * a figure that will be misread.
 *
 * Signs follow the ledger's own rule: `order_completed` adds, anything else
 * (`order_returned`, a manual adjustment) subtracts.
 *
 * That rule is currently implemented FOUR times across the codebase —
 * `totalsFromGroups` and `draftSettlement` in finance.service.ts, an inline
 * copy in analytics.service.ts, and `signedTotals` below — because none of them
 * is exported. They agree today, and the finance suite pins the wallet against a
 * settlement computed by a different one of them, so a divergence fails a test
 * rather than reaching a merchant. But four copies is three too many, and the
 * honest thing to record here is that this is a known duplication, not a shared
 * helper.
 */
import { prisma } from "../db/prisma.js";

export interface MerchantWallet {
  /** The window this balance covers — always shown, never implied. */
  period: { from: Date | null; to: Date };
  /** Null when he has never been settled: the window then runs from the start. */
  /// `Settlement` records no status column, so none is reported here — an
  /// invented «paid/unpaid» would be a claim about money that nothing backs.
  lastSettlement: { id: string; periodTo: Date; netPayoutIqd: number; createdAt: Date } | null;
  pending: {
    completedOrders: number;
    reversedOrders: number;
    subtotalIqd: number;
    deliveryFeeIqd: number;
    commissionIqd: number;
    /** 19-د: what points paid for. The courier never collected it, so it leaves the payout. */
    loyaltyDiscountIqd: number;
    /** What the platform owes him: sales plus delivery, less points and its commission. */
    netPayoutIqd: number;
  };
  lifetime: { settledCount: number; settledNetIqd: number };
}

function signedTotals(groups: { entryType: string; _count: { _all: number }; _sum: { subtotalIqd: number | null; deliveryFeeIqd: number | null; loyaltyDiscountIqd: number | null; commissionIqd: number | null } }[]) {
  const totals = { completedOrders: 0, reversedOrders: 0, subtotalIqd: 0, deliveryFeeIqd: 0, loyaltyDiscountIqd: 0, commissionIqd: 0 };
  for (const group of groups) {
    const sign = group.entryType === "order_completed" ? 1 : -1;
    if (sign === 1) totals.completedOrders += group._count._all; else totals.reversedOrders += group._count._all;
    totals.subtotalIqd += sign * (group._sum.subtotalIqd ?? 0);
    totals.deliveryFeeIqd += sign * (group._sum.deliveryFeeIqd ?? 0);
    totals.loyaltyDiscountIqd += sign * (group._sum.loyaltyDiscountIqd ?? 0);
    totals.commissionIqd += sign * (group._sum.commissionIqd ?? 0);
  }
  return totals;
}

/**
 * The payout formula, written ONCE. `Settlement` stores its components rather
 * than the total, so a wallet that computed the net differently from the
 * settlement would quietly disagree with the payment the merchant receives.
 *
 * 19-د — THE LOYALTY TERM IS NOT COSMETIC. The courier collects
 * `subtotal − coupon − points + delivery`. The ledger books `subtotal − coupon`
 * as the commissionable net, so without subtracting the points the platform
 * paid out money nobody ever paid in: goods 20,000, points 3,000, delivery
 * 3,000 collected 20,000 and this function used to answer 22,600. It is a
 * SUBTRACTION and not a smaller `subtotalIqd` on purpose — shrinking the
 * subtotal would move the commission base, and the owner decided on 2026-09-04
 * that it does not move: a coupon reduces the base («العمولة على المجموع بعد
 * الخصم», 20B-1 §8.4), redeemed points do not.
 */
function netPayout(parts: { subtotalIqd: number; deliveryFeeIqd: number; loyaltyDiscountIqd: number | null; commissionIqd: number }): number {
  return parts.subtotalIqd + parts.deliveryFeeIqd - (parts.loyaltyDiscountIqd ?? 0) - parts.commissionIqd;
}

export async function merchantWallet(merchantId: string, now = new Date()): Promise<MerchantWallet> {
  const lastSettlement = await prisma.settlement.findFirst({
    where: { merchantId },
    orderBy: [{ periodTo: "desc" }, { createdAt: "desc" }],
    select: { id: true, periodTo: true, subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true, createdAt: true },
  });
  // FROM the settled period's end, inclusive: settlements are half-open
  // `[periodFrom, periodTo)` (finance.service.ts `draftSettlement`), so an entry
  // stamped exactly on `periodTo` belongs to the NEXT period — this one. A `gt`
  // here left it in no period and on no screen.
  const from = lastSettlement?.periodTo ?? null;

  const [groups, settledAggregate] = await Promise.all([
    prisma.ledgerEntry.groupBy({
      by: ["entryType"],
      where: { store: { merchantId }, createdAt: { ...(from ? { gte: from } : {}), lte: now } },
      _count: { _all: true },
      _sum: { subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true },
    }),
    prisma.settlement.aggregate({ where: { merchantId }, _count: { _all: true }, _sum: { subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true } }),
  ]);

  const totals = signedTotals(groups);
  return {
    period: { from, to: now },
    lastSettlement: lastSettlement ? { id: lastSettlement.id, periodTo: lastSettlement.periodTo, netPayoutIqd: netPayout(lastSettlement), createdAt: lastSettlement.createdAt } : null,
    pending: { ...totals, netPayoutIqd: netPayout(totals) },
    lifetime: { settledCount: settledAggregate._count._all, settledNetIqd: netPayout({ subtotalIqd: settledAggregate._sum.subtotalIqd ?? 0, deliveryFeeIqd: settledAggregate._sum.deliveryFeeIqd ?? 0, loyaltyDiscountIqd: settledAggregate._sum.loyaltyDiscountIqd ?? 0, commissionIqd: settledAggregate._sum.commissionIqd ?? 0 }) },
  };
}

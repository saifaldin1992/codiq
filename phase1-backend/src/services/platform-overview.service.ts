/**
 * P27-13 (ق-101) — the owner's home page: what he must decide, and how the
 * platform is doing, in thirty seconds.
 *
 * WHY THIS IS A SERVER ENDPOINT AND NOT THREE FETCHES:
 *
 * The three cards it replaces each fetched a LIST and counted its length in the
 * browser. That is not merely wasteful — «عدد التجار» was WRONG the moment the
 * platform held more merchants than one page returns, and it would have gone on
 * being quietly wrong while looking like a number. ق-10 forbids exactly this
 * shape of lie: a figure the interface invented from a partial answer.
 *
 * Every number below is a database aggregate over the whole table.
 *
 * WHAT IS DELIBERATELY ABSENT, and shown in the interface as «قريباً» rather
 * than as an empty card:
 *   - operational health (stuck outbox rows, dead-lettered sends, silent stores)
 *     needs the structured logging of D-41, which is phase 24;
 *   - a cross-store activity timeline would be a NEW owner-facing surface over
 *     `store_audit_events`, and the PG-2 plan §6.4 recorded that the owner
 *     dashboard has no per-store audit surface in v1. Building one here would be
 *     scope this item did not buy, and a tenancy surface deserves its own review.
 */
import { prisma } from "../db/prisma.js";

export interface PlatformOverview {
  /** Rows that are waiting on a decision by the owner, each with somewhere to go. */
  awaiting: { key: string; count: number; href: string }[];
  scale: { merchants: number; activeMerchants: number; stores: number; activeStores: number };
  commerce: {
    period: { from: Date; to: Date };
    previous: { from: Date; to: Date };
    ordersToday: number;
    sales: { current: number; previous: number };
    commission: { current: number; previous: number };
  };
}

function windowFor(days: number, now: Date) {
  const to = now;
  const from = new Date(now.valueOf() - days * 24 * 60 * 60 * 1000);
  const previousTo = from;
  const previousFrom = new Date(from.valueOf() - days * 24 * 60 * 60 * 1000);
  return { from, to, previousFrom, previousTo };
}

/** Orders that consumed nothing are not sales, here as everywhere else. */
const NON_CONSUMING = ["cancelled", "rejected"];

export async function platformOverview(
  rawDays: unknown,
  now = new Date()
): Promise<PlatformOverview> {
  const days = Math.min(Math.max(Number(rawDays) || 30, 1), 365);
  const { from, to, previousFrom, previousTo } = windowFor(days, now);
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [
    pendingRegistrations,
    pendingUpgrades,
    merchants,
    activeMerchants,
    stores,
    activeStores,
    ordersToday,
    current,
    previous,
  ] = await Promise.all([
    prisma.merchant.count({ where: { approvalStatus: "pending" } }),
    prisma.planUpgradeRequest.count({ where: { status: "pending" } }),
    prisma.merchant.count(),
    prisma.merchant.count({ where: { isActive: true, approvalStatus: "approved" } }),
    prisma.store.count(),
    prisma.store.count({ where: { isActive: true } }),
    prisma.storeOrder.count({
      where: { createdAt: { gte: todayStart }, status: { notIn: NON_CONSUMING } },
    }),
    signedLedgerTotals({ gte: from, lte: to }),
    signedLedgerTotals({ gte: previousFrom, lt: previousTo }),
  ]);

  return {
    awaiting: [
      {
        key: "registration_requests",
        count: pendingRegistrations,
        href: "/platform/dashboard/merchants/registration-requests",
      },
      {
        key: "upgrade_requests",
        count: pendingUpgrades,
        href: "/platform/dashboard/upgrade-requests",
      },
    ],
    scale: { merchants, activeMerchants, stores, activeStores },
    commerce: {
      period: { from, to },
      previous: { from: previousFrom, to: previousTo },
      ordersToday,
      sales: { current: current.subtotalIqd, previous: previous.subtotalIqd },
      commission: { current: current.commissionIqd, previous: previous.commissionIqd },
    },
  };
}

/**
 * Audit 17-أ — the owner's first screen summed the ledger across ALL entry types
 * with no sign, while `recordOrderReturn` copies the completion's figures as
 * POSITIVE numbers. A completed-then-returned order, whose real contribution is
 * zero, showed as twice the sale and twice the commission. This applies the
 * same rule as the wallet, finance and analytics readers (see
 * `tests/ledger-sign.guard.mjs`): `order_completed` adds, every other type
 * subtracts.
 */
async function signedLedgerTotals(createdAt: { gte: Date; lte?: Date; lt?: Date }) {
  const sum = { subtotalIqd: true, commissionIqd: true } as const;
  // The one-type-adds rule, as two filters: completions add, every other type subtracts.
  const [added, subtracted] = await Promise.all([
    prisma.ledgerEntry.aggregate({ where: { createdAt, entryType: "order_completed" }, _sum: sum }),
    prisma.ledgerEntry.aggregate({
      where: { createdAt, entryType: { not: "order_completed" } },
      _sum: sum,
    }),
  ]);
  return {
    subtotalIqd: (added._sum.subtotalIqd ?? 0) - (subtracted._sum.subtotalIqd ?? 0),
    commissionIqd: (added._sum.commissionIqd ?? 0) - (subtracted._sum.commissionIqd ?? 0),
  };
}

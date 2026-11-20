/**
 * codiq phase 20B-2 — merchant analytics (D-09).
 *
 * Strictly separate aggregated GET reads (lesson D-17): every function here is
 * a pure read guarded at the route by requireStoreActor(orders.view). Nothing
 * in this module writes, and the checkout path never touches it. No caching in
 * 20B (approved decision §8.14) — a counters table is the documented future
 * path once volumes require it.
 *
 * Realized revenue comes from the append-only ledger with the SAME signed
 * semantics as finance.service.ts totalsFromGroups: order_completed adds,
 * order_returned / manual_adjustment subtract — so a return reversal lowers
 * revenue automatically and ledger.subtotal_iqd already means the DISCOUNTED
 * commissionable net (decision §8.4).
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { ORDER_STATUSES } from "./order-lifecycle.service.js";
import { LIVE } from "./soft-delete/constants.js";

const SERIES_INTERVALS = ["day", "week", "month"] as const;
export type SeriesInterval = (typeof SERIES_INTERVALS)[number];

/** Orders that never shipped carry no sales weight — same consuming definition as coupon.service.ts. */
/** Orders that consumed nothing: they must never be counted as a sale, anywhere. */
export const NON_CONSUMING_STATUSES = ["cancelled", "rejected"] as const;

function parseDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  return parsed;
}

/** Default window: the last 30 days, ending now. `from`/`to` accept ISO dates. */
function parseRange(query: Record<string, unknown>) {
  const to = parseDate(query.to, "to") ?? new Date();
  const from = parseDate(query.from, "from") ?? new Date(to.valueOf() - 30 * 24 * 60 * 60 * 1000);
  if (to <= from) throw new HttpError(400, "INVALID_DATE_FILTER", "to must be after from.");
  return { from, to };
}

function parseInterval(value: unknown): SeriesInterval {
  if (value === undefined || value === null || value === "") return "day";
  if (typeof value !== "string" || !SERIES_INTERVALS.includes(value as SeriesInterval)) {
    throw new HttpError(422, "INVALID_SERIES_INTERVAL", "interval must be day, week, or month.");
  }
  return value as SeriesInterval;
}

/**
 * Summary cards: realized revenue (signed ledger aggregate), orders count, AOV,
 * and new customers — all exact database aggregates, replacing the documented
 * «100+» page-derived approximations of the dashboard overview.
 */
export async function analyticsSummary(storeId: string, query: Record<string, unknown>) {
  const { from, to } = parseRange(query);
  const range = { gte: from, lte: to };
  const [groups, ordersCount, newCustomers, posLive, posReturned] = await Promise.all([
    prisma.ledgerEntry.groupBy({
      by: ["entryType"],
      where: { storeId, createdAt: range },
      _count: { _all: true },
      _sum: { subtotalIqd: true, deliveryFeeIqd: true, loyaltyDiscountIqd: true, commissionIqd: true },
    }),
    // Platform-carried orders only. POS sales are counted in their OWN block
    // below — mixing them here would inflate the storefront funnel with sales
    // that never had a checkout, a courier, or a plan-quota cost.
    prisma.storeOrder.count({ where: { storeId, createdAt: range, source: { not: "pos" } } }),
    prisma.customer.count({ where: { storeId, createdAt: range } }),
    // ق-135: the till's takings come from ORDERS, never the ledger — the
    // platform never held this cash, so the ledger (rightly) knows nothing of
    // it. Two aggregates, because a returned counter sale must LEAVE the
    // takings: the drawer gave the money back.
    //
    // POS offline v1: BOTH aggregates key on soldAt — the clamped sale time —
    // not createdAt (sync time), or a Monday outage flushed Tuesday inflates
    // Tuesday's takings. They must switch axes TOGETHER: completed on one
    // clock and returned on another would drift the net across two time
    // axes. Every non-POS read in this module stays on createdAt (no other
    // channel has a till clock), and the ledger blocks are untouched.
    prisma.storeOrder.aggregate({
      where: { storeId, soldAt: range, source: "pos", status: "completed" },
      _count: { _all: true },
      _sum: { totalIqd: true },
    }),
    prisma.storeOrder.aggregate({
      where: { storeId, soldAt: range, source: "pos", status: "returned" },
      _count: { _all: true },
      _sum: { totalIqd: true },
    }),
  ]);
  // The totalsFromGroups signed pattern (finance.service.ts): completed adds, everything else subtracts.
  const totals = { completedOrders: 0, reversedOrders: 0, subtotalIqd: 0, deliveryFeeIqd: 0, loyaltyDiscountIqd: 0, commissionIqd: 0 };
  for (const group of groups) {
    const sign = group.entryType === "order_completed" ? 1 : -1;
    if (sign === 1) totals.completedOrders += group._count._all; else totals.reversedOrders += group._count._all;
    totals.subtotalIqd += sign * (group._sum.subtotalIqd ?? 0);
    totals.deliveryFeeIqd += sign * (group._sum.deliveryFeeIqd ?? 0);
    totals.loyaltyDiscountIqd += sign * (group._sum.loyaltyDiscountIqd ?? 0);
    totals.commissionIqd += sign * (group._sum.commissionIqd ?? 0);
  }
  const netCompletedOrders = totals.completedOrders - totals.reversedOrders;
  // 19-د: redeemed points never arrived as cash, so they leave realized revenue
  // exactly as they leave the wallet's payout. `subtotalIqd` below stays the
  // commissionable net (decision §8.4) and is reported beside the deduction
  // rather than quietly reduced, so the two figures can still be reconciled.
  const revenueIqd = totals.subtotalIqd + totals.deliveryFeeIqd - totals.loyaltyDiscountIqd;
  return {
    period: { from, to },
    revenue: {
      // subtotal here is the ledger's commissionable net (discounted, decision §8.4).
      revenueIqd,
      subtotalIqd: totals.subtotalIqd,
      deliveryFeeIqd: totals.deliveryFeeIqd,
      loyaltyDiscountIqd: totals.loyaltyDiscountIqd,
      commissionIqd: totals.commissionIqd,
      completedOrders: totals.completedOrders,
      reversedOrders: totals.reversedOrders,
    },
    ordersCount,
    averageOrderValueIqd: netCompletedOrders > 0 ? Math.round(revenueIqd / netCompletedOrders) : 0,
    newCustomers,
    // «مبيعات المحل» — ISOLATED from everything above by design (ق-135). The
    // revenue block is money the platform carried and partly owes; this block
    // is cash already in the merchant's drawer. One number is a claim on the
    // platform, the other is a fact in the till — adding them into one figure
    // would make both unreadable.
    pos: {
      completedSales: posLive._count._all,
      returnedSales: posReturned._count._all,
      takingsIqd: (posLive._sum.totalIqd ?? 0) - (posReturned._sum.totalIqd ?? 0),
      countsTowardPlanQuota: false,
    },
  };
}

/**
 * Sales time series via raw SQL date_trunc (day|week|month), covered by the
 * existing (store_id, created_at, id) index. Cancelled/rejected orders never
 * shipped, so they are excluded from the sales curve.
 */
export async function salesSeries(storeId: string, query: Record<string, unknown>) {
  const { from, to } = parseRange(query);
  const interval = parseInterval(query.interval);
  // `interval` is validated against the closed SERIES_INTERVALS allowlist above
  // and still travels as a bound parameter, never interpolated SQL.
  const rows = await prisma.$queryRaw<Array<{ bucket: Date; orders_count: number; total_iqd: number }>>(Prisma.sql`
    SELECT date_trunc(${interval}, created_at) AS bucket,
           COUNT(*)::int AS orders_count,
           COALESCE(SUM(total_iqd), 0)::int AS total_iqd
    FROM store_orders
    WHERE store_id = ${storeId}::uuid
      AND created_at >= ${from} AND created_at <= ${to}
      AND status NOT IN (${Prisma.join([...NON_CONSUMING_STATUSES])})
      -- ق-136: the sales curve sits above LEDGER-derived revenue cards, so it
      -- must draw the same money. Counter sales live in their own pos block.
      AND source <> 'pos'
    GROUP BY 1
    ORDER BY 1 ASC
  `);
  return {
    period: { from, to },
    interval,
    series: rows.map((row) => ({ bucketStart: row.bucket, ordersCount: row.orders_count, totalIqd: row.total_iqd })),
  };
}

/**
 * Variant-aware best sellers: order_items JOIN store_orders grouped by
 * (product_id, variant_id) so two variants of one product rank independently.
 * Names/SKUs come from the immutable order-item snapshots.
 */
export async function topProducts(storeId: string, query: Record<string, unknown>) {
  const { from, to } = parseRange(query);
  const by = query.by === undefined || query.by === "" || query.by === "revenue" ? "revenue" : query.by === "units" ? "units" : null;
  if (!by) throw new HttpError(422, "INVALID_TOP_PRODUCTS_SORT", "by must be revenue or units.");
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 50);
  const rows = await prisma.$queryRaw<Array<{ product_id: string | null; variant_id: string | null; product_name: string; variant_name: string | null; sku: string | null; units: number; revenue_iqd: number }>>(Prisma.sql`
    SELECT oi.product_id, oi.variant_id,
           MAX(oi.product_name) AS product_name,
           MAX(oi.variant_name) AS variant_name,
           MAX(oi.sku) AS sku,
           SUM(oi.quantity)::int AS units,
           SUM(oi.line_total_iqd)::int AS revenue_iqd
    FROM order_items oi
    JOIN store_orders o ON o.id = oi.order_id
    WHERE o.store_id = ${storeId}::uuid
      AND o.created_at >= ${from} AND o.created_at <= ${to}
      AND o.status NOT IN (${Prisma.join([...NON_CONSUMING_STATUSES])})
      -- ق-136: revenue_iqd here sits beside ledger-derived cards; counter
      -- cash would make the two irreconcilable. A cross-channel bestseller
      -- view can come later as its own explicit toggle.
      AND o.source <> 'pos'
    GROUP BY oi.product_id, oi.variant_id
    ORDER BY ${Prisma.raw(by === "units" ? "units" : "revenue_iqd")} DESC, product_name ASC
    LIMIT ${limit}
  `);
  return {
    period: { from, to },
    by,
    products: rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      productName: row.product_name,
      variantName: row.variant_name,
      sku: row.sku,
      units: row.units,
      revenueIqd: row.revenue_iqd,
    })),
  };
}

/** Exact per-status counts for the funnel bars (and the overview cards). */
export async function statusFunnel(storeId: string, query: Record<string, unknown>) {
  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  const groups = await prisma.storeOrder.groupBy({
    by: ["status"],
    // ق-136: a POS sale is born completed and never travels the funnel, so
    // counting it here would inflate the terminal bar of a journey it never
    // took. The till's numbers live in the pos block of the summary.
    where: { storeId, source: { not: "pos" }, ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
    _count: { _all: true },
  });
  const countByStatus = new Map(groups.map((group) => [group.status, group._count._all]));
  return { funnel: ORDER_STATUSES.map((status) => ({ status, count: countByStatus.get(status) ?? 0 })) };
}

/** Customer segments per the approved pass-A definitions (customer-directory.service.ts). */
export async function customersSummary(storeId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [total, recent, active] = await Promise.all([
    prisma.customer.count({ where: { storeId } }),
    prisma.customer.count({ where: { storeId, createdAt: { gte: thirtyDaysAgo } } }),
    prisma.customer.count({ where: { storeId, orders: { some: {} } } }),
  ]);
  return { totalCustomers: total, newCustomers: recent, activeCustomers: active, prospectCustomers: total - active };
}

/**
 * Coupon usage for «تقارير التسويق»: uses/discount totals count ONLY
 * redemptions whose order still consumes (status not cancelled/rejected) —
 * the exact consuming definition of coupon.service.ts — while
 * redemptionsTotal keeps the raw append-only row count for honesty.
 */
export async function couponsUsage(storeId: string) {
  const [coupons, consuming, raw] = await Promise.all([
    prisma.coupon.findMany({
      // PG-2 LIVE. The $queryRaw on order_items above is NOT filtered — it reads
      // snapshots of what was sold, which stay true whatever happened to the row.
      where: { storeId, ...LIVE },
      select: { id: true, code: true, kind: true, isActive: true, maxUsesTotal: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      where: { storeId, order: { status: { notIn: [...NON_CONSUMING_STATUSES] } } },
      _count: { _all: true },
      _sum: { discountIqd: true, waivedDeliveryFeeIqd: true },
    }),
    prisma.couponRedemption.groupBy({ by: ["couponId"], where: { storeId }, _count: { _all: true } }),
  ]);
  const consumingById = new Map(consuming.map((group) => [group.couponId, group]));
  const rawById = new Map(raw.map((group) => [group.couponId, group._count._all]));
  return {
    coupons: coupons.map((coupon) => {
      const usage = consumingById.get(coupon.id);
      return {
        id: coupon.id,
        code: coupon.code,
        kind: coupon.kind,
        isActive: coupon.isActive,
        maxUsesTotal: coupon.maxUsesTotal,
        consumingUses: usage?._count._all ?? 0,
        redemptionsTotal: rawById.get(coupon.id) ?? 0,
        discountIqd: usage?._sum.discountIqd ?? 0,
        waivedDeliveryFeeIqd: usage?._sum.waivedDeliveryFeeIqd ?? 0,
      };
    }),
  };
}

/**
 * ق-202 — the merchant's home page, in one fetch.
 *
 * The page is being rebuilt to the reference dashboard's arrangement: four
 * headline numbers compared with yesterday, then the key indicators over a
 * date range (orders by status, by payment method, by hour, the best sellers,
 * the most viewed, low stock), the balance, and the latest orders. Every card
 * used to fetch on its own; a home page that makes twelve requests is a home
 * page that flickers. One aggregate, one request, one loading state.
 *
 * WHAT «TODAY» MEANS: the Baghdad calendar day. A merchant's day ends at his
 * midnight, not at 03:00 — the reference dashboard itself apologises for UTC
 * on its hourly chart (D-104). «Sales» is the value of real, platform-carried
 * orders placed that day: cancelled and rejected orders are not sales, and a
 * counter sale never had a storefront (the same two exclusions everywhere).
 * «Conversion» is orders over UNIQUE visitors, and is null — not 0 — on a day
 * nobody came, because a ratio invented from a division by zero is a lie.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import { NON_CONSUMING_STATUSES, topProducts } from "./analytics.service.js";
import { merchantWallet } from "./merchant-wallet.service.js";
import { baghdadDay, baghdadDayBounds, daysBefore, mostViewed, trafficByDay } from "./store-traffic.service.js";

const NOT_A_SALE: string[] = [...NON_CONSUMING_STATUSES];
const REAL_ORDERS = { source: { not: "pos" }, status: { notIn: NOT_A_SALE } };
const DEFAULT_RANGE_DAYS = 7;

function parseDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  return parsed;
}

/** Default: the last seven Baghdad days, today included. */
function parseRange(query: Record<string, unknown>, now: Date) {
  const to = parseDate(query.to, "to") ?? now;
  const from = parseDate(query.from, "from") ?? baghdadDayBounds(daysBefore(baghdadDay(to), DEFAULT_RANGE_DAYS - 1)).from;
  if (to <= from) throw new HttpError(400, "INVALID_DATE_FILTER", "to must be after from.");
  return { from, to };
}

/** Prisma types a groupBy `_count` as `true | {...}`; only the object shape ever arrives. */
function countOf(count: true | { _all?: number } | undefined): number {
  return count && count !== true ? count._all ?? 0 : 0;
}

export interface DaySummary { day: string; salesIqd: number; ordersCount: number; visits: number; visitors: number; conversionPct: number | null }

async function daySummary(storeId: string, day: string, traffic: { visits: number; visitors: number }): Promise<DaySummary> {
  const bounds = baghdadDayBounds(day);
  const [sales, ordersCount] = await Promise.all([
    prisma.storeOrder.aggregate({ where: { storeId, createdAt: { gte: bounds.from, lt: bounds.to }, ...REAL_ORDERS }, _sum: { totalIqd: true } }),
    prisma.storeOrder.count({ where: { storeId, createdAt: { gte: bounds.from, lt: bounds.to }, ...REAL_ORDERS } }),
  ]);
  return {
    day,
    salesIqd: sales._sum?.totalIqd ?? 0,
    ordersCount,
    visits: traffic.visits,
    visitors: traffic.visitors,
    conversionPct: traffic.visitors > 0 ? Math.round((ordersCount / traffic.visitors) * 1000) / 10 : null,
  };
}

/**
 * Audit 14-أ: the wallet is the MERCHANT's money across ALL his stores. The home
 * page is guarded by `orders.view`, which the lowest staff role holds, so the
 * balance is computed and returned only when the caller is the merchant himself.
 */
export async function merchantHome(storeId: string, merchantId: string, query: Record<string, unknown>, now: Date = new Date(), options: { includeWallet: boolean } = { includeWallet: false }) {
  const today = baghdadDay(now);
  const yesterday = daysBefore(today, 1);
  const { from, to } = parseRange(query, now);
  const rangeWhere = { storeId, createdAt: { gte: from, lte: to }, source: { not: "pos" } } as const;

  const traffic = await trafficByDay(storeId, [today, yesterday]);
  const [store, todaySummary, yesterdaySummary, wallet, byStatus, byPayment, byHourRows, top, viewed, lowStockCount, lowStockProducts, recentOrders] = await Promise.all([
    // The identity strip and the verification banner: what the shop is called,
    // where it lives, whether the platform has vouched for it, and its address.
    prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { name: true, slug: true, defaultSubdomain: true, customDomain: true, verifiedAt: true, addressLine: true, city: true, supportPhone: true, guestCheckoutEnabled: true, logoObjectKey: true } }),
    daySummary(storeId, today, traffic.get(today)!),
    daySummary(storeId, yesterday, traffic.get(yesterday)!),
    options.includeWallet ? merchantWallet(merchantId, now) : Promise.resolve(null),
    prisma.storeOrder.groupBy({ by: ["status"], where: rangeWhere, _count: { _all: true }, _sum: { totalIqd: true } }),
    prisma.storeOrder.groupBy({ by: ["paymentMethodCode"], where: { ...rangeWhere, status: REAL_ORDERS.status }, _count: { _all: true }, _sum: { totalIqd: true } }),
    // D-104: hours in Baghdad time. `AT TIME ZONE` on a timestamptz yields the
    // wall-clock time there; the hour of THAT is what the merchant means.
    prisma.$queryRaw<Array<{ hour: number; count: bigint | number }>>(Prisma.sql`
      SELECT EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Asia/Baghdad'))::int AS hour, COUNT(*) AS count
        FROM store_orders
       WHERE store_id = ${storeId}::uuid
         AND created_at >= ${from} AND created_at <= ${to}
         AND source <> 'pos'
         AND status NOT IN ('cancelled', 'rejected')
       GROUP BY 1`),
    topProducts(storeId, { from: from.toISOString(), to: to.toISOString(), by: "units", limit: 5 }),
    mostViewed(storeId, baghdadDay(from), baghdadDay(to), 5),
    // `is_low_stock` is a generated column, so this is an exact count and not a
    // page of the catalog list with an overflow marker.
    prisma.product.count({ where: { storeId, isActive: true, deletedAt: null, isLowStock: true } }),
    prisma.product.findMany({ where: { storeId, isActive: true, deletedAt: null, isLowStock: true }, orderBy: [{ stockQuantity: "asc" }, { name: "asc" }], take: 5, select: { id: true, name: true, stockQuantity: true, lowStockThreshold: true } }),
    prisma.storeOrder.findMany({ where: { storeId, source: { not: "pos" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8, select: { id: true, orderNumber: true, status: true, totalIqd: true, customerName: true, createdAt: true, paymentMethodCode: true, paymentStatus: true } }),
  ]);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const row of byHourRows) byHour[row.hour]!.count = Number(row.count);

  return {
    store: {
      name: store.name, slug: store.slug, defaultSubdomain: store.defaultSubdomain, customDomain: store.customDomain, verifiedAt: store.verifiedAt,
      addressLine: store.addressLine, city: store.city, supportPhone: store.supportPhone, guestCheckoutEnabled: store.guestCheckoutEnabled, hasLogo: Boolean(store.logoObjectKey),
    },
    today: todaySummary,
    yesterday: yesterdaySummary,
    range: { from, to },
    byStatus: byStatus.map((group) => ({ status: group.status, count: countOf(group._count), totalIqd: group._sum?.totalIqd ?? 0 })),
    byPaymentMethod: byPayment.map((group) => ({ code: group.paymentMethodCode, count: countOf(group._count), totalIqd: group._sum?.totalIqd ?? 0 })),
    byHour,
    topProducts: top.products.map((product) => ({ productId: product.productId, name: product.productName, units: product.units, revenueIqd: product.revenueIqd })),
    mostViewed: viewed,
    lowStock: { count: lowStockCount, products: lowStockProducts },
    // The balance is the MERCHANT's, across his stores — one wallet, one payout.
    wallet: wallet ? { pendingNetIqd: wallet.pending.netPayoutIqd, pendingOrders: wallet.pending.completedOrders, lastSettlement: wallet.lastSettlement } : null,
    recentOrders,
  };
}

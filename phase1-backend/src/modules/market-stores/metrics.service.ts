/**
 * The market-metrics job: read each store's facts in one SQL pass, judge them
 * (market-score.ts), and upsert store_market_metrics. Hourly from the worker's
 * scheduler, on demand from the owner's screen, and for one store when its
 * merchant opens «ملفّي في السوق» on stale numbers.
 *
 * POS sales are left out on purpose: the market reputation is about how a
 * store treats ONLINE shoppers it never meets.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { judgeStore, type StoreFacts } from "./market-score.js";

type FactRow = {
  store_id: string;
  completed: number; completed_30d: number; settled: number; cancelled: number;
  median_minutes: number | null; customers: number; repeat_customers: number;
  rating_avg: number | null; rating_count: number; products: number; in_stock: number; views_30d: number;
};

/** Stores the directory may show or is about to: listed and waiting for a decision. */
const JUDGED_STATUSES = ["listed", "pending"];

async function readFacts(storeIds: readonly string[]): Promise<FactRow[]> {
  if (storeIds.length === 0) return [];
  const ids = Prisma.sql`SELECT unnest(${storeIds}::uuid[]) AS id`;
  return prisma.$queryRaw<FactRow[]>`
    WITH s AS (${ids}),
    o AS (
      SELECT store_id,
             count(*) FILTER (WHERE status = 'completed')::int AS completed,
             count(*) FILTER (WHERE status = 'completed' AND created_at > now() - interval '30 days')::int AS completed_30d,
             count(*) FILTER (WHERE status IN ('completed','cancelled','rejected','returned'))::int AS settled,
             count(*) FILTER (WHERE status IN ('cancelled','rejected'))::int AS cancelled
        FROM store_orders
       WHERE store_id IN (SELECT id FROM s) AND source <> 'pos' AND created_at > now() - interval '180 days'
       GROUP BY store_id),
    r AS (
      SELECT o.store_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_move.at - o.created_at) / 60) AS median_minutes
        FROM store_orders o
        JOIN LATERAL (SELECT min(e.created_at) AS at FROM order_status_events e
                       WHERE e.order_id = o.id AND e.store_id = o.store_id AND e.from_status = 'new') first_move ON first_move.at IS NOT NULL
       WHERE o.store_id IN (SELECT id FROM s) AND o.source <> 'pos' AND o.created_at > now() - interval '90 days'
       GROUP BY o.store_id),
    c AS (
      SELECT store_id, count(*)::int AS customers, count(*) FILTER (WHERE n >= 2)::int AS repeat_customers
        FROM (SELECT store_id, customer_id, count(*) AS n FROM store_orders
               WHERE status = 'completed' AND customer_id IS NOT NULL AND source <> 'pos' AND store_id IN (SELECT id FROM s)
               GROUP BY store_id, customer_id) per_customer
       GROUP BY store_id),
    v AS (SELECT store_id, sum(visits)::int AS views_30d FROM store_visits_daily
           WHERE day > current_date - 30 AND store_id IN (SELECT id FROM s) GROUP BY store_id),
    rv AS (SELECT store_id, avg(rating)::float8 AS rating_avg, count(*)::int AS rating_count FROM product_reviews
            WHERE withdrawn_at IS NULL AND store_id IN (SELECT id FROM s) GROUP BY store_id),
    p AS (
      SELECT pr.store_id, count(*)::int AS products,
             count(*) FILTER (WHERE pr.stock_quantity > 0 OR EXISTS (
               SELECT 1 FROM product_variants pv
                WHERE pv.product_id = pr.id AND pv.store_id = pr.store_id AND pv.is_active AND pv.deleted_at IS NULL AND pv.stock_quantity > 0))::int AS in_stock
        FROM products pr
       WHERE pr.is_active AND pr.deleted_at IS NULL AND pr.store_id IN (SELECT id FROM s)
       GROUP BY pr.store_id)
    SELECT s.id AS store_id,
           COALESCE(o.completed, 0) AS completed, COALESCE(o.completed_30d, 0) AS completed_30d,
           COALESCE(o.settled, 0) AS settled, COALESCE(o.cancelled, 0) AS cancelled,
           r.median_minutes::float8 AS median_minutes,
           COALESCE(c.customers, 0) AS customers, COALESCE(c.repeat_customers, 0) AS repeat_customers,
           rv.rating_avg, COALESCE(rv.rating_count, 0) AS rating_count,
           COALESCE(p.products, 0) AS products, COALESCE(p.in_stock, 0) AS in_stock,
           COALESCE(v.views_30d, 0) AS views_30d
      FROM s
      LEFT JOIN o ON o.store_id = s.id LEFT JOIN r ON r.store_id = s.id LEFT JOIN c ON c.store_id = s.id
      LEFT JOIN v ON v.store_id = s.id LEFT JOIN rv ON rv.store_id = s.id LEFT JOIN p ON p.store_id = s.id`;
}

function factsOf(row: FactRow): StoreFacts {
  return {
    completedOrders: row.completed,
    completedOrders30d: row.completed_30d,
    settledOrders: row.settled,
    cancelledOrders: row.cancelled,
    medianResponseMinutes: row.median_minutes === null ? null : Math.round(row.median_minutes),
    customers: row.customers,
    repeatCustomers: row.repeat_customers,
    ratingAvg: row.rating_avg,
    ratingCount: row.rating_count,
    productCount: row.products,
    inStockProducts: row.in_stock,
    maxDiscountPercent: null,
  };
}

const round = (value: number | null, places: number) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

/** Recompute the given stores, or every listed/pending store. Returns how many rows were written. */
export async function recomputeMarketMetrics(storeIds?: readonly string[]): Promise<{ stores: number }> {
  const ids = storeIds ?? (await prisma.store.findMany({ where: { marketStatus: { in: JUDGED_STATUSES } }, select: { id: true } })).map((row) => row.id);
  let written = 0;
  // Batches keep each statement's id array and the upsert transaction small at a thousand stores.
  for (let start = 0; start < ids.length; start += 200) {
    const rows = await readFacts(ids.slice(start, start + 200));
    await prisma.$transaction(rows.map((row) => {
      const facts = factsOf(row);
      const verdict = judgeStore(facts);
      const data = {
        score: verdict.score,
        tier: verdict.tier,
        ratingAvg: round(facts.ratingAvg, 2),
        ratingCount: facts.ratingCount,
        completedOrders: facts.completedOrders,
        completedOrders30d: facts.completedOrders30d,
        cancelRate: round(verdict.cancelRate, 4),
        repeatRate: round(verdict.repeatRate, 4),
        medianResponseMinutes: facts.medianResponseMinutes,
        inStockRate: round(verdict.inStockRate, 4),
        views30d: row.views_30d,
        productCount: facts.productCount,
        badges: verdict.badges,
        computedAt: new Date(),
      };
      return prisma.storeMarketMetrics.upsert({ where: { storeId: row.store_id }, create: { storeId: row.store_id, ...data }, update: data });
    }));
    written += rows.length;
  }
  return { stores: written };
}

const STALE_AFTER_MS = 10 * 60 * 1000;
/** For the merchant's own screen: recompute one store when its numbers are older than ten minutes. */
export async function freshMetricsFor(storeId: string) {
  const current = await prisma.storeMarketMetrics.findUnique({ where: { storeId } });
  if (current && Date.now() - current.computedAt.getTime() < STALE_AFTER_MS) return current;
  await recomputeMarketMetrics([storeId]);
  return prisma.storeMarketMetrics.findUnique({ where: { storeId } });
}

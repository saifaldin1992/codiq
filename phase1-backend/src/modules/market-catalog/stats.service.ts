/**
 * Per-product numbers for the market lists (product_market_stats): units sold
 * in four windows, views in two, and the star average. One SQL statement per
 * batch of stores; hourly from the worker, beside the store reputation job.
 * Units, not orders: «الأكثر مبيعاً» is about the product. Cancelled and
 * rejected orders do not count; POS sales do not either (the market is online).
 */
import { prisma } from "../../db/prisma.js";

export async function recomputeProductStats(
  storeIds?: readonly string[]
): Promise<{ products: number }> {
  const ids =
    storeIds ??
    (
      await prisma.store.findMany({
        where: { marketStatus: { in: ["listed", "pending"] } },
        select: { id: true },
      })
    ).map((row) => row.id);
  let written = 0;
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    written += await prisma.$executeRaw`
      WITH s AS (SELECT unnest(${batch}::uuid[]) AS id),
      sold AS (
        SELECT oi.product_id,
               sum(oi.quantity) FILTER (WHERE o.created_at > now() - interval '1 day')::int AS d1,
               sum(oi.quantity) FILTER (WHERE o.created_at > now() - interval '7 days')::int AS d7,
               sum(oi.quantity) FILTER (WHERE o.created_at > now() - interval '30 days')::int AS d30,
               sum(oi.quantity)::int AS d90
          FROM order_items oi
          JOIN store_orders o ON o.id = oi.order_id
         WHERE o.store_id IN (SELECT id FROM s) AND oi.product_id IS NOT NULL AND o.source <> 'pos'
           AND o.status NOT IN ('cancelled', 'rejected') AND o.created_at > now() - interval '90 days'
         GROUP BY oi.product_id),
      viewed AS (
        SELECT product_id,
               sum(views) FILTER (WHERE day > current_date - 7)::int AS w7,
               sum(views)::int AS w30
          FROM product_views_daily
         WHERE store_id IN (SELECT id FROM s) AND day > current_date - 30
         GROUP BY product_id),
      rated AS (
        SELECT product_id, avg(rating)::numeric(3,2) AS avg_rating, count(*)::int AS n
          FROM product_reviews
         WHERE store_id IN (SELECT id FROM s) AND withdrawn_at IS NULL
         GROUP BY product_id)
      INSERT INTO product_market_stats (product_id, store_id, rating_avg, rating_count, sold_1d, sold_7d, sold_30d, sold_90d, views_7d, views_30d, computed_at)
      SELECT p.id, p.store_id, rated.avg_rating, COALESCE(rated.n, 0),
             COALESCE(sold.d1, 0), COALESCE(sold.d7, 0), COALESCE(sold.d30, 0), COALESCE(sold.d90, 0),
             COALESCE(viewed.w7, 0), COALESCE(viewed.w30, 0), now()
        FROM products p
        LEFT JOIN sold ON sold.product_id = p.id
        LEFT JOIN viewed ON viewed.product_id = p.id
        LEFT JOIN rated ON rated.product_id = p.id
       WHERE p.store_id IN (SELECT id FROM s) AND p.deleted_at IS NULL
      ON CONFLICT (product_id) DO UPDATE SET
        rating_avg = EXCLUDED.rating_avg, rating_count = EXCLUDED.rating_count,
        sold_1d = EXCLUDED.sold_1d, sold_7d = EXCLUDED.sold_7d, sold_30d = EXCLUDED.sold_30d, sold_90d = EXCLUDED.sold_90d,
        views_7d = EXCLUDED.views_7d, views_30d = EXCLUDED.views_30d, computed_at = EXCLUDED.computed_at`;
  }
  return { products: written };
}

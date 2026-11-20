/**
 * MD-3, second half — «سينفد خلال ~N أيام».
 *
 * An upgrade to the low-stock alert that already exists. «مخزون منخفض» tells a
 * merchant a number he can already see; «يكفي 4 أيام بمعدل بيعك الأخير» tells
 * him whether to reorder today, which is the decision he actually has.
 *
 * WHAT THIS REFUSES TO SAY. A forecast is a claim about the future and this one
 * is built from fourteen days of sales, so:
 *
 *   - a product that sold NOTHING in the window gets no forecast at all. Its
 *     rate is zero, "days remaining" is infinity, and printing «∞» or «آمن» would
 *     be a promise made from an absence of evidence;
 *   - a product with fewer than MIN_UNITS sold gets no forecast either. Two
 *     units in a fortnight is not a rate, it is a coincidence, and dividing by
 *     it produces a confident-looking number built on nothing;
 *   - the number is stated as an approximation, from a named window, and the
 *     window travels with it so the screen can say where it came from.
 *
 * The whole point is that a merchant can tell how much to trust it.
 */
import { prisma } from "../db/prisma.js";
import { LIVE } from "./soft-delete/constants.js";

/** Days of history the rate is measured over. */
export const FORECAST_WINDOW_DAYS = 14;
/** Below this many units sold in the window there is no rate worth quoting. */
export const FORECAST_MIN_UNITS = 3;
/** Statuses whose items never left the shelf, so they never count as demand. */
const NON_SELLING_STATUSES = ["cancelled", "rejected", "returned"];

export interface StockForecast {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  stockQuantity: number;
  /** Units sold across the window. */
  soldInWindow: number;
  /** Units per day, rounded to two places — shown so the estimate can be judged. */
  dailyRate: number;
  /** Whole days until the shelf is empty at that rate. Null when no rate qualifies. */
  daysRemaining: number | null;
  windowDays: number;
}

/**
 * The store's variants that HAVE a usable rate, most urgent first — soonest to
 * run out at the front.
 *
 * Variants below FORECAST_MIN_UNITS are absent from this list, and the screen
 * that renders it must say so: this is a list of what is running out, not a
 * stock report. A product missing from it has not sold enough to forecast, which
 * is not the same as being well stocked, and a UI that implies otherwise would
 * make the omission a claim.
 */
export async function stockForecasts(storeId: string, options: { now?: Date; limit?: number } = {}): Promise<StockForecast[]> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const since = new Date(now.getTime() - FORECAST_WINDOW_DAYS * 86_400_000);

  const rows = await prisma.$queryRaw<Array<{
    variant_id: string; product_id: string; name: string; sku: string | null; stock_quantity: number; sold: number;
  }>>`
    SELECT v.id            AS variant_id,
           v.product_id    AS product_id,
           p.name || CASE WHEN v.is_default THEN '' ELSE ' — ' || v.name END AS name,
           v.sku           AS sku,
           v.stock_quantity AS stock_quantity,
           COALESCE(SUM(oi.quantity) FILTER (
             WHERE o.created_at >= ${since}
               AND o.status NOT IN ('cancelled', 'rejected', 'returned')
           ), 0)::int AS sold
      FROM product_variants v
      JOIN products p ON p.id = v.product_id AND p.store_id = v.store_id
      -- order_items carries no store_id; the ORDER is what belongs to a store,
      -- so the tenancy filter rides on the join to store_orders below.
      LEFT JOIN order_items oi ON oi.variant_id = v.id
      LEFT JOIN store_orders o ON o.id = oi.order_id AND o.store_id = v.store_id
     WHERE v.store_id = ${storeId}::uuid
       AND v.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND p.is_active = true
     GROUP BY v.id, v.product_id, p.name, v.name, v.is_default, v.sku, v.stock_quantity
    HAVING COALESCE(SUM(oi.quantity) FILTER (
             WHERE o.created_at >= ${since}
               AND o.status NOT IN ('cancelled', 'rejected', 'returned')
           ), 0) >= ${FORECAST_MIN_UNITS}
     ORDER BY v.stock_quantity::numeric / GREATEST(COALESCE(SUM(oi.quantity) FILTER (
             WHERE o.created_at >= ${since}
               AND o.status NOT IN ('cancelled', 'rejected', 'returned')
           ), 0), 1) ASC
     LIMIT ${limit}`;

  return rows.map((row) => {
    const dailyRate = row.sold / FORECAST_WINDOW_DAYS;
    return {
      productId: row.product_id,
      variantId: row.variant_id,
      name: row.name,
      sku: row.sku,
      stockQuantity: row.stock_quantity,
      soldInWindow: row.sold,
      dailyRate: Math.round(dailyRate * 100) / 100,
      // Floor, not round: telling a merchant he has 3 days when he has 3.9 is a
      // day of slack; telling him 4 when he has 3.1 is a stockout.
      daysRemaining: dailyRate > 0 ? Math.floor(row.stock_quantity / dailyRate) : null,
      windowDays: FORECAST_WINDOW_DAYS,
    };
  });
}

/** The forecast for ONE variant, or null when it has not sold enough to have one. */
export async function stockForecastFor(storeId: string, variantId: string, now = new Date()): Promise<StockForecast | null> {
  const since = new Date(now.getTime() - FORECAST_WINDOW_DAYS * 86_400_000);
  const [variant, sold] = await Promise.all([
    prisma.productVariant.findFirst({
      where: { id: variantId, storeId, ...LIVE },
      select: { id: true, productId: true, sku: true, name: true, isDefault: true, stockQuantity: true, product: { select: { name: true } } },
    }),
    prisma.orderItem.aggregate({
      // Scoped through the ORDER: order_items carries no store_id at all (see the
      // join in stockForecasts above), so the order is the only thing that
      // belongs to a store and the tenancy filter has to ride on it.
      where: { variantId, order: { storeId, createdAt: { gte: since }, status: { notIn: NON_SELLING_STATUSES } } },
      _sum: { quantity: true },
    }),
  ]);
  if (!variant) return null;
  const soldInWindow = sold._sum?.quantity ?? 0;
  if (soldInWindow < FORECAST_MIN_UNITS) return null;
  const dailyRate = soldInWindow / FORECAST_WINDOW_DAYS;
  return {
    productId: variant.productId,
    variantId: variant.id,
    name: variant.isDefault ? variant.product.name : `${variant.product.name} — ${variant.name}`,
    sku: variant.sku,
    stockQuantity: variant.stockQuantity,
    soldInWindow,
    dailyRate: Math.round(dailyRate * 100) / 100,
    daysRemaining: Math.floor(variant.stockQuantity / dailyRate),
    windowDays: FORECAST_WINDOW_DAYS,
  };
}

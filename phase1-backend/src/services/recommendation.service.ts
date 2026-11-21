/**
 * CD-4 «يُشترى معه عادة» — what real shoppers actually bought alongside this.
 *
 * WHAT MAKES THIS HONEST IS THE WORD «عادة». One person who once bought a shirt
 * and a phone charger in the same basket is a coincidence, not a pattern, and
 * presenting it as one teaches a shopper that the section is noise — after which
 * the genuine recommendations are worth nothing either. So a pair must have been
 * bought together in at least MIN_ORDERS_TOGETHER separate orders, and a product
 * with nothing that clears that bar shows NO section at all rather than a thin
 * one padded with single coincidences.
 *
 * COUNTED IN ORDERS, NOT IN LINES. `count(DISTINCT o.id)`, because one order
 * that happens to carry the same product on two lines is still one shopper
 * deciding once. Counting rows would let a single basket manufacture a pattern.
 *
 * CANCELLED AND REJECTED ORDERS ARE NOT EVIDENCE. Nobody carried those goods
 * home together; an order refused at the door tells us nothing about what goes
 * with what.
 *
 * NOTHING UNBUYABLE IS RECOMMENDED. A trashed, switched-off or entirely
 * out-of-stock product sends a shopper to a page he cannot buy from, which is
 * worse than showing him nothing.
 *
 * COMPUTED LIVE, not cached. The query is bounded by one product and a small
 * limit, and both sides of the self-join are indexed (`order_items.product_id`,
 * `order_items.order_id`). A materialised table would be a second copy of the
 * truth that goes stale exactly when a merchant changes his catalogue.
 */
import { prisma } from "../db/prisma.js";
import { categoryFilterIds } from "./storefront.service.js";

export interface RelatedProduct {
  productId: string;
  name: string;
  priceIqd: number;
  imageId: string | null;
}

/**
 * ق-200 «عناصر قد تعجبك» — same-category siblings, newest first.
 *
 * A SECOND, clearly separate rail from «يُشترى معه عادة»: this one carries no
 * evidence and must never be labelled as something people bought together.
 * It exists because the evidence-based rail is empty on every new store and on
 * every product without three shared orders, and a product page that simply
 * ends is a dead end. A parent category rolls its descendants up, exactly as
 * the catalog filter does; nothing unbuyable is offered, for the same reason
 * as above.
 */
export async function relatedByCategory(
  storeId: string,
  productId: string,
  options: { limit?: number } = {}
): Promise<{ related: RelatedProduct[] }> {
  const limit = Math.min(Math.max(options.limit ?? 4, 1), 12);
  // A trashed product has no siblings to offer — the PG-2 leak rule applies to reads, not only to lists.
  const product = await prisma.product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    select: { categoryId: true },
  });
  if (!product?.categoryId) return { related: [] };
  const categoryIds = await categoryFilterIds(storeId, product.categoryId);
  const rows = await prisma.product.findMany({
    where: {
      storeId,
      isActive: true,
      deletedAt: null,
      id: { not: productId },
      categoryId: { in: categoryIds },
      variants: { some: { isActive: true, deletedAt: null, stockQuantity: { gt: 0 } } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      name: true,
      priceIqd: true,
      images: { select: { id: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 1 },
    },
  });
  return {
    related: rows.map((row) => ({
      productId: row.id,
      name: row.name,
      priceIqd: row.priceIqd,
      imageId: row.images[0]?.id ?? null,
    })),
  };
}

/** Below this many separate orders, a pairing is a coincidence, not a habit. */
export const MIN_ORDERS_TOGETHER = 3;
/** How many to offer. More than a handful stops being a recommendation. */
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 12;

export interface Recommendation {
  productId: string;
  name: string;
  priceIqd: number;
  /** Separate orders in which the two were bought together. Sent so the UI can be specific. */
  ordersTogether: number;
  imageId: string | null;
}

export async function boughtTogether(
  storeId: string,
  productId: string,
  options: { limit?: number } = {}
): Promise<{ minOrdersTogether: number; recommendations: Recommendation[] }> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await prisma.$queryRaw<
    Array<{
      product_id: string;
      name: string;
      price_iqd: number;
      orders_together: bigint;
      image_id: string | null;
    }>
  >`
    SELECT other.product_id                AS product_id,
           MAX(p.name)                     AS name,
           MAX(p.price_iqd)                AS price_iqd,
           count(DISTINCT o.id)            AS orders_together,
           -- The COVER image, the one the product page itself shows: lowest
           -- sort_order, tie-broken by id. An aggregate over all images would
           -- have picked an arbitrary photo, so a product could appear here
           -- wearing a different face than on its own page.
           MIN(cover.id::text)             AS image_id
      FROM order_items mine
      JOIN store_orders o
        ON o.id = mine.order_id
       AND o.store_id = ${storeId}::uuid
       AND o.status NOT IN ('cancelled', 'rejected')
      JOIN order_items other
        ON other.order_id = mine.order_id
       AND other.product_id IS NOT NULL
       AND other.product_id <> mine.product_id
      -- The partner must still be a product this store can sell today.
      JOIN products p
        ON p.id = other.product_id
       AND p.store_id = ${storeId}::uuid
       AND p.is_active = true
       AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT i.id
          FROM product_images i
         WHERE i.product_id = p.id AND i.store_id = p.store_id
         ORDER BY i.sort_order ASC, i.id ASC
         LIMIT 1
      ) cover ON true
     WHERE mine.product_id = ${productId}::uuid
       -- Something of it must actually be on a shelf. Recommending a product
       -- whose every variant is at zero is an invitation to a dead end.
       AND EXISTS (
         SELECT 1 FROM product_variants v
          WHERE v.product_id = p.id
            AND v.store_id = p.store_id
            AND v.is_active = true
            AND v.deleted_at IS NULL
            AND v.stock_quantity > 0
       )
     GROUP BY other.product_id
    HAVING count(DISTINCT o.id) >= ${MIN_ORDERS_TOGETHER}
     ORDER BY orders_together DESC, name ASC
     LIMIT ${limit}`;

  return {
    // Shipped to the client so the screen can state the rule it is applying
    // instead of leaving a shopper to wonder why a section is missing.
    minOrdersTogether: MIN_ORDERS_TOGETHER,
    recommendations: rows.map((row) => ({
      productId: row.product_id,
      name: row.name,
      priceIqd: row.price_iqd,
      ordersTogether: Number(row.orders_together),
      imageId: row.image_id,
    })),
  };
}

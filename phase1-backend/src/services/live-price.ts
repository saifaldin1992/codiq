/**
 * Marketplace M8a — the price a variant sells at right now.
 *
 * `product_variants.price_iqd` is the store's list price. During an approved
 * hourly deal the product sells lower; `codiq_live_price()` (migration
 * 20261121180000) is the ONE definition of that, and this is its TypeScript
 * door. Every cart snapshot is taken from here, and the checkout's FOR UPDATE
 * read calls the SQL function directly, so the snapshot check that already
 * guards every order (CART_PRICE_CHANGED) is also what ends a deal: a line
 * priced inside the hour and paid after it no longer matches, and is re-priced.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** variantId → the price it sells at now. Variants not found are absent. */
export async function livePrices(db: Db, variantIds: readonly string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(variantIds));
  if (!ids.length) return new Map();
  const rows = await db.$queryRaw<{ id: string; price: number }[]>(Prisma.sql`
    SELECT v.id, codiq_live_price(v.product_id, v.price_iqd, now()) AS price
      FROM product_variants v
     WHERE v.id = ANY(${ids}::uuid[]) AND v.deleted_at IS NULL`);
  return new Map(rows.map((row) => [row.id, Number(row.price)]));
}

/** One variant's live price, or `fallback` when the row is gone. */
export async function livePriceOf(db: Db, variantId: string, fallback: number): Promise<number> {
  return (await livePrices(db, [variantId])).get(variantId) ?? fallback;
}

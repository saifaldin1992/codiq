/**
 * Marketplace M12 — «البحث بالصورة».
 *
 *   indexing  each live product of a listed store gets the fingerprint of its
 *             main picture (services/image-embedding.ts). Done right after a
 *             picture is uploaded, and by a sweep (owner button / script) for
 *             what that missed: a store listed later, a main picture changed,
 *             a new fingerprint model.
 *   search    the shopper's photo becomes the same 256 numbers; pgvector's
 *             HNSW index returns the nearest products by cosine distance; only
 *             visible products above a similarity floor are answered. The photo
 *             itself is never stored.
 *   look-alike  the same nearest-neighbour question asked with a product's own
 *             fingerprint: «يشبهه في الشكل» on its page.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { logger } from "../../logging/logger.js";
import { embedImage, IMAGE_EMBEDDING_MODEL, vectorLiteral } from "../../services/image-embedding.js";
import { getProductImageBytes } from "../../services/product-image-storage.service.js";
import { variantObjectKey } from "../../services/image-variants.service.js";
import { listMarketProducts } from "../market-catalog/products.service.js";
import type { MarketProductQuery } from "../market-catalog/schema.js";

/** Below this, «looks like» is a stretch — the calibration in tests/image-embedding.unit.mjs puts other products under 0.65. */
export const SIMILARITY_FLOOR = 0.7;
const SEARCH_LIMIT = 40;
const LOOK_ALIKE_LIMIT = 12;

/** Products a shopper can see — the same rule as the market's product list. */
const VISIBLE = Prisma.sql`st.market_status = 'listed' AND st.is_active AND m_acc.is_active AND p.is_active AND p.deleted_at IS NULL`;

type MainImage = { product_id: string; store_id: string; image_id: string; object_key: string; variant_set: number | null };

/** The main picture (first by order) of each product that needs a fingerprint: none yet, another picture, or an older model. */
async function stale(limit: number, productId?: string) {
  return prisma.$queryRaw<MainImage[]>`
    SELECT p.id AS product_id, p.store_id, img.id AS image_id, img.object_key, img.variant_set
    FROM products p
    JOIN stores st ON st.id = p.store_id
    JOIN merchants m_acc ON m_acc.id = st.merchant_id
    JOIN LATERAL (SELECT i.id, i.object_key, i.variant_set FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort_order ASC, i.id ASC LIMIT 1) img ON true
    LEFT JOIN product_image_embeddings e ON e.product_id = p.id
    WHERE ${VISIBLE}
      AND (e.product_id IS NULL OR e.image_id <> img.id OR e.model <> ${IMAGE_EMBEDDING_MODEL})
      ${productId ? Prisma.sql`AND p.id = ${productId}::uuid` : Prisma.empty}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${limit}`;
}

async function indexOne(row: MainImage) {
  // The 200px thumbnail is plenty for a 64px fingerprint and a fraction of the read.
  const key = row.variant_set ? variantObjectKey(row.object_key, "thumb") : row.object_key;
  const embedding = vectorLiteral(await embedImage(await getProductImageBytes(key)));
  await prisma.$executeRaw`
    INSERT INTO product_image_embeddings (product_id, store_id, image_id, model, embedding)
    VALUES (${row.product_id}::uuid, ${row.store_id}::uuid, ${row.image_id}::uuid, ${IMAGE_EMBEDDING_MODEL}, ${embedding}::vector)
    ON CONFLICT (product_id) DO UPDATE SET store_id = EXCLUDED.store_id, image_id = EXCLUDED.image_id, model = EXCLUDED.model, embedding = EXCLUDED.embedding, created_at = now()`;
}

/** One batch of the sweep. A picture that fails is logged and skipped; the next batch tries it again. */
export async function indexProductImages(limit = 100) {
  const rows = await stale(Math.min(Math.max(limit, 1), 500));
  let indexed = 0, failed = 0;
  for (const row of rows) {
    try { await indexOne(row); indexed += 1; } catch (error) {
      failed += 1;
      logger.warn("market.image_index.failed", { productId: row.product_id, reason: (error as Error).message });
    }
  }
  return { indexedNow: indexed, failed, ...(await imageIndexStatus()) };
}

/** Right after a picture is uploaded — best effort; the sweep is the safety net. */
export function indexProductSoon(productId: string) {
  setImmediate(() => {
    void stale(1, productId).then(async ([row]) => { if (row) await indexOne(row); })
      .catch((error: Error) => logger.warn("market.image_index.failed", { productId, reason: error.message }));
  });
}

export async function imageIndexStatus() {
  const [counts] = await prisma.$queryRaw<{ indexed: bigint; pending: bigint }[]>`
    SELECT
      count(*) FILTER (WHERE e.product_id IS NOT NULL AND e.image_id = img.id AND e.model = ${IMAGE_EMBEDDING_MODEL}) AS indexed,
      count(*) FILTER (WHERE e.product_id IS NULL OR e.image_id <> img.id OR e.model <> ${IMAGE_EMBEDDING_MODEL}) AS pending
    FROM products p
    JOIN stores st ON st.id = p.store_id
    JOIN merchants m_acc ON m_acc.id = st.merchant_id
    JOIN LATERAL (SELECT i.id FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort_order ASC, i.id ASC LIMIT 1) img ON true
    LEFT JOIN product_image_embeddings e ON e.product_id = p.id
    WHERE ${VISIBLE}`;
  return { model: IMAGE_EMBEDDING_MODEL, indexed: Number(counts?.indexed ?? 0), pending: Number(counts?.pending ?? 0) };
}

/** The nearest visible products to a vector, best first, above the floor. */
async function nearest(vector: string, limit: number, excludeProductId?: string) {
  const rows = await prisma.$transaction(async (tx) => {
    // HNSW returns at most ef_search candidates before the visibility filter: ask for enough.
    await tx.$executeRaw`SET LOCAL hnsw.ef_search = 200`;
    return tx.$queryRaw<{ product_id: string; similarity: number }[]>`
      SELECT c.product_id, c.similarity FROM (
        SELECT e.product_id, 1 - (e.embedding <=> ${vector}::vector) AS similarity
        FROM product_image_embeddings e
        WHERE e.model = ${IMAGE_EMBEDDING_MODEL}
        ORDER BY e.embedding <=> ${vector}::vector
        LIMIT 200
      ) c
      JOIN products p ON p.id = c.product_id
      JOIN stores st ON st.id = p.store_id
      JOIN merchants m_acc ON m_acc.id = st.merchant_id
      WHERE ${VISIBLE} AND c.similarity >= ${SIMILARITY_FLOOR}
        ${excludeProductId ? Prisma.sql`AND c.product_id <> ${excludeProductId}::uuid` : Prisma.empty}
      ORDER BY c.similarity DESC, c.product_id
      LIMIT ${limit}`;
  });
  if (!rows.length) return [];
  const cards = (await listMarketProducts({ ids: rows.map((row) => row.product_id), limit: rows.length, period: "month" } as MarketProductQuery)).products;
  const byId = new Map(cards.map((card) => [card.id, card]));
  return rows.flatMap((row) => { const card = byId.get(row.product_id); return card ? [{ ...card, similarity: Math.round(row.similarity * 100) }] : []; });
}

/** The shopper's photo → products that look like it. The photo is read, measured and dropped. */
export async function searchByImage(photo: Buffer) {
  const vector = vectorLiteral(await embedImage(photo));
  return { products: await nearest(vector, SEARCH_LIMIT), model: IMAGE_EMBEDDING_MODEL, floor: Math.round(SIMILARITY_FLOOR * 100) };
}

/** «يشبهه في الشكل»: other products near this one's fingerprint. Empty until it has one. */
export async function lookAlike(productId: string) {
  const [own] = await prisma.$queryRaw<{ embedding: string }[]>`
    SELECT e.embedding::text AS embedding
    FROM product_image_embeddings e
    JOIN products p ON p.id = e.product_id
    JOIN stores st ON st.id = p.store_id
    JOIN merchants m_acc ON m_acc.id = st.merchant_id
    WHERE ${VISIBLE} AND e.product_id = ${productId}::uuid AND e.model = ${IMAGE_EMBEDDING_MODEL}`;
  if (!own) {
    const exists = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM products p JOIN stores st ON st.id = p.store_id JOIN merchants m_acc ON m_acc.id = st.merchant_id
      WHERE ${VISIBLE} AND p.id = ${productId}::uuid`;
    if (!exists.length) throw new HttpError(404, "PRODUCT_NOT_FOUND", "هذا المنتج غير موجود في السوق.");
    return { products: [] };
  }
  return { products: await nearest(own.embedding, LOOK_ALIKE_LIMIT, productId) };
}

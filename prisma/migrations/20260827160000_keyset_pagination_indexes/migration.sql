-- Keyset pagination indexes for the two lists that were still missing them.
--
-- store_orders already carries (store_id, created_at DESC, id DESC) and both
-- the merchant order list and the customer order history ride it. The merchant
-- product list and the merchant customer directory sort the same way and page
-- with the same cursor shape, but had only (store_id) — so every page after the
-- first sorted the store's whole product set to return twenty rows.
--
-- Additive only: CREATE INDEX IF NOT EXISTS adds no column, rewrites no row,
-- and re-running the migration is a no-op.
--
-- Not CONCURRENTLY: Prisma wraps each migration in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. Both tables are small at
-- this stage, so the brief ACCESS EXCLUSIVE lock is acceptable; once a store
-- carries a large catalogue this pair should be rebuilt concurrently by hand.

CREATE INDEX IF NOT EXISTS products_store_created_id_idx
  ON products (store_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS customers_store_created_id_idx
  ON customers (store_id, created_at DESC, id DESC);

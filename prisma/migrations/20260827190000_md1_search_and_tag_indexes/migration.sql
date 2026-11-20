-- MD-1 review follow-up — index support for the unified search and the
-- server-side internal-tag filter. Strictly ADDITIVE: no table, column, or
-- constraint changes shape; only extensions and indexes are created.
--
-- WHY. The MD-1 search comment claimed it rode `UNIQUE(store_id, sku)` and
-- `customers(store_id, phone_normalized)`. It did not, and could not: every
-- match is `ILIKE '%q%'`, and a leading wildcard makes a b-tree index unusable.
-- EXPLAIN showed an Index Scan on store_id, then a Filter, then a Sort — an O(n)
-- pass over the whole store on a path the command palette calls every 250 ms.
--
-- pg_trgm's `gin_trgm_ops` DOES serve a leading-wildcard ILIKE. pg_trgm is a
-- trusted extension in PostgreSQL 13+, so a plain database owner can create it,
-- and it is available on the managed provider.
--
-- SINGLE-COLUMN, deliberately. A composite `GIN (store_id, <col> gin_trgm_ops)`
-- via btree_gin looks tidier but was MEASURED here and the planner never chose
-- it — not even with seqscan and indexscan disabled; it fell back to the plain
-- store_id b-tree and re-filtered every row of the store. The single-column
-- trigram index is chosen immediately, and the `store_id` equality becomes a
-- heap filter over the handful of trigram matches, so the work scales with
-- MATCHES rather than with the size of the store. Tenancy is unaffected:
-- `store_id` is still in every WHERE clause the service builds.
--
-- These indexes only pay off because merchant-search.service.ts also stopped
-- ORing two columns in one query — the planner refuses a BitmapOr here and falls
-- straight back to a sequential scan. Measured on 8,013 products in one store
-- (PostgreSQL 17, after VACUUM ANALYZE), same ORDER BY and LIMIT:
--   name ILIKE q OR sku ILIKE q  ->  Seq Scan, 8012 rows removed   39.4 ms
--   name ILIKE q (split query)   ->  Bitmap Index Scan, 1 block     1.0 ms
-- Note for anyone re-measuring: GIN keeps new entries in a pending list, so a
-- freshly bulk-loaded table looks slower until VACUUM (or autovacuum) flushes it.
--
-- Honest limit: a trigram index needs three characters to form a full trigram.
-- The two-character floor the service enforces still degrades to a scan, which
-- is why that floor exists and stays.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS products_name_trgm_idx ON products USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_sku_trgm_idx ON products USING GIN (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS store_orders_order_number_trgm_idx ON store_orders USING GIN (order_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customers_full_name_trgm_idx ON customers USING GIN (full_name gin_trgm_ops);

-- The internal-tag filter moved from the browser (which could only filter the
-- 25 rows already loaded, and therefore lied about how many orders carry a tag)
-- to `listStoreOrders`. Both the relation filter and the chip facet read
-- order_tags by (store_id, tag_normalized).
CREATE INDEX IF NOT EXISTS order_tags_store_tag_idx ON order_tags (store_id, tag_normalized);

-- المرحلة 20-3 «الأداء والفهارس» — the composite indexes the 20-2 keyset pages
-- ride. Strictly additive plus ONE drop of an index this file strictly
-- supersedes: no table, column or constraint changes shape.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY. 20-2 gave every list the same page shape:
--
--     WHERE <ordering_col, id> beyond the cursor
--     ORDER BY ordering_col, id
--     LIMIT n
--
-- That shape is fast only on an index that is EXACTLY `(ordering_col, id)` —
-- and, in a multi-tenant schema, only with the tenant column leading it. Without
-- one, «الصفحة التالية» is a fresh sort of the whole partition every time.
--
-- Measured on a seeded corpus of 1.96 million rows across sixteen tables, one
-- «big» store holding half of every store-scoped table (PostgreSQL 16, after
-- VACUUM ANALYZE, cursor placed HALF WAY down each list, median of five
-- EXPLAIN (ANALYZE, BUFFERS) runs). The harness is
-- `phase1-backend/tests/perf-index-evidence.mjs`; it builds each page with
-- Prisma from the same spec the service uses and explains the SQL the engine
-- actually emitted, exactly as PG-6's plan gate does (ق-144).
--
--   list                              rows    before      after   plan before › after
--   platform.orders                200,000  178.55 ms   0.05 ms  Seq Scan+Sort › Index Scan
--   merchant.abandoned-carts        40,000   76.51 ms   0.13 ms  Bitmap+Sort  › Index Scan
--   merchant.returns                75,000   67.88 ms   0.05 ms  Seq Scan+Sort › Index Scan
--   platform.stores                 60,000   22.31 ms   0.04 ms  Seq Scan+Sort › Index Scan
--   platform.merchants              60,000   18.96 ms   0.04 ms  Seq Scan+Sort › Index Scan
--   merchant.coupons                25,000   14.84 ms   0.05 ms  Bitmap+Sort  › Index Scan
--   platform.upgrade-requests       80,000   13.88 ms   0.04 ms  Seq Scan+Sort › Index Scan
--   platform.registration-requests   6,667   10.58 ms   0.05 ms  Seq Scan+Sort › Index Scan
--   merchant.pos.shortfalls         25,000    8.89 ms   0.07 ms  Bitmap+Sort  › Index Scan
--   platform.pulse.cohort/never_sold 60,000 237.67 ms 170.16 ms  Seq Scan+Sort › Index Scan
--
-- Half of every one of those numbers is NOT this file. The keyset predicate in
-- `services/list-page.ts` was a bare top-level OR, which PostgreSQL cannot turn
-- into an index STARTING point — it opened the index at the top and filtered
-- forward, so a deep page still cost time proportional to its depth even on a
-- perfect index. That predicate is bounded in the same PR; see the comment on
-- `keysetWhere`. Neither half works without the other.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NOT `CONCURRENTLY`, and what the house comment about it gets wrong.
--
-- Three earlier migrations (20260827160000, 20260829090000, 20260904090000,
-- 20260904100000) say «prisma migrate deploy wraps a migration file in a
-- transaction and CONCURRENTLY cannot run inside one». That is only half true,
-- and the half that is false matters the day a table is too big to lock.
-- Measured against prisma 6.18 on this schema:
--
--   · a migration file containing EXACTLY ONE statement, and that statement
--     `CREATE INDEX CONCURRENTLY` → APPLIES CLEANLY. Prisma sends the file as
--     one simple-query batch and PostgreSQL opens no implicit transaction for a
--     single statement.
--   · the same statement in a file with a second statement beside it →
--     `ERROR 25001: CREATE INDEX CONCURRENTLY cannot run inside a transaction
--     block`, and prisma leaves the migration in the FAILED state (P3018),
--     which then blocks every later migration until someone runs
--     `prisma migrate resolve` by hand.
--
-- So the real rule is «one statement per file», not «never». This file keeps
-- the plain form deliberately, for two measured reasons rather than a repeated
-- claim:
--
--   1. `CREATE INDEX` takes a **ShareLock**, not ACCESS EXCLUSIVE — read off
--      `pg_locks` while a build was in flight. Readers are never blocked; only
--      writers wait. (20260827160000 names the wrong lock; it is corrected
--      here rather than repeated.)
--   2. The longest build in this file took 468 ms on 200,000 rows. Production
--      is smaller than that corpus today, and eleven separate migration
--      directories — each able to fail into P3018 and leave an INVALID index
--      behind — is a worse trade than a sub-second write pause.
--
-- When a table here does outgrow that: split the one index into its own
-- migration directory, as the single statement in the file, with CONCURRENTLY.
-- It works. It is measured. Do not repeat the claim that it cannot.
-- ─────────────────────────────────────────────────────────────────────────────

-- `merchants` declared ZERO indexes. Both platform lists over it sorted all
-- 60,000 rows to return 25.
CREATE INDEX IF NOT EXISTS merchants_created_id_idx
  ON merchants (created_at DESC, id DESC);

-- The registration queue is a MINORITY of the table, and a shrinking one: the
-- longer the platform runs, the more approved merchants the full index above
-- has to skip to find twenty-five pending ones. Measured with the full index
-- only, at the same cursor depth:
--   pending 11% of merchants → 0.089 ms, 200 rows removed by filter
--   pending  1% of merchants → 0.724 ms, 2,396 rows removed by filter
-- The partial index is flat at ~0.03 ms in both, and is 280 kB against 2,400 kB.
-- It is not expressible in schema.prisma; it lives only here, like the partial
-- unique on phone_normalized (P27-12, ق-100).
CREATE INDEX IF NOT EXISTS merchants_pending_created_id_idx
  ON merchants (created_at, id) WHERE approval_status = 'pending';

-- PG-7's pulse cohorts page by `(business_name, id)` — the one list that writes
-- its keyset by hand, as a row-wise comparison.
CREATE INDEX IF NOT EXISTS merchants_business_name_id_idx
  ON merchants (business_name, id);

CREATE INDEX IF NOT EXISTS stores_created_id_idx
  ON stores (created_at DESC, id DESC);

-- The platform-wide order feed carries NO store filter, so neither
-- `(store_id, created_at, id)` nor `(status, created_at, id)` can serve it —
-- both lead with a column this list does not constrain. 178.55 ms › 0.05 ms.
CREATE INDEX IF NOT EXISTS store_orders_created_id_idx
  ON store_orders (created_at DESC, id DESC);

-- Same defect: `plan_upgrade_requests_status_created_idx` leads with `status`,
-- which this list filters only sometimes, and stops before `id`.
CREATE INDEX IF NOT EXISTS plan_upgrade_requests_created_id_idx
  ON plan_upgrade_requests (created_at DESC, id DESC);

-- And again: `return_requests_queue_idx` is `(store_id, status, created_at, id)`
-- and `status` is the OPTIONAL filter. ASC here, because the merchant's returns
-- queue is oldest-first — the order it must be worked in.
CREATE INDEX IF NOT EXISTS return_requests_store_created_id_idx
  ON return_requests (store_id, created_at, id);

-- `shopping_carts_abandoned_notified_idx` buries `last_activity_at` behind
-- `abandoned_notified_at`, which this list never filters, so the ordering column
-- is unreachable. Partial on the only status the list reads.
CREATE INDEX IF NOT EXISTS shopping_carts_store_activity_id_idx
  ON shopping_carts (store_id, last_activity_at DESC, id DESC) WHERE status = 'active';

-- `coupons_store_idx` is `(store_id, is_active)` — no ordering column at all.
-- Partial on PG-2's LIVE predicate, which this list always carries.
CREATE INDEX IF NOT EXISTS coupons_store_live_created_id_idx
  ON coupons (store_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- The till's shortfall queue. This one SUPERSEDES its predecessor rather than
-- joining it: `pos_ticket_shortfalls_open_idx` is `(store_id) WHERE reviewed_at
-- IS NULL` — the identical partial predicate and a strict column prefix — so
-- every query it served, this serves. Keeping both is not free: two overlapping
-- partial indexes let the planner build a BitmapOr across them and LOSE the
-- index ordering, which is how the trash list measured 5.28 ms against 0.05 ms
-- on the same data during this work.
CREATE INDEX IF NOT EXISTS pos_ticket_shortfalls_open_created_id_idx
  ON pos_ticket_shortfalls (store_id, created_at DESC, id DESC) WHERE reviewed_at IS NULL;

DROP INDEX IF EXISTS pos_ticket_shortfalls_open_idx;

-- `wishlist_items` is indexed for its uniqueness constraint —
-- (store_id, customer_id, variant_id) — so the shopper's rows are found
-- cheaply and then TOP-N SORTED, every page, over her whole saved list. 0.178 ms
-- on a 500-item wishlist against 0.038 ms here, and the gap grows with the list
-- rather than staying flat: this is a sort of the partition, not of a handful of
-- ties. Writes are one row per «حفظ» tap.
CREATE INDEX IF NOT EXISTS wishlist_items_customer_created_id_idx
  ON wishlist_items (store_id, customer_id, created_at DESC, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- MEASURED AND REJECTED. Each of these was built, measured against the same
-- corpus at the same cursor depth, and dropped again, because an index no
-- query needs is a write cost every INSERT pays forever:
--
--   notification_outbox (store_id, created_at DESC, id DESC)
--       0.07 ms › 0.07 ms. `notification_outbox_store_log_idx` already seeks;
--       its `id ASC` tail only adds an Incremental Sort over ties, which are
--       single rows. This is the busiest write table in the schema — every
--       order writes to it — and it would have paid for nothing.
--   settlements (merchant_id, created_at DESC, id DESC)
--       0.09 ms › 0.07 ms. Same story, on a list whose partition is hundreds
--       of rows.
--   inventory_reservations (store_id, returned_at DESC, id DESC)
--       WHERE return_disposition = 'pending_inspection'
--       0.09 ms › 0.08 ms. The existing index already seeks.
--   products (store_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL
--       0.13 ms › 0.05 ms. A real difference and a real plan change (the
--       Incremental Sort goes), but 0.08 ms in absolute terms, and the
--       Incremental Sort is over `deleted_at` ties — single rows — so it does
--       not grow with the trash. Not worth replacing a live index for.
-- ─────────────────────────────────────────────────────────────────────────────

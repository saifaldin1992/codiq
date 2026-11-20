-- PG-2 (c) — soft delete + trash bin for the four entities (+ product variants).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The columns. All nullable ⇒ instant ALTER, no rewrite, no backfill.
--    deleted_event_id: foreign key to the audit event that killed the row.
--    RESTRICT because the event must survive as long as the row points at it —
--    which is what turns "restore revives ONLY what died in the SAME event"
--    from a convention into a structural fact.
--    deleted_was_active: is_active snapshot before the delete; without it a
--    draft comes back published.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

ALTER TABLE product_variants
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean;

ALTER TABLE product_categories
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

ALTER TABLE coupons
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

ALTER TABLE store_staff_memberships
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) The structural invariant: "deleted ⇒ inactive".
--    This is the guarantee that closes the ENTIRE public surface — including the
--    raw-SQL checkout lock (storefront.service.ts reads p.is_active inside
--    FOR UPDATE OF v, p) — with zero changes on the payment path.
--    ⚠ Dropping ANY of these constraints opens deleted rows on the storefront
--    in the same instant. See PG2_SOFT_DELETE_PLAN.md §6.2 before touching them:
--    the four public reads (publicProducts, publicProduct, the cart reads) must
--    gain an explicit LIVE filter BEFORE any of these is relaxed.
--    NOT VALID then VALIDATE: no long ACCESS EXCLUSIVE lock. Every current row
--    has deleted_at IS NULL so the validation is instant.
--    And a second invariant: deleted_at and deleted_event_id always move together.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE products ADD CONSTRAINT products_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT products_deleted_implies_inactive;
ALTER TABLE products ADD CONSTRAINT products_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT products_deleted_pair;
ALTER TABLE products ADD CONSTRAINT products_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT products_purge_block_requires_deleted;

ALTER TABLE product_variants ADD CONSTRAINT product_variants_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE product_variants VALIDATE CONSTRAINT product_variants_deleted_implies_inactive;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE product_variants VALIDATE CONSTRAINT product_variants_deleted_pair;

ALTER TABLE coupons ADD CONSTRAINT coupons_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE coupons VALIDATE CONSTRAINT coupons_deleted_implies_inactive;
ALTER TABLE coupons ADD CONSTRAINT coupons_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE coupons VALIDATE CONSTRAINT coupons_deleted_pair;
ALTER TABLE coupons ADD CONSTRAINT coupons_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE coupons VALIDATE CONSTRAINT coupons_purge_block_requires_deleted;

ALTER TABLE store_staff_memberships ADD CONSTRAINT ssm_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE store_staff_memberships VALIDATE CONSTRAINT ssm_deleted_implies_inactive;
ALTER TABLE store_staff_memberships ADD CONSTRAINT ssm_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE store_staff_memberships VALIDATE CONSTRAINT ssm_deleted_pair;
ALTER TABLE store_staff_memberships ADD CONSTRAINT ssm_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE store_staff_memberships VALIDATE CONSTRAINT ssm_purge_block_requires_deleted;

ALTER TABLE product_categories ADD CONSTRAINT product_categories_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE product_categories VALIDATE CONSTRAINT product_categories_deleted_pair;
ALTER TABLE product_categories ADD CONSTRAINT product_categories_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE product_categories VALIDATE CONSTRAINT product_categories_purge_block_requires_deleted;
-- product_categories has no is_active: publicCategories requires an active
-- product somewhere in the tree (storefront.service.ts:115-119), so a deleted
-- category cannot surface publicly by construction.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Freeing the code space: full constraint → partial unique index.
--    The names below are the REAL constraint names in the database (verified in
--    the migrations), not the ones Prisma would generate by default.
--    Drop and create inside the one migration transaction ⇒ there is no window
--    in which another connection sees the table without uniqueness protection.
--    The index names are deliberate: errors.ts matches
--    target.includes("product_categories" | "coupons" | "product_variants" |
--    "products") in that order, so each name lands in its correct branch and the
--    existing 409 messages keep working with no change.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE products DROP CONSTRAINT products_store_id_sku_key;
CREATE UNIQUE INDEX products_store_sku_live_key
  ON products (store_id, sku) WHERE deleted_at IS NULL;

ALTER TABLE product_variants DROP CONSTRAINT product_variants_store_sku_key;
CREATE UNIQUE INDEX product_variants_store_sku_live_key
  ON product_variants (store_id, sku) WHERE deleted_at IS NULL;

ALTER TABLE product_categories DROP CONSTRAINT product_categories_store_normalized_name_key;
CREATE UNIQUE INDEX product_categories_store_name_live_key
  ON product_categories (store_id, normalized_name) WHERE deleted_at IS NULL;

ALTER TABLE coupons DROP CONSTRAINT coupons_store_code_unique;
CREATE UNIQUE INDEX coupons_store_code_live_key
  ON coupons (store_id, code_normalized) WHERE deleted_at IS NULL;

ALTER TABLE store_staff_memberships DROP CONSTRAINT store_staff_memberships_unique_staff_store;
CREATE UNIQUE INDEX store_staff_memberships_staff_store_live_key
  ON store_staff_memberships (staff_id, store_id) WHERE deleted_at IS NULL;

-- The default variant: a deleted product must not hold the "default" seat away
-- from a live one, and above all it must not stop the
-- codiq_create_default_product_variant trigger from working.
DROP INDEX product_variants_one_default_uq;
CREATE UNIQUE INDEX product_variants_one_default_uq
  ON product_variants (product_id) WHERE is_default AND deleted_at IS NULL;

-- ⚠ (id, store_id), (id, product_id, store_id) and (id, staff_id, store_id)
--   stay FULL, non-partial constraints: they are the targets of the composite
--   foreign keys the whole store-isolation model rests on (cart_items,
--   inventory_reservations, product_variants, staff_sessions). Touching them
--   demolishes the model.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Trash and purge indexes. Partial on the deleted rows alone ⇒ tiny.
--    The sweep order (purge_blocked_at NULLS FIRST, deleted_at) guarantees the
--    blocked rows get retried without starving the fresh ones.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX products_store_trash_idx ON products (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX products_purge_sweep_idx ON products (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX product_categories_store_trash_idx ON product_categories (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX product_categories_purge_sweep_idx ON product_categories (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX coupons_store_trash_idx ON coupons (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX coupons_purge_sweep_idx ON coupons (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX ssm_store_trash_idx ON store_staff_memberships (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX ssm_purge_sweep_idx ON store_staff_memberships (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX product_variants_product_trash_idx ON product_variants (product_id, deleted_event_id)
  WHERE deleted_at IS NOT NULL;

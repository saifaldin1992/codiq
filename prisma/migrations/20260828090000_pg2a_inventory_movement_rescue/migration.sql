-- PG-2 (a) — inventory movement history rescue (debt item D-48).
-- Fully independent of soft delete: it repairs the audit-trail loss on ANY hard
-- product delete, past or future, and can be deployed on its own.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) The landmine first. codiq_guard_product_child_store is bound to
--    BEFORE INSERT OR UPDATE OF store_id, product_id ON inventory_movements
--    (20260817093000/migration.sql:89-91) and its body raises 23514 whenever
--    product_id has no store. ON DELETE SET NULL is an UPDATE of product_id, so
--    without this line the trigger fires on every purge and aborts the delete
--    AND the whole batch — inside a background worker with no HTTP path, i.e. a
--    silent failure nobody sees.
--    Safe on a live database: CREATE OR REPLACE FUNCTION locks no table, and the
--    old behaviour is preserved verbatim for every non-NULL product_id row.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION codiq_guard_product_child_store()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  product_store_id uuid;
BEGIN
  -- PG-2: after inventory_movements.product_id became ON DELETE SET NULL,
  -- nulling it is a legitimate operation and there is no store to match.
  -- DO NOT REMOVE THIS LINE.
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT store_id INTO product_store_id FROM products WHERE id = NEW.product_id;
  IF product_store_id IS NULL OR product_store_id <> NEW.store_id THEN
    RAISE EXCEPTION 'CODIQ_PRODUCT_STORE_MISMATCH: child resource must belong to the product store'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Snapshot columns. All nullable on ADD ⇒ instant ALTER with no table
--    rewrite (Postgres 11+ never rewrites for a nullable column without DEFAULT).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_movements
  ADD COLUMN product_name text,
  ADD COLUMN product_sku  text,
  ADD COLUMN variant_name text,
  ADD COLUMN variant_sku  text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Backfill. Every row that exists today owns a live product by virtue of the
--    old Cascade (whatever preceded was already annihilated and nothing can be
--    recovered from it). The table is still small at this stage; if it ever
--    passes a million rows, this statement gets split into ctid batches and the
--    SET NOT NULL moves to a follow-up migration.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE inventory_movements m
SET product_name = p.name,
    product_sku  = p.sku
FROM products p
WHERE p.id = m.product_id AND m.product_name IS NULL;

UPDATE inventory_movements m
SET variant_name = v.name,
    variant_sku  = v.sku
FROM product_variants v
WHERE v.id = m.variant_id AND m.variant_name IS NULL;

-- Safety net: any straggler (none is expected) stays readable instead of
-- failing the constraint.
UPDATE inventory_movements SET product_name = '(منتج محذوف)' WHERE product_name IS NULL;
UPDATE inventory_movements SET product_sku  = '(غير معروف)'  WHERE product_sku  IS NULL;

ALTER TABLE inventory_movements
  ALTER COLUMN product_name SET NOT NULL,
  ALTER COLUMN product_sku  SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Stamped by a trigger, not by the service: inventoryMovement.create is
--    written in six places today (product-catalog.service.ts:219,264,277,341,368
--    and csv-transfer.service.ts:331,339) and the seventh will be written
--    without review. The trigger makes the row self-sufficient whoever writes
--    it — raw SQL in a test included.
--    Its name starts with a letter after "g" so it runs after the guard trigger
--    (Postgres orders alphabetically); logically it does not matter, because it
--    touches neither store_id nor product_id.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION codiq_stamp_inventory_movement_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND NEW.product_name IS NULL THEN
    SELECT name, sku INTO NEW.product_name, NEW.product_sku
    FROM products WHERE id = NEW.product_id;
  END IF;
  IF NEW.variant_id IS NOT NULL AND NEW.variant_name IS NULL THEN
    SELECT name, sku INTO NEW.variant_name, NEW.variant_sku
    FROM product_variants WHERE id = NEW.variant_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_stamp_snapshot
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION codiq_stamp_inventory_movement_snapshot();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) The heart: Cascade → SetNull.
--    • DROP NOT NULL is a widening, not a narrowing: every existing row stays valid.
--    • ADD CONSTRAINT … NOT VALID avoids a full table scan under lock; the
--      VALIDATE then takes only SHARE UPDATE EXCLUSIVE and blocks neither
--      reads nor writes.
--    • A single-column key, not the composite (product_id, store_id), on
--      purpose: SET NULL on a composite key would null store_id too — an
--      isolation catastrophe. store_id keeps its own key to stores and tenancy
--      is preserved.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_movements ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_product_id_fkey;
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_product_id_fkey;

-- Note: variant_id was already SET NULL (20260826120000:151). After this
-- migration a movement can arrive with BOTH keys NULL — and the snapshot
-- columns are all that is left of it.
CREATE INDEX inventory_movements_orphan_idx
  ON inventory_movements (store_id, created_at DESC) WHERE product_id IS NULL;

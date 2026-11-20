-- Approved addition (2026-08-26) — nested category tree (التصنيفات المتشعبة).
-- product_categories gains a self-referencing parent pointer guarded by a
-- composite same-store FK, so a category can never point at another store's
-- category — the same schema-level tenant boundary style used for products
-- and product_variants. Additive-first: no existing column or constraint
-- changes; normalized-name uniqueness stays store-wide.

-- 1. Composite identity key: required target for same-store child references.
ALTER TABLE product_categories
  ADD CONSTRAINT product_categories_id_store_unique UNIQUE (id, store_id);

-- 2. Parent pointer + same-store composite FK. ON DELETE RESTRICT: deleting a
--    parent that still has children is refused at the schema level (surfaced
--    as 409 CATEGORY_HAS_CHILDREN by the service before it ever reaches here).
ALTER TABLE product_categories
  ADD COLUMN parent_category_id uuid;
ALTER TABLE product_categories
  ADD CONSTRAINT product_categories_parent_store_fk
  FOREIGN KEY (parent_category_id, store_id)
  REFERENCES product_categories(id, store_id) ON DELETE RESTRICT;
CREATE INDEX product_categories_store_parent_idx ON product_categories(store_id, parent_category_id);

-- 3. Cycle guard: walk NEW.parent_category_id's ancestor chain and RAISE when
--    it reaches NEW.id — direct SQL can never make the tree circular. Depth
--    (max 3 levels) is a service-side rule; this trigger guards cycles only,
--    and the iteration cap is a defense against walking an unexpectedly deep
--    chain, not a depth limit.
CREATE OR REPLACE FUNCTION codiq_guard_category_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ancestor uuid;
  hops integer := 0;
  subtree_height integer := 0;
BEGIN
  IF NEW.parent_category_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Serialize structural writes per store: without this, two concurrent
  -- re-parents can each pass a snapshot walk and commit a cycle (plain
  -- SELECTs do not conflict with the FK's KEY SHARE locks).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.store_id::text, 42));
  IF NEW.parent_category_id = NEW.id THEN
    RAISE EXCEPTION 'product_categories cycle: category % cannot be its own parent', NEW.id
      USING ERRCODE = '23514';
  END IF;
  ancestor := NEW.parent_category_id;
  LOOP
    SELECT parent_category_id INTO ancestor FROM product_categories WHERE id = ancestor;
    EXIT WHEN ancestor IS NULL;
    IF ancestor = NEW.id THEN
      RAISE EXCEPTION 'product_categories cycle: category % is an ancestor of its requested parent', NEW.id
        USING ERRCODE = '23514';
    END IF;
    hops := hops + 1;
    IF hops > 32 THEN
      RAISE EXCEPTION 'product_categories parent chain for % exceeds the walkable depth', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  -- Depth is enforced here too (not only in the service) because the lock
  -- above is what makes the check race-free: parent level = hops + 1, the
  -- moved node sits at hops + 2, and its deepest descendant must stay <= 3.
  WITH RECURSIVE sub AS (
    SELECT id, 1 AS depth FROM product_categories WHERE parent_category_id = NEW.id
    UNION ALL
    SELECT c.id, s.depth + 1 FROM product_categories c JOIN sub s ON c.parent_category_id = s.id WHERE s.depth < 8
  )
  SELECT COALESCE(MAX(depth), 0) INTO subtree_height FROM sub;
  IF hops + 2 + subtree_height > 3 THEN
    RAISE EXCEPTION 'product_categories depth for % would exceed 3 levels', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_categories_guard_cycle
BEFORE INSERT OR UPDATE OF parent_category_id ON product_categories
FOR EACH ROW EXECUTE FUNCTION codiq_guard_category_cycle();

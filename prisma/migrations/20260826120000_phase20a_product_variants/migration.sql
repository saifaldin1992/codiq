-- Phase 20A — product variants core (D-07).
-- Implicit default-variant model: every product always owns >= 1 row in
-- product_variants; purchasable stock and price live exclusively on the variant.
-- The vestigial products stock/price columns are frozen (no purchase-path
-- reads/writes) and kept consistent for legacy readers by a default-variant
-- mirror trigger; they are dropped in a later cleanup migration.

-- 1. Variant table: composite identity keys enforce same-store AND same-product
--    membership at the schema level for every child reference.
CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  price_iqd integer NOT NULL CHECK (price_iqd >= 0),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  low_stock_threshold integer NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  is_low_stock boolean GENERATED ALWAYS AS (stock_quantity <= low_stock_threshold) STORED,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  options jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_variants_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT product_variants_identity_unique UNIQUE (id, product_id, store_id),
  CONSTRAINT product_variants_store_sku_key UNIQUE (store_id, sku),
  CONSTRAINT product_variants_product_store_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE
);

CREATE INDEX product_variants_store_product_idx ON product_variants(store_id, product_id, position);
CREATE INDEX product_variants_store_stock_idx ON product_variants(store_id, stock_quantity);
CREATE INDEX product_variants_store_low_stock_idx ON product_variants(store_id, is_low_stock) WHERE is_low_stock;
CREATE UNIQUE INDEX product_variants_one_default_uq ON product_variants(product_id) WHERE is_default;

-- Tenant guard: reuse the existing product-child store guard.
CREATE TRIGGER product_variants_guard_store
BEFORE INSERT OR UPDATE OF store_id, product_id ON product_variants
FOR EACH ROW EXECUTE FUNCTION codiq_guard_product_child_store();

-- 2. Default-variant invariant: every product INSERT — application or direct SQL —
--    creates its default variant in the same transaction, inheriting the legacy
--    sku/price/stock/threshold columns 1:1.
CREATE OR REPLACE FUNCTION codiq_create_default_product_variant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO product_variants (store_id, product_id, sku, name, price_iqd, stock_quantity, low_stock_threshold, is_default, is_active, position, options)
  VALUES (NEW.store_id, NEW.id, NEW.sku, NEW.name, NEW.price_iqd, NEW.stock_quantity, NEW.low_stock_threshold, true, NEW.is_active, 0, '{}'::jsonb);
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_create_default_variant
AFTER INSERT ON products
FOR EACH ROW EXECUTE FUNCTION codiq_create_default_product_variant();

-- 3. Freeze-consistency mirror: the frozen products stock/price columns keep
--    tracking the default variant so legacy readers (merchant payloads, older
--    tests, reports) stay truthful without any purchase-path write to products.
CREATE OR REPLACE FUNCTION codiq_mirror_default_variant_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_default THEN
    UPDATE products
    SET stock_quantity = NEW.stock_quantity,
        low_stock_threshold = NEW.low_stock_threshold,
        price_iqd = NEW.price_iqd
    WHERE id = NEW.product_id
      AND store_id = NEW.store_id
      AND (stock_quantity IS DISTINCT FROM NEW.stock_quantity
        OR low_stock_threshold IS DISTINCT FROM NEW.low_stock_threshold
        OR price_iqd IS DISTINCT FROM NEW.price_iqd);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER product_variants_mirror_default_stock
AFTER INSERT OR UPDATE OF stock_quantity, low_stock_threshold, price_iqd, is_default ON product_variants
FOR EACH ROW EXECUTE FUNCTION codiq_mirror_default_variant_stock();

-- 4. Backfill: one default variant per existing product, inheriting sku, price,
--    stock, threshold, and active flag literally.
INSERT INTO product_variants (store_id, product_id, sku, name, price_iqd, stock_quantity, low_stock_threshold, is_default, is_active, position, options)
SELECT p.store_id, p.id, p.sku, p.name, p.price_iqd, p.stock_quantity, p.low_stock_threshold, true, p.is_active, 0, '{}'::jsonb
FROM products p;

-- 5. cart_items: variant-scoped lines. Two variants of one product must coexist,
--    so uniqueness moves from (cart_id, product_id) to (cart_id, variant_id).
ALTER TABLE cart_items ADD COLUMN variant_id uuid;
UPDATE cart_items ci SET variant_id = v.id FROM product_variants v WHERE v.product_id = ci.product_id AND v.is_default;
ALTER TABLE cart_items ALTER COLUMN variant_id SET NOT NULL;
ALTER TABLE cart_items
  ADD CONSTRAINT cart_items_variant_product_store_fk FOREIGN KEY (variant_id, product_id, store_id) REFERENCES product_variants(id, product_id, store_id) ON DELETE RESTRICT;
ALTER TABLE cart_items DROP CONSTRAINT cart_items_cart_product_unique;
ALTER TABLE cart_items ADD CONSTRAINT cart_items_cart_variant_unique UNIQUE (cart_id, variant_id);
CREATE INDEX cart_items_variant_idx ON cart_items(variant_id);

-- Legacy-compat: a cart_items INSERT that omits variant_id (pre-20A writers and
-- raw SQL) resolves the product's default variant BEFORE constraints run, so the
-- composite FK — not a NOT NULL error — remains the boundary that rejects
-- cross-store/cross-product rows (23503), exactly as pre-20A behavior promised.
CREATE OR REPLACE FUNCTION codiq_default_variant_for_cart_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.variant_id IS NULL THEN
    SELECT id INTO NEW.variant_id FROM product_variants WHERE product_id = NEW.product_id AND is_default;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cart_items_default_variant
BEFORE INSERT ON cart_items
FOR EACH ROW EXECUTE FUNCTION codiq_default_variant_for_cart_item();

-- 6. inventory_reservations: reservations pin the variant; the availability
--    partial index follows the variant, and uniqueness becomes per-variant.
ALTER TABLE inventory_reservations ADD COLUMN variant_id uuid;
UPDATE inventory_reservations r SET variant_id = v.id FROM product_variants v WHERE v.product_id = r.product_id AND v.is_default;
ALTER TABLE inventory_reservations ALTER COLUMN variant_id SET NOT NULL;
ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservations_variant_product_store_fk FOREIGN KEY (variant_id, product_id, store_id) REFERENCES product_variants(id, product_id, store_id) ON DELETE RESTRICT;
ALTER TABLE inventory_reservations DROP CONSTRAINT inventory_reservations_order_product_unique;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_order_variant_unique UNIQUE (order_id, variant_id);
DROP INDEX inventory_reservations_available_idx;
CREATE INDEX inventory_reservations_available_idx ON inventory_reservations(store_id, variant_id) WHERE status = 'active';

-- 7. order_items: variant snapshot columns; variant_id stays nullable because
--    legacy rows may carry product_id NULL already.
ALTER TABLE order_items
  ADD COLUMN variant_id uuid,
  ADD COLUMN variant_name text;
UPDATE order_items oi SET variant_id = v.id FROM product_variants v WHERE oi.product_id IS NOT NULL AND v.product_id = oi.product_id AND v.is_default;
ALTER TABLE order_items
  ADD CONSTRAINT order_items_variant_fk FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE RESTRICT;
CREATE INDEX order_items_variant_idx ON order_items(variant_id);

-- 8. inventory_movements: new movements carry the variant; history survives a
--    variant deletion at the product level via SET NULL.
ALTER TABLE inventory_movements ADD COLUMN variant_id uuid;
UPDATE inventory_movements m SET variant_id = v.id FROM product_variants v WHERE v.product_id = m.product_id AND v.is_default;
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_variant_fk FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL;
CREATE INDEX inventory_movements_variant_idx ON inventory_movements(variant_id);

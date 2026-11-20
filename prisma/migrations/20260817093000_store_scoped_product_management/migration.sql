ALTER TABLE products
  ADD COLUMN category_id uuid,
  ADD COLUMN stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  ADD COLUMN is_low_stock boolean GENERATED ALWAYS AS (stock_quantity <= low_stock_threshold) STORED;

CREATE TABLE product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  normalized_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_categories_store_normalized_name_key UNIQUE (store_id, normalized_name)
);

ALTER TABLE products
  ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE RESTRICT;

CREATE TABLE product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  reason text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_store_category_idx ON products(store_id, category_id);
CREATE INDEX products_store_stock_idx ON products(store_id, stock_quantity);
CREATE INDEX products_store_low_stock_idx ON products(store_id, is_low_stock) WHERE is_low_stock;
CREATE INDEX product_categories_store_idx ON product_categories(store_id);
CREATE INDEX product_images_store_product_sort_idx ON product_images(store_id, product_id, sort_order);
CREATE INDEX inventory_movements_store_product_created_idx ON inventory_movements(store_id, product_id, created_at DESC);

CREATE OR REPLACE FUNCTION codiq_guard_product_tenant_relations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_store_id uuid;
BEGIN
  IF NEW.category_id IS NOT NULL THEN
    SELECT store_id INTO category_store_id FROM product_categories WHERE id = NEW.category_id;
    IF category_store_id IS NULL OR category_store_id <> NEW.store_id THEN
      RAISE EXCEPTION 'CODIQ_CATEGORY_STORE_MISMATCH: product category must belong to the same store'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_guard_category_store
BEFORE INSERT OR UPDATE OF store_id, category_id ON products
FOR EACH ROW EXECUTE FUNCTION codiq_guard_product_tenant_relations();

CREATE OR REPLACE FUNCTION codiq_guard_product_child_store()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  product_store_id uuid;
BEGIN
  SELECT store_id INTO product_store_id FROM products WHERE id = NEW.product_id;
  IF product_store_id IS NULL OR product_store_id <> NEW.store_id THEN
    RAISE EXCEPTION 'CODIQ_PRODUCT_STORE_MISMATCH: child resource must belong to the product store'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_images_guard_store
BEFORE INSERT OR UPDATE OF store_id, product_id ON product_images
FOR EACH ROW EXECUTE FUNCTION codiq_guard_product_child_store();

CREATE TRIGGER inventory_movements_guard_store
BEFORE INSERT OR UPDATE OF store_id, product_id ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION codiq_guard_product_child_store();

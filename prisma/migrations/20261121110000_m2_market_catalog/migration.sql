-- Marketplace M2 — products across the market (docs/MARKETPLACE_PLAN.md §1.3, §1.5).
--
-- 1. market_categories — ONE tree for the whole market (each store keeps its own
--    categories; the merchant maps his to these). Two levels.
-- 2. products gain what the market shows: a price before discount, condition,
--    tags from a closed list, specifications, pre-order dates, a per-order cap,
--    and an optional market category of their own (else their store category's).
-- 3. product_addons — optional extras sold with a product (gift wrap, a case…).
-- 4. product_market_stats — sold/viewed/rated per product, written hourly by the
--    market-metrics job; the lists sort by it instead of aggregating per request.
-- 5. market_search_terms — searches per normalized term per day. No shopper,
--    no session, no IP: only the words and how often.

CREATE TABLE market_categories (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id   INTEGER REFERENCES market_categories(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  slug        TEXT    NOT NULL UNIQUE,
  name_ar     TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_categories_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  CONSTRAINT market_categories_name_length CHECK (length(btrim(name_ar)) BETWEEN 2 AND 60),
  CONSTRAINT market_categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX market_categories_parent_idx ON market_categories (parent_id, sort_order);

-- Two levels only: a child's parent must itself be a root.
CREATE FUNCTION codiq_market_category_depth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM market_categories WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'market categories have two levels' USING ERRCODE = 'check_violation', CONSTRAINT = 'market_categories_two_levels';
  END IF;
  IF NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM market_categories WHERE parent_id = NEW.id) THEN
    RAISE EXCEPTION 'a category with children cannot become a child' USING ERRCODE = 'check_violation', CONSTRAINT = 'market_categories_two_levels';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER market_categories_two_levels BEFORE INSERT OR UPDATE OF parent_id ON market_categories
  FOR EACH ROW EXECUTE FUNCTION codiq_market_category_depth();

ALTER TABLE product_categories
  ADD COLUMN market_category_id INTEGER REFERENCES market_categories(id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE products
  ADD COLUMN market_category_id   INTEGER REFERENCES market_categories(id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN compare_at_price_iqd INTEGER,
  ADD COLUMN condition            TEXT    NOT NULL DEFAULT 'new',
  ADD COLUMN tags                 TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN specs                JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN is_preorder          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN preorder_release_on  DATE,
  ADD COLUMN preorder_ships_by    DATE,
  ADD COLUMN max_per_order        INTEGER,
  -- «was» is a real earlier price: above today's, and a sane number.
  ADD CONSTRAINT products_compare_at_above_price CHECK (compare_at_price_iqd IS NULL OR (compare_at_price_iqd > price_iqd AND compare_at_price_iqd <= 2147483647)),
  ADD CONSTRAINT products_condition_known CHECK (condition IN ('new', 'used', 'refurbished')),
  ADD CONSTRAINT products_tags_known CHECK (
    tags <@ ARRAY['original','imported','warranty','limited_edition','exclusive','free_delivery','free_returns']::text[]
    AND cardinality(tags) <= 7),
  ADD CONSTRAINT products_specs_array CHECK (jsonb_typeof(specs) = 'array' AND jsonb_array_length(specs) <= 30),
  -- Pre-order dates belong to pre-orders; a ship date cannot precede the release.
  ADD CONSTRAINT products_preorder_dates CHECK (
    (is_preorder OR (preorder_release_on IS NULL AND preorder_ships_by IS NULL))
    AND (preorder_release_on IS NULL OR preorder_ships_by IS NULL OR preorder_ships_by >= preorder_release_on)),
  ADD CONSTRAINT products_max_per_order_range CHECK (max_per_order IS NULL OR max_per_order BETWEEN 1 AND 99);

CREATE INDEX products_market_category_idx ON products (market_category_id) WHERE deleted_at IS NULL;
CREATE INDEX product_categories_market_category_idx ON product_categories (market_category_id);
-- The market's «newest» list reads live products across every store.
CREATE INDEX products_market_created_idx ON products (created_at DESC, id DESC) WHERE deleted_at IS NULL AND is_active;

CREATE TABLE product_addons (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID    NOT NULL,
  product_id  UUID    NOT NULL,
  name        TEXT    NOT NULL,
  price_iqd   INTEGER NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- Tenant isolation the house way: an add-on cannot point at another store's product.
  CONSTRAINT product_addons_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT product_addons_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT product_addons_price_range CHECK (price_iqd BETWEEN 0 AND 100000000)
);
CREATE INDEX product_addons_product_idx ON product_addons (store_id, product_id, sort_order);

CREATE TABLE product_market_stats (
  product_id     UUID PRIMARY KEY,
  store_id       UUID NOT NULL,
  rating_avg     NUMERIC(3,2),
  rating_count   INTEGER NOT NULL DEFAULT 0,
  sold_1d        INTEGER NOT NULL DEFAULT 0,
  sold_7d        INTEGER NOT NULL DEFAULT 0,
  sold_30d       INTEGER NOT NULL DEFAULT 0,
  sold_90d       INTEGER NOT NULL DEFAULT 0,
  views_7d       INTEGER NOT NULL DEFAULT 0,
  views_30d      INTEGER NOT NULL DEFAULT 0,
  computed_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT product_market_stats_product_store_key UNIQUE (product_id, store_id),
  CONSTRAINT product_market_stats_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT product_market_stats_rating_range CHECK (rating_avg IS NULL OR rating_avg BETWEEN 1 AND 5),
  CONSTRAINT product_market_stats_nonnegative CHECK (rating_count >= 0 AND sold_1d >= 0 AND sold_7d >= 0 AND sold_30d >= 0 AND sold_90d >= 0 AND views_7d >= 0 AND views_30d >= 0)
);

CREATE TABLE market_search_terms (
  term      TEXT    NOT NULL,
  day       DATE    NOT NULL,
  searches  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, day),
  CONSTRAINT market_search_terms_term_length CHECK (length(term) BETWEEN 2 AND 60),
  CONSTRAINT market_search_terms_positive CHECK (searches >= 0)
);
CREATE INDEX market_search_terms_day_idx ON market_search_terms (day);

-- Seed: the market's category tree. The owner extends it; slugs are URLs.
WITH roots(slug, name_ar, ord) AS (VALUES
  ('electronics', 'الإلكترونيات والموبايل', 1), ('appliances', 'الأجهزة المنزليّة', 2), ('men', 'أزياء رجاليّة', 3),
  ('women', 'أزياء نسائيّة', 4), ('kids', 'الأطفال والألعاب', 5), ('beauty', 'الجمال والعناية', 6),
  ('home', 'البيت والمطبخ', 7), ('health', 'الصحّة والصيدليّة', 8), ('grocery', 'البقالة والأغذية', 9),
  ('sports', 'الرياضة', 10), ('automotive', 'السيّارات', 11), ('books', 'الكتب والقرطاسيّة', 12), ('gifts', 'الهدايا والورود', 13))
INSERT INTO market_categories (slug, name_ar, sort_order) SELECT slug, name_ar, ord FROM roots;

INSERT INTO market_categories (parent_id, slug, name_ar, sort_order)
SELECT parent.id, child.slug, child.name_ar, child.ord
  FROM (VALUES
    ('electronics', 'phones', 'هواتف ذكيّة', 1), ('electronics', 'phone-accessories', 'إكسسوارات الهواتف', 2),
    ('electronics', 'computers', 'حواسيب ولابتوبات', 3), ('electronics', 'audio', 'سمّاعات وصوتيّات', 4),
    ('electronics', 'smart-watches', 'ساعات ذكيّة', 5), ('electronics', 'gaming', 'ألعاب الفيديو', 6),
    ('appliances', 'kitchen-appliances', 'أجهزة المطبخ', 1), ('appliances', 'screens', 'الشاشات والتلفزيونات', 2),
    ('appliances', 'cooling', 'التبريد والتكييف', 3), ('appliances', 'washers', 'الغسّالات', 4),
    ('men', 'men-clothing', 'ملابس رجاليّة', 1), ('men', 'men-shoes', 'أحذية رجاليّة', 2), ('men', 'men-accessories', 'إكسسوارات رجاليّة', 3),
    ('women', 'women-clothing', 'ملابس نسائيّة', 1), ('women', 'women-shoes', 'أحذية نسائيّة', 2), ('women', 'bags', 'حقائب', 3), ('women', 'jewelry', 'إكسسوارات ومجوهرات', 4),
    ('kids', 'kids-clothing', 'ملابس أطفال', 1), ('kids', 'toys', 'ألعاب', 2), ('kids', 'baby', 'مستلزمات الرضّع', 3),
    ('beauty', 'makeup', 'مكياج', 1), ('beauty', 'skincare', 'العناية بالبشرة', 2), ('beauty', 'fragrance', 'العطور', 3), ('beauty', 'haircare', 'العناية بالشعر', 4),
    ('home', 'kitchenware', 'أدوات المطبخ', 1), ('home', 'furniture', 'الأثاث', 2), ('home', 'bedding', 'المفروشات', 3), ('home', 'decor', 'الديكور', 4),
    ('health', 'supplements', 'أدوية ومكمّلات', 1), ('health', 'medical-devices', 'أجهزة طبيّة', 2),
    ('grocery', 'food', 'مواد غذائيّة', 1), ('grocery', 'drinks', 'مشروبات', 2), ('grocery', 'sweets', 'حلويات', 3),
    ('sports', 'sportswear', 'ملابس رياضيّة', 1), ('sports', 'sports-equipment', 'معدّات رياضيّة', 2),
    ('automotive', 'car-accessories', 'إكسسوارات السيّارات', 1), ('automotive', 'car-parts', 'قطع غيار', 2)
  ) AS child(parent_slug, slug, name_ar, ord)
  JOIN market_categories parent ON parent.slug = child.parent_slug;

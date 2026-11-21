-- Marketplace M3 — the market's front page (docs/MARKETPLACE_PLAN.md §1.3, C3–C11).
--
-- Everything here is the PLATFORM's editorial content, edited by the owner:
--   market_banners          scheduled slides and ads, each with where it shows and where it leads,
--                           and how often it was seen and tapped;
--   market_collections      curated product lists («مجموعات») and discount events («خصومات»);
--   market_malls            groups of stores («مول»);
--   market_home_sections    the front page itself: which blocks, in which order.

CREATE TABLE market_banners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement     TEXT NOT NULL,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  image_object_key   TEXT UNIQUE,
  image_content_type TEXT,
  image_byte_size    INTEGER,
  link_kind     TEXT NOT NULL DEFAULT 'none',
  link_target   TEXT,
  starts_at     TIMESTAMPTZ(6),
  ends_at       TIMESTAMPTZ(6),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_ad         BOOLEAN NOT NULL DEFAULT false,
  views         INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_banners_placement_known CHECK (placement IN ('home_hero', 'home_strip', 'categories_top', 'search_top')),
  CONSTRAINT market_banners_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 80 AND (subtitle IS NULL OR length(subtitle) <= 140)),
  CONSTRAINT market_banners_image_complete CHECK (
    (image_object_key IS NULL AND image_content_type IS NULL AND image_byte_size IS NULL)
    OR (image_object_key IS NOT NULL AND image_content_type IS NOT NULL AND image_byte_size > 0)),
  CONSTRAINT market_banners_link_known CHECK (link_kind IN ('none', 'store', 'product', 'category', 'collection', 'mall', 'section', 'search')),
  -- Every link but «none» names its target; «none» names nothing.
  CONSTRAINT market_banners_link_target CHECK ((link_kind = 'none') = (link_target IS NULL) AND (link_target IS NULL OR length(link_target) <= 120)),
  CONSTRAINT market_banners_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT market_banners_counts_nonnegative CHECK (views >= 0 AND clicks >= 0)
);
CREATE INDEX market_banners_live_idx ON market_banners (placement, sort_order) WHERE is_active;

CREATE TABLE market_collections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'collection',
  title         TEXT NOT NULL,
  subtitle      TEXT,
  -- A discount event's headline («خصومات لحد ٤٠٪»). The prices themselves stay the stores'.
  headline_discount_percent INTEGER,
  starts_at     TIMESTAMPTZ(6),
  ends_at       TIMESTAMPTZ(6),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_collections_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  CONSTRAINT market_collections_kind_known CHECK (kind IN ('collection', 'discount')),
  CONSTRAINT market_collections_title_length CHECK (length(btrim(title)) BETWEEN 2 AND 80 AND (subtitle IS NULL OR length(subtitle) <= 160)),
  CONSTRAINT market_collections_headline_range CHECK (headline_discount_percent IS NULL OR headline_discount_percent BETWEEN 1 AND 99),
  CONSTRAINT market_collections_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE market_collection_items (
  collection_id UUID NOT NULL REFERENCES market_collections(id) ON DELETE CASCADE ON UPDATE CASCADE,
  product_id    UUID NOT NULL,
  store_id      UUID NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, product_id),
  CONSTRAINT market_collection_items_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX market_collection_items_product_idx ON market_collection_items (product_id);

CREATE TABLE market_malls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_malls_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  CONSTRAINT market_malls_name_length CHECK (length(btrim(name)) BETWEEN 2 AND 80 AND (description IS NULL OR length(description) <= 300))
);

CREATE TABLE market_mall_stores (
  mall_id    UUID NOT NULL REFERENCES market_malls(id) ON DELETE CASCADE ON UPDATE CASCADE,
  store_id   UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mall_id, store_id)
);
CREATE INDEX market_mall_stores_store_idx ON market_mall_stores (store_id);

CREATE TABLE market_home_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,
  title       TEXT,
  -- What the block shows: {sort, category, discount…} for a product list,
  -- {slug} for a collection, {placement} for banners. Shaped by zod on write.
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  position    INTEGER NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT market_home_sections_kind_known CHECK (kind IN ('banners', 'categories', 'products', 'stores', 'collections', 'malls', 'recently_viewed', 'for_you')),
  CONSTRAINT market_home_sections_title_length CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 60),
  CONSTRAINT market_home_sections_config_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT market_home_sections_position_key UNIQUE (position) DEFERRABLE INITIALLY DEFERRED
);

-- The default front page; the owner reorders and edits it.
INSERT INTO market_home_sections (kind, title, config, position) VALUES
  ('banners', NULL, '{"placement": "home_hero"}', 1),
  ('categories', 'تسوّق حسب الفئة', '{}', 2),
  ('products', 'أفضل التخفيضات', '{"sort": "discount", "discount": "any", "section": "discounts"}', 3),
  ('recently_viewed', 'شاهدته مؤخراً', '{}', 4),
  ('stores', 'متاجر مقترحة', '{"sort": "recommended"}', 5),
  ('products', 'ينفد قريباً', '{"sort": "best_selling", "sellsFast": true, "section": "sells-fast"}', 6),
  ('banners', NULL, '{"placement": "home_strip"}', 7),
  ('products', 'وصل حديثاً', '{"sort": "newest", "section": "new"}', 8),
  ('collections', 'مجموعات مختارة', '{}', 9),
  ('products', 'الأكثر شعبية', '{"sort": "trending", "section": "trending"}', 10),
  ('for_you', 'مقترح لك', '{}', 11),
  ('malls', 'المولات', '{}', 12),
  ('products', 'الأكثر مبيعاً', '{"sort": "best_selling", "period": "week", "section": "best-sellers"}', 13),
  ('stores', 'انضمّت حديثاً', '{"sort": "newest"}', 14);

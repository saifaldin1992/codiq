-- Marketplace M8b — the platform's own coupons and points (docs/MARKETPLACE_PLAN.md H4–H6).
--
-- WHO PAYS. A store's coupon and a store's points are the store's (unchanged). A PLATFORM
-- coupon is the platform's: the shopper pays less, the store is paid as if he had not.
-- So the platform discount is NOT the order's `discount_iqd` (which lowers the commission
-- base and the payout); it is its own column, recorded on the order and on the completion
-- ledger entry, and never subtracted from what the store is owed. Its sum is the
-- platform's cost of the programme.
--
--   platform_coupons / platform_coupon_stores   the coupons and, optionally, the stores they work in
--   shopper_coupons                             «كوبوناتي»: one row per coupon a shopper holds; used once
--   shopper_points_entries                      the points ledger (append-only); the balance is its sum
--   store_orders.platform_discount_iqd / .platform_coupon_wallet_id
--   ledger_entries.platform_discount_iqd

CREATE TABLE platform_coupons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  description         TEXT,
  kind                TEXT NOT NULL,
  percent_off         SMALLINT,
  amount_off_iqd      INTEGER,
  max_discount_iqd    INTEGER,
  min_subtotal_iqd    INTEGER NOT NULL DEFAULT 0,
  starts_at           TIMESTAMPTZ(6) NOT NULL,
  ends_at             TIMESTAMPTZ(6) NOT NULL,
  -- How many may be handed out in all; NULL = no limit.
  total_limit         INTEGER,
  issued_count        INTEGER NOT NULL DEFAULT 0,
  -- > 0: bought with points («استبدل نقاطك»). 0: claimed free from the coupons page.
  points_cost         INTEGER NOT NULL DEFAULT 0,
  all_stores          BOOLEAN NOT NULL DEFAULT true,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT platform_coupons_code_shape CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  CONSTRAINT platform_coupons_text CHECK (char_length(title) BETWEEN 1 AND 80 AND (description IS NULL OR char_length(description) <= 300)),
  CONSTRAINT platform_coupons_kind CHECK (
    (kind = 'percent' AND percent_off BETWEEN 1 AND 90 AND amount_off_iqd IS NULL) OR
    (kind = 'fixed' AND amount_off_iqd > 0 AND percent_off IS NULL)),
  CONSTRAINT platform_coupons_amounts CHECK ((max_discount_iqd IS NULL OR max_discount_iqd > 0) AND min_subtotal_iqd >= 0 AND points_cost >= 0),
  CONSTRAINT platform_coupons_window CHECK (ends_at > starts_at),
  CONSTRAINT platform_coupons_limit CHECK ((total_limit IS NULL OR total_limit > 0) AND issued_count >= 0 AND (total_limit IS NULL OR issued_count <= total_limit))
);

CREATE TABLE platform_coupon_stores (
  coupon_id  UUID NOT NULL REFERENCES platform_coupons(id) ON DELETE CASCADE ON UPDATE CASCADE,
  store_id   UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (coupon_id, store_id)
);
CREATE INDEX platform_coupon_stores_store_idx ON platform_coupon_stores (store_id);

CREATE TABLE shopper_coupons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id      UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  coupon_id       UUID NOT NULL REFERENCES platform_coupons(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  source          TEXT NOT NULL,
  used_order_id   UUID,
  used_at         TIMESTAMPTZ(6),
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT shopper_coupons_source_known CHECK (source IN ('claimed', 'points', 'granted')),
  CONSTRAINT shopper_coupons_used_pair CHECK ((used_order_id IS NULL) = (used_at IS NULL))
);
-- A free coupon is held once; one bought with points may be bought again.
CREATE UNIQUE INDEX shopper_coupons_claimed_once ON shopper_coupons (shopper_id, coupon_id) WHERE source = 'claimed';
CREATE UNIQUE INDEX shopper_coupons_used_order ON shopper_coupons (used_order_id) WHERE used_order_id IS NOT NULL;
CREATE INDEX shopper_coupons_wallet_idx ON shopper_coupons (shopper_id, created_at DESC, id DESC);

CREATE TABLE shopper_points_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  order_id    UUID,
  coupon_id   UUID REFERENCES platform_coupons(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT shopper_points_entries_reason CHECK (reason IN ('earned', 'clawback', 'spent', 'granted')),
  CONSTRAINT shopper_points_entries_sign CHECK ((reason IN ('earned', 'granted') AND delta > 0) OR (reason IN ('clawback', 'spent') AND delta < 0))
);
-- An order earns once and is clawed back once.
CREATE UNIQUE INDEX shopper_points_entries_order_once ON shopper_points_entries (order_id, reason) WHERE order_id IS NOT NULL;
CREATE INDEX shopper_points_entries_shopper_idx ON shopper_points_entries (shopper_id, created_at DESC, id DESC);

ALTER TABLE store_orders
  ADD COLUMN platform_discount_iqd INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN platform_coupon_wallet_id UUID,
  ADD CONSTRAINT store_orders_platform_discount_nonnegative CHECK (platform_discount_iqd >= 0),
  ADD CONSTRAINT store_orders_platform_coupon_pair CHECK ((platform_coupon_wallet_id IS NULL) = (platform_discount_iqd = 0));

ALTER TABLE ledger_entries
  ADD COLUMN platform_discount_iqd INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT ledger_entries_platform_discount_nonnegative CHECK (platform_discount_iqd >= 0);

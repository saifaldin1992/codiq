-- Phase 20B-1 — coupons engine (D-08) + prescription-required products.
-- One migration for the whole checkout-core batch. Everything here is additive:
-- no existing column changes shape, no existing constraint is weakened, and a
-- checkout without a coupon or a prescription product is byte-identical to 20A.

-- ============================================================================
-- 1. coupons — merchant-managed discount codes (percent / fixed / free_shipping).
--    The exclusive CHECK makes the three kinds structurally disjoint; the
--    composite identity UNIQUE (id, store_id) lets every child reference
--    enforce same-store membership at the schema level (the 20A pattern).
-- ============================================================================
CREATE TABLE coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code text NOT NULL,
  code_normalized text NOT NULL,
  kind text NOT NULL,
  percent_off integer,
  amount_off_iqd integer,
  min_subtotal_iqd integer NOT NULL DEFAULT 0 CHECK (min_subtotal_iqd >= 0),
  max_uses_total integer CHECK (max_uses_total > 0),
  max_uses_per_customer integer CHECK (max_uses_per_customer > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_kind CHECK (kind IN ('percent', 'fixed', 'free_shipping')),
  -- Exclusive kind payload: exactly the fields of the declared kind, nothing else.
  CONSTRAINT coupons_kind_payload CHECK (
    (kind = 'percent' AND percent_off IS NOT NULL AND percent_off BETWEEN 1 AND 100 AND amount_off_iqd IS NULL)
    OR (kind = 'fixed' AND amount_off_iqd IS NOT NULL AND amount_off_iqd > 0 AND percent_off IS NULL)
    OR (kind = 'free_shipping' AND percent_off IS NULL AND amount_off_iqd IS NULL)
  ),
  CONSTRAINT coupons_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT coupons_store_code_unique UNIQUE (store_id, code_normalized),
  CONSTRAINT coupons_id_store_unique UNIQUE (id, store_id)
);

CREATE INDEX coupons_store_idx ON coupons(store_id, is_active);

-- ============================================================================
-- 2. coupon_redemptions — append-only usage ledger. UNIQUE (order_id) is the
--    structural "one coupon per order" guarantee (approved decision §8.2), and
--    the composite FKs refuse any cross-store combination with 23503.
--    waived_delivery_fee_iqd snapshots the fee a free_shipping coupon zeroed
--    (decision §8.3: free shipping zeroes the fee and never touches discount).
-- ============================================================================
CREATE TABLE coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT (not CASCADE): the immutability trigger blocks every DELETE anyway,
  -- so a store hard-delete must fail with a clear FK error, not a confusing
  -- trigger message — same rationale as ledger_entries in phase 17.
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  coupon_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  discount_iqd integer NOT NULL DEFAULT 0 CHECK (discount_iqd >= 0),
  waived_delivery_fee_iqd integer NOT NULL DEFAULT 0 CHECK (waived_delivery_fee_iqd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupon_redemptions_order_unique UNIQUE (order_id),
  CONSTRAINT coupon_redemptions_coupon_store_fk FOREIGN KEY (coupon_id, store_id) REFERENCES coupons(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT coupon_redemptions_order_store_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT coupon_redemptions_customer_store_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT
);

CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions(coupon_id);
CREATE INDEX coupon_redemptions_coupon_customer_idx ON coupon_redemptions(store_id, coupon_id, customer_id);

-- Append-only, exactly like ledger_entries (phase 17 pattern).
CREATE OR REPLACE FUNCTION codiq_prevent_coupon_redemption_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CODIQ_COUPON_REDEMPTION_IMMUTABLE'
    USING ERRCODE = '23514', DETAIL = 'Coupon redemptions are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coupon_redemptions_immutable
BEFORE UPDATE OR DELETE ON coupon_redemptions
FOR EACH ROW EXECUTE FUNCTION codiq_prevent_coupon_redemption_mutation();

-- ============================================================================
-- 3. store_orders — coupon snapshot columns (discount_iqd exists since 8A).
--    The composite FK keeps the referenced coupon in the order's own store.
-- ============================================================================
ALTER TABLE store_orders
  ADD COLUMN coupon_id uuid,
  ADD COLUMN coupon_code text,
  ADD CONSTRAINT store_orders_coupon_store_fk FOREIGN KEY (coupon_id, store_id) REFERENCES coupons(id, store_id) ON DELETE RESTRICT;

CREATE INDEX store_orders_coupon_idx ON store_orders(coupon_id) WHERE coupon_id IS NOT NULL;

-- ============================================================================
-- 4. Prescription-required products (additive).
--    products.requires_prescription flags the product; the ORDER carries the
--    review state machine: NULL (no prescription involved) or
--    pending_upload -> pending_review -> approved | rejected (rejected allows
--    re-upload). Upload happens AFTER order creation (approved decision §8.10),
--    so the checkout transaction and fingerprint stay untouched.
-- ============================================================================
ALTER TABLE products
  ADD COLUMN requires_prescription boolean NOT NULL DEFAULT false;

ALTER TABLE store_orders
  ADD COLUMN prescription_status text,
  ADD CONSTRAINT store_orders_prescription_status CHECK (
    prescription_status IS NULL
    OR prescription_status IN ('pending_upload', 'pending_review', 'approved', 'rejected')
  );

-- ============================================================================
-- 5. order_prescriptions — uploaded prescription files (private objects under
--    prescriptions/{storeId}/{orderId}/{uuid}; NO public route ever serves
--    them). Composite FKs enforce same-store membership; rejected uploads stay
--    as audit rows because a rejection allows a fresh upload.
-- ============================================================================
CREATE TABLE order_prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  review_status text NOT NULL DEFAULT 'pending',
  reviewed_by_kind text,
  reviewed_by_id uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_prescriptions_review_status CHECK (review_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT order_prescriptions_order_store_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE CASCADE,
  CONSTRAINT order_prescriptions_customer_store_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT
);

CREATE INDEX order_prescriptions_order_idx ON order_prescriptions(store_id, order_id, created_at);

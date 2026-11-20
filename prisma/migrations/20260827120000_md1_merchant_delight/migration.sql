-- MD-1 «راحة اليوم» — merchant delight batch. Strictly ADDITIVE: no existing
-- column changes shape, no existing constraint is weakened, and every new
-- column carries a NOT NULL DEFAULT so pre-existing rows stay valid without a
-- backfill. Checkout money math and locking are untouched.
--
-- 1. order_notes  — internal merchant/staff notes on an order.
-- 2. order_tags   — internal per-order labels.
-- 3. stores.vacation_mode / vacation_message — temporary "closed for orders".

-- ============================================================================
-- 1. order_notes — INTERNAL thread on an order (merchant + their staff only).
--    The composite (order_id, store_id) FK to store_orders(id, store_id) makes
--    same-store membership structural — a note can never point at another
--    store's order even if a bad id reaches the writer (the 20A/20B pattern).
--    body is capped at 2000 characters in the database as well as the service.
-- ============================================================================
CREATE TABLE order_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  author_kind text NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_notes_author_kind CHECK (author_kind IN ('merchant', 'staff')),
  CONSTRAINT order_notes_body_length CHECK (char_length(body) BETWEEN 1 AND 2000),
  CONSTRAINT order_notes_order_store_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE CASCADE
);

CREATE INDEX order_notes_store_order_idx ON order_notes(store_id, order_id, created_at);

-- ============================================================================
-- 2. order_tags — internal labels rendered on the merchant order list/detail.
--
--    WHY A TABLE AND NOT A `store_orders.internal_tags text[]` COLUMN:
--    the customer-facing order read in storefront.service.ts selects the order
--    with a TOP-LEVEL `include`, which returns every SCALAR column of
--    store_orders. A new scalar column would therefore appear in the customer's
--    own order payload the moment it exists — the exact opposite of "internal".
--    A child table is structurally invisible instead: Prisma only returns a
--    relation when a query names it, and no storefront/customer query does. The
--    privacy guarantee stops being a filter somebody must remember and becomes a
--    property of the schema.
--
--    Cost: one extra (batched) read per merchant order page — bounded by the
--    100-row page cap. Uniqueness is per order on the normalized spelling, the
--    per-tag length cap is a CHECK, and the 8-tags-per-order cap is a constraint
--    trigger, so a direct SQL write cannot bypass any of the service rules.
-- ============================================================================
CREATE TABLE order_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  tag text NOT NULL,
  tag_normalized text NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_tags_length CHECK (char_length(tag) BETWEEN 1 AND 24),
  CONSTRAINT order_tags_order_unique UNIQUE (order_id, tag_normalized),
  CONSTRAINT order_tags_order_store_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE CASCADE
);

CREATE INDEX order_tags_store_order_idx ON order_tags(store_id, order_id, position);

CREATE OR REPLACE FUNCTION codiq_guard_order_tag_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT count(*) FROM order_tags WHERE order_id = NEW.order_id) > 8 THEN
    RAISE EXCEPTION 'an order may carry at most 8 internal tags' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER order_tags_max_per_order
AFTER INSERT ON order_tags
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION codiq_guard_order_tag_count();

-- ============================================================================
-- 3. stores.vacation_mode / vacation_message — a temporary "closed for new
--    orders" switch. This is deliberately NOT is_active: the storefront stays
--    fully browsable (catalog, product pages, cart) and only CHECKOUT is
--    refused, with the merchant's own Arabic message shown as a banner.
-- ============================================================================
ALTER TABLE stores ADD COLUMN vacation_mode boolean NOT NULL DEFAULT false;
ALTER TABLE stores ADD COLUMN vacation_message text;

ALTER TABLE stores ADD CONSTRAINT stores_vacation_message_length CHECK (
  vacation_message IS NULL OR char_length(vacation_message) <= 500
);

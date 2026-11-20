-- CD-2 «تقييمات ورغبات» — product reviews, the wishlist, and back-in-stock.
--
-- ============================================================================
-- REVIEWS
-- ============================================================================
--
-- THE VERIFIED-BUYER BADGE IS STRUCTURAL, NOT A FLAG. Every review names the
-- order that entitles it (`order_id`, NOT NULL), and that order is matched by
-- `(id, store_id, customer_id)` at write time against a COMPLETED order that
-- actually contained the product. There is no `is_verified` column to set,
-- because a badge that can be set is a badge that can be granted wrongly. If a
-- row exists, a purchase exists.
--
-- ONE REVIEW PER CUSTOMER PER PRODUCT — a partial unique index, so a review the
-- customer deletes does not bar him from writing another.
--
-- MODERATION: THE MERCHANT MAY HIDE THE WORDS, NEVER THE SCORE.
--
-- This is the load-bearing decision of the whole feature, and it is a departure
-- from what «إشراف التاجر» would most obviously mean. A merchant who can remove
-- a review removes the one-star reviews, and then the rating on his shop is not
-- a rating, it is an advertisement — and every honest merchant's rating is
-- devalued with it, because a shopper cannot tell the two apart.
--
-- So `hidden_at` suppresses the TEXT from the storefront and nothing else. The
-- score stays in the average, the storefront states how many are hidden, and
-- every hide is written to store_audit_events with a required reason, where the
-- platform owner can see a merchant who hides only his worst.
--
-- The remedy for an abusive review is therefore real (the words come down) and
-- the rating stays honest (the score does not). A merchant who believes a score
-- itself is fraudulent has a path — the audit trail puts it in front of the
-- owner — but he cannot act on it alone.

CREATE TABLE IF NOT EXISTS product_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  product_id    uuid NOT NULL,
  customer_id   uuid NOT NULL,
  -- The proof. NOT NULL: there is no such thing as an unverified review here.
  order_id      uuid NOT NULL,
  rating        integer NOT NULL,
  body          text,
  hidden_at     timestamptz(6),
  hidden_reason text,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  -- NOT `deleted_at`: this is the SHOPPER withdrawing his own words, which is a
  -- different act from the merchant trashing a row of his own. Sharing the name
  -- would put withdrawn reviews in his trash bin, where he could 'restore'
  -- something that was never his to remove — and the PG-2 leak guard is right
  -- to refuse a `deleted_at` written outside the soft-delete module.
  withdrawn_at  timestamptz(6),

  -- Composite tenancy: the product, the customer and the order must all belong
  -- to the SAME store as the review. A plain FK on id alone would let a review
  -- point at another tenant's product.
  CONSTRAINT product_reviews_product_fk  FOREIGN KEY (product_id, store_id)  REFERENCES products (id, store_id)       ON DELETE CASCADE,
  CONSTRAINT product_reviews_customer_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers (id, store_id)      ON DELETE CASCADE,
  CONSTRAINT product_reviews_order_fk    FOREIGN KEY (order_id, store_id)    REFERENCES store_orders (id, store_id)   ON DELETE RESTRICT,

  CONSTRAINT product_reviews_rating_ck  CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT product_reviews_body_ck    CHECK (body IS NULL OR (btrim(body) <> '' AND length(body) <= 2000)),
  -- Hiding is an act that must be explained. Both columns or neither.
  CONSTRAINT product_reviews_hidden_ck  CHECK (
    (hidden_at IS NULL AND hidden_reason IS NULL)
    OR (hidden_at IS NOT NULL AND hidden_reason IS NOT NULL AND btrim(hidden_reason) <> '' AND length(hidden_reason) <= 500)
  )
);

-- One live review per customer per product.
CREATE UNIQUE INDEX IF NOT EXISTS product_reviews_one_per_customer_uq
  ON product_reviews (store_id, product_id, customer_id) WHERE withdrawn_at IS NULL;

-- The storefront reads a product's live reviews, newest first.
CREATE INDEX IF NOT EXISTS product_reviews_product_idx
  ON product_reviews (store_id, product_id, created_at DESC, id DESC) WHERE withdrawn_at IS NULL;

-- The merchant's moderation queue reads his store's live reviews.
CREATE INDEX IF NOT EXISTS product_reviews_store_idx
  ON product_reviews (store_id, created_at DESC, id DESC) WHERE withdrawn_at IS NULL;

COMMENT ON COLUMN product_reviews.order_id IS
  'CD-2: the completed order that entitles this review. NOT NULL — the verified-buyer badge is this column, not a flag.';
COMMENT ON COLUMN product_reviews.hidden_at IS
  'CD-2: the merchant hid the TEXT. The rating still counts toward the average; see the migration header.';

-- ============================================================================
-- WISHLIST
-- ============================================================================
--
-- Rows point at a VARIANT, not a product: «نبّهني عند التوفر» is a question
-- about a specific size or colour, and answering it for the product as a whole
-- would send a shopper to a page where the thing he wanted is still absent.

CREATE TABLE IF NOT EXISTS wishlist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  product_id  uuid NOT NULL,
  variant_id  uuid NOT NULL,
  -- MD-3-style opt-in: saving a product is not the same as asking to be paged
  -- when it returns, so the alert is its own switch and defaults OFF.
  notify_on_restock boolean NOT NULL DEFAULT false,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT wishlist_items_customer_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers (id, store_id) ON DELETE CASCADE,
  CONSTRAINT wishlist_items_product_fk  FOREIGN KEY (product_id, store_id)  REFERENCES products (id, store_id)  ON DELETE CASCADE,
  CONSTRAINT wishlist_items_variant_fk  FOREIGN KEY (variant_id, store_id)  REFERENCES product_variants (id, store_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS wishlist_items_unique_uq
  ON wishlist_items (store_id, customer_id, variant_id);

-- The restock scanner asks: who is waiting on this variant?
CREATE INDEX IF NOT EXISTS wishlist_items_restock_idx
  ON wishlist_items (store_id, variant_id) WHERE notify_on_restock = true;

-- ============================================================================
-- BACK IN STOCK
-- ============================================================================
--
-- CLASSIFIED MARKETING, deliberately, even though the shopper asked for it.
--
-- The argument for «operational» is that he requested this exact message. The
-- argument against — which wins — is that its timing is ours, its content
-- promotes a purchase, and the sending domain is SHARED with every store's
-- order confirmations. Being wrong in the operational direction risks that
-- domain for everyone; being wrong in the marketing direction costs one message
-- to somebody who had already told us to stop marketing to him.

INSERT INTO notification_event_kinds (event_type, kind, description) VALUES
  ('stock.back_in_stock', 'marketing', 'عاد متغيّر إلى التوفر وكان زبون قد طلب التنبيه — رسالة مطلوبة، لكنها تسويقية التوقيت والمضمون.')
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- AUDIT: the merchant hiding a review is an act that must be answerable for.
-- ============================================================================
--
-- THE VALUE LISTS BELOW ARE A UNION, ON PURPOSE. These CHECKs are recreated
-- wholesale rather than appended to, so any migration that recreates them must
-- carry EVERY value already in use — including `store_verification` and the two
-- verification actions from MD-6, which land in a separate branch. If this file
-- listed only the review values and MD-6 had already shipped, this ALTER would
-- fail against any database holding a verification event, and if it somehow
-- succeeded it would outlaw rows that already exist. Migrations run in timestamp
-- order, so a later file must always be a superset of the earlier ones.

ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_entity_type;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_entity_type CHECK (entity_type IN
  ('product','product_variant','product_category','coupon','staff_membership','store_verification','product_review'));

ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_action;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_action CHECK (action IN
  ('soft_deleted','restored','purged','purge_blocked','verification.granted','verification.revoked','review.hidden','review.unhidden'));

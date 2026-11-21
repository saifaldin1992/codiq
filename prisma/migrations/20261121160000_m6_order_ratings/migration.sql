-- Marketplace M6 (G6): «قيّم طلبك».
--
-- A shopper rates a completed order once (and may revise it): stars for each
-- product go to product_reviews — the existing verified-buyer reviews that
-- already feed the product's and the store's rating — and what is about the
-- ORDER rather than a product lands here: the delivery stars (none for a
-- pick-up), tags from a fixed list, and a note for the store.
CREATE TABLE order_ratings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL,
  store_id        UUID NOT NULL,
  customer_id     UUID NOT NULL,
  delivery_rating SMALLINT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  note            TEXT,
  created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT order_ratings_order_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders (id, store_id) ON DELETE CASCADE,
  CONSTRAINT order_ratings_customer_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers (id, store_id) ON DELETE CASCADE,
  CONSTRAINT order_ratings_delivery_range CHECK (delivery_rating IS NULL OR delivery_rating BETWEEN 1 AND 5),
  -- Mirrors ORDER_RATING_TAGS in modules/market-cart/after-sale.service.ts.
  CONSTRAINT order_ratings_known_tags CHECK (tags <@ ARRAY[
    'late_delivery', 'damaged', 'not_as_described', 'poor_service', 'poor_packaging', 'average_quality', 'slow_response', 'overpriced',
    'excellent_quality', 'fast_delivery', 'as_described', 'great_service'
  ]::TEXT[]),
  CONSTRAINT order_ratings_note_length CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE UNIQUE INDEX order_ratings_order_key ON order_ratings (order_id);
-- The store's view of its ratings, newest first.
CREATE INDEX order_ratings_store_created_idx ON order_ratings (store_id, created_at DESC, id DESC);

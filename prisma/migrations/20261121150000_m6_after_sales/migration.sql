-- Marketplace M6 — after the order is placed (docs/MARKETPLACE_PLAN.md §1.7).
--
-- Nothing here touches the order state machine or the money. Every change of
-- status still goes through transitionOrderStatus; this migration only adds
-- what the shopper SEES and SAYS around it:
--
--   store_orders.delivery_stage       the finer step the store reports while the order is with
--                                     the courier (at the warehouse, with the courier, on the way,
--                                     postponed, coming back). Shown, never a status.
--   order_handover_codes              four digits the shopper hands the courier or the counter.
--                                     The store types it to mark the order delivered: proof of
--                                     hand-over the store itself cannot invent, because it never
--                                     sees the code. A TABLE, not a column on store_orders: the
--                                     store's order payload carries every column of the order,
--                                     and this one must never reach the store.
--   store_orders.cancel_reason_code   why the shopper called it off, from a fixed list.
--   order_ratings                     one rating per delivered order: the store, the delivery,
--                                     quick tags, a note. Product stars go to product_reviews.

ALTER TABLE store_orders
  ADD COLUMN delivery_stage         TEXT,
  ADD COLUMN delivery_stage_at      TIMESTAMPTZ(6),
  ADD COLUMN cancel_reason_code     TEXT,
  ADD CONSTRAINT store_orders_delivery_stage_known CHECK (delivery_stage IS NULL OR delivery_stage IN ('at_warehouse', 'with_courier', 'on_the_way', 'postponed', 'returning')),
  ADD CONSTRAINT store_orders_cancel_reason_known CHECK (cancel_reason_code IS NULL OR cancel_reason_code IN ('changed_mind', 'ordered_by_mistake', 'found_better_price', 'delivery_too_slow', 'wrong_details', 'other'));

CREATE TABLE order_handover_codes (
  order_id    UUID PRIMARY KEY,
  store_id    UUID NOT NULL,
  code        TEXT NOT NULL,
  -- Wrong codes typed by the store. After five the code stops working and the
  -- order is completed the ordinary way, from the orders screen.
  failures    INTEGER NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ(6),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT order_handover_codes_order_id_store_id_key UNIQUE (order_id, store_id),
  CONSTRAINT order_handover_codes_order_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT order_handover_codes_shape CHECK (code ~ '^[0-9]{4}$'),
  CONSTRAINT order_handover_codes_failures_range CHECK (failures BETWEEN 0 AND 100)
);

CREATE TABLE order_ratings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL UNIQUE,
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  shopper_id      UUID REFERENCES shoppers(id) ON DELETE SET NULL ON UPDATE CASCADE,
  store_stars     SMALLINT NOT NULL,
  delivery_stars  SMALLINT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  note            TEXT,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT order_ratings_order_id_store_id_key UNIQUE (order_id, store_id),
  CONSTRAINT order_ratings_order_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT order_ratings_store_stars_range CHECK (store_stars BETWEEN 1 AND 5),
  CONSTRAINT order_ratings_delivery_stars_range CHECK (delivery_stars IS NULL OR delivery_stars BETWEEN 1 AND 5),
  CONSTRAINT order_ratings_tags_bounded CHECK (cardinality(tags) <= 10),
  CONSTRAINT order_ratings_note_length CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX order_ratings_store_idx ON order_ratings (store_id, created_at DESC, id DESC);
CREATE INDEX order_ratings_shopper_idx ON order_ratings (shopper_id, created_at DESC, id DESC);

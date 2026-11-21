-- POS price deviations — the till's prices, read against the catalog.
--
-- The till is trusted with its own prices ON PURPOSE (pos.service.ts): an
-- offline sale rung at yesterday's price is a real sale, and the receipt in the
-- customer's hand is the record. What was missing is anyone LOOKING. A cashier
-- could ring a line at 0, or a ticket discount equal to the whole ticket, and
-- keep the cash; the order recorded the price faithfully and no screen ever
-- set it beside what the catalog says the goods cost.
--
-- One row per deviating line, plus one per ticket-level discount. Written in
-- the SAME transaction as the sale, never refusing it — the clamp-never-refuse
-- rule of the shortfall queue, applied to money. Reviewed, never deleted.

CREATE TABLE pos_price_deviations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id               uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  pos_ticket_id          uuid NOT NULL,
  -- NULL only for a ticket-level discount, which belongs to no single line.
  variant_id             uuid,
  kind                   text NOT NULL CHECK (kind IN ('price_below_catalog', 'price_above_catalog', 'ticket_discount')),
  quantity               integer NOT NULL CHECK (quantity > 0),
  sold_unit_price_iqd    integer NOT NULL CHECK (sold_unit_price_iqd >= 0),
  catalog_unit_price_iqd integer NOT NULL CHECK (catalog_unit_price_iqd >= 0),
  -- The size of the gap in money, always positive; `kind` says which way.
  amount_iqd             integer NOT NULL CHECK (amount_iqd > 0),
  reviewed_at            timestamptz(6),
  -- (3), not (6): the keyset cursor carries a JS Date, which holds milliseconds.
  created_at             timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT pos_price_deviations_ticket_store_fk
    FOREIGN KEY (pos_ticket_id, store_id) REFERENCES pos_tickets(id, store_id) ON DELETE CASCADE,
  CONSTRAINT pos_price_deviations_variant_store_fk
    FOREIGN KEY (variant_id, store_id) REFERENCES product_variants(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT pos_price_deviations_shape_ck CHECK (
    (kind = 'ticket_discount' AND variant_id IS NULL)
    OR (kind <> 'ticket_discount' AND variant_id IS NOT NULL AND sold_unit_price_iqd <> catalog_unit_price_iqd)
  )
);

-- The open queue, newest first: the keyset `(created_at, id)` behind the tenant.
CREATE INDEX pos_price_deviations_open_created_id_idx
  ON pos_price_deviations (store_id, created_at DESC, id DESC) WHERE reviewed_at IS NULL;

-- The ticket's foreign key is (pos_ticket_id, store_id); the cascade from a
-- ticket must find its rows without a scan.
CREATE INDEX pos_price_deviations_ticket_idx ON pos_price_deviations (pos_ticket_id);

COMMENT ON TABLE pos_price_deviations IS
  'Till prices that differ from the catalog price at sync time, and ticket-level discounts. Never refuses a sale; reviewed by the store owner, never deleted.';

-- Marketplace M5 — one cart for the whole market, checked out one store at a time
-- (docs/MARKETPLACE_PLAN.md §1.6).
--
-- THE DESIGN: the market cart is only a list. Paying for one store's lines
-- moves them into that store's own customer cart and runs the store's EXISTING
-- checkout unchanged — the same locks, stock reservations, coupon, loyalty,
-- commission, ledger and notifications as a purchase on the storefront. No
-- second money path exists to drift from the first.
--
--   market_carts / market_cart_items    the shopper's basket across stores
--   cart_items.addon_ids, .addons_snapshot_iqd
--   order_items.addons                  paid add-ons travel with the line: priced into
--                                       its unit price at checkout, named on the order
--   store_orders.fulfilment             delivery, or pick-up at the store's counter

CREATE TABLE market_carts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  UUID NOT NULL UNIQUE REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE market_cart_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id              UUID NOT NULL REFERENCES market_carts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  store_id             UUID NOT NULL,
  product_id           UUID NOT NULL,
  variant_id           UUID NOT NULL,
  quantity             INTEGER NOT NULL,
  addon_ids            UUID[] NOT NULL DEFAULT '{}',
  -- What the shopper was shown when he added it: the variant's price and the add-ons' sum.
  price_snapshot_iqd   INTEGER NOT NULL,
  addons_snapshot_iqd  INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- The line's variant belongs to its product, and its product to its store.
  CONSTRAINT market_cart_items_variant_fk FOREIGN KEY (variant_id, product_id, store_id) REFERENCES product_variants(id, product_id, store_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT market_cart_items_cart_variant_key UNIQUE (cart_id, variant_id),
  CONSTRAINT market_cart_items_quantity_range CHECK (quantity BETWEEN 1 AND 99),
  CONSTRAINT market_cart_items_addons_bounded CHECK (cardinality(addon_ids) <= 20),
  CONSTRAINT market_cart_items_prices_nonnegative CHECK (price_snapshot_iqd >= 0 AND addons_snapshot_iqd >= 0)
);
CREATE INDEX market_cart_items_cart_idx ON market_cart_items (cart_id, store_id, created_at);
CREATE INDEX market_cart_items_variant_idx ON market_cart_items (variant_id);

ALTER TABLE cart_items
  ADD COLUMN addon_ids           UUID[]  NOT NULL DEFAULT '{}',
  ADD COLUMN addons_snapshot_iqd INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT cart_items_addons_bounded CHECK (cardinality(addon_ids) <= 20 AND addons_snapshot_iqd >= 0);

ALTER TABLE order_items
  -- [{id, name, priceIqd}] as charged. Already inside unit_price_iqd; this names them.
  ADD COLUMN addons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT order_items_addons_array CHECK (jsonb_typeof(addons) = 'array');

ALTER TABLE store_orders
  ADD COLUMN fulfilment TEXT NOT NULL DEFAULT 'delivery',
  ADD CONSTRAINT store_orders_fulfilment_known CHECK (fulfilment IN ('delivery', 'pickup')),
  -- A counter pick-up carries no courier: nothing to charge for delivery.
  ADD CONSTRAINT store_orders_pickup_no_delivery_fee CHECK (fulfilment = 'delivery' OR delivery_fee_iqd = 0);

-- A store customer created for a market shopper signs in through the market
-- (phone + one-time code), not with a password at that store. The rule «a
-- customer is a guest or has a password» gains its third, equally explicit case.
ALTER TABLE customers DROP CONSTRAINT customers_guest_or_password;
ALTER TABLE customers ADD CONSTRAINT customers_guest_or_password CHECK (is_guest OR password_hash IS NOT NULL OR shopper_id IS NOT NULL);

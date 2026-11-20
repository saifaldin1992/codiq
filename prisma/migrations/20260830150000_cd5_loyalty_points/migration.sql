-- CD-5 «نقاط الولاء» — earned on completion, spent as a discount.
--
-- ============================================================================
-- A LEDGER, NOT A BALANCE COLUMN
-- ============================================================================
--
-- There is no `customers.points` to increment. The balance is the SUM of this
-- append-only table, exactly as the merchant's money is the sum of
-- `ledger_entries`. A stored balance and a history that disagree is the defining
-- loyalty bug: the customer sees one number, the statement shows another, and
-- nobody can say which is wrong or when it happened.
--
-- Every row names the ORDER it came from, so any figure on any screen can be
-- opened and read back to the purchase that caused it.
--
-- ============================================================================
-- EARNING IS IDEMPOTENT, AND A RETURN TAKES IT BACK
-- ============================================================================
--
-- `loyalty_entries_one_per_order_kind_uq` makes «one earn per order» and «one
-- spend per order» structural. Completion can be retried, a worker can run
-- twice, two requests can race — the second collides with the index rather than
-- minting points a second time.
--
-- And a returned order reverses BOTH sides. Without the earn clawback, buy →
-- return is a points printer. Without the spend refund, a shopper who paid part
-- of a returned order in points is refunded in money for the cash half and
-- nothing for the points half, which is simply keeping his money.
--
-- ============================================================================
-- OFF UNTIL THE MERCHANT TURNS IT ON
-- ============================================================================
--
-- A merchant must never discover he has been giving discounts away because a
-- platform update defaulted a programme on. `loyalty_enabled` is false, and the
-- rates below only mean anything while it is true.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS loyalty_enabled boolean NOT NULL DEFAULT false,
  -- Points earned per 1000 IQD of commissionable subtotal. Integer: a fractional
  -- point is a number a shopper cannot reason about.
  ADD COLUMN IF NOT EXISTS loyalty_earn_per_1000 integer NOT NULL DEFAULT 10,
  -- IQD each point is worth when spent.
  ADD COLUMN IF NOT EXISTS loyalty_point_value_iqd integer NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_loyalty_rates_ck') THEN
    ALTER TABLE stores ADD CONSTRAINT stores_loyalty_rates_ck
      CHECK (loyalty_earn_per_1000 BETWEEN 0 AND 1000 AND loyalty_point_value_iqd BETWEEN 1 AND 10000);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS loyalty_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  order_id    uuid NOT NULL,
  -- earned  : completion awarded points        (+)
  -- spent   : checkout redeemed points         (-)
  -- reversed_earn : the order was returned     (-)
  -- refunded_spend: the order was returned     (+)
  kind        text NOT NULL,
  -- ALWAYS POSITIVE. The sign lives in `kind`, not in the number, so a query
  -- that forgets to apply it produces an obviously wrong total rather than a
  -- plausible one. `loyaltyBalance` applies the sign in exactly one place.
  points      integer NOT NULL,
  /* What the points were worth in IQD when spent — snapshotted, because a
     merchant may change the rate tomorrow and this row must still explain the
     order it belongs to. Null for earn rows. */
  value_iqd   integer,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT loyalty_entries_customer_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers (id, store_id)    ON DELETE CASCADE,
  CONSTRAINT loyalty_entries_order_fk    FOREIGN KEY (order_id, store_id)    REFERENCES store_orders (id, store_id) ON DELETE CASCADE,

  CONSTRAINT loyalty_entries_kind_ck   CHECK (kind IN ('earned', 'spent', 'reversed_earn', 'refunded_spend')),
  CONSTRAINT loyalty_entries_points_ck CHECK (points > 0),
  CONSTRAINT loyalty_entries_value_ck  CHECK (
    (kind IN ('spent', 'refunded_spend') AND value_iqd IS NOT NULL AND value_iqd >= 0)
    OR (kind IN ('earned', 'reversed_earn') AND value_iqd IS NULL)
  )
);

-- One of each kind per order: this is what makes earning idempotent, and what
-- stops a return being clawed back twice.
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_entries_one_per_order_kind_uq
  ON loyalty_entries (order_id, kind);

-- The balance query: every entry for one customer in one store.
CREATE INDEX IF NOT EXISTS loyalty_entries_customer_idx
  ON loyalty_entries (store_id, customer_id, created_at DESC, id DESC);

-- Append-only, exactly like the finance ledger. A points history that can be
-- edited is a points history nobody can be shown.
CREATE OR REPLACE FUNCTION loyalty_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CODIQ_LOYALTY_ENTRY_IMMUTABLE' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS loyalty_entries_immutable ON loyalty_entries;
CREATE TRIGGER loyalty_entries_immutable
BEFORE UPDATE OR DELETE ON loyalty_entries
FOR EACH ROW EXECUTE FUNCTION loyalty_entries_immutable();

-- The order records what it actually redeemed, so an order can be read on its
-- own — a receipt that needed a join to explain its own total is not a receipt.
ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS loyalty_points_spent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_discount_iqd integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_orders_loyalty_ck') THEN
    ALTER TABLE store_orders ADD CONSTRAINT store_orders_loyalty_ck
      CHECK (loyalty_points_spent >= 0 AND loyalty_discount_iqd >= 0
             AND (loyalty_points_spent = 0) = (loyalty_discount_iqd = 0));
  END IF;
END $$;

COMMENT ON TABLE loyalty_entries IS
  'CD-5: append-only points history. The balance is SUM(signed by kind); there is deliberately no balance column.';

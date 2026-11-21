-- Marketplace M13a — online card payment and instalments.
--
-- One row per attempt to pay an order through a provider: a card session
-- (the shopper pays on the provider's page; the provider's SIGNED notification
-- marks it paid) or an instalment plan (eligibility, a term, a code the
-- provider sends, approval). The provider is named by `provider`; the test
-- providers are `fake-card`, `fake-instalments-a`, `fake-instalments-b`.
--
-- An instalment plan is made BEFORE its order (the code confirms it, then the
-- order is placed), so `order_id` is nullable; a card session always has its
-- order. `amount_iqd` is what the provider covers: the whole total for a card,
-- the goods only for instalments (the delivery fee is paid in cash).
CREATE TABLE market_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id uuid NOT NULL REFERENCES shoppers(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  order_id uuid UNIQUE REFERENCES store_orders(id) ON DELETE RESTRICT,
  method text NOT NULL,
  provider text NOT NULL,
  provider_ref text,
  status text NOT NULL,
  amount_iqd integer NOT NULL,
  months integer,
  monthly_iqd integer,
  fee_iqd integer NOT NULL DEFAULT 0,
  refunded_iqd integer NOT NULL DEFAULT 0,
  code_attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_payments_method_known CHECK (method IN ('card', 'instalments')),
  CONSTRAINT market_payments_status_known CHECK (status IN ('pending', 'code_sent', 'paid', 'approved', 'failed', 'expired', 'cancelled', 'refunded', 'adjusted')),
  CONSTRAINT market_payments_amount_positive CHECK (amount_iqd > 0),
  CONSTRAINT market_payments_refund_bounded CHECK (refunded_iqd >= 0 AND refunded_iqd <= amount_iqd),
  CONSTRAINT market_payments_card_has_order CHECK (method <> 'card' OR order_id IS NOT NULL),
  CONSTRAINT market_payments_plan_shape CHECK (method <> 'instalments' OR (months BETWEEN 2 AND 36 AND monthly_iqd > 0)),
  CONSTRAINT market_payments_paid_dated CHECK ((status IN ('paid', 'approved', 'refunded', 'adjusted')) = (paid_at IS NOT NULL)),
  CONSTRAINT market_payments_provider_ref_unique UNIQUE (provider, provider_ref)
);
CREATE INDEX market_payments_status_idx ON market_payments (status, expires_at);
CREATE INDEX market_payments_created_idx ON market_payments (created_at DESC, id DESC);
CREATE INDEX market_payments_shopper_idx ON market_payments (shopper_id, created_at DESC);

-- What the providers said and what was done, in order. A provider's
-- notification carries its own id: the same notification twice is one event.
CREATE TABLE market_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES market_payments(id) ON DELETE CASCADE,
  kind text NOT NULL,
  provider_event_id text,
  amount_iqd integer,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_payment_events_kind_length CHECK (length(kind) BETWEEN 1 AND 40),
  CONSTRAINT market_payment_events_once UNIQUE (payment_id, provider_event_id)
);
CREATE INDEX market_payment_events_payment_idx ON market_payment_events (payment_id, created_at);

-- E6: which products may be bought in instalments, and which at the cash price
-- (the store absorbs the provider's fee: «أقساط بسعر الكاش»).
ALTER TABLE products
  ADD COLUMN instalments_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN instalments_cash_price boolean NOT NULL DEFAULT false;

-- The order's method may now be one of the market's two online methods.
ALTER TABLE store_orders DROP CONSTRAINT IF EXISTS store_orders_payment_method_allowed;
ALTER TABLE store_orders ADD CONSTRAINT store_orders_payment_method_allowed
  CHECK (payment_method_code IN ('legacy', 'cod', 'cash', 'zaincash', 'asiahawala', 'fib', 'market_card', 'market_instalments'));

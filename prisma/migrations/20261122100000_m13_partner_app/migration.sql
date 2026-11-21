-- Marketplace M13b — the partner app (a wallet): sign-in from it (A2) and
-- payment links it pays (F10).
--
-- A2. The partner hands the shopper over with a SIGNED, short-lived, single-use
-- token naming its account and the phone it verified. The first time, the
-- partner account is linked to the market shopper with that phone; afterwards
-- the same link signs him in. One partner account ↔ one shopper.
CREATE TABLE shopper_partner_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id uuid NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  partner text NOT NULL,
  partner_account_id text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopper_partner_links_account_once UNIQUE (partner, partner_account_id),
  CONSTRAINT shopper_partner_links_shopper_once UNIQUE (shopper_id, partner),
  CONSTRAINT shopper_partner_links_account_length CHECK (length(partner_account_id) BETWEEN 1 AND 120)
);

-- Each handoff token's nonce is used once; old ones are pruned.
CREATE TABLE partner_handoff_nonces (
  partner text NOT NULL,
  nonce text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner, nonce),
  CONSTRAINT partner_handoff_nonces_length CHECK (length(nonce) BETWEEN 16 AND 80)
);
CREATE INDEX partner_handoff_nonces_used_idx ON partner_handoff_nonces (used_at);

-- F10. A payment link: valid once, for one shopper's cart at one store, for a
-- while. Only its hash is kept. `cart_fingerprint` is what the cart was when
-- the link was made — a different cart when the partner pays is refused.
CREATE TABLE checkout_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  shopper_id uuid NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  partner text NOT NULL,
  address_id uuid NOT NULL,
  fulfilment text NOT NULL,
  cart_fingerprint text NOT NULL,
  amount_iqd integer NOT NULL,
  status text NOT NULL DEFAULT 'issued',
  refusal text,
  order_id uuid UNIQUE REFERENCES store_orders(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_tokens_status_known CHECK (status IN ('issued', 'using', 'used', 'refused', 'expired', 'replaced')),
  CONSTRAINT checkout_tokens_fulfilment_known CHECK (fulfilment IN ('delivery', 'pickup')),
  CONSTRAINT checkout_tokens_amount_positive CHECK (amount_iqd > 0),
  CONSTRAINT checkout_tokens_used_dated CHECK ((status = 'used') = (used_at IS NOT NULL))
);
CREATE INDEX checkout_tokens_shopper_idx ON checkout_tokens (shopper_id, created_at DESC);

-- The partner's payment is a third online method.
ALTER TABLE market_payments DROP CONSTRAINT market_payments_method_known;
ALTER TABLE market_payments ADD CONSTRAINT market_payments_method_known CHECK (method IN ('card', 'instalments', 'partner'));
ALTER TABLE store_orders DROP CONSTRAINT IF EXISTS store_orders_payment_method_allowed;
ALTER TABLE store_orders ADD CONSTRAINT store_orders_payment_method_allowed
  CHECK (payment_method_code IN ('legacy', 'cod', 'cash', 'zaincash', 'asiahawala', 'fib', 'market_card', 'market_instalments', 'market_partner'));

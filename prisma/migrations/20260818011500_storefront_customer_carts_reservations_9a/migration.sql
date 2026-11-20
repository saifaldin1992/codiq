ALTER TABLE customers
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN phone_normalized text,
  ADD COLUMN phone_verified_at timestamptz;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_store_email_unique;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_email_normalized;
ALTER TABLE customers
  ADD CONSTRAINT customers_email_normalized CHECK (email IS NULL OR email = lower(btrim(email))),
  ADD CONSTRAINT customers_phone_normalized_format CHECK (phone_normalized IS NULL OR phone_normalized ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT customers_id_store_unique UNIQUE (id, store_id);
CREATE UNIQUE INDEX customers_store_email_present_uq ON customers(store_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX customers_store_phone_present_uq ON customers(store_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX customers_store_phone_idx ON customers(store_id, phone_normalized);

ALTER TABLE products ADD CONSTRAINT products_id_store_unique UNIQUE (id, store_id);

ALTER TABLE store_orders
  ADD COLUMN payment_method_code text NOT NULL DEFAULT 'legacy',
  ADD CONSTRAINT store_orders_id_store_unique UNIQUE (id, store_id),
  ADD CONSTRAINT store_orders_payment_method_allowed CHECK (payment_method_code IN ('legacy', 'cod')),
  ADD CONSTRAINT store_orders_source_allowed CHECK (source IN ('legacy', 'storefront'));
ALTER TABLE store_orders DROP CONSTRAINT IF EXISTS store_orders_customer_id_fkey;
ALTER TABLE store_orders
  ADD CONSTRAINT store_orders_customer_store_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT;

CREATE TABLE shopping_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('guest', 'customer')),
  customer_id uuid,
  session_token_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'converted', 'expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  expires_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  merged_into_cart_id uuid,
  converted_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopping_carts_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT shopping_carts_converted_order_store_unique UNIQUE (converted_order_id, store_id),
  CONSTRAINT shopping_carts_owner_shape_ck CHECK (
    (owner_kind = 'guest' AND customer_id IS NULL AND session_token_hash IS NOT NULL AND expires_at IS NOT NULL)
    OR (owner_kind = 'customer' AND customer_id IS NOT NULL AND session_token_hash IS NULL)
  ),
  CONSTRAINT shopping_carts_customer_store_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT shopping_carts_merged_store_fk FOREIGN KEY (merged_into_cart_id, store_id) REFERENCES shopping_carts(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT shopping_carts_converted_store_fk FOREIGN KEY (converted_order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX shopping_carts_active_customer_uq ON shopping_carts(store_id, customer_id) WHERE status = 'active' AND owner_kind = 'customer';
CREATE UNIQUE INDEX shopping_carts_active_guest_token_uq ON shopping_carts(store_id, session_token_hash) WHERE status = 'active' AND owner_kind = 'guest';
CREATE INDEX shopping_carts_store_status_expiry_idx ON shopping_carts(store_id, status, expires_at);
CREATE INDEX shopping_carts_store_customer_status_idx ON shopping_carts(store_id, customer_id, status);

CREATE TABLE cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  price_snapshot_iqd integer NOT NULL CHECK (price_snapshot_iqd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_items_cart_product_unique UNIQUE (cart_id, product_id),
  CONSTRAINT cart_items_cart_store_fk FOREIGN KEY (cart_id, store_id) REFERENCES shopping_carts(id, store_id) ON DELETE CASCADE,
  CONSTRAINT cart_items_product_store_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE RESTRICT
);
CREATE INDEX cart_items_cart_created_id_idx ON cart_items(cart_id, created_at, id);

CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  recipient_name text NOT NULL,
  full_address text NOT NULL,
  city text NOT NULL,
  governorate text NOT NULL,
  phone_contact_normalized text NOT NULL CHECK (phone_contact_normalized ~ '^\+[1-9][0-9]{7,14}$'),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_addresses_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT customer_addresses_customer_store_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX customer_addresses_default_uq ON customer_addresses(customer_id, store_id) WHERE is_default;
CREATE INDEX customer_addresses_customer_created_idx ON customer_addresses(store_id, customer_id, created_at DESC, id DESC);

CREATE TABLE checkout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  key_hash text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed')),
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_requests_key_unique UNIQUE (store_id, customer_id, key_hash),
  CONSTRAINT checkout_requests_customer_store_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT checkout_requests_order_store_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT
);
CREATE INDEX checkout_requests_lookup_idx ON checkout_requests(store_id, customer_id, created_at DESC);

CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
  return_disposition text NOT NULL DEFAULT 'not_returned' CHECK (return_disposition IN ('not_returned', 'pending_inspection')),
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  consumed_at timestamptz,
  returned_at timestamptz,
  CONSTRAINT inventory_reservations_order_product_unique UNIQUE (order_id, product_id),
  CONSTRAINT inventory_reservations_order_store_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_reservations_product_store_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE RESTRICT
);
CREATE INDEX inventory_reservations_available_idx ON inventory_reservations(store_id, product_id) WHERE status = 'active';
CREATE INDEX inventory_reservations_order_idx ON inventory_reservations(store_id, order_id, status);

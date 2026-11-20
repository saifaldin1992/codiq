ALTER TABLE store_orders
  ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE RESTRICT,
  ADD COLUMN customer_email text,
  ADD COLUMN recipient_phone text,
  ADD COLUMN shipping_governorate text,
  ADD COLUMN shipping_address_line1 text,
  ADD COLUMN shipping_address_line2 text,
  ADD COLUMN subtotal_iqd integer NOT NULL DEFAULT 0 CHECK (subtotal_iqd >= 0),
  ADD COLUMN delivery_fee_iqd integer NOT NULL DEFAULT 0 CHECK (delivery_fee_iqd >= 0),
  ADD COLUMN discount_iqd integer NOT NULL DEFAULT 0 CHECK (discount_iqd >= 0),
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid',
  ADD COLUMN source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN status_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by_kind text;

ALTER TABLE order_items ADD COLUMN sku text;

UPDATE store_orders
SET status = lower(status)
WHERE status IN ('NEW', 'PROCESSING', 'PREPARATION', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED', 'REJECTED', 'RETURNED');

ALTER TABLE store_orders
  ADD CONSTRAINT store_orders_status_allowed
  CHECK (status IN ('new', 'processing', 'preparation', 'out_for_delivery', 'completed', 'cancelled', 'rejected', 'returned')) NOT VALID;
ALTER TABLE store_orders VALIDATE CONSTRAINT store_orders_status_allowed;

CREATE TABLE order_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('merchant', 'platform_owner', 'customer', 'system')),
  actor_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_status_events_from_status_allowed CHECK (from_status IS NULL OR from_status IN ('new', 'processing', 'preparation', 'out_for_delivery', 'completed', 'cancelled', 'rejected', 'returned')),
  CONSTRAINT order_status_events_to_status_allowed CHECK (to_status IN ('new', 'processing', 'preparation', 'out_for_delivery', 'completed', 'cancelled', 'rejected', 'returned')),
  CONSTRAINT order_status_events_note_length CHECK (note IS NULL OR char_length(note) <= 1000)
);

CREATE INDEX store_orders_customer_id_idx ON store_orders(customer_id);
CREATE INDEX store_orders_store_status_created_id_idx ON store_orders(store_id, status, created_at DESC, id DESC);
CREATE INDEX store_orders_store_created_id_idx ON store_orders(store_id, created_at DESC, id DESC);
CREATE INDEX store_orders_status_created_id_idx ON store_orders(status, created_at DESC, id DESC);
CREATE INDEX order_status_events_store_order_created_idx ON order_status_events(store_id, order_id, created_at DESC);

CREATE OR REPLACE FUNCTION codiq_guard_order_status_event_store()
RETURNS trigger AS $$
DECLARE order_store uuid;
BEGIN
  SELECT store_id INTO order_store FROM store_orders WHERE id = NEW.order_id;
  IF order_store IS NULL OR order_store <> NEW.store_id THEN
    RAISE EXCEPTION 'CODIQ_ORDER_EVENT_STORE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'order_status_events.store_id must match store_orders.store_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_status_events_guard_store
BEFORE INSERT ON order_status_events
FOR EACH ROW EXECUTE FUNCTION codiq_guard_order_status_event_store();

CREATE OR REPLACE FUNCTION codiq_prevent_order_status_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CODIQ_ORDER_STATUS_EVENT_IMMUTABLE'
    USING ERRCODE = '23514', DETAIL = 'Order status events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_status_events_immutable
BEFORE UPDATE OR DELETE ON order_status_events
FOR EACH ROW EXECUTE FUNCTION codiq_prevent_order_status_event_mutation();

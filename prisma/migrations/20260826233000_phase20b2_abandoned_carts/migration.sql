-- Phase 20B-2 — abandoned-cart recovery (D-24). Everything here is additive:
-- notification_outbox gains a nullable cart_id column following the exact
-- order_id pattern (plain FK + index), so a cart.abandoned outbox row points at
-- the cart it recovers and disappears with it. No existing column, constraint,
-- or worker behavior changes.

ALTER TABLE notification_outbox
  ADD COLUMN cart_id uuid REFERENCES shopping_carts(id) ON DELETE CASCADE;

CREATE INDEX notification_outbox_cart_idx ON notification_outbox(cart_id);

-- The phase-15 CHECK pinned event_type to three values; cart.abandoned joins it.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_event_type;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_event_type
  CHECK (event_type IN ('order.created', 'order.status_changed', 'low_stock', 'cart.abandoned'));

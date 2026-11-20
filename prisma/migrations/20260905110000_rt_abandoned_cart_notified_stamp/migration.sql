-- 19-د (ATTACK-SURFACE) — «one message per abandoned cart, forever» meant «every
-- 90 days».
--
-- The scanner had exactly two dedupe mechanisms and BOTH were the outbox row
-- itself: the candidate filter `notificationOutbox: { none: { eventType:
-- 'cart.abandoned' } }`, and UNIQUE(store_id, dedupe_key) on
-- `cart_abandoned:{cartId}`. The retention sweep hard-deletes settled outbox
-- rows once `updated_at` passes 90 days.
--
-- A customer-owned cart, meanwhile, never expires and is never swept — the guest
-- sweep is `owner_kind = 'guest'` only, and no job flips a customer cart's
-- status. So a registered shopper who leaves items in a cart is mailed on day 0,
-- the row that remembers it is deleted on day 90, and on the next fifteen-minute
-- pass the same cart matches every filter again and is mailed again — every 90
-- days, for as long as the cart sits there. The module header calls the
-- guarantee «structural»; it was structural on a row with a retention clock.
--
-- The stamp moves the guarantee onto the CART, which is what the guarantee is
-- about and which outlives any retention number. The outbox row stays free to be
-- swept, as retention intends.
ALTER TABLE shopping_carts
  ADD COLUMN IF NOT EXISTS abandoned_notified_at timestamptz(6);

-- Backfill from the rows that still exist, so no cart already messaged is
-- messaged a second time the first time the new scanner runs. Carts whose outbox
-- row was ALREADY swept cannot be recovered — that history is gone — and they
-- get one final message, which is the same number they would have received
-- anyway on the old code. From then on the stamp holds.
UPDATE shopping_carts cart
SET abandoned_notified_at = source.first_enqueued_at
FROM (
  SELECT cart_id, MIN(created_at) AS first_enqueued_at
  FROM notification_outbox
  WHERE event_type = 'cart.abandoned' AND cart_id IS NOT NULL
  GROUP BY cart_id
) AS source
WHERE cart.id = source.cart_id
  AND cart.abandoned_notified_at IS NULL;

-- The scanner's candidate query filters on this column across every eligible
-- store, so it is the difference between an index probe and a scan of the table.
CREATE INDEX IF NOT EXISTS shopping_carts_abandoned_notified_idx
  ON shopping_carts (store_id, status, abandoned_notified_at, last_activity_at);

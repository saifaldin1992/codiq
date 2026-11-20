-- POS offline v1 (ق-132/ق-136) — sale time vs sync time.
--
-- StoreOrder.createdAt is @default(now()): it records when the SERVER first
-- heard of the sale. For an online till the two coincide; for an offline queue
-- flushed after an outage they do not — a Monday outage flushed on Tuesday
-- would inflate Tuesday's takings. sold_at is when the cash actually changed
-- hands, per the till's clock, clamped server-side into [now − 30d, now] at
-- ingest (pos.service.ts). The raw, unclamped claim stays in
-- pos_tickets.device_reported_at as evidence.
--
-- Additive column, NOT a rewrite of created_at: client clocks must never leak
-- into the order book, exports, or anything else keyed on created_at.
-- NULL for every non-POS order — the storefront has no till clock.

ALTER TABLE store_orders ADD COLUMN sold_at timestamptz;

-- Deploy-window seam: between this migration running and the new app booting,
-- the OLD app is still ingesting POS sales and knows nothing of sold_at. A
-- future-inserts-only default catches exactly those rows at sync time — the
-- same axis analytics used before this column existed — instead of leaving
-- them NULL and invisible to the POS aggregates forever. The new service
-- always writes the clamped device time, so this default never fires again
-- after the cutover. (SET DEFAULT after ADD COLUMN, deliberately: a default
-- in the ADD itself would fast-backfill every historic non-POS row too.)
ALTER TABLE store_orders ALTER COLUMN sold_at SET DEFAULT now();

-- Backfill existing POS orders from the ticket that created them: the device's
-- reported ring-up time is the best sale-time fact we hold for them.
UPDATE store_orders o SET sold_at = t.device_reported_at FROM pos_tickets t WHERE t.order_id = o.id AND o.source = 'pos';

-- Any POS order left without a ticket time falls back to sync time — createdAt
-- is exactly what the aggregates used before this column existed.
UPDATE store_orders SET sold_at = created_at WHERE source = 'pos' AND sold_at IS NULL;

-- The two POS takings aggregates filter (store_id, sold_at, source='pos');
-- partial index because sold_at is NULL everywhere else by design.
CREATE INDEX store_orders_pos_sold_at_idx ON store_orders (store_id, sold_at) WHERE source = 'pos';

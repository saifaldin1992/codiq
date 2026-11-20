-- CODIQ Phase 15 — notification outbox (additive-first).
-- The outbox row is written inside the same transaction as the business event,
-- so a successful order can never lose its notification and a rolled-back
-- operation can never leave one behind. No drop/truncate/delete of existing data.

BEGIN;

CREATE TABLE notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  order_id UUID REFERENCES store_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  recipient_kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  last_outcome TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_outbox_event_type CHECK (event_type IN ('order.created', 'order.status_changed', 'low_stock')),
  CONSTRAINT notification_outbox_recipient_kind CHECK (recipient_kind IN ('merchant', 'customer')),
  CONSTRAINT notification_outbox_channel CHECK (channel IN ('email', 'sms')),
  CONSTRAINT notification_outbox_status CHECK (status IN ('pending', 'processing', 'sent', 'retry_scheduled', 'dead_letter', 'skipped')),
  CONSTRAINT notification_outbox_attempts CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX notification_outbox_dedupe ON notification_outbox(store_id, dedupe_key);
CREATE INDEX notification_outbox_claim_idx ON notification_outbox(status, next_attempt_at);
CREATE INDEX notification_outbox_store_log_idx ON notification_outbox(store_id, created_at DESC, id);
CREATE INDEX notification_outbox_order_idx ON notification_outbox(order_id);

COMMIT;

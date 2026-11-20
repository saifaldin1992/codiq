-- WA-1 (ق-131/ق-139) «واتساب اليدوي» — يسجل نية إرسال بشرية، لا يدّعي تسليماً.
-- One tap = one row. Deliberately NOT the notification outbox: no claim/retry
-- lifecycle exists for a message the human sends from his own WhatsApp, and the
-- phase-15 channel CHECK stays untouched (widening it belongs to the automated
-- 25ب phase together with the worker's channel switch, in one change).
CREATE TABLE IF NOT EXISTS order_whatsapp_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  order_id        uuid NOT NULL,
  template_key    text NOT NULL,
  -- E.164 as dialed at tap time — a later edit of the order's phone must not
  -- rewrite history about which number the message actually went to.
  recipient_phone text NOT NULL,
  -- What the SERVER rendered and handed to wa.me — never a client-supplied body.
  message_body    text NOT NULL,
  actor_kind      text NOT NULL,
  actor_id        uuid NOT NULL,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  -- House composite FK: a row can never point at another store's order.
  CONSTRAINT order_whatsapp_sends_order_fk FOREIGN KEY (order_id, store_id)
    REFERENCES store_orders (id, store_id) ON DELETE CASCADE,
  -- Operational occasions ONLY. Marketing template keys are a hard non-goal
  -- until a phone-keyed suppression identity exists (the PG-3 unsubscribe
  -- machinery is emailNormalized-keyed and cannot name a phone recipient).
  CONSTRAINT order_whatsapp_sends_template_ck CHECK (template_key IN ('order_created', 'courier_dispatched', 'order_completed')),
  CONSTRAINT order_whatsapp_sends_actor_kind_ck CHECK (actor_kind IN ('merchant', 'staff')),
  CONSTRAINT order_whatsapp_sends_phone_ck CHECK (recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT order_whatsapp_sends_body_ck CHECK (btrim(message_body) <> '' AND length(message_body) <= 2000)
);

CREATE INDEX IF NOT EXISTS order_whatsapp_sends_order_idx
  ON order_whatsapp_sends (store_id, order_id, created_at DESC);

-- Marketplace M7b — support tickets (docs/MARKETPLACE_PLAN.md T1–T7).
--
-- A ticket is opened FROM an order, and only on a delivered one, within 24 hours
-- of delivery (the service checks; the order link is the database's). The store
-- that sold it answers; the platform owner can step in (escalation) and close.
--
--   status   open → in_progress → awaiting_customer ⇄ in_progress → resolved → closed
--            (the shopper's «لا، ليس بعد» on a resolved ticket sends it back to in_progress)
--   the shopper may reply only after the support side has, and never on a closed ticket.

CREATE SEQUENCE support_ticket_number_seq START 1001;

CREATE TABLE support_tickets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number             INTEGER NOT NULL UNIQUE DEFAULT nextval('support_ticket_number_seq'),
  shopper_id         UUID REFERENCES shoppers(id) ON DELETE SET NULL ON UPDATE CASCADE,
  store_id           UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  order_id           UUID NOT NULL,
  type               TEXT NOT NULL,
  subject            TEXT,
  description        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  escalated_at       TIMESTAMPTZ(6),
  resolved_at        TIMESTAMPTZ(6),
  closed_at          TIMESTAMPTZ(6),
  last_support_at    TIMESTAMPTZ(6),
  shopper_read_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_order_fk FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT support_tickets_type_known CHECK (type IN ('damaged', 'missing_item', 'wrong_item', 'not_as_described', 'late_delivery', 'payment', 'other')),
  CONSTRAINT support_tickets_status_known CHECK (status IN ('open', 'in_progress', 'awaiting_customer', 'resolved', 'closed')),
  CONSTRAINT support_tickets_text_lengths CHECK ((subject IS NULL OR char_length(subject) <= 120) AND char_length(description) BETWEEN 10 AND 3000)
);
-- One ticket that is not closed per order.
CREATE UNIQUE INDEX support_tickets_one_live_per_order ON support_tickets (order_id) WHERE status <> 'closed';
CREATE INDEX support_tickets_shopper_idx ON support_tickets (shopper_id, updated_at DESC, id DESC);
CREATE INDEX support_tickets_store_idx ON support_tickets (store_id, status, updated_at DESC, id DESC);
CREATE INDEX support_tickets_platform_idx ON support_tickets (status, updated_at DESC, id DESC);

CREATE TABLE support_ticket_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE ON UPDATE CASCADE,
  author_kind  TEXT NOT NULL,
  author_id    UUID,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT support_ticket_comments_author_known CHECK (author_kind IN ('shopper', 'merchant', 'staff', 'platform')),
  CONSTRAINT support_ticket_comments_body_length CHECK (char_length(body) BETWEEN 1 AND 3000)
);
CREATE INDEX support_ticket_comments_ticket_idx ON support_ticket_comments (ticket_id, created_at, id);

CREATE TABLE support_ticket_attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE ON UPDATE CASCADE,
  author_kind    TEXT NOT NULL,
  object_key     TEXT NOT NULL UNIQUE,
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT support_ticket_attachments_author_known CHECK (author_kind IN ('shopper', 'merchant', 'staff', 'platform')),
  CONSTRAINT support_ticket_attachments_size CHECK (byte_size > 0)
);
CREATE INDEX support_ticket_attachments_ticket_idx ON support_ticket_attachments (ticket_id, created_at);

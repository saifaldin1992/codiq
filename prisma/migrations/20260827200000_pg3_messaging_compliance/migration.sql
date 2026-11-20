-- CODIQ PG-3 — messaging compliance.
--
-- WHY THIS IS COMPLIANCE, NOT POLISH. A domain that sends marketing mail with
-- no unsubscribe path gets listed as a spam source, and once that happens the
-- OPERATIONAL mail dies with it: order confirmations, courier notices, password
-- flows. Losing the marketing channel is a marketing problem; losing the
-- transactional channel is an outage.
--
-- 1. CLASSIFICATION LIVES IN THE DATABASE, NOT IN A CODE CONSTANT.
--
-- Until now the set of legal event types was a CHECK constraint that had to be
-- dropped and rewritten every time a type was added — it has already been
-- rewritten twice (cart.abandoned, order.courier_dispatched), and each rewrite
-- was a chance to forget. It is replaced by a lookup table plus a foreign key:
-- an event type that has not been classified as marketing or operational cannot
-- be inserted at all. Adding a notification now REQUIRES stating which kind it
-- is, in the same migration that introduces it. That is the point.
--
-- This is a net tightening: the FK is strictly stronger than the CHECK it
-- replaces (same closed set, plus the marketing/operational fact), and it is
-- validated against existing rows before the transaction commits.

BEGIN;

CREATE TABLE notification_event_kinds (
  event_type  text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('marketing', 'operational')),
  description text NOT NULL
);

COMMENT ON TABLE notification_event_kinds IS
  'PG-3: every notification event type and whether it is marketing (needs consent and an unsubscribe path) or operational (about something the recipient already did).';

INSERT INTO notification_event_kinds (event_type, kind, description) VALUES
  ('order.created',             'operational', 'تأكيد طلب أنشأه الزبون بنفسه، ونسخة للتاجر.'),
  ('order.status_changed',      'operational', 'تغيّر حالة طلب قائم.'),
  ('order.courier_dispatched',  'operational', 'خروج المندوب بطلب قائم — CD-1b.'),
  ('low_stock',                 'operational', 'تنبيه تشغيلي للتاجر عن مخزونه.'),
  -- The only marketing event today. It is unsolicited by definition: nobody
  -- asked to be reminded about a cart they walked away from.
  ('cart.abandoned',            'marketing',   'تذكير بسلة متروكة — رسالة تسويقية بامتياز.');

ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_event_type;

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_event_type_fk
  FOREIGN KEY (event_type) REFERENCES notification_event_kinds (event_type)
  ON UPDATE CASCADE ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE notification_outbox VALIDATE CONSTRAINT notification_outbox_event_type_fk;

-- 2. UNSUBSCRIBE — PER STORE, NOT PER PLATFORM.
--
-- A shopper who mutes one store's reminders has said nothing about another
-- store they also buy from, and nothing about their own order confirmations.
-- The scope of the record is exactly the scope of the consent withdrawn.

CREATE TABLE notification_unsubscribes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  email_normalized text NOT NULL,
  source           text NOT NULL CHECK (source IN ('link', 'complaint', 'owner')),
  unsubscribed_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT notification_unsubscribes_store_email_uq UNIQUE (store_id, email_normalized)
);

COMMENT ON TABLE notification_unsubscribes IS
  'PG-3: suppression list for MARKETING mail only. Operational mail is never suppressed by a row here — a customer who muted reminders still gets told their order shipped.';

-- 3. COMPLAINTS.
--
-- Recorded so a store that generates complaints can be seen doing it before the
-- platform domain pays for it. The outbox row is kept nullable and ON DELETE SET
-- NULL: a complaint outlives the message that caused it.

CREATE TABLE notification_complaints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  outbox_id        uuid REFERENCES notification_outbox (id) ON DELETE SET NULL,
  email_normalized text NOT NULL,
  note             text,
  reported_at      timestamptz(6) NOT NULL DEFAULT now()
);

CREATE INDEX notification_complaints_store_reported_idx
  ON notification_complaints (store_id, reported_at DESC, id DESC);

-- 4. DAILY MARKETING CAP, PER STORE.
--
-- A cap that DROPS messages silently is worse than no cap: the merchant sees a
-- send that never happened. Over the cap, the worker reschedules to the next
-- day instead — the message is late, never lost. 200/day is the conservative
-- default a new sending domain can carry without tripping reputation filters;
-- 0 disables marketing for the store entirely.

ALTER TABLE notification_settings
  ADD COLUMN marketing_daily_cap integer NOT NULL DEFAULT 200
  CONSTRAINT notification_settings_marketing_cap_range CHECK (marketing_daily_cap BETWEEN 0 AND 10000);

-- Serves the per-store per-day count the cap is measured against.
CREATE INDEX notification_outbox_store_sent_idx
  ON notification_outbox (store_id, sent_at)
  WHERE sent_at IS NOT NULL;

COMMIT;

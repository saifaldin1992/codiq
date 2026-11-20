-- MD-3 «الرسائل الذكية» — the merchant's daily digest.
--
-- OPERATIONAL, not marketing. It is a report about the recipient's own shop,
-- sent to the person who owns it, and he switches it on himself. It carries no
-- offer and asks nothing of him, so PG-3 classifies it operational and it is
-- never suppressed by a marketing unsubscribe — a merchant who stopped a cart
-- reminder has not asked to stop hearing about his own orders.
--
-- OPT-IN, DEFAULT OFF, like every other message this platform can send. A daily
-- email nobody asked for is how a sending domain earns a spam reputation, and
-- the domain is shared by every store's order confirmations.

INSERT INTO notification_event_kinds (event_type, kind, description) VALUES
  ('merchant.daily_digest', 'operational', 'ملخص يومي للتاجر عن متجره هو — مبيعات اليوم وطلبات تنتظره.')
ON CONFLICT (event_type) DO NOTHING;

ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS daily_digest_enabled boolean NOT NULL DEFAULT false,
  -- Baghdad hour at which the day is considered done. Iraq is UTC+3 with no
  -- daylight saving, so the conversion is a constant offset and never a table.
  ADD COLUMN IF NOT EXISTS daily_digest_hour integer NOT NULL DEFAULT 20;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_settings_digest_hour_ck') THEN
    ALTER TABLE notification_settings
      ADD CONSTRAINT notification_settings_digest_hour_ck
      CHECK (daily_digest_hour BETWEEN 0 AND 23);
  END IF;
END $$;

COMMENT ON COLUMN notification_settings.daily_digest_enabled IS
  'MD-3: the merchant opted in to a daily summary of his own store. Default false.';
COMMENT ON COLUMN notification_settings.daily_digest_hour IS
  'MD-3: Baghdad hour (0-23) after which the digest for that day may be sent.';

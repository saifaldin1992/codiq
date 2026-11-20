-- 19-د (ATTACK-SURFACE) — ceilings for the OPERATIONAL messaging channel.
--
-- PG-3 put every consent control inside `kind = 'marketing'`, deliberately and
-- correctly: a shopper who muted reminders must still be told his order shipped.
-- What that left undocumented is that operational messages then had no ceiling
-- of any kind — while the recipient address is never proven to belong to the
-- recipient, since customer registration accepts any email and stores it
-- unverified.
--
-- A self-registered merchant could therefore point the platform's own
-- CODIQ_SMTP_FROM identity at a stranger's inbox: ~84 messages per ten minutes,
-- each carrying 120 characters of store name he chose, none of them carrying an
-- unsubscribe line, indefinitely.
--
-- Additive with defaults, so every existing row acquires the ceilings without a
-- backfill and no store's behaviour changes unless it was already abusing the
-- channel. The per-store default (5000/day) sits well above what a growth-plan
-- store can legitimately send — 5,000 orders a month is ~166/day, ~1,160
-- customer messages — so it is a circuit breaker rather than a throttle. The
-- per-recipient default (20/day) is the one that actually bites: seven messages
-- per order means about three orders a day to one address before it holds.
ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS operational_daily_cap integer NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS operational_recipient_daily_cap integer NOT NULL DEFAULT 20;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_settings_operational_caps_ck') THEN
    ALTER TABLE notification_settings ADD CONSTRAINT notification_settings_operational_caps_ck
      CHECK (operational_daily_cap >= 0 AND operational_recipient_daily_cap >= 0);
  END IF;
END $$;

-- The index the two counters read. Without it the worker's per-day count walks
-- the whole outbox for the store on every single operational row.
CREATE INDEX IF NOT EXISTS notification_outbox_store_recipient_sent_idx
  ON notification_outbox (store_id, recipient, sent_at);

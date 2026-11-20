-- Phase 19-أ — logout, and sessions a person can actually recognise.
--
-- `revoked_at` already exists on all four session tables, so the MECHANISM for
-- ending a session has been there since phase 1. What was missing is any way to
-- use it: there is no logout endpoint for an owner, a merchant or a staff
-- member, and no way for anyone to see what is signed in as them.
--
-- A LIST OF SESSIONS IS USELESS WITHOUT A WAY TO TELL THEM APART. "Session
-- a3f9…, created Tuesday" tells a person nothing about whether to end it. So
-- each session records the browser it was opened from, and when it was last
-- used.
--
-- DELIBERATELY NOT AN IP ADDRESS. An IP is a location trail on a person, kept
-- for the lifetime of the row, and it is not what anyone actually uses to
-- recognise their own device — "Chrome على Windows، آخر استخدام قبل ساعة" is.
-- The weaker identifier answers the question, so the stronger one is not
-- collected. Nothing here can be turned into a movement history later, because
-- the data to do it is not stored.
--
-- The user agent is truncated at 300 characters: it is a label, not evidence,
-- and an unbounded string from a header is a row a client controls the size of.

ALTER TABLE platform_owner_sessions
  ADD COLUMN IF NOT EXISTS user_agent   text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz(6);

ALTER TABLE merchant_sessions
  ADD COLUMN IF NOT EXISTS user_agent   text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz(6);

ALTER TABLE staff_sessions
  ADD COLUMN IF NOT EXISTS user_agent   text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz(6);

ALTER TABLE customer_sessions
  ADD COLUMN IF NOT EXISTS user_agent   text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz(6);

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['platform_owner_sessions', 'merchant_sessions', 'staff_sessions', 'customer_sessions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = target || '_user_agent_ck') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (user_agent IS NULL OR length(user_agent) <= 300)',
        target, target || '_user_agent_ck');
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN platform_owner_sessions.user_agent IS
  'Phase 19: the browser this session was opened from, so a person can recognise it in his own session list. No IP is stored — see the migration header.';

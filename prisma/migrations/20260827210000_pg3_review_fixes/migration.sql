-- PG-3 review follow-up — queue priority for notification classes.
--
-- WHY. Operational mail must outrank marketing across the whole platform, and
-- the worker previously ordered only by nextAttemptAt. A deferred marketing row
-- carries an EARLIER nextAttemptAt than a row created afterwards, so a single
-- store switching on abandoned-cart recovery put its backlog at the head of the
-- queue — and a shopper in an unrelated store then waited behind the whole pile
-- for her order confirmation. Measured at 8.3 minutes for 2000 deferred rows,
-- recurring nightly.
--
-- Sorting on `kind` directly would work today only by the accident that
-- 'marketing' sorts before 'operational'. An explicit priority says what is
-- meant, survives a third class being added, and reads correctly in the query.
--
-- ADDITIVE ONLY: one column with a default, then values set per row. No table
-- is rewritten, nothing is dropped, and re-running is harmless.

BEGIN;

ALTER TABLE notification_event_kinds
  ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;

COMMENT ON COLUMN notification_event_kinds.priority IS
  'PG-3: lower drains first. Operational mail is about something the recipient already did and must never queue behind marketing.';

UPDATE notification_event_kinds SET priority = 0   WHERE kind = 'operational';
UPDATE notification_event_kinds SET priority = 100 WHERE kind = 'marketing';

-- Serves the worker claim query, whose leading term is now the priority.
CREATE INDEX IF NOT EXISTS notification_outbox_claim_priority_idx
  ON notification_outbox (status, next_attempt_at, created_at);

COMMIT;

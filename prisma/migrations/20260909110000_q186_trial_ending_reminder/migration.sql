-- ق-186 (D-90) — the trial ends, and until now the merchant was never told.
--
-- ق-181 put the end date and the days remaining on his dashboard, and ق-128
-- moves him to the free plan the moment `ends_at` passes. Both are correct and
-- neither speaks: a merchant who did not happen to open the dashboard in his
-- final week simply wakes up on a smaller plan. The reminder is the missing
-- half — the one message that turns a silent downgrade into a decision.
--
-- TWO SCHEMA FACTS MAKE THIS A MIGRATION RATHER THAN A CODE CHANGE.
--
-- 1. `event_type` is a FOREIGN KEY into `notification_event_kinds`, so a new
--    kind of message does not exist until it is named here. `operational`, not
--    `marketing`: nobody opted out of being told his own plan is about to
--    change, and the marketing caps must never delay it.
--
-- 2. `notification_outbox_store_scope` allows a store-less row for exactly one
--    event type today. The trial belongs to the MERCHANT, not to any one of his
--    stores — a two-store merchant must get one reminder, not two — so the row
--    carries no store, and the constraint has to be re-stated to admit it. This
--    is the same re-statement ق-179 had to make on `store_audit_events`: a
--    CHECK over a literal list is a schema-level enum, and adding a value is a
--    migration whatever the TypeScript says.
--
-- Once-only is enforced by `notification_outbox_dedupe_no_store` (ق-185, the
-- migration immediately before this one) over `dedupe_key = trial_ending:<id>`.
-- Without that index this scanner would re-enqueue on every ten-minute pass:
-- roughly four hundred copies across the three-day window. The order of these
-- two migrations is therefore load-bearing, not incidental.
INSERT INTO notification_event_kinds (event_type, kind, description) VALUES
  ('trial.ending', 'operational', 'تذكير التاجر قبل انتهاء تجربته المجانية بأيام — ق-186 (D-90).');

ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_store_scope;

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_store_scope CHECK (
    store_id IS NOT NULL OR event_type IN ('auth.password_reset', 'trial.ending')
  );

COMMENT ON COLUMN notification_outbox.store_id IS
  'The store this message belongs to. NULL only for the account event types named in notification_outbox_store_scope — mail about an identity or a subscription rather than about a store.';

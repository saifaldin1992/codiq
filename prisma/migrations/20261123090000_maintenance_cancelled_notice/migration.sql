-- Review batch 4 (owner decision, 2026-11-22): a merchant told that a platform maintenance window
-- is coming is told when it is cancelled. Until now he was mailed «scheduled» and then nothing:
-- he kept waiting for a stoppage that never came.
--
-- One new event type, operational like its two siblings, and allowed the same NULL store_id — the
-- notice is about the platform, so a two-store merchant gets one mail, not two.

INSERT INTO notification_event_kinds (event_type, kind, description, priority) VALUES
  ('maintenance.cancelled', 'operational', 'إشعار التاجر بإلغاء صيانةٍ أُبلغ بها — لن تتوقّف الخدمة، أو عادت قبل موعدها.', 150)
ON CONFLICT (event_type) DO NOTHING;

ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_store_scope;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_store_scope CHECK (
    store_id IS NOT NULL OR event_type IN (
      'auth.password_reset', 'trial.ending',
      'maintenance.scheduled', 'maintenance.ended', 'maintenance.cancelled'
    )
  );

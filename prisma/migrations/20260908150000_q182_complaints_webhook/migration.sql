-- ق-182: complaints now arrive from the mail provider's webhook. Svix redelivers
-- on timeout, so the provider's event id is kept and made unique: the same event
-- twice is one complaint. And the owner reads the table platform-wide, newest
-- first, which the store-leading index cannot serve — this one ends in the
-- house keyset (reported_at, id).
ALTER TABLE notification_complaints ADD COLUMN provider_event_id TEXT;
CREATE UNIQUE INDEX notification_complaints_provider_event_uq ON notification_complaints(provider_event_id);
CREATE INDEX notification_complaints_reported_id_idx ON notification_complaints(reported_at DESC, id DESC);

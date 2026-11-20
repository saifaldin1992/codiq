-- ق-188 — the platform tells its owner when something is silently broken.
--
-- Until now nothing did. Phase 24-أ shipped structured logs with correlation
-- ids and a /ready endpoint, and both are read by a human who already suspects
-- a problem. Nothing WAKES that human: a message that dead-letters, or an
-- outbox that stops draining, is invisible until a merchant complains.
--
-- One open alert per kind, and the row's EXISTENCE is the state. Opening it and
-- sending the mail happen in one pass; the row is deleted when the condition
-- clears, which is also when the recovery notice goes out. So a condition that
-- persists for a week is one email, not one per pass — the fastest way to make
-- an alert channel useless is to let it repeat.
CREATE TABLE platform_health_alerts (
  kind              TEXT PRIMARY KEY,
  opened_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_notified_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  detail            TEXT NOT NULL,
  -- Mirrored by HEALTH_ALERT_KINDS in services/platform-health.service.ts. A
  -- CHECK on a literal list is an enum at the schema level: adding a check is a
  -- migration, whatever TypeScript believes (the lesson of ق-179 and ق-186).
  CONSTRAINT platform_health_alerts_kind CHECK (kind IN ('outbox_dead_letters', 'outbox_stalled'))
);

-- The reader is «show me what is open, oldest first» — a list a human scans.
CREATE INDEX platform_health_alerts_opened_idx ON platform_health_alerts (opened_at DESC, kind DESC);

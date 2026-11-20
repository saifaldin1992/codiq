-- CODIQ Phase 14 — extend order_status_events.actor_kind to accept 'staff'.
-- This file mirrors the SQL already applied to the Neon staging branch on 2026-08-24
-- (recorded there in _prisma_migrations under this exact migration name).
-- No table/data drop, truncate, or delete.

BEGIN;

ALTER TABLE order_status_events
  DROP CONSTRAINT order_status_events_actor_kind_check;

ALTER TABLE order_status_events
  ADD CONSTRAINT order_status_events_actor_kind_check
  CHECK (actor_kind IN ('merchant', 'platform_owner', 'customer', 'system', 'staff')) NOT VALID;

ALTER TABLE order_status_events
  VALIDATE CONSTRAINT order_status_events_actor_kind_check;

COMMIT;

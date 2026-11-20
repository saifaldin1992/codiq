-- PG-2 (b) — store-scoped "who did what" audit log.
-- A brand-new table: zero effect on any existing read or write.

CREATE TABLE store_audit_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  entity_type      text NOT NULL,
  -- Deliberately NO foreign key: a "who did what" record must outlive its
  -- subject, and the 30-day purge hard-deletes the entity. Cascade would erase
  -- the record and Restrict would forbid the purge; either one kills the feature.
  entity_id        uuid NOT NULL,
  entity_label     text NOT NULL,   -- name snapshot at the moment of the action
  entity_secondary text,            -- SKU, coupon code, or staff email
  action           text NOT NULL,
  actor_kind       text NOT NULL,
  actor_id         uuid,            -- no FK: three different identities + NULL for the system
  actor_label      text NOT NULL,   -- name/email snapshot at the moment of the action
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_audit_events_entity_type CHECK (entity_type IN
    ('product','product_variant','product_category','coupon','staff_membership')),
  CONSTRAINT store_audit_events_action CHECK (action IN
    ('soft_deleted','restored','purged','purge_blocked')),
  CONSTRAINT store_audit_events_actor_kind CHECK (actor_kind IN
    ('merchant','staff','platform_owner','system')),
  -- Only the system has no actor, and every human actor has an id.
  CONSTRAINT store_audit_events_actor_pair CHECK ((actor_kind = 'system') = (actor_id IS NULL))
);

-- Keyset pagination on (created_at DESC, id DESC) like every other platform list.
CREATE INDEX store_audit_events_store_created_idx
  ON store_audit_events (store_id, created_at DESC, id DESC);
CREATE INDEX store_audit_events_entity_idx
  ON store_audit_events (store_id, entity_type, entity_id, created_at DESC);

-- The audit log is neither editable nor deletable from any surface (the
-- codiq_prevent_ledger_entry_mutation / codiq_prevent_order_status_event_mutation
-- pattern).
--
-- The ONE exemption: deleting a store cascades to its audit events. Without the
-- NOT EXISTS escape below, `ON DELETE CASCADE` from stores would hit this
-- exception and make store deletion impossible. No path deletes a store today,
-- but leaving a trap for a future one is not acceptable. During a cascade the
-- parent DELETE has already run in this transaction, so the store row is gone.
CREATE OR REPLACE FUNCTION codiq_prevent_store_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM stores WHERE id = OLD.store_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CODIQ_AUDIT_EVENT_IMMUTABLE: store audit events are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER store_audit_events_immutable
BEFORE UPDATE OR DELETE ON store_audit_events
FOR EACH ROW EXECUTE FUNCTION codiq_prevent_store_audit_event_mutation();

-- MD-6, second half: teach `store_audit_events` about verification.
--
-- The table arrived with PG-2 for the trash, and its CHECK constraints name
-- exactly the entity types and actions the trash uses. Granting a badge is the
-- same KIND of fact — something a named actor did to a store, which must remain
-- answerable later — so it belongs in the same log rather than in a second one
-- that would have to be merged with this at every screen that shows history.
--
-- CONSEQUENCE, DELIBERATELY ACCEPTED: this log is readable by the merchant who
-- owns the store. The note therefore travels to him, and the owner's screen says
-- so before he types it. That is the better arrangement — a merchant whose badge
-- is revoked learns why instead of watching it disappear — but it is a choice,
-- not an accident, and anything the owner wants kept private does not go here.
--
-- A separate file from the columns migration purely because that one had already
-- run against the author's local database and Prisma checksums what it has run.
-- Both arrived in the same commit, so on any fresh database they apply back to
-- back and the split carries no meaning.

ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_entity_type;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_entity_type CHECK (entity_type IN
  ('product','product_variant','product_category','coupon','staff_membership','store_verification'));

ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_action;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_action CHECK (action IN
  ('soft_deleted','restored','purged','purge_blocked','verification.granted','verification.revoked'));

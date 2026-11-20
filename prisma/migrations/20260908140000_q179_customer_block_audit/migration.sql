-- ق-179: blocking a shopper is policy, and policy is an audit event. The
-- CHECK constraints on store_audit_events enumerate every entity and action the
-- log may carry (PG-2b) — each new kind re-states them, as MD-6, CD-3 and this
-- migration do. The lists below are the full current vocabulary of
-- services/soft-delete/constants.ts plus the shopper and the two acts on him.
ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_entity_type;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_entity_type CHECK (entity_type IN
  ('product','product_variant','product_category','coupon','staff_membership','store_verification','product_review','return_request','customer'));

ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_action;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_action CHECK (action IN
  ('soft_deleted','restored','purged','purge_blocked',
   'verification.granted','verification.revoked',
   'review.hidden','review.unhidden',
   'return.approved','return.rejected',
   'customer.blocked','customer.unblocked'));

-- ق-225 — the platform can stop a merchant it has already approved, and the
-- database learns the two words for it.
--
-- `platform_audit_events_action` is a CHECK, not a convention: 19-ب put the list
-- of what a platform actor may be recorded as doing in the database precisely so
-- that a new action cannot be logged by an application that forgot to declare it.
-- Widening it is therefore a migration, and this is the whole of the schema this
-- feature needs — suspension writes `merchants.is_active`, `stores.is_active` and
-- the two session tables' `revoked_at`, every one of which has existed since
-- phase 1.
--
-- Nothing else changes. In particular NO order, ledger entry, settlement or
-- wallet balance is touched by suspension, by design: it is a gate on ACTING,
-- never on the record, and a suspended merchant's money must still reconcile —
-- including what the platform owes him for deliveries already made.
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_action;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action CHECK (action IN
  ('registration_decided', 'registration_mode_changed', 'merchant_created_manually',
   'merchant_suspended', 'merchant_resumed',
   'subscription_assigned', 'plan_created', 'plan_updated', 'upgrade_request_decided',
   'settlement_created', 'adjustment_created', 'logo_changed', 'logo_cleared',
   'staff_created', 'staff_updated', 'staff_overrides_changed', 'staff_removed',
   'staff_totp_reset', 'contact_details_changed', 'owner_email_changed'));

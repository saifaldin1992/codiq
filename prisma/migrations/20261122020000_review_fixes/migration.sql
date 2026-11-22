-- Review fixes (batches 1–2).
--
-- 1. The owner's market coupons are platform money: creating one, editing it
--    and changing the stores it works in are now written to the platform audit
--    log like every other owner action. Mirrors PLATFORM_AUDIT_ENTITY_TYPES /
--    PLATFORM_AUDIT_ACTIONS.
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_entity_type;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_entity_type CHECK (entity_type IN
  ('merchant', 'plan', 'subscription', 'upgrade_request', 'settlement', 'ledger_adjustment',
   'registration_mode', 'platform_staff', 'brand', 'platform_contact', 'platform_account',
   'service', 'capability', 'availability_override', 'feature_flag', 'store',
   'maintenance_window', 'incident', 'setting', 'support_ticket', 'platform_coupon'));
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_action;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action CHECK (action IN
  ('registration_decided', 'registration_mode_changed', 'merchant_created_manually',
   'merchant_suspended', 'merchant_resumed',
   'subscription_assigned', 'plan_created', 'plan_updated', 'upgrade_request_decided',
   'settlement_created', 'adjustment_created', 'logo_changed', 'logo_cleared',
   'staff_created', 'staff_updated', 'staff_overrides_changed', 'staff_removed',
   'staff_totp_reset', 'contact_details_changed', 'owner_email_changed',
   'service_state_changed', 'capability_state_changed',
   'availability_override_set', 'availability_override_revoked',
   'feature_flag_changed', 'store_status_changed',
   'maintenance_window_scheduled', 'maintenance_window_cancelled',
   'incident_opened', 'incident_updated', 'incident_resolved',
   'setting_changed',
   'support_ticket_replied', 'support_ticket_escalated', 'support_ticket_closed',
   'platform_coupon_created', 'platform_coupon_updated', 'platform_coupon_stores_changed'));

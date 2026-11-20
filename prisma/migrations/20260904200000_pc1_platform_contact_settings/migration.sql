-- PC-1 (owner request, 2026-09-04) — «معلومات التواصل» becomes data.
--
-- Two halves, both additive:
--
--   1. The platform audit log learns two entity types and two actions. The CHECK
--      lists are enumerations, so widening one means replacing the constraint —
--      the new list is a strict SUPERSET of the old, so no existing row can fail
--      it and no existing writer can start failing. `platform_audit_events` is
--      append-only (codiq_prevent_platform_audit_event_mutation), and a row
--      trigger does not fire for ALTER TABLE, so the log stays untouched.
--
--   2. The three contact settings are SEEDED with the owner's values, so a fresh
--      database — a new environment, a restored backup, a laptop — shows him the
--      real numbers in his form on day one rather than an empty one. The code
--      carries the same defaults (platform-contact.service.ts), so a database
--      that never ran this seed still ANSWERS correctly; this row is what makes
--      the dashboard show it, not what makes it true.
--
-- ON CONFLICT DO NOTHING makes the seed idempotent and, more importantly, makes
-- it safe on an environment where the owner has ALREADY set his own values: a
-- re-run must never overwrite what he typed with what shipped.

ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_entity_type;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_entity_type CHECK (entity_type IN
  ('merchant', 'plan', 'subscription', 'upgrade_request', 'settlement', 'ledger_adjustment',
   'registration_mode', 'platform_staff', 'brand', 'platform_contact', 'platform_account'));

ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_action;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_action CHECK (action IN
  ('registration_decided', 'registration_mode_changed', 'merchant_created_manually',
   'subscription_assigned', 'plan_created', 'plan_updated', 'upgrade_request_decided',
   'settlement_created', 'adjustment_created', 'logo_changed', 'logo_cleared',
   'staff_created', 'staff_updated', 'staff_overrides_changed', 'staff_removed',
   'staff_totp_reset', 'contact_details_changed', 'owner_email_changed'));

-- The public contact details. `platform.contact.whatsapp` is deliberately NOT
-- seeded: an absent row means «واتساب على رقم التواصل نفسه», so WhatsApp follows
-- the phone the next time the owner changes it instead of silently pointing at
-- the number that was current when the platform was installed.
INSERT INTO platform_settings (key, value, updated_at) VALUES
  ('platform.contact.email', 'codiq.iraq@gmail.com', NOW()),
  ('platform.contact.phone', '+9647777782092', NOW())
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- ق-250 — المرحلة 29 (الشريحة الثانية): الصيانة المجدولة والحوادث
-- ============================================================================
--
-- ما يُضاف:
--   1. `maintenance_windows` — نافذةٌ لها بداية ونهاية بتوقيت بغداد، ورسالة
--      عربيّة (وإنكليزيّة اختياريّة)، ونطاق: المنصّة كلّها، أو خدمة، أو قدرة،
--      أو تاجر، أو متجر. النافذة تبدأ وتنتهي بنفسها لأنّ الحلّ يقرأ الساعة
--      وقت الطلب — لا عامل يقلب أعمدةً في منتصف الليل. العامل يُتمّم فقط:
--      يختم النوافذ المنتهية ويُرسل إشعار «انتهت الصيانة».
--   2. `incidents` + `incident_updates` — الحادث بحالاته الأربع
--      (investigating → identified → monitoring → resolved)، ورسالةٌ عامّة،
--      وقائمة ما يتأثّر به، وخيار «يحجب» فيُغلق القدرات المتأثّرة فعلاً لا
--      إعلاماً فقط. التحديثات append-only: كلّ خطوة سطرٌ يبقى.
--   3. توسيع CHECK التدقيق بكيانين وستّة أفعال، وصنفَي حدثٍ للصندوق
--      (`maintenance.scheduled`, `maintenance.ended`) يُسمح لهما بلا متجر لأنّهما
--      عن المنصّة لا عن متجر — وتوسيع `notification_outbox_store_scope` تبعاً.
--
-- ما لا يُضاف: لا عمود حالةٍ يقول «نشطة» — النشاط مشتقٌّ من الوقت؛ العمود
-- `status` يحمل ما لا يُشتقّ: scheduled / cancelled / completed (خُتمت وأُشعر بها).

-- ---------------------------------------------------------------- نوافذ الصيانة
CREATE TABLE maintenance_windows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text NOT NULL,
  service_id       uuid NULL REFERENCES services(id) ON DELETE CASCADE,
  capability_id    uuid NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  merchant_id      uuid NULL REFERENCES merchants(id) ON DELETE CASCADE,
  store_id         uuid NULL REFERENCES stores(id) ON DELETE CASCADE,
  starts_at        timestamptz(3) NOT NULL,
  ends_at          timestamptz(3) NOT NULL,
  timezone         text NOT NULL DEFAULT 'Asia/Baghdad',
  message_ar       text NOT NULL,
  message_en       text NULL,
  -- capability codes narrowed inside a platform/merchant/store window; empty = everything under the scope.
  affects          jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'scheduled',
  created_by_kind  text NOT NULL,
  created_by_id    uuid NOT NULL,
  cancelled_at     timestamptz(3) NULL,
  cancelled_by_kind text NULL,
  cancelled_by_id  uuid NULL,
  completed_at     timestamptz(3) NULL,
  created_at       timestamptz(3) NOT NULL DEFAULT now(),
  updated_at       timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_windows_scope CHECK (scope IN ('platform', 'service', 'capability', 'merchant', 'store')),
  CONSTRAINT maintenance_windows_status CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  CONSTRAINT maintenance_windows_span CHECK (ends_at > starts_at),
  CONSTRAINT maintenance_windows_span_max CHECK (ends_at <= starts_at + interval '7 days'),
  CONSTRAINT maintenance_windows_message CHECK (char_length(btrim(message_ar)) BETWEEN 3 AND 500),
  CONSTRAINT maintenance_windows_created_by CHECK (created_by_kind IN ('platform_owner', 'platform_staff', 'merchant', 'staff')),
  CONSTRAINT maintenance_windows_target CHECK (
    (scope = 'platform'   AND service_id IS NULL     AND capability_id IS NULL     AND merchant_id IS NULL     AND store_id IS NULL) OR
    (scope = 'service'    AND service_id IS NOT NULL AND capability_id IS NULL     AND merchant_id IS NULL     AND store_id IS NULL) OR
    (scope = 'capability' AND service_id IS NULL     AND capability_id IS NOT NULL AND merchant_id IS NULL     AND store_id IS NULL) OR
    (scope = 'merchant'   AND service_id IS NULL     AND capability_id IS NULL     AND merchant_id IS NOT NULL AND store_id IS NULL) OR
    (scope = 'store'      AND service_id IS NULL     AND capability_id IS NULL     AND merchant_id IS NULL     AND store_id IS NOT NULL)
  ),
  CONSTRAINT maintenance_windows_cancel_stamp CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_kind IS NOT NULL AND cancelled_by_id IS NOT NULL) OR
    (status <> 'cancelled' AND cancelled_at IS NULL)
  )
);
-- The resolver's question, every request: «is there a live window over this scope right now?»
CREATE INDEX maintenance_windows_live_idx ON maintenance_windows (status, starts_at, ends_at);
CREATE INDEX maintenance_windows_store_idx ON maintenance_windows (store_id, status, starts_at) WHERE store_id IS NOT NULL;
CREATE INDEX maintenance_windows_merchant_idx ON maintenance_windows (merchant_id, status, starts_at) WHERE merchant_id IS NOT NULL;
-- The owner's list: newest first, keyset (20-2).
CREATE INDEX maintenance_windows_created_id_idx ON maintenance_windows (created_at DESC, id DESC);

COMMENT ON TABLE maintenance_windows IS
  'ق-250: a maintenance window is live when now() is inside [starts_at, ends_at) and status = scheduled — computed at read time, never flipped by a worker. Store-scope windows close the store to shoppers; platform/service/capability/merchant windows resolve the affected capabilities to MAINTENANCE.';

-- ---------------------------------------------------------------- الحوادث
CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status           text NOT NULL DEFAULT 'investigating',
  severity         text NOT NULL DEFAULT 'minor',
  title            text NOT NULL,
  public_message   text NOT NULL,
  -- service or capability codes; empty = the whole platform is affected.
  affects          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- true: the affected capabilities answer 423 while the incident is open; false: notice only.
  blocks           boolean NOT NULL DEFAULT false,
  started_at       timestamptz(3) NOT NULL DEFAULT now(),
  resolved_at      timestamptz(3) NULL,
  created_by_kind  text NOT NULL,
  created_by_id    uuid NOT NULL,
  created_at       timestamptz(3) NOT NULL DEFAULT now(),
  updated_at       timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT incidents_status CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  CONSTRAINT incidents_severity CHECK (severity IN ('minor', 'major', 'critical')),
  CONSTRAINT incidents_title CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  CONSTRAINT incidents_public_message CHECK (char_length(btrim(public_message)) BETWEEN 3 AND 1000),
  CONSTRAINT incidents_created_by CHECK (created_by_kind IN ('platform_owner', 'platform_staff')),
  CONSTRAINT incidents_resolution CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX incidents_open_idx ON incidents (status, started_at DESC) WHERE status <> 'resolved';
CREATE INDEX incidents_created_id_idx ON incidents (created_at DESC, id DESC);

CREATE TABLE incident_updates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status           text NOT NULL,
  message          text NOT NULL,
  created_by_kind  text NOT NULL,
  created_by_id    uuid NOT NULL,
  created_at       timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT incident_updates_status CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  CONSTRAINT incident_updates_message CHECK (char_length(btrim(message)) BETWEEN 1 AND 1000)
);
CREATE INDEX incident_updates_incident_idx ON incident_updates (incident_id, created_at);

-- Updates are the incident's history; history is not edited.
CREATE OR REPLACE FUNCTION codiq_incident_updates_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'incident_updates are append-only (ق-250)';
END $$;
CREATE TRIGGER incident_updates_immutable BEFORE UPDATE OR DELETE ON incident_updates
  FOR EACH ROW EXECUTE FUNCTION codiq_incident_updates_immutable();

-- ---------------------------------------------------------------- التدقيق
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_entity_type;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_entity_type CHECK (entity_type IN
  ('merchant', 'plan', 'subscription', 'upgrade_request', 'settlement', 'ledger_adjustment',
   'registration_mode', 'platform_staff', 'brand', 'platform_contact', 'platform_account',
   'service', 'capability', 'availability_override', 'feature_flag', 'store',
   'maintenance_window', 'incident'));
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
   'incident_opened', 'incident_updated', 'incident_resolved'));

-- ---------------------------------------------------------------- الصندوق
INSERT INTO notification_event_kinds (event_type, kind, description, priority) VALUES
  ('maintenance.scheduled', 'operational', 'ق-250: إشعار التاجر بصيانةٍ مجدولة تمسّه — الموعد والمدّة والرسالة، قبل أن تبدأ.', 150),
  ('maintenance.ended', 'operational', 'ق-250: إشعار التاجر بانتهاء الصيانة — الخدمة عادت.', 150)
ON CONFLICT (event_type) DO NOTHING;

-- The notice is about the platform, not about one of his stores: a two-store merchant gets one mail.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_store_scope;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_store_scope CHECK (
    store_id IS NOT NULL OR event_type IN ('auth.password_reset', 'trial.ending', 'maintenance.scheduled', 'maintenance.ended')
  );

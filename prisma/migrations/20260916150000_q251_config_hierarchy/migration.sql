-- ============================================================================
-- ق-251 — المرحلة 29 (الشريحة الثالثة): تسلسل التهيئة كدالّةٍ واحدة
-- ============================================================================
--
-- `افتراض المنصّة ← الخطّة ← تجاوز التاجر ← إعداد المتجر ← تفضيل الزبون` (01 §14).
-- الإعدادات سجلٌّ مغلقٌ في الشيفرة (`config.service.ts`) — لا مفتاح/قيمة حرّة:
-- المنصّة تكتب في `platform_settings` تحت `config.<code>` رموزَ السجلّ وحدها،
-- والخطّة في `plan_features`، والمتجر في أعمدته القائمة، والزبون في
-- `notification_unsubscribes`. ما كان ينقص هو مستوى التاجر — «تجاوز التاجر
-- لكلّ متاجره» — وهذا الجدول هو ذاك المستوى. الرموز المسموحة فيه هي التي
-- يقول السجلّ إنّ التاجر يملك رأياً فيها، محصورةً بـCHECK؛ اختبار الوحدة يقارن
-- قائمة الـCHECK بالسجلّ فلا يفترقان.
--
-- المستويات الدنيا لا تكسر قيود الأمان العليا: سقفٌ (cap) لا يُرفع فوق ما فوقه،
-- وسماحٌ (allow) لا يُفتح إن أُغلق فوقه — تُنفَّذ في الدالّة وقت القراءة، وتُرفض
-- عند الكتابة بأسماءٍ (SETTING_ABOVE_CEILING / SETTING_NOT_ALLOWED).

CREATE TABLE merchant_settings (
  merchant_id      uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  code             text NOT NULL,
  value            jsonb NOT NULL,
  updated_by_kind  text NOT NULL,
  updated_by_id    uuid NOT NULL,
  created_at       timestamptz(3) NOT NULL DEFAULT now(),
  updated_at       timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, code),
  -- exactly the registry codes whose levels include «merchant» — config.unit.mjs holds this list to the registry
  CONSTRAINT merchant_settings_code CHECK (code IN ('marketing.daily_cap', 'checkout.guest_allowed', 'loyalty.enabled')),
  CONSTRAINT merchant_settings_updated_by CHECK (updated_by_kind IN ('merchant', 'staff'))
);

COMMENT ON TABLE merchant_settings IS
  'ق-251: the merchant level of the configuration hierarchy — one row per (merchant, registry code). Read by config.service.resolveSetting between the plan and the store; never loosens what the platform or the plan set.';

-- ---------------------------------------------------------------- التدقيق
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_entity_type;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_entity_type CHECK (entity_type IN
  ('merchant', 'plan', 'subscription', 'upgrade_request', 'settlement', 'ledger_adjustment',
   'registration_mode', 'platform_staff', 'brand', 'platform_contact', 'platform_account',
   'service', 'capability', 'availability_override', 'feature_flag', 'store',
   'maintenance_window', 'incident', 'setting'));
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
   'setting_changed'));

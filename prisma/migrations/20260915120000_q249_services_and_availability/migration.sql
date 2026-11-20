-- ق-249 — المرحلة 29: الخدمات والقدرات والإتاحة وأعلام الميزات.
--
-- المنصّة تعرف ماذا تبيع (خطط بحدود رقميّة) ولا تعرف ماذا تملك: الميزات
-- مبعثرة في الشيفرة بلا اسمٍ ولا حالة، فلا يستطيع المالك أن يقول «نقطة البيع
-- تحت الصيانة» أو «الحملات قريباً» أو «هذا التاجر بلا مطابقة نقد» إلا بنشرٍ
-- جديد. هذه الهجرة تجعل الميزة صفّاً: خدمة، قدراتها، حالتها الافتراضيّة،
-- وتجاوزاتها لكلّ تاجر أو متجر — تُدار من اللوحة كإعدادات لا كود (ق-08).
--
-- الإتاحة ليست صلاحيّة: RBAC يقول «مَن»، والاستحقاق يقول «بأيّ خطّة»، وهذه
-- الجداول تقول «هل هي متاحة الآن ولماذا». الأعلى يغلب: قيدُ المنصّة فوق
-- حالة التاجر فوق حالة المتجر فوق التجاوزات فوق حالة الخدمة فوق العلم.

-- ---------------------------------------------------------------- الخدمات والقدرات
CREATE TABLE services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  state       text NOT NULL DEFAULT 'available',
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT services_code_key UNIQUE (code),
  CONSTRAINT services_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT services_state CHECK (state IN ('available', 'coming_soon', 'disabled', 'deprecated', 'retired'))
);

CREATE TABLE capabilities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  state       text NOT NULL DEFAULT 'available',
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  updated_at  timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT capabilities_code_key UNIQUE (code),
  CONSTRAINT capabilities_code_format CHECK (code ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT capabilities_state CHECK (state IN ('available', 'coming_soon', 'disabled', 'deprecated', 'retired'))
);
CREATE INDEX capabilities_service_sort_idx ON capabilities (service_id, sort_order);

-- تبعيّةُ خدمةٍ على خدمةٍ أخرى ('service') أو على مزوّدٍ خارجيّ ('external' —
-- مفتاحٌ يعرفه الخادم: mail_provider …). خدمةٌ تبعيّتها معطّلة تُعلن
-- DEPENDENCY_UNAVAILABLE لا «متاحة» كاذبة.
CREATE TABLE service_dependencies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  target     text NOT NULL,
  note       text NOT NULL DEFAULT '',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT service_dependencies_kind CHECK (kind IN ('service', 'external')),
  CONSTRAINT service_dependencies_unique UNIQUE (service_id, kind, target)
);

-- ---------------------------------------------------------------- التجاوزات
-- صفٌّ واحد يقول: في هذا النطاق (المنصّة كلّها، أو تاجرٌ، أو متجرٌ) هذه
-- الخدمة أو القدرة في هذه الحالة، لهذا السبب، من هذه اللحظة إلى تلك. يُلغى
-- بختم revoked_at لا بالحذف: «لماذا كانت نقطة البيع معطّلة لهذا التاجر في
-- تشرين» سؤالٌ يُجاب من هنا.
CREATE TABLE availability_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL,
  merchant_id     uuid REFERENCES merchants(id) ON DELETE CASCADE,
  store_id        uuid REFERENCES stores(id) ON DELETE CASCADE,
  service_id      uuid REFERENCES services(id) ON DELETE CASCADE,
  capability_id   uuid REFERENCES capabilities(id) ON DELETE CASCADE,
  state           text NOT NULL,
  reason          text NOT NULL,
  starts_at       timestamptz(3),
  ends_at         timestamptz(3),
  created_by_kind text NOT NULL,
  created_by_id   uuid NOT NULL,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  revoked_at      timestamptz(3),
  revoked_by_kind text,
  revoked_by_id   uuid,
  CONSTRAINT availability_overrides_scope CHECK (scope IN ('platform', 'merchant', 'store')),
  CONSTRAINT availability_overrides_target CHECK (
    (scope = 'platform' AND merchant_id IS NULL AND store_id IS NULL)
    OR (scope = 'merchant' AND merchant_id IS NOT NULL AND store_id IS NULL)
    OR (scope = 'store' AND store_id IS NOT NULL)
  ),
  CONSTRAINT availability_overrides_subject CHECK ((service_id IS NULL) <> (capability_id IS NULL)),
  CONSTRAINT availability_overrides_state CHECK (state IN ('AVAILABLE', 'COMING_SOON', 'DISABLED', 'MAINTENANCE', 'TEMPORARILY_UNAVAILABLE', 'DEPRECATED', 'RETIRED')),
  CONSTRAINT availability_overrides_reason CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  CONSTRAINT availability_overrides_window CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT availability_overrides_revocation CHECK ((revoked_at IS NULL) = (revoked_by_kind IS NULL) AND (revoked_at IS NULL) = (revoked_by_id IS NULL))
);
-- قائمة المالك تُمشى على (created_at, id) — مفتاحُ صفحاتٍ مسجَّل في keyset-index.map.json.
CREATE INDEX availability_overrides_created_id_idx ON availability_overrides (created_at DESC, id DESC);
-- حلُّ الإتاحة يسأل: التجاوزات الحيّة لهذا المتجر / هذا التاجر / المنصّة.
CREATE INDEX availability_overrides_live_store_idx ON availability_overrides (store_id) WHERE revoked_at IS NULL;
CREATE INDEX availability_overrides_live_merchant_idx ON availability_overrides (merchant_id) WHERE revoked_at IS NULL;
CREATE INDEX availability_overrides_live_platform_idx ON availability_overrides (scope) WHERE revoked_at IS NULL AND scope = 'platform';

-- ---------------------------------------------------------------- أعلام الميزات
-- آليّةُ طرحٍ لا آليّةُ تخويل: العلم يفتح قدرةً لتاجرٍ تجريبيّ أو لنسبةٍ،
-- ولا يفتح أبداً ما تغلقه الصلاحيّة أو الاستحقاق أو الإتاحة.
CREATE TABLE feature_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  enabled_default boolean NOT NULL DEFAULT false,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT feature_flags_code_key UNIQUE (code),
  CONSTRAINT feature_flags_code_format CHECK (code ~ '^[a-z][a-z0-9_.]{1,59}$')
);

CREATE TABLE feature_flag_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id     uuid NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  scope       text NOT NULL,
  plan_id     uuid REFERENCES plans(id) ON DELETE CASCADE,
  merchant_id uuid REFERENCES merchants(id) ON DELETE CASCADE,
  store_id    uuid REFERENCES stores(id) ON DELETE CASCADE,
  percentage  integer,
  enabled     boolean NOT NULL,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT feature_flag_rules_scope CHECK (scope IN ('global', 'plan', 'merchant', 'store', 'beta', 'percentage')),
  CONSTRAINT feature_flag_rules_target CHECK (
    (scope = 'global' AND plan_id IS NULL AND merchant_id IS NULL AND store_id IS NULL AND percentage IS NULL)
    OR (scope = 'plan' AND plan_id IS NOT NULL AND merchant_id IS NULL AND store_id IS NULL AND percentage IS NULL)
    OR (scope IN ('merchant', 'beta') AND merchant_id IS NOT NULL AND plan_id IS NULL AND store_id IS NULL AND percentage IS NULL)
    OR (scope = 'store' AND store_id IS NOT NULL AND plan_id IS NULL AND merchant_id IS NULL AND percentage IS NULL)
    OR (scope = 'percentage' AND percentage BETWEEN 0 AND 100 AND plan_id IS NULL AND merchant_id IS NULL AND store_id IS NULL)
  )
);
CREATE INDEX feature_flag_rules_flag_idx ON feature_flag_rules (flag_id);

-- ---------------------------------------------------------------- حالة المتجر
-- كانت حالةُ المتجر حقلين منطقيّين: is_active (يُطفئه التسجيلُ غير المعتمد
-- وتعليقُ التاجر) وvacation_mode (إجازةُ MD-1). الآن حالةٌ واحدة مسمّاة، والحقلان
-- القديمان مرآةٌ لها بمشغّلٍ في القاعدة: من يكتب الحالة تتبعه المرآة، ومن
-- يكتب المرآة (الشيفرة القديمة) تُشتقّ حالتُه — فلا قارئَ قديمٌ ينكسر ولا
-- قارئَ جديدٌ يُخدع.
ALTER TABLE stores
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN status_message text,
  ADD COLUMN maintenance_until timestamptz(3);
ALTER TABLE stores ADD CONSTRAINT stores_status CHECK (status IN ('active', 'paused', 'maintenance', 'suspended', 'closed'));
ALTER TABLE stores ADD CONSTRAINT stores_status_message_length CHECK (status_message IS NULL OR char_length(status_message) <= 500);

UPDATE stores SET status = CASE WHEN NOT is_active THEN 'suspended' WHEN vacation_mode THEN 'paused' ELSE 'active' END;

CREATE OR REPLACE FUNCTION codiq_store_status_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      NEW.is_active := NEW.status NOT IN ('suspended', 'closed');
      NEW.vacation_mode := (NEW.status = 'paused');
    ELSIF NOT NEW.is_active THEN
      NEW.status := 'suspended';
    ELSIF NEW.vacation_mode THEN
      NEW.status := 'paused';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- الحالة هي مصدر الحقيقة؛ المرآة تتبعها.
    NEW.is_active := NEW.status NOT IN ('suspended', 'closed');
    NEW.vacation_mode := (NEW.status = 'paused');
  ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.vacation_mode IS DISTINCT FROM OLD.vacation_mode THEN
    -- كاتبٌ قديم حرّك المرآة؛ تُشتقّ الحالةُ التي قصدها.
    IF NOT NEW.is_active THEN NEW.status := 'suspended';
    ELSIF NEW.vacation_mode THEN NEW.status := 'paused';
    ELSE NEW.status := 'active';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stores_status_sync BEFORE INSERT OR UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION codiq_store_status_sync();

-- ---------------------------------------------------------------- الصندوق والتدقيق
-- الحدثُ يحمل إصداره من اليوم: مستهلكٌ يقرأ حمولةَ الإصدار 1 لا يُفاجَأ بحقلٍ
-- غيّر معناه في الإصدار 2.
ALTER TABLE notification_outbox ADD COLUMN event_version integer NOT NULL DEFAULT 1;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_event_version CHECK (event_version >= 1);

ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_events_entity_type;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_events_entity_type CHECK (entity_type IN
  ('merchant', 'plan', 'subscription', 'upgrade_request', 'settlement', 'ledger_adjustment',
   'registration_mode', 'platform_staff', 'brand', 'platform_contact', 'platform_account',
   'service', 'capability', 'availability_override', 'feature_flag', 'store'));
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
   'feature_flag_changed', 'store_status_changed'));

-- (تدقيقُ المنصّة append-only بمشغّل `platform_audit_events_immutable` منذ 19-ب — لا شيء يُضاف.)

-- ---------------------------------------------------------------- الزرع: ثماني خدمات
-- الخدمات الأولى بقرار المالك (2026-09-15): كلٌّ منها ميزةٌ حيّة اليوم؛ الصيدلة
-- ليست خدمةً (تبقى «منتج بوصفة» داخل الكتالوج). قدرةُ واتساب تُزرع «قريباً»
-- لأنّ مرحلتها 31 لم تبدأ — وهذه أوّل قدرةٍ تقول للتاجر حالَها بصدق.
INSERT INTO services (code, name, description, state, sort_order) VALUES
  ('pos',                 'نقطة البيع',      'البيع من الكاشير، الأجهزة المقترنة، والعمل بلا شبكة.', 'available', 10),
  ('delivery',            'التوصيل والتسليم', 'أسعار المحافظات، تسليم الطرد للناقل، بيان الشحنات، ومطابقة نقد الاستلام.', 'available', 20),
  ('offers',              'العروض',          'الكوبونات ونقاط الولاء.', 'available', 30),
  ('customer_experience', 'تجربة الزبون',    'المراجعات، قائمة الرغبات، تتبّع الطلب، الإرجاع الذاتيّ، وإعادة الطلب.', 'available', 40),
  ('communication',       'التواصل',         'رسائل البريد اليوم، وواتساب حين تُفتح المرحلة 31.', 'available', 50),
  ('marketing',           'التسويق',         'البكسلات الإعلانيّة، السلال المتروكة، وصورة المشاركة.', 'available', 60),
  ('data',                'البيانات',        'استيراد وتصدير CSV، التحليلات، والتقرير الشهريّ.', 'available', 70),
  ('team',                'الفريق',          'طاقم المتجر وصلاحيّاته.', 'available', 80)
ON CONFLICT (code) DO NOTHING;

INSERT INTO capabilities (service_id, code, name, description, state, sort_order)
SELECT s.id, c.code, c.name, c.description, c.state, c.sort_order
FROM (VALUES
  ('pos', 'pos.sell',                        'البيع من الكاشير',       'إصدار تذاكر البيع من شاشة الكاشير.', 'available', 10),
  ('pos', 'pos.devices',                     'أجهزة الكاشير',          'اقتران أجهزة نقطة البيع وإدارتها.', 'available', 20),
  ('pos', 'pos.offline',                     'العمل بلا شبكة',         'طابور التذاكر حين ينقطع الاتّصال.', 'available', 30),
  ('delivery', 'delivery.rates',             'أسعار التوصيل',          'سعر التوصيل لكلّ محافظة.', 'available', 10),
  ('delivery', 'delivery.handover',          'تسليم الطرد للناقل',     'الناقل ورقم البوليصة على زرّ «قيد التوصيل».', 'available', 20),
  ('delivery', 'delivery.manifest',          'بيان الشحنات',           'ملفّ CSV للناقل بالطرود التي خرجت.', 'available', 30),
  ('delivery', 'delivery.cod_reconciliation','مطابقة نقد الاستلام',    'ما حصّله الناقل مقابل ما استلمه التاجر.', 'available', 40),
  ('offers', 'offers.coupons',               'الكوبونات',              'أكواد خصم بنسبة أو مبلغ أو شحن مجّانيّ.', 'available', 10),
  ('offers', 'offers.loyalty',               'نقاط الولاء',            'كسب النقاط عند الإكمال وصرفها خصماً.', 'available', 20),
  ('customer_experience', 'cx.reviews',      'المراجعات',              'تقييمات بشارة «مشترٍ موثّق».', 'available', 10),
  ('customer_experience', 'cx.wishlist',     'قائمة الرغبات',          'حفظ المنتجات و«نبّهني عند التوفّر».', 'available', 20),
  ('customer_experience', 'cx.tracking',     'تتبّع الطلب',            'صفحة «أين طلبي؟» العامّة.', 'available', 30),
  ('customer_experience', 'cx.returns',      'الإرجاع الذاتيّ',        'طلب الإرجاع من حساب الزبون.', 'available', 40),
  ('customer_experience', 'cx.reorder',      'إعادة الطلب',            '«اطلبه مجدّداً» بنقرة.', 'available', 50),
  ('communication', 'communication.email',   'رسائل البريد',           'إشعارات الطلب والحساب بالبريد.', 'available', 10),
  ('communication', 'communication.whatsapp','رسائل واتساب',           'إشعارات الطلب على واتساب من رقم المنصّة — المرحلة 31.', 'coming_soon', 20),
  ('marketing', 'marketing.pixels',          'البكسلات الإعلانيّة',    'Meta وTikTok وGA4 في واجهة المتجر.', 'available', 10),
  ('marketing', 'marketing.abandoned_carts', 'السلال المتروكة',        'التقاط السلال التي لم تُتمَّم.', 'available', 20),
  ('marketing', 'marketing.share_cards',     'صورة المشاركة',          'بطاقة المنتج الجاهزة للستوري.', 'available', 30),
  ('data', 'data.csv',                       'استيراد وتصدير CSV',     'المنتجات والطلبات ملفّاً.', 'available', 10),
  ('data', 'data.analytics',                 'التحليلات',              'مبيعات اليوم، أفضل المنتجات، قمع الحالات.', 'available', 20),
  ('data', 'data.monthly_report',            'التقرير الشهريّ',        '«شهرك في CODIQ».', 'available', 30),
  ('team', 'team.staff',                     'طاقم المتجر',            'إضافة موظّفين بأدوار وصلاحيّات.', 'available', 10)
) AS c(service_code, code, name, description, state, sort_order)
JOIN services s ON s.code = c.service_code
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_dependencies (service_id, kind, target, note)
SELECT s.id, 'external', 'mail_provider', 'رسائل البريد تحتاج مزوّد بريدٍ مضبوطاً (Resend أو SMTP).'
FROM services s WHERE s.code = 'communication'
ON CONFLICT (service_id, kind, target) DO NOTHING;

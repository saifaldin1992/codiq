# 02 — البنية التقنيّة الرئيسيّة: كما هي، وكما تصير

| | |
|---|---|
| **معرّف الوثيقة** | CODIQ-ARCH-002 |
| **النوع** | البنية التقنيّة الرئيسيّة (Master Technical Architecture) |
| **الحالة** | معتمدة (ق-248) |
| **الإصدار** | 1.0 — 2026-09-15 |
| **التفصيل الحيّ** | `docs/ARCHITECTURE.md` (كيف يعمل النظام فعلاً) — هذه الوثيقة تضع نموذج ميديكا فوقه: ما هو قائم، وما يُضاف، وأين |

الأهداف بترتيبها: الصحّة، الأمان، عزل المستأجرين، القابليّة للصيانة، القابليّة للاختبار، الرصد، التوسّع المنضبط، القابليّة للتمديد.

---

## 1. الطوبولوجيا

```
المستخدمون
   ↓
تطبيق React + Vite واحد (المالك · الطاقم · التاجر · المتجر العامّ)   ←  يُخدَم من Express نفسه
   ↓  /api  و /api/v1
Express: routes/ (zod، الحرّاس، السياق)  →  services/ (المعنى)  →  Prisma  →  PostgreSQL (Neon)
   ↓                                          ↓
notification_outbox  →  عامل (عمليّة فرعيّة، إشارة IPC)  →  NotificationProvider (Resend HTTPS / SMTP)
مجدول النبضة الواحدة (تنظيف، انتهاء الحجوزات، ملخّص يوميّ، تنبيهات الصحّة …)
خدمة cron مستقلّة: النسخ الاحتياطيّ المعمّى إلى تخزينٍ منفصل
R2 (S3 API)  ·  Sentry  ·  Cloudflare DNS  ·  Railway (web + backup)  ·  GitHub Actions
```

**المستهدف (بلا تغيير في الطوبولوجيا):** وحدات جديدة داخل `services/` (29→33)، محوّلات جديدة (`WhatsAppProvider` في 31، `PaymentProvider`/`ShippingProvider` في 25أ)، Cloudflare for SaaS في 24-ب. Redis والعامل المنفصل بمعيار `00` §6.

## 2. المستودع

```
client/src/{pages,components,components/ui,config,lib,index.css}   الواجهات — أدوار الألوان، مغلّف القوائم، التنقّل المركزيّ
phase1-backend/src/{http/routes,http/schemas,services,auth,notifications,backup,jobs,db}
phase1-backend/tests/*.integration.mjs · *.guard.mjs · *.browser-acceptance.mjs   (136 ملفّ اختبار، 38 حارساً)
server/index.ts   نقطة الدخول: الأمان، الضغط، /api و /api/v1، الإغلاق النظيف
prisma/schema.prisma · prisma/migrations (81 + RELEASED)
docs/ · tools/local-ci/
```

## 3. الوحدات وملكيّتها

الطبقات: **HTTP** (`routes/` — الشكل بـzod، الحرّاس، لا قواعد أعمال) → **التطبيق/المجال** (`services/` — القواعد والمعاملات) → **البيانات** (Prisma). القاعدة البيتيّة: *الشكل في zod، والمعنى والرموز المسمّاة في الخدمة*. لا مسار يكتب Prisma مباشرةً؛ لا خدمة تعرف الشكل.

| المجال | المالك (ملفّات الخدمة) | الجداول التي يملكها | يُضاف |
|---|---|---|---|
| الهويّة والجلسات | `auth/*`, `session`, `password-reset`, `owner-totp`, `platform-staff-totp` | `platform_owners`, `platform_staff`, `merchants`, `staff`, `customers` وجلسات كلٍّ منها، رموز الاستعادة | — |
| التخويل | `staff-permissions`, `platform-permissions`, `platform-staff` | `staff_memberships`, `staff_membership_permission_overrides`, `platform_staff_permission_overrides` | 32: `merchant_memberships` |
| التجّار والمتاجر | `registration`, `merchant-store`, `merchant-suspension`, `manual-provisioning`, `store-bootstrap`, `store-verification`, `storefront-config`, `store-banner` | `merchants`, `stores`, `store_banners`, `reserved_slugs` | 29: `stores.status` + صيانة |
| **الخدمات والقدرات والإتاحة** | — | — | **29**: `services`, `capabilities`, `service_dependencies`, `availability_overrides`, `maintenance_windows`, `incidents`, `incident_updates`, `feature_flags`, `feature_flag_rules` |
| الخطط والاستحقاق والاشتراك | `entitlement`, مسارات `platform` | `plans`, `plan_features`, `merchant_subscriptions`, `plan_upgrade_requests` | **30**: `plan_versions`, `plan_version_capabilities`, `subscription_events`, `billing_events` |
| المال | `finance`, `merchant-wallet` | `ledger_entries` (append-only)، `settlements` (تلاصق بقيد)، `adjustments` | 25أ: فواتير |
| الكتالوج | `product-catalog`, `image-variants`, `product-image-storage`, `soft-delete`, `csv-transfer` | `products`, `product_variants`, `categories`, `product_images`, `product_attributes` | **33**: `publication_status`, `collections`, `collection_products` |
| المخزون | `inventory-movements`, `reservation-expiry-job`, `stock-forecast` | `inventory_movements`, `inventory_reservations` | — |
| الزبائن | `customer-directory`, `guest-checkout`, `storefront` | `customers`, `customer_addresses`, `customer_sessions` | **32**: `customer_identities` |
| السلّة والإتمام | `storefront`, `guest-checkout`, `coupon`, `loyalty` | `shopping_carts`, `cart_items`, `checkout_requests`, `coupons`, `coupon_redemptions`, `loyalty_entries` | 29: إعادة التحقّق من الإتاحة |
| الطلبات والتنفيذ | `order-lifecycle`, `order-notes`, `order-bulk`, `order-print`, `order-self-cancel`, `order-tracking`, `delivery`, `return-request`, `return-inspection`, `prescription` | `store_orders`, `order_items`, `order_status_events` (immutable)، `order_notes`, `order_tags`, `return_requests`, `order_prescriptions` | **33**: `shipments`, `orders.fulfillment_status` |
| الدفع والشحن | `payment-methods`, `delivery-rates` | `payment_methods`, `delivery_rates` | **25أ**: `payment_intents`, `payment_events`, `shipping_providers` |
| التواصل | `notifications/*`, `notification-settings`, `messaging-caps`, `whatsapp-manual` | `notification_outbox`, `notification_event_kinds`, `notification_settings`, `notification_unsubscribes`, `notification_complaints`, `order_whatsapp_sends` | **31**: `communication_accounts`, `communication_templates`, `communication_preferences`, `otp_challenges`, `whatsapp_webhook_events`, `communication_usage`, `merchant_inbox_messages` |
| التسويق والتحليلات | `marketing-settings`, `abandoned-cart`, `recommendation`, `analytics`, `platform-pulse`, `store-traffic`, `merchant-monthly-report` | `store_traffic_*`, `pixels` | 31ب: حملات وشرائح |
| التدقيق والأمان والاحتفاظ | `platform-audit`, `retention`, `retention-job`, `csrf`, `security-headers`, `secret-box`, `backup/*` | `store_audit_events` (immutable)، `platform_audit_events`, `platform_health_alerts`, `platform_settings` | 29: تدقيق الإتاحة؛ تثبيت `platform_audit_events` بـtrigger |

**قاعدة الاعتماد:** `routes → services → prisma`; المحوّلات (`notifications/`, `backup/`, R2) خلف واجهات؛ لا خدمة تستورد من `client/` ولا تحمل ترميزاً — يُثبَّت بحارس `layers:guard` (يُضاف مع 21).

## 4. بنية المستأجرين — كيف يجري السياق من الطلب إلى الصفّ

1. **الكعكة** `__Host-codiq_session` → JWT → صفّ جلسةٍ في جدول الهويّة (غير مُبطَل، غير منتهٍ) → **الفاعل**.
2. **الحارس** على المسار: `requireStoreActor(request, "orders.update")` يقرأ `:storeSlug`، يتحقّق أنّ الجلسة مقيَّدة بهذا المتجر (تاجر مالك أو عضويّة طاقم بالرمز)، ويعيد `{ actor, store }`. `requireMerchantStore` للتاجر على متاجره؛ `requireStorefrontCustomer` للزبون على متجره. الطاقم المنصّيّ بمصفوفة الأدوار.
3. **الخدمة** تستقبل `storeId` من الحارس لا من الجسم؛ كلّ استعلامٍ يحمل `store_id`؛ القراءة بالمعرّف تُنطَّق بالمتجر ثمّ تعيد 404.
4. **القاعدة** تكمل الدفاع: مفاتيح أجنبيّة مركّبة `(customer_id, store_id) → customers(id, store_id)`، Triggers تمنع الربط العابر وتعديل السجلّات المحميّة.
5. **الاستحقاق** يُسأل عند كلّ كتابةٍ محدودة (403 مسمّى). **الإتاحة** (29) تُسأل بعده: `resolveAvailability({capability, merchant, store})`.

**المستهدف (32):** سياق تاجر صريح لمسارات `/merchant/*` غير المتجريّة، بعضويّات تاجر بأدوار (مالك، مدير كلّ المتاجر، محاسب قراءة) وسياسة إسقاطٍ إلى صلاحيّات المتجر.

## 5. المصادقة

- دخول بكلمة سرّ (bcrypt 12، مقارنة وهميّة دائماً)، TOTP للمالك (إلزاميّ، رموز استعادة مجزَّأة) والتجّار، استعادة كلمة السرّ برمزٍ موقوت أحاديّ الاستعمال عبر البريد (كلمة السرّ لا تمرّ بواتساب — ق-245).
- الجلسة: JWT قصير الحمل + صفّ جلسة بـ`token_hash`، `revoked_at`، `expires_at`؛ قائمة الجلسات، خروجٌ من كلّ الهويّات، إبطال عند التعطيل وتغيير الدور.
- الحدود: الدخول والاستعادة والـOTP (31) بمفاتيح مسمّاة.
- **حدّ معروف (D-88):** كعكة واحدة لأربع هويّات في المتصفّح نفسه — سؤال منتج مفتوح للمالك.

## 6. التخويل والاستحقاق والإتاحة والأعلام — الفعّاليّة الفعليّة

```
مسموح؟ = صلاحيّة RBAC
        ∧ استحقاق الخطّة (إصدار الاشتراك الحاليّ — 30)
        ∧ الإتاحة الفعّالة (29):  قيد المنصّة > حالة التاجر > حالة المتجر > التبعيّة > الخدمة/القدرة > علم الميزة
```

الأعلى يغلب الأدنى دائماً؛ العلم لا يفتح ما تغلقه الصلاحيّة أو الاستحقاق؛ الإتاحة ليست تخويلاً. الحالات الثلاث عشرة وحالات المتجر الخمس في `01` §13. تُنفَّذ كدالّةٍ واحدة تُسأل من الحرّاس ومن الإتمام ومن الواجهة (لعرض الشارة)، وتُثبَت مصفوفةُ الأسبقيّة باختبار.

## 7. نموذج الخدمة والقدرة والإصدار (29/30) — رسم المخطّط

```
services(code, name, kind, sort)  1─n  capabilities(code, service_id, default_availability)
plans  1─n  plan_versions(version, effective_from, monthly_price_iqd, commission_bps, limits jsonb)  1─n  plan_version_capabilities
merchant_subscriptions.plan_version_id  →  plan_versions        (الاشتراك القديم يحتفظ بإصداره حتى التجديد)
availability_overrides(scope platform|merchant|store, target_id, capability_id?, service_id?, state, reason, from, to, actor)
maintenance_windows(scope, target_id?, starts_at, ends_at, timezone, message_ar, message_en, affects jsonb)
incidents(status, title, public_message, affects jsonb)  1─n  incident_updates
feature_flags(code)  1─n  feature_flag_rules(scope global|plan|merchant|store|beta|percentage, target, on)
stores.status  active|paused|maintenance|suspended|closed   (يحلّ محلّ is_active+vacation_mode عبر هجرة اشتقاق)
```

الاستحقاق يبقى في `entitlement.service` ويقرأ حدود الإصدار؛ لقطة العمولة عند الإتمام تبقى كما هي (ق-145).

## 8. قاعدة البيانات

- **إضافيّة أوّلاً**، CHECK وUNIQUE جزئيّة وTriggers في القاعدة لا في الشيفرة وحدها، أعمدة مولَّدة للبحث، `timestamptz(3)` لكلّ عمود مؤشّر (ق-242)، فهارس keyset مسجَّلة ومقيسة (`keyset-index.map.json`)، تمرين الهجرات فوق صفوف الإنتاج (ق-247)، `RELEASED` يتقدّم بعد كلّ إصدار.
- **الملكيّة:** `store_id` على كلّ جدولٍ متجريّ، `merchant_id` على ما يملكه التاجر فوق المتاجر (الاشتراك، الطاقم، العضويّات)، `customer_id` مع `store_id` معاً. لا تكرار معرّفات ملكيّة بلا غرض؛ الفهارس تبدأ بالمستأجر.
- **المعاملات:** الإتمام Serializable مع idempotency وقفلٍ قبل فحص التوفّر؛ المخزون بقفل الصفّ ثمّ الحساب (CAS)؛ العمولة داخل معاملة الإكمال؛ الاشتراكات والاستحقاقات في 30 معاملةً واحدة لكلّ انتقال؛ التهيئة الحرجة (29) بمعاملة + تدقيق.
- **التاريخ:** الدفتر وأحداث الحالة وتدقيق المتجر immutable بـtriggers؛ `platform_audit_events` يُثبَّت في 29.

## 9. الأحداث والصندوق والعمّال

- الحدث يُكتب في `notification_outbox` **داخل معاملة العمليّة** (فشل الطلب = لا صفّ)، مصنَّف بمفتاح أجنبيّ، بمفتاح عدم تكرار فريد مع المتجر؛ العامل يطالب الصفّ بـclaim token، يرسل، يعيد المحاولة بتراجع، يدفن بعد N. الإيقاظ بإشارة IPC والنبضة الواحدة (ق-239).
- **المستهدف:** `version` على الحدث وسجلّ أحداث المنصّة (29)؛ أحداث الاشتراك (30)؛ أحداث الإتاحة تُطلق إبطالاً موجَّهاً حين يظهر كاش (لا إبطال عامّ).
- الوظائف: آمنة الإعادة، تحمل سياق المتجر، مرصودة (Sentry + سجلّ بمعرّف الوظيفة).

## 10. API

- `/api` و`/api/v1` تطبيقٌ واحد بمسارين؛ OpenAPI مولَّد من المسارات (حارس)؛ مغلّف قوائم واحد `{ items, nextCursor, storeSlug, …facets }` بمؤشّر keyset (حارس `list`)؛ الخطأ `{ code, message, requestId, details? }` بفئاته (validation/authentication/authorization/not-found/conflict/rate-limited/unavailable/dependency-failure/internal).
- الوسطاء بالترتيب: رؤوس الأمان + CSP → الضغط → معرّف الطلب → الجسم (حدود) → CSRF (`Origin`/`Sec-Fetch-Site`) → الحدود → المسار (zod → حارس → خدمة).
- التوافق: لا كسر لعقدٍ منشور بلا إصدارٍ جديد للمسار؛ `docs/API_VERSIONING.md`.

## 11. Idempotency والـwebhooks

- مفاتيح: الإتمام (`checkout_requests`)، الصندوق (`dedupe_key`)، تعليم الاستلام (idempotent بالتصميم)، الـwebhooks (معرّف الحدث فريد — Resend اليوم، Meta في 31، الدفع في 25أ)، الهجرات (`_prisma_migrations`).
- الـwebhook: جسم خام → توقيع HMAC → هويّة المزوّد → مفتاح تكرار → معالجة خارج الطلب (200 سريع) → انتقال حالة آمن → سجلّ. البنية العامّة (توقيع/إعادة محاولة/سجلّ) تُعمَّم في 24 لتخدم 25أ.

## 12. الدفع والشحن والتنفيذ (25أ / 33)

```ts
interface PaymentProvider { createIntent(order, method): Promise<PaymentIntent>; verifyWebhook(raw, sig): boolean; parseEvent(raw): PaymentEvent }
interface ShippingProvider { createShipment(order): Promise<Shipment>; track(ref): Promise<TrackingStatus>; verifyWebhook(...) }
```
- محرّك الدفع يملك `payment_intents`/`payment_events` بحالات صريحة (pending/authorized/paid/failed/refunded)؛ فشل المزوّد لا يمسّ الطلب؛ اعتمادات المزوّد لكلّ تاجر معمّاة.
- التنفيذ منفصل عن إعداد الشحن: `shipments` (ناقل، بوليصة، حالة، لحظات) — أعمدة ق-246 على الطلب تبقى «الشحنة الأولى» وتُهاجَر إلى `shipments` في 33 بلا فقد؛ `fulfillment_status` على الطلب (unfulfilled/partial/fulfilled) للتنفيذ الجزئيّ لاحقاً.

## 13. التواصل (31)

بنية المحرّك بمحوّلات `EmailProvider` (موجود) و`WhatsAppProvider` (Meta + زائف) و`SMSProvider` (واجهة موجودة بلا مزوّد)؛ الأحداث تُطلق الرسائل عبر الصندوق؛ `communication_accounts` بنطاق `platform | merchant` — قرار المالك ق-245 يبدأ بحساب المنصّة. التفصيل الكامل في `docs/PHASE31_COMMUNICATION_PLATFORM_SPEC.md`.

## 14. البحث والوسائط والنطاقات

- **البحث:** تطبيع في القاعدة + `pg_trgm`؛ الواجهة `search.service` هي الحدّ الذي يقف خلفه أيّ محرّك لاحق.
- **الوسائط:** R2 عبر S3 API؛ مفاتيح تحمل المتجر؛ ثلاثة مقاسات؛ عامّ (صور المنتجات، اللافتات) مقابل خاصّ (الوصفات بروابط موقَّعة)؛ القاعدة للبيانات الوصفيّة فقط.
- **النطاقات:** `hostname → stores.default_subdomain | custom_domain → سياق المتجر → التطبيق`. **24-ب:** سجلّ `domains` (تحقّق، حالة التزويد، هدف)، Cloudflare for SaaS للـhostname والشهادة، تحقّق CNAME آليّ.

## 15. المتجر العامّ والمظهر والكاش

- SPA يُخدَم من الخادم نفسه؛ بيانات SEO مهيكلة تُحقن؛ حارس `storefront` يمنع تسرّب مسارٍ خاصّ. القرار على Next.js عند 23 بالقياس.
- **المظهر:** أدوار ألوان في `index.css` (حارس `theme`)، أقسام الرئيسيّة مهيّأة بالبيانات (`home_sections`) — أي «ثيم مهيّأ بالإعداد» كما يطلب MVP ميديكا — و`store_theme` في 21-د ضمن حدود الخطّة. لا بانيَ سحبٍ وإفلات في MVP؛ محرّك واحد في 28-A.
- **الكاش:** المتصفّح + ضغط الاستجابات؛ لا CDN كاش اليوم (DNS فقط)؛ لا Redis. قاعدة ثابتة: مفتاح الكاش يحمل المتجر، ولا يدخل بيانٌ خاصّ أيّ كاشٍ عامّ. الإبطال بالأحداث (PRODUCT_UPDATED, PRICE_CHANGED, INVENTORY_CHANGED, STORE_THEME_PUBLISHED, AVAILABILITY_CHANGED) حين يُدخل كاش.

## 16. الرصد والتدقيق والأخطاء والصحّة

Sentry للأعطال والإصدارات؛ سجلّات JSON بـ`requestId` و`store_id` ونوع الهويّة؛ لا أسرار في السجلّ؛ تدقيقٌ لكلّ عمليّة حسّاسة (فاعل، نوعه، تاجر، متجر، فعل، مورد، قبل/بعد، وقت، سبب) في جداول append-only؛ `/api/health` و`/api/ready`؛ فشل تبعيّةٍ اختياريّة لا يُسقط ما لا يعتمد عليها.

## 17. دورة حياة البيانات وآلات الحالة

- إنشاء → نشر (33: مسودّة/معاينة/منشور) → تحديث → تعطيل (29: يحفظ) → أرشفة (الحذف الناعم 30 يوماً) → حذف (تنقية مجدولة؛ الماليّ والطلبات لا تُحذف).
- آلات حالة صريحة: الطلب (قائمة)، الاشتراك (30)، الدفع (25أ)، التنفيذ (33)، تزويد النطاق (24-ب)، الصيانة والحوادث (29). لا انفجار حقول boolean.

## 18. التوسّع والتعافي

- الويب بلا حالة (الجلسات في القاعدة) → نسخٌ متعدّدة ممكنة؛ عندها Redis للحدود الموزّعة (معيار `00`). القاعدة تتوسّع بالفهارس والاستعلامات المقيسة والاتّصال المباشر للهجرات؛ لا تجزئة بلا قياس.
- التعافي: نسخ 6 ساعات معمّاة على نطاق فشلٍ منفصل، استعادة مُثبَتة، لقطة Neon قبل الإصدار، `release` فرعٌ عاديّ يُعاد إلى دفعةٍ سابقة للتراجع؛ RTO يُقاس في 24-ج؛ استعادة الأسرار وDNS تُوثَّق فيها.

## 19. V1 مقابل بذور V2

V1 = الطوبولوجيا أعلاه بوحدات 29→33 و21→26. بذور V2 تُترك مفتوحةً لا مبنيّة: `customer_identities` (سوق متعدّد)، `communication_accounts.scope = merchant` (أرقام التجّار)، `shipments` (تنفيذ جزئيّ)، `plan_versions` (فوترة ذاتيّة)، `feature_flag_rules.percentage` (طرح تدريجيّ)، `/api/v1` (مفاتيح API عامّة في 28).

## 20. سجلّات القرارات المعماريّة

ADR-001…006 في `docs/adr/`؛ ومن ق-134 فصاعداً القرارات المعماريّة صفوفٌ في `DECISIONS_LEDGER.md`. يُفتح لكلٍّ من 29→33 صفٌّ عند بدئها يذكر هذه الوثيقة.

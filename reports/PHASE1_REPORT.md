# codiq — تقرير إنجاز المرحلة الأولى: أساس الهوية والعزل

**حالة المرحلة:** مكتملة تقنيًا ومختبرة محليًا.  
**النطاق المنفذ:** PostgreSQL، Prisma، طبقة Node.js/TypeScript للمصادقة، ومسارات API الخاصة بالهوية فقط.  
**خارج النطاق عمدًا:** أي صفحة، واجهة، تصميم، كتالوج، طلبات، دفع فعلي، إشعارات فعلية، أو مرحلة لاحقة.

> المبدأ المنفذ: المالك والتاجر والزبون ليسوا صفوفًا في جدول مستخدمين واحد. لكل منهم جدول هوية، جلسات، مسار دخول، وخدمة تحقق منفصلة. ولا يسمح النظام بتخمين الدور من البريد أو تنفيذ بحث متسلسل عبر أنواع الحسابات.

## 1. الجداول والحقول كما كُتبت في PostgreSQL

### جداول الهوية والعلاقات الأساسية

| الجدول | الحقول المكتوبة بالضبط | القيود الجوهرية |
|---|---|---|
| `platform_owners` | `id`, `email`, `password_hash`, `display_name`, `is_active`, `created_at`, `updated_at` | `email` فريد، ومطبّع إلى lowercase عبر Trigger؛ يُمنع إن كان البريد مسجلًا في `merchants`. |
| `merchants` | `id`, `email`, `password_hash`, `business_name`, `is_active`, `created_at`, `updated_at` | `email` فريد، ومطبّع إلى lowercase عبر Trigger؛ يُمنع إن كان البريد مسجلًا في `platform_owners`. |
| `stores` | `id`, `merchant_id`, `name`, `slug`, `custom_domain`, `default_subdomain`, `is_active`, `created_at`, `updated_at` | `merchant_id` مفتاح أجنبي إلى `merchants` مع `ON DELETE RESTRICT`؛ و`slug` و`default_subdomain` فريدان؛ و`custom_domain` موجود وجاهز لكنه `NULL` افتراضيًا. |
| `customers` | `id`, `store_id`, `email`, `password_hash`, `full_name`, `phone`, `is_active`, `created_at`, `updated_at` | المفتاح الفريد هو `UNIQUE (store_id, email)`، لا `email` وحده؛ لذا يجوز البريد نفسه في متجرين مختلفين فقط. |

### جداول «حقول جاهزة، ميزات مقفلة»

| الجدول | الحقول المكتوبة بالضبط | الحالة الحالية المقفلة |
|---|---|---|
| `payment_methods` | `id`, `store_id`, `code`, `display_name`, `is_enabled`, `configuration`, `created_at`, `updated_at` | القيد `payment_methods_only_cod_enabled` يمنع تفعيل أي وسيلة غير `COD`. عند إنشاء متجر، ينشأ `COD = true` و`CARD = false`. لا يوجد ربط بوابة دفع. |
| `notification_settings` | `id`, `store_id`, `provider`, `api_key`, `sender_id`, `is_enabled`, `configuration`, `created_at`, `updated_at` | `api_key = NULL` و`is_enabled = false` عند إنشاء المتجر؛ وتعيد خدمة الأهلية `NOT_CONFIGURED`، فلا يوجد أي إرسال خارجي. |
| `delivery_rates` | `id`, `store_id`, `governorate`, `amount_iqd`, `is_enabled`, `created_at`, `updated_at` | صف واحد لكل محافظة عراقية لكل متجر بواسطة `UNIQUE (store_id, governorate)`؛ حقل `amount_iqd` لا يقبل قيمة سالبة؛ لا توجد أي API خارجية. |

### جداول الجلسات المنفصلة

| الجدول | الحقول المكتوبة بالضبط | سبب الفصل |
|---|---|---|
| `platform_owner_sessions` | `id`, `platform_owner_id`, `token_hash`, `expires_at`, `revoked_at`, `created_at` | جلسات المالك لا تشير إلا إلى `platform_owners`. |
| `merchant_sessions` | `id`, `merchant_id`, `token_hash`, `expires_at`, `revoked_at`, `created_at` | جلسات التاجر لا تشير إلا إلى `merchants`. |
| `customer_sessions` | `id`, `customer_id`, `token_hash`, `expires_at`, `revoked_at`, `created_at` | جلسات الزبون لا تشير إلا إلى `customers`، ثم يتحقق الخادم من المتجر المرتبط بالزبون عند الوصول لمسار متجر. |

## 2. القيد البنيوي لمنع تداخل بريد المالك والتاجر

نفذت الهجرة SQL الدالة `codiq_guard_owner_merchant_email()` والـTriggers التاليين:

| Trigger | الجدول | زمن التنفيذ | أثره |
|---|---|---|---|
| `platform_owners_guard_owner_merchant_email` | `platform_owners` | `BEFORE INSERT OR UPDATE OF email` | يرفض كتابة المالك إذا كان البريد موجودًا في `merchants`. |
| `merchants_guard_owner_merchant_email` | `merchants` | `BEFORE INSERT OR UPDATE OF email` | يرفض كتابة التاجر إذا كان البريد موجودًا في `platform_owners`. |

تطبّع الدالة البريد أولًا إلى lowercase بعد إزالة الفراغات، ثم تستخدم `pg_advisory_xact_lock(hashtextextended(...))` داخل المعاملة؛ لذلك تتسلسل أي محاولتين متزامنتين على البريد نفسه قبل إجراء الفحص. الرفض يصدر من PostgreSQL بالرمز `23505` والرسالة الصريحة التي تبدأ بـ`CODIQ_EMAIL_CONFLICT`، حتى إذا حاول طرف تجاوز الـAPI وإجراء `INSERT` مباشر.

توجد كذلك فحوص سريعة في `phase1-backend/src/auth/auth.service.ts` لتقديم رسالة API واضحة مبكرًا. هذه ليست طبقة الحماية الوحيدة؛ الـTrigger هو الحماية النهائية الملزمة داخل قاعدة البيانات.

## 3. منطق تحديد نوع الدخول وإعادة التوجيه

لم تُنشأ واجهات في هذه المرحلة التزامًا بالنطاق، لكن عقود المسارات التي ستستدعيها الواجهات أصبحت محددة وثابتة.

| نوع الحساب | مسار الدخول المقصود في الواجهة | Endpoint المنفذ | جدول البحث الوحيد | دالة التحقق | إعادة التوجيه الوحيدة |
|---|---|---|---|---|---|
| مالك المنصة | `/platform/login` | `POST /auth/platform/login` | `platform_owners` | `loginPlatformOwner()` | `/platform/dashboard` |
| تاجر ضمن متجر محدد | `/merchant/stores/{store-slug}/login` | `POST /auth/merchant/stores/:storeSlug/login` | `merchants` ثم `stores` المقيّد بـ`merchant_id` و`store_slug` | `loginMerchant()` | `/merchant/stores/{store-slug}/dashboard` |
| زبون متجر | `/store/{store-slug}/account/login` | `POST /stores/:storeSlug/account/login` | `customers` بعد حل `store_slug` إلى `store_id` | `loginCustomer()` | `/stores/{store-slug}/account` |

**المسؤوليات الدقيقة في الكود** هي كالآتي. الملف `phase1-backend/src/http/app.ts` يربط كل Endpoint بخدمة محددة ولا يقدم مسار تسجيل دخول عام. الملف `phase1-backend/src/auth/auth.service.ts` ينفذ البحث في جدول الهوية المحدد فقط. الملف `phase1-backend/src/auth/redirects.ts` يحتوي دوال المسارات الثابتة: `platformOwnerDashboardPath()` و`merchantStoreDashboardPath()` و`customerAccountPath()`؛ لذلك لا توجد وجهة fallback أو دالة تحاول استنتاج دور الحساب. أما `phase1-backend/src/auth/identity.ts` فينشئ ويتحقق من جلسة تحمل `identityKind` صريحًا، ويطابقها مع جدول جلسات من النوع نفسه.

بالنسبة للتاجر متعدد المتاجر، لا توجد جلسة تاجر عامة قابلة للتنقل بين المتاجر. يتطلب الدخول `store_slug` صريحًا، وتخزن `merchant_sessions.store_id` مع `merchant_id`. يفرض Trigger قاعدة البيانات `merchant_sessions_guard_store_ownership` أن المتجر المختار يعود إلى التاجر نفسه، ثم يتحقق `requireMerchantStoreAccess` من أن الـToken مرتبط **بالمتجر المطلوب نفسه**. لذلك لا تكفي ملكية التاجر للمتجر B للوصول إليه باستخدام جلسة فُتحت في متجر A؛ يلزم دخول/جلسة مستقلة بسياق B.

لا يكفي أن تكون جلسة الزبون من النوع `customer`: في `phase1-backend/src/http/app.ts` يتحقق المعالج `requireCustomerStoreAccess` من أن `store.slug` المرتبط فعليًا بالزبون يطابق `:storeSlug` المطلوب. وبذلك لا يستطيع زبون متجر A استعمال جلسته للوصول إلى متجر B، ولو كان البريد نفسه مستخدمًا في المتجرين.

## 4. الاختبارات الفعلية الموثقة

شغلت الأوامر التالية على PostgreSQL محلي حقيقي بعد تطبيق الهجرة بنجاح:

```bash
pnpm phase1:db:generate
pnpm phase1:db:migrate
pnpm phase1:typecheck
pnpm phase1:test
```

الاختبار التكاملي محفوظ في `phase1-backend/tests/phase1.integration.ts`، وآخر مخرجات تشغيله محفوظة في `phase1-backend/tests/latest-test-output.json`.

| الاختبار المطلوب | بيانات الاختبار | النتيجة الفعلية |
|---|---|---|
| تسجيل مالك تجريبي والدخول به | `owner.phase1@codiq.test` | نجح التسجيل؛ أعاد الدخول `redirectTo: /platform/dashboard`؛ ثم أعاد المسار المحمي `area: platform_owner` بحالة `200`. |
| تسجيل تاجر تجريبي والدخول به | `merchant.phase1@codiq.test` | نجح التسجيل؛ أعاد الدخول `redirectTo: /merchant/dashboard`؛ ثم أعاد المسار المحمي `area: merchant` بحالة `200`. |
| منع تداخل المناطق المحمية | استخدام Token المالك في `/merchant/dashboard` والعكس | رفض الطلبان بحالة `403` ورمز `IDENTITY_BOUNDARY_DENIED`. |
| عزل متجرين لنفس التاجر | جلسة تاجر فُتحت في `store-a` ثم طلب `/merchant/stores/store-b/dashboard`، مع أن المتجرين للتاجر نفسه | الوصول إلى `store-a` نجح بـ`200`؛ الوصول إلى `store-b` بالجلسة ذاتها رُفض بـ`403` ورمز `STORE_BOUNDARY_DENIED`؛ ونجح `store-b` فقط بعد فتح جلسة مستقلة في سياقه. |
| محاولة إنشاء تاجر ببريد المالك عبر الـAPI | `owner.phase1@codiq.test` | رُفضت بحالة `409` ورمز `EMAIL_RESERVED_FOR_PLATFORM_OWNER` ورسالة صريحة. |
| محاولة تجاوز الـAPI بإدراج SQL مباشر في `merchants` ببريد المالك | `INSERT INTO merchants ... owner.phase1@codiq.test` | رفض PostgreSQL الإدراج نفسه بالرمز `23505` وبالرسالة `CODIQ_EMAIL_CONFLICT: this email is already registered as a platform owner and cannot be a merchant`. |
| محاولة تكرار بريد زبون في المتجر نفسه | تسجيل `same.customer@codiq.test` مرة ثانية في `store-a` | رُفضت فعليًا بحالة `409` ورمز `DUPLICATE_IDENTITY`؛ وهذا يثبت تنفيذ `UNIQUE (store_id, email)` داخل نطاق المتجر نفسه. |
| البريد ذاته في متجر آخر | تسجيل `same.customer@codiq.test` في `store-b` بعد وجوده في `store-a` | نجح فعليًا بحالة `201`؛ وهذا يثبت أن القيد لا يمنع التكرار المشروع عبر متاجر مختلفة. |
| منع زبون متجر A من مساحة متجر B | Token زبون `store-a` إلى `/stores/store-b/account` | رُفض بحالة `403` ورمز `STORE_BOUNDARY_DENIED`؛ أما متجره نفسه فأعاد `200`. |
| الحقول المقفلة الجاهزة | متجر اختباري | `custom_domain: null`؛ `COD: true`؛ `CARD: false`؛ `notification api_key: null`؛ `notification is_enabled: false`؛ و18 صفًا في `delivery_rates`. |

## 5. كلمات المرور وحالة GitHub

تستخدم كلمة المرور في هذه المرحلة مكتبة `bcryptjs` وخوارزمية **bcrypt**. الدالة `createPasswordHash()` تستدعي `bcrypt.hash(password, 12)`؛ أي إن معامل الكلفة هو **12 rounds**. تتحقق الدالة `verifyPassword()` بواسطة `bcrypt.compare(password, passwordHash)`. لا تحفظ قاعدة البيانات كلمة المرور الأصلية ولا تقارنها نصيًا؛ تحفظ فقط ناتج bcrypt في الحقل `password_hash`.

أما حالة GitHub وقت كتابة هذا التقرير فهي شفافة: مستودع [`phsaifaldin/cod-multistore`](https://github.com/phsaifaldin/cod-multistore) موجود وفرعه الافتراضي `main`، لكن النسخة الحالية من `codiq-phase1` لم تُرفع إليه بعد. المسار البعيد المحلي الحالي هو مستودع نقاط الحفظ الداخلي، وليس `cod-multistore`؛ كما أن آخر commit على GitHub هو `2223d54d1a4509891a5aeabc4eb782f2b73781d7` برسالة خارطة طريق التوسعة، ولذلك **لا يعكس** هذا العمل. لا توجد أي ادعاءات برفع كود المرحلة الأولى إلى GitHub قبل إجراء عملية دفع صريحة.

## 6. النتيجة وحدود المرحلة

أصبح أساس الفصل البنيوي موجودًا في طبقة قاعدة البيانات والمصادقة، لا في الواجهة فقط. أنشأت المرحلة قاعدة بيانات محلية مخصصة للتطوير والاختبار باسم `codiq_phase1`، وطُبقت هجرة Prisma المسماة `20260816193500_phase1_identity_foundation` بنجاح.

لم أبدأ المرحلة الثانية أو أي ميزة إضافية. ينتظر المشروع الآن مراجعتك وموافقتك الصريحة قبل أي انتقال لاحق.

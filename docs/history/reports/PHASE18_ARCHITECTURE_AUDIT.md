> ⚠️ **تدقيقٌ مؤرَّخ 2026-08-25، لا وصفٌ للمعمارية الحاليّة (ق-189).** أُعيد فحصه في 2026-09-09: **نحو ثلثيه أُغلق بالشيفرة**. مؤكَّدٌ إغلاقه: BE-1 (‏`app.ts` صار ١٧٨ سطراً و‏٢٣ وحدة توجيه) · BE-3 (‏zod هي طبقة التحقّق) · AU-1 (تسجيل المالك مُقفل بمتغيّر) · IN-1 (`trust proxy` مضبوط) · IN-2 (‏`/ready`) · IN-3 (سجلّات منظَّمة ومعرّف ارتباط) · DB-1 · DB-4 · DB-5 · DB-10 · API-3 · JB-1 · CI-1. **ما زال صحيحاً:** FE-4 (لا مكتبة i18n) · ST-1 (‏`S3Client` جديد لكلّ عمليّة) · D-63 الكعكة المشتركة · D-64 · D-66. لا يُقتبَس منه شيءٌ قبل إعادة فحصه على الشيفرة — وهي قاعدةُ الملفّ نفسه في §1.3.

# تقرير تدقيق المعمارية الرسمي — CODIQ
## المرحلة 18 — المخرج 1 من 2

**التاريخ:** 2026-08-25
**الحالة:** نهائي — مُجمَّع من ستة تدقيقات مجالية مكتملة، كل ادعاء فيه مُتحقق منه بقراءة الكود مباشرة مع مرجع الملف والسطر.
**قاعدة المرحلة 18:** تدقيق قراءة فقط — لم يُنفَّذ أي تغيير على الكود.

---

# 1) منهجية التدقيق

## 1.1 النطاق

جرى التدقيق على كامل الشجرة الحية للمنصة:

| المكوّن | النطاق المفحوص |
|---|---|
| Backend | `phase1-backend/src` كاملاً (28 ملفاً، ~3,108 سطر) + `server/index.ts` (64 سطراً) |
| قاعدة البيانات | `prisma/schema.prisma` (34 موديل) + جميع ملفات `migrations/` الاثني عشر |
| الواجهة الأمامية | `client/src` كاملاً (37 ملف تطبيق + 54 مكوّن `components/ui`) + `client/index.html` + `vite.config.ts` |
| الاختبارات وCI | `phase1-backend/tests/` (28 ملفاً) + `.github/workflows/ci.yml` + `vitest.backend.config.ts` |
| التشغيل والبنية | `docs/DEPLOYMENT.md`، `docs/BACKLOG.md`، `docs/history/reports/RAILWAY_ACCESS_FINDINGS.md`، سكربتات `package.json` |

## 1.2 الأبعاد الستة

نُفِّذ التدقيق على ستة محاور مستقلة، كلٌّ بتقرير مجالي مُتحقَّق منه:

1. **المعمارية الخلفية (Backend Architecture)** — بنية الطبقات، الخدمات، عقود الأخطاء، الترانزاكشنات.
2. **الوضع الأمني (Security Posture)** — المصادقة، الجلسات، CSRF، rate limiting، عزل IDOR (عينة 11 مساراً).
3. **نموذج البيانات والأداء (Data & Performance)** — المخطط، الفهارس، المسارات الساخنة، دورة حياة البيانات.
4. **الواجهة الأمامية وجاهزية UX (Frontend)** — قياسات فعلية لا تقديرية (ألوان، نصوص، حزمة، a11y).
5. **الاختبارات وخط CI (Testing & CI)** — جرد 28 ملف اختبار، بوابات CI الحاجبة وغير الحاجبة.
6. **العمليات والبنية التحتية (Operations & Infrastructure)** — Railway، الفحوص الصحية، الـ observability، الاستعادة.

## 1.3 القواعد المنهجية

- **لا ادعاء بلا دليل:** كل نتيجة مذكورة أدناه تحمل مرجع `ملف:سطر` تم التحقق منه بالقراءة المباشرة (لا grep وحده حيث يلزم السياق).
- **لا هجمات حية ولا تغييرات:** الفحص الأمني كان تحليلاً ساكناً للكود؛ لم تُنفَّذ أي عمليات على البيئات الحية.
- **سلّم الخطورة:** Critical (اختراق/عطل كامل) → High (خطأ مالي/توافري/انسداد مرحلة قادمة) → Medium (دين يتفاقم) → Low (تحسين/نظافة).
- **تقدير الجهد:** S (ساعات) / M (أيام) / L (أسبوع+ أو موزّع على مرحلة).
- **قياسات لا انطباعات:** أرقام الواجهة (1,035 لون hex، 946 نصاً عربياً، 842KB حزمة) مقاسة فعلياً من الكود.

---

# 2) نقاط القوة المعمارية — ما يجب ألّا يتغيّر

هذه الركائز هي رأس مال المشروع البنيوي. أي عمل مستقبلي (المراحل 19–26) يجب أن يبني **فوقها** لا أن يمسّها.

## 2.1 نموذج عزل المستأجرين (Tenancy Isolation) — الركيزة الأولى

- **مفاتيح أجنبية مركّبة same-store** تمنع بنيوياً أي ربط عابر للمتاجر: `@@unique([id, storeId])` على customers/products/store_orders/shopping_carts ثم FKs مركّبة مثل `CartItem.product([productId, storeId])` و`InventoryReservation.order([orderId, storeId])` (`prisma/schema.prisma:141,259,345,411` والعلاقات في 427-428، 488-489). العزل هنا **في بنية القاعدة نفسها** لا في انضباط المطوّر فقط.
- **نمط `where {id, storeId(, customerId)}` مطبَّق باتساق كامل:** عيّنة تحقق IDOR على 11 مساراً (عناوين الزبون، طلباته، عناصر السلة، طلبات التاجر، صور المنتجات، الفريق، التسويات) — **كلها سليمة**، ولم يُعثر على أي مسار يقرأ مورداً بالـ id وحده ضمن سياق مستأجر (أمثلة: `storefront.service.ts:244-266,376`، `order-lifecycle.service.ts:92,116`، `staff.service.ts:84`، `finance.service.ts:136`).
- **triggers دفاعية على مستوى القاعدة** لتعارض الإيميل بين الهويات (defense in depth في `prisma/migrations/20260816193500.../migration.sql:147`).

## 2.2 السلامة الترانزاكشنية (Transactional Invariants) — الركيزة الثانية

- **checkout ناضج فعلاً لـ COD** (`storefront.service.ts:297-365`): عزل Serializable + retry على P2002/P2034/40001 + idempotency key مع fingerprint + قفل `FOR UPDATE ... ORDER BY id ASC` بترتيب ثابت يمنع الـ deadlocks (`storefront.service.ts:320-328`) + optimistic versioning للسلة.
- **صف الـ outbox يُكتب في نفس ترانزاكشن الحدث** (`order-lifecycle.service.ts:121`، `storefront.service.ts:353`) — لا فقدان أحداث بين الطلب والإشعار.
- **قيد الـ ledger المالي في نفس ترانزاكشن تحويل الحالة** (`order-lifecycle.service.ts:124-128`)، append-only مع snapshot للعمولة والخطة (ADR-006).
- **append-only triggers** على `order_status_events` و`ledger_entries` و`settlements` ترفض UPDATE/DELETE من داخل قاعدة البيانات (`migrations/20260817201500_order_lifecycle_8a/migration.sql:66-76`، `migrations/20260825190000_phase17.../migration.sql:49-59,80-90`).
- **Snapshots في order_items** (productName, sku, unitPriceIqd) تفصل الطلبات التاريخية عن تعديلات المنتج (`schema.prisma:355-371`).

## 2.3 نموذج "الخادم يحسم كل شيء" — الركيزة الثالثة

- لا يُؤتمن أي `storeId` أو دور أو صلاحية من الـ client؛ `requireStoreActor`/`requireStoreStaff` (`src/auth/staff-permissions.ts:98-151`) تعيد قراءة العضوية والـ overrides من قاعدة البيانات في كل طلب حساس (قرار D14-07).
- **جلسات typed مدعومة بسجل DB:** JWT + صف جلسة بـ `tokenHash` (sha256) و`revokedAt` و`expiresAt` تُفحص في كل طلب (`identity.ts:102-114`) + إبطال فوري عند تغيير الدور (`staff.service.ts:109-112`) + جداول جلسات منفصلة لكل هوية (`identity.ts:70-78`). البنية تدعم الإبطال الحقيقي — أساس صحيح لدورة حياة الحسابات في المرحلة 19.

## 2.4 نمط الـ Outbox Worker

`outbox-worker.ts`: claim ذري عبر claim-token (`outbox-worker.ts:69-75`) يمنع الإرسال المزدوج، exponential backoff، dead-letter، عملية OS منفصلة (ADR-004). النمط جاهز للتعميم على webhooks (المرحلة 21+) ومزودي الدفع (المرحلة 25) كما هو — و`FakeNotificationProvider` (`tests/helpers/fake-notification-provider.ts`) هو النموذج الاختباري الصحيح للتعميم.

## 2.5 ركائز أصغر تستحق الحماية

- **عقد الأخطاء الموحّد:** `HttpError(status, code, message)` + معالج مركزي واحد يعيد دائماً `{error:{code,message}}` (`app.ts:177-194`).
- **العملة أعداد صحيحة IQD** في كل مكان + تحقق magic bytes من نوع الصور (`product-image-storage.service.ts:31-47`).
- **فهارس جزئية ذكية:** توفر المخزون `WHERE status='active'`، سلة الضيف الفريدة، اشتراك نشط واحد، `products_store_low_stock_idx` (`storefront_...9a:51-52,122`، `phase16:52`، `product_management:42`) + keyset pagination صحيح للطلبات مع فهرس مطابق تماماً (`order-lifecycle.service.ts:42-58,77-89`).
- **rate limiter ذري بالقاعدة** بـ upsert واحد `RETURNING` وSQL parameterized — لا SQLi (`storefront.service.ts:60-78`).
- **فصل pooled/unpooled** لاتصال Neon (`db/database-url.ts`) وتسجيل `/health` قبل الـ body parser.
- **الأسرار كلها من env** بلا قيم في الكود أو الوثائق، ولا CORS متساهل (same-origin افتراضياً)، وguest tokens عشوائية 32 بايت مخزنة hashed (`storefront.service.ts:17-18`).
- **عمق اختبارات التكامل:** تغطية concurrency حقيقية (سباق عاملَين على outbox في `phase15.notifications.integration.ts:195-200`، حاجز `FOR UPDATE` في `phase9a.storefront.integration.mjs:41-48`)، اختبار immutability بأكواد PostgreSQL (`phase17.finance.integration.ts:129-139`)، اختبار 429 فعلي (`phase9a:248-250`).
- **واجهة storefront هي الأنضج:** توكنز CSS variables، skip-link، `aria-live`، تحقق فعلي عند 390px — النموذج الذي يجب أن تُقاس عليه لوحات الإدارة.

**الحكم:** طبقة الخدمات نقية (تستقبل ids + input وتعيد بيانات، لا تلمس req/res) و**لا تحتاج إعادة هيكلة**. الأساس سليم؛ المشكلة قابلية النمو لا الصحة.

---

# 3) نقاط الضعف والمخاطر — حسب الطبقة

## 3.1 الواجهة الأمامية (Frontend)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| FE-1 | **أصول صور مكسورة في الإنتاج**: 6 مراجع `/manus-storage/*` تعمل فقط عبر plugin تطويري (`vitePluginStorageProxy`) غير موجود في خادم الإنتاج | `Home.tsx:120`، `OwnerDashboard.tsx:67,174,193`، `MerchantDashboard.tsx:85`، `StaffDashboard.tsx:38`، `vite.config.ts:151-202`، `server/index.ts:35-45` | High | S |
| FE-2 | **صفر code splitting → حزمة 842KB**: 13 صفحة مستوردة statically بما فيها لوحة الهندسة (23KB) التي تُشحن لكل زائر متجر؛ `Toaster` مركّب بلا أي استدعاء `toast()` | `App.tsx:9-23,113`، `vite.config.ts:217-220`، `docs/history/reports/HANDOFF_REPORT.md:274` | High | M |
| FE-3 | **1,095 لوناً صلباً** (1,035 hex + 60 rgba) خارج نظام التوكنز؛ لا block `.dark` رغم `@custom-variant dark`؛ نظامان للثيم لا يتخاطبان (next-themes في `ui/sonner.tsx` مقابل `ThemeContext`) — **يحجب الوضع الليلي (مرحلة 21)** | `index.css:5,33-54`، `EngineeringArchitectureDashboard.tsx` (69)، `Home.tsx` (47)، `OrderWorkspace.tsx:21-30`، `StorefrontShell.tsx:17-25` | High | L |
| FE-4 | **~1,275 نصاً عربياً صلباً** (946 literal + ~329 عقدة JSX) بلا أي مكتبة i18n؛ `dir="rtl"` مكرر 43 مرة؛ تنسيقات مثبتة على `ar-IQ` — **يحجب i18n الثلاثي ar/en/ckb (مرحلة 22)** | `package.json` (لا i18n)، `config/navigation.ts` (181 تسمية)، `storefront-api.ts:88-109`، `index.html:2` | High | L |
| FE-5 | **6 نسخ متطابقة من `api<T>` + 12 موضع fetch خام** مقابل عميل typed واحد ممتاز — سلوك 401/429 غير موحّد | `OrderWorkspace.tsx:50`، `ProductCatalogManager.tsx:21`، `StoreTeamManager.tsx:42`، `NotificationCenter.tsx:42`، `FinanceCenter.tsx:18`، `DeliveryRatesManager.tsx:24` | Medium | M |
| FE-6 | **فجوات a11y**: `maximum-scale=1` يحجب التكبير (WCAG 1.4.4)؛ صفر إدارة تركيز (drawers بلا focus trap/Escape)؛ `window.confirm` للحذف؛ أكواد أخطاء خام للمستخدم بلا `role="alert"` | `client/index.html:8`، `OwnerDashboard.tsx:162-166`، `ProductCatalogManager.tsx:69,103,142`، `DashboardLogin.tsx` | Medium | M |
| FE-7 | **لوحات المالك/الموظف/المالية غير مُتحقق منها موبايلياً** (كل اختباراتها 1280×900+)؛ breakpoints شبه معدومة في `SubscriptionsManager` (0) و`RegistrationCenter` (0) | `RegistrationCenter.tsx:83`، `SubscriptionsManager.tsx:66`، سكربتات `phase8b/14/15/16/17.browser-acceptance` | Medium | M |
| FE-8 | **~60–65% من 102 مسار تنقّل placeholder** بشارات مراحل قديمة مضللة ("المرحلة 2 من 10" رغم اكتمال 17/26) | `config/navigation.ts`، `OwnerDashboard.tsx:186-191`، `MerchantDashboard.tsx:135` | Medium | S |
| FE-9 | **monolith بأسطر عملاقة** (أطول سطر 4,814 حرفاً؛ router ثانٍ مخفي بـ7 ternaries في سطر واحد) + تكرار shell اللوحات الثلاث حرفياً | `StorefrontCatalogPage.tsx`، `MerchantDashboard.tsx:135`، `OwnerDashboard.tsx:129-142` | Medium | M |
| FE-10 | **بقايا قالب Manus ميتة**: `ManusDialog.tsx`، `Map.tsx`، `const.ts`، 47/54 مكوّن ui غير مستورد، ~15 حزمة Radix زائدة، سكربت analytics بـ placeholders معطوبة | `vite.config.ts:75-202,225-233`، `client/index.html:19-23` | Low | S-M |
| FE-11 | لوحة الهندسة عامة بلا حماية وتكشف التقنيات الداخلية؛ `ThemeContext.tsx:26` يقرأ localStorage بلا try/catch؛ فلتر rejected ناقص عند المالك | `App.tsx:66`، `OwnerDashboard.tsx:151-152` | Low | S |

## 3.2 الخلفية (Backend / طبقة HTTP)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| BE-1 | **monolith مسطّح**: `app.ts` بـ 515 سطراً و~90 route flat داخل `createApp()` واحدة، بلا أي `express.Router` في المشروع؛ يخلط 6 مسؤوليات (routes/كوكيز/guards/serialization/error mapping/multer) — لن يصمد أمام المراحل 19–26 | `phase1-backend/src/http/app.ts` (كاملاً؛ 196-513) | High | M |
| BE-2 | **guards تُستدعى يدوياً وقد سقطت فعلاً عن 11 route كتابة** بلا `requireTrustedWriteOrigin` (تغيير حالة الطلب، CRUD المنتجات والفئات، المخزون، الصور، الإدخال اليدوي) — دليل أن النمط اليدوي لا يتوسع | `app.ts:315,421,488,498-500,506-511` مقابل تطبيقه في 439، 471، 324 | Medium | M |
| BE-3 | **validation ad-hoc موزَّع وغير متسق**: نفس صنف الخطأ يعود أحياناً 400 وأحياناً 422 حسب الخدمة؛ zod منصّبة في `package.json` بصفر استيراد؛ `STORE_SLUG_PATTERN` مكرر حرفياً | `storefront.service.ts:20-52` (400)، `product-catalog.service.ts:13-33` (422)، `manual-provisioning.service.ts:8-13`، `registration.service.ts:14` ≡ `merchant-store.service.ts:6` | High | S→L |
| BE-4 | **تكرار helpers بنيوية**: `bearerToken` ≡ `bearerTokenFromRequest`، `resolveStore` ≡ `resolveStoreBySlug`، نوع `DbClient` معاد تعريفه 4 مرات — أي تعديل على استخراج الجلسة يجب أن يحدث في مكانين | `app.ts:33-39,110-114,124-131` ≡ `staff-permissions.ts:80-92,135-141`؛ `entitlement.service.ts:12`، `finance.service.ts:14` | Medium | S |
| BE-5 | **استعلامات مزدوجة في المسار الساخن**: `resolveStore()` يُستدعى مرتين لكل طلب سلة (3–5 استعلامات قبل أي منطق عمل) | `app.ts:237-241,253-269,118`، `identity.ts:104-111` | Medium | S |
| BE-6 | **مطابقة أخطاء بالسلاسل النصية**: `message.includes("CODIQ_EMAIL_CONFLICT")` وتمييز P2002 بأسماء جداول كـ substrings — إعادة تسمية تكسر الترجمة بصمت | `app.ts:180,184-190` | Low | S |
| BE-7 | **read models عالقة في طبقة HTTP + أنواع `any`** عند حدود الـ serialization | `app.ts:151-175,507`، `storefront.service.ts:53`، `order-lifecycle.service.ts:66,84,144` | Low | S |
| BE-8 | عمر الجلسة مكرر بين config والكوكيز (8h literal مقابل `sessionLifetimeSeconds`) | `config.ts:15` مقابل `app.ts:68,73` | Low | S |

## 3.3 قاعدة البيانات (DB / نموذج البيانات)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| DB-1 | **إجماليات التقرير المالي للتاجر تُحسب من 200 صف فقط**: `findMany({take:200})` ثم `totalsFromEntries` على نفس الصفحة — **أرقام مالية خاطئة** لأي تاجر نشط دون أي مؤشر | `finance.service.ts:126-132` | High | S |
| DB-2 | **تقرير المنصة المالي يحمّل كل قيود الفترة للذاكرة بلا حد** ويجمّع بخريطة JS؛ نفس النمط في `createSettlement` | `finance.service.ts:139-156,165-169` | High | M |
| DB-3 | **بوابة entitlement تنفّذ 5 استعلامات تجميعية دائماً** (عدّ متاجر/منتجات/موظفين/طلبات الشهر/جمع bytes الصور) حتى لفحص ميزة واحدة — **داخل ترانزاكشن checkout المتسلسلة وبعد الأقفال** | `entitlement.service.ts:62-95`، `storefront.service.ts:321→346` | High | M |
| DB-4 | **حجوزات مخزون بلا انتهاء صلاحية**: طلب COD متروك بحالة `new` يحجب التوفر إلى الأبد — خسارة مبيعات صامتة | `schema.prisma:474-495`، `storefront.service.ts:381-405` | Medium | M |
| DB-5 | **لا تنظيف لأي جدول تشغيلي**: 4 جداول sessions (revoke فقط بلا حذف)، `storefront_rate_limits` بفهرس تنظيف بلا كود حذف، سلال الضيوف المهجورة تبقى `active`، outbox المرسَل يتراكم | `identity.ts:70-78`، `migrations/20260818020000:11`، `storefront.service.ts:80-86` | Medium | M |
| DB-6 | **~20 رحلة قاعدة داخل معاملة checkout المتسلسلة** بمهلة Prisma الافتراضية (5s)؛ P2028 غير مشمول بشرط إعادة المحاولة | `storefront.service.ts:297-365,358`، `mergeGuestCartIntoCustomer:189-224` | Medium | M |
| DB-7 | **حذف المنتج الصلب يبيد سجل حركات المخزون** (`InventoryMovement onDelete: Cascade`)؛ الحارس بلا معاملة؛ P2003 غير معالج → 500 عام | `schema.prisma:305`، `product-catalog.service.ts:160-165`، `app.ts:184` | Medium | M |
| DB-8 | **فهارس مفقودة**: لا `products(store_id, created_at DESC)` رغم أنه شكل استعلام الكتالوج الرئيسي؛ فحص `publicCategories` بلا فهرس يقوده على `category_id` (قد ينحدر لمسح الجدول العالمي متعدد المستأجرين) | `product-catalog.service.ts:95`، `storefront.service.ts:109-115,128` مقابل `migrations/20260816211500:14`، `20260817093000:40-42` | Medium | S |
| DB-9 | **انحراف `schema.prisma` عن فهارس DB الفعلية** (الفهارس الجزئية غير ممثلة) — أي `prisma migrate dev` مستقبلي سيولّد diff مدمّراً | `9a:12-13,51-52,122`، `phase16:52` غائبة عن `schema.prisma:492` | Medium | M |
| DB-10 | **لا قيد يمنع تسوية نفس الفترة مرتين** على جدول append-only لا يقبل التصحيح | `finance.service.ts:158-184`، `schema.prisma:623-640` | Medium | M |
| DB-11 | ترقيم `listProducts` بلا tiebreaker (`id`) + استعلام تحقق زائد للـ cursor؛ نمطا ترقيم متعارضان (cursor هش مقابل keyset متين) | `product-catalog.service.ts:93-95` مقابل `order-lifecycle.service.ts:42-58` | Medium/Low | S |

## 3.4 طبقة API

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| API-1 | **endpoints قديمة بلا ترقيم تُرجع كل صفوف المتجر** (`sendOrdersForStore` يسلسل **كل** الطلبات) رغم وجود بدائل مرقّمة — نقطة DoS ذاتية | `app.ts:155-158,166-169` مربوطة في `484,490,492` | High | S |
| API-2 | أكواد حالة غير متسقة للخطأ نفسه (400/422) ورسائل خليط عربي/إنجليزي بلا نظام — سيصطدم بـ i18n مرحلة 24 (انظر BE-3) | `storefront.service.ts:20-52` مقابل `product-catalog.service.ts:13-33` | High | S→L |
| API-3 | أي مسار `/api/*` مجهول يسقط إلى SPA `index.html` بـ 200 بدل 404 JSON؛ `/health` يكشف `NODE_ENV` | `server/index.ts:44-46`، `app.ts:198` | Low | S |
| API-4 | **فجوات تغطية اختبارية على مسارات مالية**: `PATCH/DELETE cart/items/:itemId` صفر اختبار (بما فيه فرض `cartVersion`)؛ logout الزبون مغطى فقط بملف يتيم خارج CI | `app.ts:253,261,292`، `phase9b.cookie-session.acceptance.mjs` (غير مربوط) | Medium | M |

## 3.5 المصادقة (Auth)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| AU-1 | **[الأخطر في التقرير] endpoint تسجيل مالك المنصة مفتوح للعموم**: `POST /auth/platform/register` بلا مصادقة ولا bootstrap token ولا فحص وجود owner ولا rate limit — أي مجهول ينشئ حساب `platform_owner` كامل الصلاحيات (كل التجار، الخطط، العمولات، التسويات) | `app.ts:201`، `auth.service.ts:7-20`، `server/index.ts:32` | **Critical** | S |
| AU-2 | **التاجر المعطَّل/المرفوض والمتجر المعطَّل يبقيان يعملان**: `resolveStore` بلا فلتر `isActive`؛ واجهة متجر أوقفته المنصة تبقى عامة بالكامل حتى الـ checkout | `app.ts:110-114,124-131`، `identity.ts:104-113` مقابل `registration.service.ts:83-86`، `auth.service.ts:61,98` | High | S-M |
| AU-3 | **صفر rate limiting على مسارات دخول الإدارة** (platform/merchant/staff login+register) — brute force حر على أعلى الحسابات امتيازاً، مضاعف بـ bcryptjs على الـ main thread (CPU-DoS) | `app.ts:201-217` مقابل التغطية الجزئية في `app.ts:248-308,398` | High | S |
| AU-4 | **غياب دورة حياة الحساب كاملة**: لا password reset (النسيان = قفل نهائي)، لا تغيير كلمة سر، لا email/phone verification (هوية الزبون `phoneNormalized` بلا توثيق → انتحال)، لا 2FA حتى لمالك المنصة | `app.ts` (515 سطراً، لا مسار reset/verify/otp)، `auth.service.ts:90-100` | High | L |
| AU-5 | **لا logout لغير الزبون** ولا إبطال للجلسة القديمة عند login/switch — سرقة كوكي = نافذة 8 ساعات غير قابلة للإغلاق رغم أن البنية تدعم الإبطال | `app.ts:292-298` (الوحيد)، `app.ts:405-420` | Medium | S-M |
| AU-6 | **bcryptjs (JS خالص) بكلفة 12 على الـ event loop** — مئات المللي ثانية CPU لكل login | `identity.ts:1,39-48`، `package.json` | Medium | S |
| AU-7 | كوكي واحد لثلاث هويات بلا `__Host-`؛ تسريب صحة بيانات الدخول (404 مميز بعد نجاح كلمة السر + enumeration زمني)؛ صلاحية **عرض** تحرس إنشاء زبون (`customers.view` على POST) | `app.ts:62-70,421-424`، `auth.service.ts:41-64,97-105` | Low | S |
| AU-8 | لا حد أدنى لطول `SESSION_JWT_SECRET` ولا آلية تدوير (HS256 بسر واحد بلا `kid`) | `config.ts:5-13`، `identity.ts:64-67` | Low | S |

## 3.6 تعدد المستأجرين (Tenancy)

**الحكم العام: هذه أقوى طبقة في النظام** (انظر 2.1) — عيّنة الـ 11 مساراً كلها سليمة. الاستثناءات السلوكية الوحيدة:

| # | النتيجة | الدليل | الخطورة |
|---|---|---|---|
| TN-1 | متجر عطّلته المنصة يبقى يخدم الجمهور (= AU-2؛ خرق سياسة العزل التشغيلي لا عزل البيانات) | `app.ts:110-114` | High |
| TN-2 | `storefront_rate_limits` بلا عمود `store_id` بنيوي (الـ slug مدفون داخل sha256): لا تدقيق per-store، وتغيير slug يصفّر الحدود | `schema.prisma:642-652`، `app.ts:96` | Medium |
| TN-3 | فحص `publicCategories` قد يمسح جدول products **العالمي** متعدد المستأجرين (تدهور متجر يتبع حجم المنصة كلها لا حجمه) | `storefront.service.ts:109-115` (= DB-8) | Medium |

## 3.7 التخزين (Storage / الصور وS3)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| ST-1 | **`new S3Client` لكل عملية صورة** + تقديم الصور العامة بالكامل عبر ذاكرة Express **بلا `Cache-Control`** — كل صفحة storefront بـ N منتجات = N تمريرات (Express→S3) بعميل جديد؛ أول عنق زجاجة CPU/ذاكرة عند 10x | `product-image-storage.service.ts:27-29,53,57-62`، `app.ts:230-236,512` | Medium | S |
| ST-2 | **مسار الصور العامة بلا rate limit وبلا كاش** — تضخيم كلفة (bandwidth+memory+DB+S3 egress) قابل للاستغلال من مجهولين | `app.ts:230-236` | Medium | M |
| ST-3 | **multer memoryStorage 8×5MB لكل طلب بلا حد تكرار** — رفع متوازٍ من staff مخترق/مسيء = ضغط ذاكرة يسقط العملية (فحص magic bytes سليم لكنه لا يمنع DoS) | `app.ts:23-27,511` | Medium | M |
| ST-4 | **رفع الصور بلا ترانزاكشن**: فشل الملف الثالث يترك ملفين ملتزمين + object يتيم في S3؛ فحص حد الخطة خارج الترانزاكشن (سباق) | `product-catalog.service.ts:167-182` | Low | M |
| ST-5 | أسرار S3 تُفحص وقت الطلب لا وقت الإقلاع — نشر بإعداد خاطئ "ينجح" ويُكتشف عند أول رفع (503) | `product-image-storage.service.ts:16-25` | Medium | S |

## 3.8 المهام الخلفية (Jobs / Worker)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| JB-1 | **العامل child process بلا respawn**: موته = توقف صامت لكل إشعارات المنصة حتى النشر التالي؛ غياب `dist/worker.js` يعود بصمت تام | `server/index.ts:15-25,18,20`، `docs/history/reports/RAILWAY_ACCESS_FINDINGS.md:49` | High | M |
| JB-2 | **صفوف `processing` لا تُستعاد أبداً بعد موت العامل أثناء دفعة**: `CLAIMABLE_STATUSES` لا تشمل `processing` ولا يوجد sweep على `claimedAt`؛ كل نشر (وstaging تنشر عند كل دمج) قد يحرق حتى 20 إشعاراً نهائياً | `outbox-worker.ts:14`، `worker-entry.ts:15-20`، `server/index.ts:23` | High | S |
| JB-3 | **حالة `skipped` نهائية غير قابلة للاسترجاع** عند غياب مزود SMTP — كل إشعار وُلد قبل ضبط SMTP محروق للأبد | `outbox-worker.ts:80` | Medium | S |
| JB-4 | **لا يوجد أي job تنظيف/صيانة** (sessions، rate-limits، سلال منتهية، outbox مرسَل، حجوزات راكدة) رغم أن بنية العامل الموجودة تصلح لاستضافته | = DB-4، DB-5 | Medium | M |

## 3.9 الإعدادات (Config)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| CF-1 | **تشظّي config**: `config.ts` يغطي 4 قيم فقط؛ `PRODUCT_S3_*` تُقرأ **عند كل طلب**، `NODE_ENV` مكررة 6 مرات في `app.ts`، `CODIQ_SMTP_*` وnotifications مبعثرة | `config.ts` (16 سطراً)، `product-image-storage.service.ts:17-24`، `notification-provider.ts:43-55`، `app.ts:66-296` | Medium | S |
| CF-2 | **تحقق البيئة عند الإقلاع جزئي**: إلزامي واحد فقط (`SESSION_JWT_SECRET`)؛ `PORT` و`CODIQ_NOTIFICATIONS_INTERVAL_MS` بـ `Number()` بلا فحص NaN؛ zod متاحة وغير مستخدمة | `config.ts:5-16`، `server/index.ts:48`، `worker-entry.ts:13` | Medium | S |
| CF-3 | **متغيرات `CODIQ_SMTP_*` غائبة عن توثيق البيئات** في `docs/DEPLOYMENT.md:34` رغم أنها شرط عمل الإشعارات | `notification-provider.ts:44-52` | Medium | S |
| CF-4 | **سكربتات POSIX-only تكسر Windows** (بيئة التطوير الفعلية): `NODE_ENV=production node ...` و`sh -c` بلا cross-env | `package.json:10,15` | Medium | S |

## 3.10 البنية التحتية والتشغيل (Infra / Ops / CI)

| # | النتيجة | الدليل | الخطورة | الجهد |
|---|---|---|---|---|
| IN-1 | **[Critical] `trust proxy` غير مفعّل خلف Railway proxy**: `request.ip` = عنوان الـ proxy لكل الزوار → حدود الـ IP دلو عالمي واحد: 6 محاولات تسجيل تاجر تقفل التسجيل **للمنصة كلها** 10 دقائق؛ عطل توافرية عند أول حمل حقيقي | لا `app.set("trust proxy")` في المستودع؛ الاستخدامات `app.ts:248,258,266,273,284,398` | **Critical** | S |
| IN-2 | **فحص الصحة liveness فقط**: لا DB ولا S3 ولا heartbeat للعامل — نشر بقاعدة مكسورة "ينجح" ويُعلن Online | `app.ts:198`، `docs/DEPLOYMENT.md:38`، `ci.yml:124-135` | High | S |
| IN-3 | **غياب observability كامل**: 5 استدعاءات `console.*` في كل الـ backend، لا request_id، لا access log، لا error tracking، لا metrics — استحالة الإجابة على "أي متجر تأثر؟" | `app.ts:192`، `outbox-worker.ts:125`، `package.json` (لا pino/Sentry) | High | M |
| IN-4 | **بروفة الاستعادة لم تُنفَّذ قط** (B-05 مستهدف المرحلة 11، ما زال 📋): PITR غير مختبر، لا RTO/RPO معروفان — **خطر وجودي** لدفتر طلبات وتسويات COD | `docs/BACKLOG.md:38-41`؛ لا `RESTORE_DRILL_LOG.md` في المستودع | High | S |
| IN-5 | **لا graceful shutdown في الخادم الإنتاجي**: SIGTERM → قتل العامل ثم `process.exit(0)` فوراً — كل نشر يقطع طلبات جارية (بينها checkout) | `server/index.ts:21-24` مقابل `phase1-backend/src/index.ts:9-12` | Medium | S |
| IN-6 | **هجرات الإنتاج يدوية بلا runbook** وإعدادات حرجة (start command، healthcheck، pre-deploy) تعيش في لوحة Railway فقط — لا config-as-code؛ fallback الهجرة قد ينحدر لاتصال pooled (خطر تعليق DDL) | `docs/DEPLOYMENT.md:72-78`، `package.json:15`، `RAILWAY_ACCESS_FINDINGS.md:43,49` | Medium | M |
| IN-7 | `startServer().catch(console.error)` يبتلع أخطاء الإقلاع بخروج نظيف (كود 0)؛ لا `uncaughtException`/`unhandledRejection`؛ لا مستمع `error` على الـ child | `server/index.ts:19,64` | Low | S |
| IN-8 | توبولوجيا نسخة واحدة (ويب+عامل في حاوية واحدة) بلا ADR يوثق القبول وعتبات الخروج — علماً أن الكود جاهز للتوسع الأفقي (DB rate limiting، جلسات stateless، claim tokens) | `server/index.ts:33`، `storefront.service.ts:60-75` | Low | S |
| CI-1 | **اختبارات المتصفح غير حاجبة منذ المرحلة 11** (`continue-on-error: true`): واجهات 5 مراحل كاملة بلا حماية انحدار ملزمة؛ السبب الجذري B-15 لم يُعزل | `ci.yml:138-141`، `docs/BACKLOG.md:77-79` | High | M |
| CI-2 | **vitest غير موصول نهائياً**: 5 ملفات اختبار ميتة، بينها **فخ**: `neon-connection.test.ts:27-40` يكتب فعلياً في أي قاعدة يشير إليها `CODIQ_POSTGRES_URL` دون حارس أمان — الوصل الساذج قد يكتب في الإنتاج | `vitest.backend.config.ts:1-8`، `package.json:6-38`، `ci.yml` | High | S |
| CI-3 | **صفر اختبارات client (React)** قبل أثقل refactoring واجهات (مرحلتا 21–22) | `client/` (جرد كامل) | High | L |
| CI-4 | قوائم TRUNCATE منسوخة يدوياً في ~15 ملفاً ومتباعدة فعلياً (schema-drift في العزل) | `phase15...:39` مقابل `phase16...:36`، `phase1.integration.ts:20` | Medium | S |
| CI-5 | وظيفة المتصفح تعيد بناء التطبيق 7 مرات؛ لقطات الفشل لا تُرفع artifacts (تشخيص B-15 شبه مستحيل)؛ لا coverage في أي طبقة؛ لا lint | `ci.yml:161,200-236,242-248`، `package.json:25-38` | Medium | S-M |
| CI-6 | حارس قاعدة الاختبار متساهل (marker `/development\|test\|phase/i` على كامل الـ URL + host مُرمَّز)؛ ملف ناتج قديم ملتزم في git | `test-database-guard.ts:1-2,30-33`، `tests/latest-test-output.json` | Low | S |

---

# 4) مخاطر التوسع — ماذا ينكسر عند 10x (تجار/زوار/ميزات)

## 4.1 ينكسر فوراً عند أول حمل حقيقي (قبل حتى 2x)

1. **قفل التسجيل والدخول للجميع (IN-1):** بدون `trust proxy` كل الزوار يتشاركون مفتاح rate limit واحداً — 6 تسجيلات تجار أو 8 تسجيلات زبائن خلال 10 دقائق من *أي* زوار تقفل المسار عن المنصة كلها (`app.ts:248-398`).
2. **أرقام مالية خاطئة (DB-1):** أي تاجر يتجاوز 200 قيد في الفترة (~7 طلبات مكتملة يومياً في شهر) يرى إجماليات مغلوطة بلا تحذير (`finance.service.ts:126-132`).
3. **الباب المفتوح (AU-1):** لا يحتاج توسعاً أصلاً — مفتوح اليوم (`app.ts:201`).

## 4.2 ينكسر مع نمو الحركة (10x زوار)

4. **مسار checkout الساخن (DB-3 + DB-6):** 5 استعلامات entitlement تجميعية + ~20 رحلة Neon داخل معاملة Serializable ممسكة بأقفال، وعدّ طلبات الشهر يكبر خطياً مع نجاح المتاجر → تصادمات تسلسل متزايدة، انتهاء مهلة 5s، وفشل P2028 غير المشمول بإعادة المحاولة (`entitlement.service.ts:62-95`، `storefront.service.ts:297-365`).
5. **خط الصور (ST-1/2/3):** `new S3Client` لكل صورة + تمرير bytes عبر ذاكرة Express بلا كاش × N منتجات × 10x متاجر = أول عنق زجاجة CPU/ذاكرة موثّق، ومسار عام قابل للاستغلال كتضخيم كلفة (`product-image-storage.service.ts:27-62`، `app.ts:230-236`).
6. **endpoints بلا ترقيم (API-1):** متجر بـ 50 ألف طلب = تسلسل 50 ألف صف JSON في طلب لوحة منصة واحد (`app.ts:155-169`).
7. **bcryptjs على الـ event loop (AU-6 + AU-3):** بلا rate limit على دخول الإدارة، كل محاولة تكلف مئات المللي ثانية CPU — أرخص مسار لشل الخادم.
8. **نمو جداول بلا حدود (DB-5 + TN-2):** صف rate-limit لكل (scope, IP)، صف جلسة لكل login، سلال ضيوف هاجعة، outbox مرسَل — تضخم تخزين Neon وفهارس بلا أي تنظيف.
9. **حجب مخزون تراكمي (DB-4):** حجوزات COD المهجورة تُنقص التوفر المعروض إلى الأبد — "غير متوفر" بينما المخزون موجود.
10. **استعلام التصنيفات العام (TN-3):** يتدهور بحجم جدول products **العالمي** لا بحجم المتجر — متجر صغير يدفع ثمن نمو المنصة كلها (`storefront.service.ts:109-115`).

## 4.3 ينكسر مع نمو الميزات (المراحل 19–26)

11. **`app.ts` المسطّح (BE-1 + BE-2):** عند إضافة auth lifecycle + payments + webhooks سيتجاوز 1,200 سطر؛ ومع النمط اليدوي للـ guards (الذي أسقط 11 route فعلاً) يصبح نسيان guard على endpoint حساس شبه مؤكد. **يجب سداده قبل بدء المرحلة 19.**
12. **الواجهة محجوبة عن المرحلتين 21–22 (FE-3 + FE-4):** 1,095 لوناً صلباً بلا palette داكنة تجعل الوضع الليلي مستحيلاً بدون تمرير شامل، و~1,275 نصاً عربياً بلا مكتبة i18n تجعل الثلاثية ar/en/ckb (مع تبديل rtl/ltr) غير قابلة للتنفيذ؛ تكرار shell اللوحات الثلاث يعني تطبيق كل ذلك 3 مرات (FE-9).
13. **شبكة أمان الاختبار أرقّ من الخطة (CI-1/2/3):** بوابة المتصفح لا تعضّ منذ المرحلة 11، صفر اختبارات client قبل أثقل refactoring، وأنماط TRUNCATE/المنافذ الثابتة ستنهار مع موجة جداول المراحل 19–25. المراحل 20 (contract/load) و23 (10k تاجر) تفترض بنية غير موجودة.
14. **الإشعارات نقطة فشل صامتة (JB-1 + JB-2 + IN-3):** worker بلا respawn وصفوف `processing` تُحرق مع كل نشر، وبلا observability لن يلاحظ أحد — عند دخول payments (مرحلة 25) يتحول هذا من إزعاج إلى فقدان أموال غير قابل للتدقيق.
15. **الاستعادة غير المثبتة (IN-4):** مع 10x تجار تصبح قاعدة البيانات دفتر أموال عشرات الأعمال — PITR غير مختبر خطر وجودي يتضاعف مع كل تاجر جديد.

## 4.4 ما لا ينكسر (مصمم صحيحاً للتوسع)

- **عزل المستأجرين** بالمفاتيح المركّبة يتوسع بلا تعديل.
- **outbox/ledger/claim-tokens** تدعم تعدد العمال والتوسع الأفقي أصلاً.
- **الجلسات وrate limiting معتمدة على القاعدة** لا على ذاكرة العملية — replicas ≥ 2 ممكنة كودياً متى أُريدت (بعد IN-2).
- **keyset pagination** للطلبات مع فهارسه صحيح لأي حجم.

---

# 5) خلاصة تنفيذية للمالك

## 5.1 الحكم العام

**الأساس المعماري لـ CODIQ سليم وفوق متوسط المشاريع في هذا العمر** — عزل المستأجرين مبني في بنية قاعدة البيانات نفسها، والسلامة الترانزاكشنية للطلبات والمال ناضجة فعلاً (Serializable + idempotency + append-only ledger)، وطبقة الخدمات نظيفة لا تحتاج إعادة هيكلة. **المشكلة ليست في صحة ما بُني، بل في قابليته للنمو وفي غياب الطبقة التشغيلية حوله.**

## 5.2 خطران حرجان يجب إغلاقهما فوراً (كلاهما جهد ساعات)

1. **باب مفتوح للاختراق الكامل:** أي مجهول على الإنترنت يستطيع اليوم إنشاء حساب مالك منصة كامل الصلاحيات عبر `POST /api/auth/platform/register` (`app.ts:201`) — يتحكم بكل التجار والخطط والعمولات والتسويات. الإغلاق سطر حماية واحد.
2. **قفل ذاتي للمنصة عند أول حمل:** غياب `trust proxy` خلف Railway يجعل كل الزوار يتشاركون حد سرعة واحداً — 6 محاولات تسجيل خلال 10 دقائق تقفل تسجيل التجار للمنصة كلها.

## 5.3 حزم المعالجة بالترتيب

| الحزمة | المحتوى | التوقيت |
|---|---|---|
| **فورية (كلها S)** | AU-1 (قفل التسجيل) + IN-1 (trust proxy) + IN-2 (فحص صحة حقيقي) + JB-2 (استعادة صفوف processing) + IN-4 (بروفة استعادة Neon) + DB-1 (تصحيح الإجماليات المالية) | هذا الأسبوع، قبل أي شيء آخر |
| **قبل بدء المرحلة 19** | BE-1+BE-2 (تقسيم app.ts + guards كـ middleware بنيوية) + AU-2 (فحص isActive) + AU-3 (rate limit على دخول الإدارة) + CI-2 (وصل vitest مع عزل الـ probes الخطرة) + helmet | الدين المعماري الوحيد الجوهري — سداده الآن أرخص 10 مرات من بعد إضافة auth lifecycle |
| **قبل بدء المرحلة 21** | CI-1 (إغلاق B-15 وترقية بوابة المتصفح إلى حاجبة) + FE-1 (الصور المكسورة) + FE-2 (code splitting) + بدء FE-3/FE-4 (توكنز + i18n من طبقة navigation ورسائل الأخطاء) | بوابة جودة 21–22 بلا CI حاجب حبر على ورق |
| **متوسطة المدى** | IN-3 (observability) + JB-1 (supervision للعامل) + AU-4 (password reset/2FA) + DB-3/DB-6 (تخفيف مسار checkout) + ST-1/2 (كاش الصور) + دورة تنظيف البيانات (DB-4/DB-5) | قبل دخول payments (مرحلة 25) إلزامياً |

## 5.4 ثلاث قواعد للمراحل القادمة

1. **لا تلمسوا الركائز:** نموذج العزل، الترانزاكشنات، الـ outbox، والـ ledger — تُمدَّد ولا تُعاد كتابتها.
2. **البنيوي يغلب التذكُّري:** كل ضعف جوهري وُجد (guards منسية، TRUNCATE متباعدة، config مبعثر، ألوان صلبة) سببه نمط يدوي يُنسخ — الحل دائماً تحويل القاعدة إلى بنية (middleware، helper واحد، schema واحد) لا إلى تعليمات.
3. **لا ميزة جديدة فوق فجوة تشغيلية:** payments وwebhooks فوق نظام بلا observability ولا worker supervision ولا استعادة مثبتة = مخاطرة مالية غير قابلة للتدقيق.

## 5.5 الأرقام النهائية

- **نتيجتان Critical** (AU-1 أمنية، IN-1 تشغيلية) — كلاهما يُغلق بجهد S.
- **~22 نتيجة High** موزعة: 4 أمنية، 4 بيانات/مالية، 5 تشغيلية، 3 اختبارات، 4 واجهة، 2 خلفية.
- **صفر Critical في نموذج البيانات أو منطق الأعمال** — التصميم المالي والعزل سليمان.
- كل النتائج قابلة للسد **بدون أي إعادة كتابة رجعية** — بالترتيب المقترح أعلاه.

---

*انتهى التقرير — المرحلة 18، المخرج 1 من 2. المرجع التفصيلي: التقارير المجالية الستة (backend-arch، security، data-perf، frontend، testing-ci، ops) المؤرشفة ضمن مخرجات المرحلة.*

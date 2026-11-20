# HANDOFF REPORT — مشروع CODIQ

**الغرض:** تسليم حالة تقنية قابلة للمراجعة لمهندس خارجي من دون الحاجة إلى الوصول للمستودع.
**تاريخ الإعداد:** 19 أغسطس 2026.
**منهج التقرير:** هذا التقرير يقتصر على الكود والـmigrations والتقارير ونتائج Git المتاحة في مساحة العمل عند إعداده. لا يعرض أي كلمة مرور أو مفتاح أو قيمة سرية. أي بند لم يمكن التحقق منه وسم بوضوح بأنه **غير متحقق** أو **غير مكتمل**.

> **تنبيه حالة:** توجد تغييرات غير ملتزمة تخص PHASE 9B وإصلاح Cookie Path محدود. لذلك لا يساوي هذا التقرير "main نظيف" أو "PHASE 9 مكتملة". رأس GitHub `main` تم التحقق منه عن بعد عند `92bccfcad3b3fe46bfc64720c4fbb3c229d4ee28`، بينما شجرة العمل المحلية غير نظيفة. المصدر: فحص Git للـhandoff في 19 أغسطس 2026.

## 1. خطة المراحل وحالتها

لم يُعثر في المستودع أو التقارير على **خطة موثقة ذات 16 مرحلة بأسماء ونطاقات للمراحل 10–16**. الموثق فعلياً هو المراحل 1–9، مع 8A/8B و9A/9B كتقسيمات فرعية. لذلك لا يصح اختلاق أسماء أو نطاقات للمراحل 10–16.

| الرقم | الاسم/النطاق المثبت | الحالة الفعلية | المصدر |
|---:|---|---|---|
| 1 | تأسيس الهوية المنفصلة للمالك والتاجر والعميل، مع قيود PostgreSQL وعزل أولي. | معتمدة ومثبتة. | `PHASE1_REPORT.md`، migration `20260816193500_phase1_identity_foundation`. |
| 2 | هيكل تنقل لوحة مالك المنصة وهوية One UI، بلا منطق أعمال تشغيلي. | معتمدة ومثبتة. | `PHASE2_REPORT.md`. |
| 3 | هيكل لوحة التاجر وStore Switcher ومسارات المتجر. | معتمدة ومثبتة. | `PHASE3_REPORT.md`. |
| 4 | بوابة اختبار فصل المسارات والهويات وإصلاح مسار لوحة المتجر. | معتمدة ومثبتة. | `PHASE4_GATE_REPORT.md` و`PHASE4_GATE_RETEST_REPORT.md`. |
| 5 | Multi-tenancy فعلي ببيانات منتجات وطلبات واختبارات IDOR للتاجر/المالك. | معتمدة ومثبتة. | `PHASE5_TENANCY_REPORT.md`. |
| 6 | إضافة تاجر يدوياً من المالك وإضافة عميل يدوياً من التاجر. | معتمدة ومثبتة. | `PHASE6_MANUAL_PROVISIONING_REPORT.md`. |
| 7 | إدارة المنتجات والتصنيفات والمخزون وصور S3-compatible في لوحة التاجر. | معتمدة ومثبتة. | `PHASE7_PRODUCT_MANAGEMENT_REPORT.md`; commit `c7344ca`. |
| 8A | مخطط دورة حياة الطلبات، State Machine، audit events، API، عزل وتزامن. | معتمدة ومختبرة. | `PHASE8A_REPORT.md`; commit `78e3848`. |
| 8B | واجهات أوامر التاجر والمالك واختبارات قبول المتصفح. | معتمدة ومختبرة. | `PHASE8B_REPORT.md`; commit `f38d43e`. |
| 9A | Backend Storefront: العميل والسلات والدمج وCOD checkout والحجز وrate limit. | معتمدة ومختبرة وموجودة على GitHub `main`. | `PHASE9A_REPORT.md`; commits `56ac48f` و`92bccfc`. |
| 9B | واجهة Storefront وحساب العميل واختبارات المتصفح UI-01–UI-07. | **قيد التنفيذ وغير معتمدة.** صفحات أولية وتغيير Cookie Path موجودان محلياً فقط؛ اختبار البيئة فشل قبل تنفيذ السيناريو. | شجرة Git الحالية، `PHASE9B_COOKIE_PATH_BLOCKER.md`، `PHASE9B_COOKIE_PATH_FIX_REPORT.md`. |
| 10 | غير موثق في الكود أو التقارير المتاحة. | لم تبدأ / غير متحقق. | لا يوجد مصدر مثبت. |
| 11 | غير موثق في الكود أو التقارير المتاحة. | لم تبدأ / غير متحقق. | لا يوجد مصدر مثبت. |
| 12 | غير موثق في الكود أو التقارير المتاحة. | لم تبدأ / غير متحقق. | لا يوجد مصدر مثبت. |
| 13 | غير موثق في الكود أو التقارير المتاحة. | لم تبدأ / غير متحقق. | لا يوجد مصدر مثبت. |
| 14 | غير موثق في الكود أو التقارير المتاحة. | لم تبدأ / غير متحقق. | لا يوجد مصدر مثبت. |
| 15 | غير موثق في الكود أو التقارير المتاحة. | لم تبدأ / غير متحقق. | لا يوجد مصدر مثبت. |
| 16 | غير موثق في الكود أو التقارير المتاحة. | لم تبدأ / غير متحقق. | لا يوجد مصدر مثبت. |

## 2. ملخص تفصيلي للمراحل 8A و8B و9

### 2.1 المرحلة 8A — دورة حياة الطلبات والـAPI

**النطاق المنفذ والمختبَر:** أضيفت دورة حالة للطلبات (`new`, `processing`, `preparation`, `out_for_delivery`, `completed`, `cancelled`, `rejected`, `returned`) داخل معاملة PostgreSQL واحدة مع `expectedVersion` وحدث append-only. لا تعدل هذه الخدمة المجردة مخزون طلبات المراحل السابقة. المصدر: `PHASE8A_REPORT.md` §§1–4، و`phase1-backend/src/services/order-lifecycle.service.ts`.

| نوع التغيير | التفاصيل الفعلية | المصدر |
|---|---|---|
| migration | `20260817201500_order_lifecycle_8a`. | `prisma/migrations/20260817201500_order_lifecycle_8a/migration.sql`. |
| `store_orders` | `customer_id` اختياري، حقول مستلم/عنوان/مبالغ/دفع/مصدر، `version`، `status_updated_at`، `updated_by_kind` وفهارس قوائم. | `prisma/schema.prisma:256–295`; `PHASE8A_REPORT.md` §3. |
| `order_items` | إضافة `sku` snapshot اختياري. | `prisma/schema.prisma:298–314`. |
| `order_status_events` | جدول سجل حالة منفصل: `store_id`, `order_id`, from/to status، actor، note، الوقت. | `prisma/schema.prisma:316–331`. |
| Triggers | `order_status_events_guard_store` لمنع store مخالف و`order_status_events_immutable` لمنع update/delete. | migration 8A؛ `PHASE8A_REPORT.md` §3. |

**مسارات API الجديدة/الموسعة وتفويضها:**

| المسار الداخلي في `createApp()` | التفويض | نتيجة العزل المثبتة |
|---|---|---|
| `GET /merchant/stores/:storeSlug/orders` | جلسة merchant وتطابق merchant/store. | قائمة cursor مقيدة بالمتجر. |
| `GET /merchant/stores/:storeSlug/orders/:orderId` | merchant/store. | `404 RESOURCE_NOT_FOUND` لمعّرف طلب متجر آخر. |
| `POST /merchant/stores/:storeSlug/orders/:orderId/status` | merchant/store مع `expectedVersion`. | `409 ORDER_VERSION_CONFLICT` للنسخة القديمة؛ `422 INVALID_ORDER_TRANSITION` للانتقال غير المسموح. |
| `GET /merchant/stores/:storeSlug/orders/:orderId/history` | merchant/store. | تاريخ مقيد بالمتجر. |
| `GET /platform/orders` | Platform Owner فقط، قراءة عالمية. | لا يوجد مسار Owner لتغيير الحالة. |
| `GET /platform/orders/:orderId` و`/history` | Platform Owner فقط، قراءة عالمية. | قراءة عالمية مصرح بها. |

المسارات أعلاه تصبح فعلياً تحت `/api/...` عندما يشغّل الخادم الموحد `server/index.ts` التطبيق عبر `app.use("/api", createCodiqApi())`. المصدر: `phase1-backend/src/http/app.ts:312–322` و`server/index.ts:10–28`.

**الواجهة:** لا توجد واجهة جديدة في 8A؛ هذا مقصود. المصدر: `PHASE8A_REPORT.md:3–5,110–114`.

**الاختبارات المنفذة والنتائج الموثقة:** `phase1-backend/tests/phase8a.order-lifecycle.integration.mjs` نجح. شمل: `processing → new` مرفوضاً بـ`422`، `out_for_delivery → cancelled` مرفوضاً بـ`422`، طلبين متزامنين (`200` و`409`)، تاجر B لطلب A (`404`)، Customer token لمسار تاجر (`403 IDENTITY_BOUNDARY_DENIED`)، وTriggers الأحداث (`SQLSTATE 23514`). كما لم تتغير كمية مخزون legacy (`7 → 7`) أو الحركات. المصدر: `PHASE8A_REPORT.md` §5.

**Commit:** `78e3848 feat(phase8a): add order lifecycle and audit trail`. المصدر: `git log` الحالي و`PHASE8A_REPORT.md`.

### 2.2 المرحلة 8B — واجهات أوامر التاجر والمالك

**النطاق المنفذ والمختبَر:** ربط واجهات RTL/One UI مع API 8A فقط. التاجر يقرأ القوائم والتفاصيل والسجل وينفذ الانتقالات التي يسمح بها الخادم؛ المالك يملك واجهة قراءة عالمية بلا أزرار تغيير حالة. المصدر: `PHASE8B_REPORT.md` §§1–3، و`client/src/components/OrderWorkspace.tsx`.

| صفحات/مسارات الواجهة | السلوك | المصدر |
|---|---|---|
| `/merchant/stores/{storeSlug}/dashboard/orders` ومسارات الحالات | قائمة مرشحة، بحث، cursor، تفاصيل وإجراءات حالة مقيدة بالمتجر. | `PHASE8B_REPORT.md:22–29`; `client/src/App.tsx:20–27`. |
| `/merchant/stores/{storeSlug}/dashboard/orders/{orderId}` | تفاصيل وسجل وأزرار انتقال مسموحة فقط. | `PHASE8B_REPORT.md:24–25`. |
| `/platform/dashboard/orders` ومسارات حالات القراءة | إشراف عالمي مع مرشحات store/merchant/search/date. | `PHASE8B_REPORT.md:26–29`; `client/src/App.tsx:28–31`. |
| `/platform/dashboard/orders/{orderId}` و`/history` | تفاصيل وتاريخ قراءة فقط. | `PHASE8B_REPORT.md:26–27`. |

**قاعدة البيانات وAPI:** لم تضف 8B migration أو Prisma schema أو API business route جديداً؛ استخدمت مسارات 8A. المصدر: `PHASE8B_REPORT.md:7–10`.

**اختبارات القبول المنفذة:** `phase1-backend/tests/phase8b.browser-acceptance.mjs` مرر M-01–M-22 للتاجر، O-01–O-07 للمالك، وU-01–U-04 للوصول/الهاتف. من الأمثلة السلبية الموثقة: إخفاء `processing → new` و`out_for_delivery → cancelled` ثم رفض API بـ`422`، معرف متجر خاطئ أو طلب متجر أخر بـ`404`، Customer token لمسار تاجر بـ`403 IDENTITY_BOUNDARY_DENIED`، ونسخة منافسة بـ`409` مع إعادة القراءة. المصدر: `PHASE8B_REPORT.md` §§4–7.

**Regression الموثق:** `pnpm check`, `pnpm phase1:typecheck`, `pnpm build`, `pnpm phase8b:browser`, واختبارات 1 و5 و6 و7 و8A جميعها نجحت في وقت تقرير 8B. المصدر: `PHASE8B_REPORT.md:78–92`.

**Commit:** `f38d43e feat(phase8b): add order management interfaces`. المصدر: `git log` الحالي.

### 2.3 المرحلة 9A — Backend Storefront

**النطاق المنفذ والمختبَر:** هوية Customer بالهاتف/كلمة المرور، سلة موحدة guest/customer، merge Serializable، عناوين، checkout COD، Idempotency، reservations، rate limiting، وعزل DB/API. المصدر: `PHASE9A_REPORT.md:3–21` و`phase1-backend/src/services/storefront.service.ts`.

| migration | الأثر | المصدر |
|---|---|---|
| `20260818011500_storefront_customer_carts_reservations_9a` | توسعة `customers`، `shopping_carts`, `cart_items`, `customer_addresses`, `checkout_requests`, `inventory_reservations` والقيود المركبة/الفهارس. | migration؛ `PHASE9A_REPORT.md:23–30`. |
| `20260818020000_storefront_rate_limits_9a` | `storefront_rate_limits` وحدّ معدل ذري مخزن في PostgreSQL. | migration؛ `PHASE9A_REPORT.md:23–30`. |

**تأثيرات أساسية مثبتة:** cart token الخام لا يخزن في DB (SHA-256 فقط)، checkout يستخدم Serializable و`FOR UPDATE` لصفوف المنتجات، الحجز لا ينقص `stock_quantity` عند checkout، والخصم يحدث عند `completed` فقط لطلب `source='storefront'`. `completed → returned` يسجل `pending_inspection` ولا يعيد مخزوناً تلقائياً. المصدر: `phase1-backend/src/services/storefront.service.ts:245–340`; `PHASE9A_REPORT.md:13–21,48–62`.

**مسارات 9A:** الكتالوج العام، الصور، cart، الحساب، العناوين، checkout، وطلبات العميل مفصلة في قسم خريطة API أدناه. التفويض الفعلي يقرأ typed customer session ثم يطابق `customer.store_id` مع المتجر المحلول. المصدر: `phase1-backend/src/http/app.ts:206–297`.

**اختبارات 9A والنتائج:** التقرير يوثق نجاح اختبار acceptance الخلفي وRegression في وقت إغلاق 9A: IDOR (`404` لطلب Customer آخر، `403` لعبور store أو identity)، checkout `201` ثم replay `200` بالطلب نفسه، login rate-limit `429 RATE_LIMITED`، SQLSTATE `23505/23503` للقيود المركبة، و`23514` لimmutability. كما يوثق عدم oversell والحجز/الإلغاء/الرفض/return المحافظ. المصدر: `PHASE9A_REPORT.md:48–75`.

**Commits:** تنفيذ 9A `56ac48f feat: implement phase 9A storefront backend`، ثم إصلاح deterministic CO-05 `92bccfc fix(phase9a): lock checkout products before availability check`. رأس GitHub `main` تحقق منه عن بعد عند `92bccfc…`. المصدر: `PHASE9A_REPORT.md:93–97` وفحص Git الحالي.

### 2.4 المرحلة 9B — حالة التنفيذ غير المعتمدة

**موجود محلياً لكن غير ملتزم وغير مجتاز:** طبقة `client/src/lib/storefront-api.ts`، `StorefrontProvider`, `StorefrontShell`, حالات العرض، صفحات الكتالوج والتفاصيل والسلة والتسجيل/الدخول والـcheckout والطلبات والتفاصيل، وربط مبدئي لمسارات `/store/:storeSlug/...` في `client/src/App.tsx`. هذه ملفات موجودة في شجرة العمل فقط؛ لم تعبر UI-01–UI-07 ولم تدخل commit. المصدر: `git status --short` الحالي وملفات `client/src/...` المذكورة.

**اختبارات واجهة 9B:** لم يوجد ملف الاختبار النهائي المتوقع `phase1-backend/tests/phase9b.browser-acceptance.mjs` في شجرة العمل. أضيف اختبار محدود غير ملتزم `phase1-backend/tests/phase9b.cookie-session.acceptance.mjs` للتحقق من Cookies، لكنه فشل قبل بدء خادم الاختبار أو المتصفح بسبب رفض PostgreSQL المحلي لمصادقة المستخدم المحلي في السطر 38. المصدر: `PHASE9B_COOKIE_PATH_FIX_REPORT.md`.

**بوابة الاعتماد:** لم تجتز المرحلة 9 ككل، إذ يتطلب الإغلاق UI-01–UI-07، Regression 9A/8A/8B/1–7، و`pnpm check`, `pnpm phase1:typecheck`, `pnpm build` مع console/network نظيفين. آخر build إنتاجي محلي نجح أثناء العمل، لكنه أصدر تحذير حجم bundle ولم يليه قبول UI كامل. المصدر: `PHASE9_FINAL_SPECIFICATION.md:361+`؛ `PHASE9B_COOKIE_PATH_FIX_REPORT.md`.

## 3. حالة المرحلة 9 الآن

| بند الإغلاق | الحالة | الدليل/المطلوب |
|---|---|---|
| 9A schema/API/DB/IDOR/concurrency | مجتاز وموثق تاريخياً. | `PHASE9A_REPORT.md`; commits `56ac48f`, `92bccfc`. |
| 9B صفحات الواجهة | موجودة أولياً محلياً، غير ملتزمة. | `git status --short`. |
| 9B Cookies | **غير مكتمل/غير مختبر.** عُدل create/clear guest وcreate customer لتستخدم `/api/store/<slug>`. | `phase1-backend/src/http/app.ts:39,64–73`. |
| Logout Cookie Path | **مشكلة مفتوحة مثبتة في الكود.** `POST /store/:storeSlug/account/logout` ما زال يمسح Cookie العميل باستخدام `Path=/store/<slug>` بدلاً من `/api/store/<slug>`. | `phase1-backend/src/http/app.ts:276–281`. |
| Cookie acceptance | فشل بيئياً قبل السيناريو. | `phase1-backend/tests/phase9b.cookie-session.acceptance.mjs:38`; `PHASE9B_COOKIE_PATH_FIX_REPORT.md`. |
| UI-01…UI-07 | لم تنفذ/غير متحققة. | لا يوجد تقرير نجاح أو ملف اختبار نهائي. |
| Regression نهائي | لم ينفذ بعد آخر تعديلات 9B/Cookie. | شرط الإغلاق في `PHASE9_FINAL_SPECIFICATION.md`; توقف بعد failure. |
| اعتماد المرحلة 9 | **لم تمر البوابة ولا يجوز اعتمادها.** | الحقول أعلاه وقواعد الإغلاق. |

لإغلاق المرحلة 9 واقعياً: يجب أولاً توفير قاعدة PostgreSQL تطويرية/معزولة قابلة للمصادقة، ثم مراجعة وإصلاح عدم تماثل logout Cookie Path بموافقة منفصلة، وإعادة اختبار Cookie المحدود، ثم إكمال/مراجعة اختبار UI النهائي، وتشغيل UI-01–UI-07 وRegression المطلوب. لا يجوز commit/push 9B قبل ذلك.

## 4. المخطط الحالي لقاعدة البيانات

**Provider:** PostgreSQL. **مفتاح العزل الأساسي:** `store_id` في الجداول المتجرية، أو العلاقة الهرمية `merchant_id`/`platform_owner_id` للجداول غير المتجرية. المصدر العام: `prisma/schema.prisma`.

| الجدول | الوصف والعلاقات الأساسية | مفتاح/حد العزل |
|---|---|---|
| `platform_owners` | حساب مالك المنصة؛ يرتبط بجلسات المالك. | Global؛ `email` فريد. |
| `merchants` | حساب التاجر؛ يملك متاجر وجلسات. | Global؛ `email` فريد. |
| `stores` | متجر تابع لتاجر؛ root لجميع البيانات المتجرية. | `merchant_id`; `slug`, domain, subdomain فريدة. |
| `customers` | عميل متجر؛ له sessions/orders/carts/addresses/checkout requests. | `store_id`; unique مركب `(id,store_id)`. |
| `payment_methods` | طرق دفع مهيأة لكل متجر؛ موجودة في schema، لا يوجد Online Payment منفذ في 9B. | `store_id`; unique `(store_id,code)`. |
| `notification_settings` | إعداد إشعارات واحد اختياري لكل متجر. | `store_id` unique. |
| `delivery_rates` | تعرفة محافظة لكل متجر؛ موجودة، لا يوجد shipping integration منفذ. | `store_id`; unique `(store_id,governorate)`. |
| `platform_owner_sessions` | hashes جلسات مالك المنصة. | `platform_owner_id`. |
| `merchant_sessions` | hashes جلسات تاجر مرتبطة بتاجر ومتجر. | `merchant_id` + `store_id`. |
| `customer_sessions` | hashes جلسات العميل. | `customer_id`; العزل يستعاد من `customers.store_id`. |
| `products` | منتجات متجر وتصنيف ومخزون وصور وحركات وحجوزات. | `store_id`; unique `(id,store_id)` و`(store_id,sku)`. |
| `product_categories` | تصنيفات خاصة بالمتجر. | `store_id`; unique normalized name داخل المتجر. |
| `product_images` | metadata ومفتاح object فقط، لا bytes في DB. | `store_id` + `product_id`. |
| `inventory_movements` | سجل حركات مخزون المنتج. | `store_id` + `product_id`. |
| `store_orders` | طلب متجر، بنود، أحداث، Checkout/Cart/Reservations. | `store_id`; unique `(id,store_id)`؛ Customer FK مركب عند وجوده. |
| `order_items` | snapshots اسم/SKU/سعر/كمية لبند طلب. | عزل عبر `order_id` المتجرية. |
| `order_status_events` | سجل append-only للحالات. | `store_id` + `order_id`; Triggers تمنع عدم تطابق المتجر والتعديل/الحذف. |
| `shopping_carts` | سلة guest/customer موحدة مع status/version/merge/converted links. | `store_id`; FKs مركبة للعميل/السلة/الطلب. |
| `cart_items` | بنود السلة ولحظة السعر. | `store_id`; FKs مركبة إلى cart/product؛ unique `(cart_id,product_id)`. |
| `customer_addresses` | عناوين تسليم العميل. | `store_id` + `customer_id` FK مركب. |
| `checkout_requests` | hash مفتاح idempotency وبصمة الطلب وربط order. | `store_id` + `customer_id`; unique `(store_id,customer_id,key_hash)`. |
| `inventory_reservations` | الحجز النشط/المحرر/المستهلك لكل order item. | `store_id` + order/product FKs مركبة؛ unique `(order_id,product_id)`. |
| `storefront_rate_limits` | عدادات كتابة Storefront حسب scope/hash/نافذة. | لا `store_id` صريح؛ يدخل slug ضمن المادة التي تُhash في الخدمة. |

### ملفات migrations بالترتيب الزمني

| الترتيب | migration | الملخص |
|---:|---|---|
| 1 | `20260816193500_phase1_identity_foundation` | هويات أساسية. |
| 2 | `20260816203000_merchant_store_session_boundary` | حد جلسة merchant/store. |
| 3 | `20260816211500_store_scoped_catalog_and_orders` | منتجات/طلبات متجريّة. |
| 4 | `20260817093000_store_scoped_product_management` | إدارة كتالوج وصور ومخزون. |
| 5 | `20260817201500_order_lifecycle_8a` | دورة حالة الطلب وevents وTriggers. |
| 6 | `20260818011500_storefront_customer_carts_reservations_9a` | هوية/sلة/checkout/reservation Storefront. |
| 7 | `20260818020000_storefront_rate_limits_9a` | حد معدل PostgreSQL للـStorefront. |

المصدر: جرد `prisma/migrations/**/*` و`prisma/schema.prisma`. تطبيق الهجرات على Neon حتى migration السابعة **موثق في تقرير 9A** لكنه غير معاد التحقق ضمن هذا handoff بسبب عدم الاتصال بقاعدة الإنتاج: `PHASE9A_REPORT.md:9–12`.

## 5. خريطة API الحالية ومسارات الواجهة

> المسارات التالية مكتوبة داخل `createApp()` بلا بادئة. في التطبيق الموحد تصبح تحت `/api` بسبب `server/index.ts:15`. مثال: `GET /store/:storeSlug/cart` يصبح `GET /api/store/:storeSlug/cart` في خادم الإنتاج الموحد.

### API عام / Authentication

| المسار | التفويض | المصدر |
|---|---|---|
| `GET /health` | عام. | `app.ts:190`. |
| `POST /auth/platform/register`, `POST /auth/platform/login` | عام؛ إنشاء/دخول مالك. | `app.ts:192–197`. |
| `POST /auth/merchant/register`, `POST /auth/merchant/stores/:storeSlug/login` | عام؛ التسجيل ثم دخول merchant-store. | `app.ts:198–203`. |
| `POST /stores/:storeSlug/account/register`, `/login` | aliases قديمة للعميل؛ لا تتطلب phone كما في Storefront الجديد. | `app.ts:204–205`; `PHASE9_FINAL_SPECIFICATION.md:340`. |
| `GET /store/:storeSlug/products`, `/:productId`, `/:productId/images/:imageId` | عام لكن منتج فعال وصورة/متجر مطابقان. | `app.ts:206–220`. |

### API الزبون / Storefront

| المسار | التفويض والعزل |
|---|---|
| `GET /store/:storeSlug/cart` | customer session اختياري أو guest cookie؛ يعيد سلة فارغة عند غيابها. |
| `POST /store/:storeSlug/cart/items` | guest/customer cookie اختياري + Origin trusted + rate limit؛ يعيد السلة. |
| `PATCH`/`DELETE /store/:storeSlug/cart/items/:itemId` | ملكية item ضمن cart/store فقط + Origin/rate limit. |
| `POST /store/:storeSlug/account/register` | عام + Origin + rate limit؛ يتطلب phone في مسار Storefront وينشئ session ثم merge. |
| `POST /store/:storeSlug/account/login` | عام + Origin + rate limit؛ session ثم merge. |
| `POST /store/:storeSlug/account/logout` | customer session؛ يبطل session ويطلب مسح Cookie. **مسار المسح غير متوافق حالياً مع إنشاء cookie** كما في القسم 3. |
| `GET /store/:storeSlug/account` | customer session وcustomer/store match. |
| `GET`/`POST /store/:storeSlug/account/addresses` | customer session؛ addresses خاصة بالعميل والمتجر. |
| `PATCH`/`DELETE /store/:storeSlug/account/addresses/:addressId` | customer session؛ `404` للعنوان خارج الملكية. |
| `POST /store/:storeSlug/checkout` | customer session + Origin + rate limit + `Idempotency-Key`; COD فقط. |
| `GET /store/:storeSlug/account/orders` | customer session؛ cursor؛ `store_id+customer_id`. |
| `GET /store/:storeSlug/account/orders/:orderId` و`/history` | customer session؛ `404` للطلب غير المملوك؛ history projection آمن. |

المصدر لكل مسارات Storefront: `phase1-backend/src/http/app.ts:221–297`؛ منطق العزل/checkout: `phase1-backend/src/services/storefront.service.ts`.

### API التاجر

| المسار | التفويض |
|---|---|
| `POST /merchant/stores/:storeSlug/customers/manual` | merchant/store فقط. |
| `GET /merchant/stores/:storeSlug/dashboard` | merchant/store فقط. |
| `GET /merchant/stores/:storeSlug/products` و`/:productId` | merchant/store فقط؛ endpoints legacy للمنتجات. |
| `GET /merchant/stores/:storeSlug/orders`, `/:orderId`, `/:orderId/history` | merchant/store فقط. |
| `POST /merchant/stores/:storeSlug/orders/:orderId/status` | merchant/store + expectedVersion. |
| `GET`/`POST /merchant/stores/:storeSlug/catalog/categories` | merchant/store فقط. |
| `PATCH`/`DELETE /merchant/stores/:storeSlug/catalog/categories/:categoryId` | merchant/store فقط. |
| `GET`/`POST /merchant/stores/:storeSlug/catalog/products` | merchant/store فقط. |
| `GET`/`PATCH`/`DELETE /merchant/stores/:storeSlug/catalog/products/:productId` | merchant/store فقط. |
| `POST /merchant/stores/:storeSlug/catalog/products/:productId/inventory` | merchant/store فقط. |
| `POST /merchant/stores/:storeSlug/catalog/products/:productId/images` | merchant/store فقط؛ حتى 8 ملفات. |
| `GET /merchant/stores/:storeSlug/catalog/products/:productId/images/:imageId` | merchant/store فقط. |

المصدر: `phase1-backend/src/http/app.ts:302–338`.

### API مالك المنصة

| المسار | التفويض |
|---|---|
| `POST /platform/merchants/manual` | Platform Owner فقط. |
| `GET /platform/dashboard` | Platform Owner فقط. |
| `GET /platform/stores/:storeSlug/products`, `/:productId` | Platform Owner فقط؛ قراءة متجر محدد. |
| `GET /platform/stores/:storeSlug/orders`, `/:orderId` | Platform Owner فقط؛ قراءة متجر محدد. |
| `GET /platform/orders`, `/:orderId`, `/:orderId/history` | Platform Owner فقط؛ قراءة عالمية. |

المصدر: `phase1-backend/src/http/app.ts:298–322`.

### مسارات الواجهة للأدوار الثلاثة

| الدور | المسارات المثبتة/الموجودة | الحالة |
|---|---|---|
| مالك | `/platform/login`, `/platform/dashboard` وامتدادات `:section/:subsection/:detail`. | موجودة ومثبتة في `client/src/App.tsx:17–31`. |
| تاجر | `/merchant/login`, `/merchant/dashboard` وامتداداتها، و`/merchant/stores/:storeSlug/dashboard` وامتداداتها. | موجودة ومثبتة في `client/src/App.tsx:19–27`. |
| زبون/Storefront | `/store/:storeSlug`, products, cart, register/login, checkout, orders, detail order. | موجودة محلياً في `client/src/App.tsx`، **غير ملتزمة وغير مختبرة قبولاً**. |

## 6. البيئة والتشغيل

| المجال | الحالة المبنية على الدليل |
|---|---|
| التطوير | Vite يعمل لواجهة التطوير (`pnpm dev`)، وAPI المرحلة مستقل (`pnpm phase1:start`). خادم الإنتاج الموحد يخدم static + `/api` من `server/index.ts`. |
| الإنتاج DB | Neon PostgreSQL قياسي مهيأ، وهجرات 1–7 موثقة كتطبيق ناجح. لم يُعد التحقق في هذا handoff. المصدر: `DATABASE_PRODUCTION_SETUP_REPORT.md`. |
| التطبيق المنشور | **غير متحقق** في هذا handoff؛ لا يوجد تقرير نشر/URL تشغيل إنتاجي موثق في الملفات المقروءة. |
| staging | **غير متحقق/غير موثق.** لم يظهر ملف أو تقرير أو إعداد staging في جرد الملفات. |
| قاعدة التطوير المحلية | كانت موثقة سابقاً، لكن اختبار Cookie الحالي فشل بمصادقة PostgreSQL محلية؛ لا تعد بيئة اختبار صالحة حتى تصحح بيانات اعتمادها. |

### أسماء متغيرات البيئة المقروءة من الكود فقط

| المجموعة | الأسماء |
|---|---|
| قاعدة البيانات | `CODIQ_POSTGRES_URL`, `CODIQ_POSTGRES_URL_UNPOOLED`, `DATABASE_URL`. |
| الجلسة والمنفذ | `SESSION_JWT_SECRET`, `PHASE1_PORT`, `PORT`, `NODE_ENV`. |
| تخزين صور S3-compatible | `PRODUCT_S3_ENDPOINT`, `PRODUCT_S3_BUCKET`, `PRODUCT_S3_ACCESS_KEY_ID`, `PRODUCT_S3_SECRET_ACCESS_KEY`, `PRODUCT_S3_REGION`, `PRODUCT_S3_FORCE_PATH_STYLE`. |

المصدر: `phase1-backend/src/db/database-url.ts`, `phase1-backend/src/config.ts`, `server/index.ts`, `phase1-backend/src/services/product-image-storage.service.ts`.

### حالة R2/S3

الكود ينفذ تخزين صور **S3-compatible** بواسطة AWS SDK ومفاتيح objects على نمط `products/<storeId>/<productId>/<uuid>`. قواعد البيانات تحفظ metadata و`object_key` فقط. اختبار المرحلة 7 موثق كناجح تاريخياً، لكن موفر التخزين الفعلي الحالي لا يمكن الجزم أنه Cloudflare R2 من الكود أو التقارير المقروءة؛ لذلك حالة **R2 تحديداً: غير متحققة**. المصدر: `product-image-storage.service.ts` و`PHASE7_PRODUCT_MANAGEMENT_REPORT.md`.

## 7. الانحرافات والديون التقنية والتحذيرات

| البند | الحالة والأثر | المصدر |
|---|---|---|
| Cookie Path غير مكتمل | إنشاء customer/guest cookie يستخدم `/api/store/<slug>`، لكن logout يحاول حذف customer cookie من `/store/<slug>`. لا يمكن افتراض أن logout يمسحها. | `app.ts:64–73,276–281`. |
| بيئة DB المحلية | `phase9b.cookie-session.acceptance.mjs` فشل عند `TRUNCATE` قبل تشغيل browser بسبب مصادقة `codiq_dev`. هذا يخالف قابلية تشغيل الاختبارات في بيئة مستقلة حتى تعالج البيئة. | `PHASE9B_COOKIE_PATH_FIX_REPORT.md`; مبدأ 2 في `PROJECT_ENGINEERING_PRINCIPLES.md`. |
| 9B غير ملتزمة | صفحات واجهة، طبقة API، اختبار Cookie، ووثائقها موجودة في working tree بلا commit. | `git status --short` الحالي. |
| اختبارات 9B المؤجلة | UI-01–UI-07 لا توجد نتائج نجاح موثقة؛ ملف browser acceptance النهائي المتوقع غير موجود. | `PHASE9_FINAL_SPECIFICATION.md`; جرد الشجرة الحالي. |
| حجم bundle | آخر `pnpm build` نجح مع تحذير Vite: ملف JavaScript إنتاجي يقارب `842.53 kB` غير مضغوط، فوق عتبة 500 kB. لا يعد failure، لكنه دين أداء محتمل. | مخرجات `pnpm build` في جلسة الإصلاح الحالية. |
| وثيقة Cookie Path قديمة | مواصفة 9 النهائية لا تزال تذكر `Path=/store/{storeSlug}`، بينما الخادم الموحد يركب API تحت `/api`. يلزم تحديث وثيقة المواصفة بعد تحقق الإصلاح، لا قبل ذلك. | `PHASE9_FINAL_SPECIFICATION.md:197–204`; `server/index.ts:15`. |
| تضارب عداد المراحل | طلب خطة 16 مرحلة لا يطابق خطة المراحل الموثقة في المستودع (1–9 فقط). لا يمكن تحديد 10–16 بأمان. | جرد ملفات Markdown والبحث النصي الحالي. |
| منطق `storefront_rate_limits` | لا يحمل عمود `store_id`؛ يضم slug في قيمة مجزأة قبل الإدراج. هذا يحقق عزل المفتاح من منطق الخدمة، لكن العزل ليس FK بنيوياً مثل cart/order. | `storefront.service.ts:42–60`; `schema.prisma:440–450`. |
| حقول مستقبلية بلا تدفق تشغيلي | توجد `payment_methods`, `delivery_rates`, `notification_settings` في schema، لكن لا يوجد Online Payment أو Shipping integration أو Customer notifications ضمن النطاق المنفذ. | `schema.prisma:93–137`; مواصفة 9 §A. |

## 8. المخاطر المفتوحة والقرارات المعلقة

| الأولوية | المخاطرة/القرار | المطلوب من مالك المشروع قبل المتابعة |
|---|---|---|
| حرجة لمرحلة 9B | إصلاح بيئة PostgreSQL المحلية/المعزولة حتى تبدأ Cookie acceptance. | تحديد/توفير اتصال تطوير محلي صالح، من دون استخدام Neon الإنتاجية للاختبار. |
| حرجة لمرحلة 9B | عدم تماثل Cookie Path في logout. | موافقة صريحة على إصلاح محدود في `phase1-backend/src/http/app.ts` لمسار clearCookie الخاص بالعميل، ثم إعادة اختبار Cookie. |
| حرجة لمرحلة 9 | UI-01–UI-07 وRegression النهائي لم ينفذا. | عدم اعتماد 9B أو commit/push حتى تمر البوابة كاملة. |
| عالية | جدول خطة 10–16 غير موجود. | تزويد/اعتماد وثيقة خطة 16 مرحلة بأسماء ونطاقات وبوابات إغلاق. |
| عالية قبل إطلاق حي | نسخ Neon المجدولة ونافذة الاستعادة لا توثق كمنفذة. | اختيار خطة النسخ والاستعادة وتوثيقها قبل بيانات عملاء حية. |
| متوسطة | R2 provider الفعلي وبيئة staging غير موثقين. | تأكيد موفر S3-compatible وقرار/إعداد staging إن كان مطلوباً. |
| متوسطة | بناء bundle كبير. | قرار لاحق حول code splitting/تحسين التحميل بعد ثبات 9B؛ لا يبرر refactor الآن. |
| متوسطة | Workflow فحص المرتجعات غير موجود. | اعتماد مواصفة مستقلة قبل أي إعادة تلقائية للمخزون بعد `returned`. |

## 9. المرحلة التالية المقترحة وفق الوضع الفعلي

لا يمكن تسمية "المرحلة 10" وفق خطة 16 لأن هذه الخطة غير موثقة في المستودع. أما **الخطوة الصحيحة التالية تقنياً** فهي استكمال وإغلاق **PHASE 9B**، وليست فتح نطاق جديد.

يجب أن تتضمن مواصفة الاستكمال/الإصلاح التالية، قبل أي كود جديد:

1. تعريف بيئة اختبار PostgreSQL محلية/معزولة قابلة للتشغيل، مع إبقاء Neon الإنتاجية خارج اختبارات القبول المدمرة.
2. نطاق ضيق وموافق عليه لتوحيد Cookie Path للإنشاء والحذف (`customer logout`) ضمن مسار API المركب، مع اختبار متصفح يثبت الإرسال للمسار المطابق وعدم الإرسال لمسار Store آخر أو API غير ذي صلة.
3. مراجعة صفحة Storefront غير الملتزمة مقابل عقود 9A، ثم إنشاء/إكمال `phase9b.browser-acceptance.mjs` لتغطية UI-01 إلى UI-07.
4. تشغيل بوابة 9B كاملة: `pnpm check`، `pnpm phase1:typecheck`، `pnpm build`، UI-01–UI-07، ثم Regression 9A و8A و8B و1–7.
5. فقط بعد نجاح جميع العناصر: مراجعة `git status`، تقرير PHASE9B النهائي، ثم قرار المستخدم الصريح بشأن commit/push. لا تبدأ مرحلة لاحقة تلقائياً.

## مراجع الأدلة داخل المشروع

| المرجع | الاستخدام |
|---|---|
| `PROJECT_ENGINEERING_PRINCIPLES.md` | القابلية للنقل، عزل tenant، وبوابات الإثبات. |
| `prisma/schema.prisma` و`prisma/migrations/*/migration.sql` | المخطط والعلاقات والهجرات. |
| `phase1-backend/src/http/app.ts` | API والتفويض وCookies. |
| `phase1-backend/src/services/storefront.service.ts` | السلات والـcheckout والحجز والـrate limit. |
| `server/index.ts` | تركيب API تحت `/api` في الخادم الموحد. |
| `PHASE8A_REPORT.md`, `PHASE8B_REPORT.md`, `PHASE9A_REPORT.md` | تنفيذ واختبارات وcommits تاريخية. |
| `PHASE9_FINAL_SPECIFICATION.md` | متطلبات الإغلاق الرسمية للمرحلة 9. |
| `PHASE9B_COOKIE_PATH_BLOCKER.md`, `PHASE9B_COOKIE_PATH_FIX_REPORT.md` | فجوة Cookie Path ونتيجة اختبارها الأخيرة. |
| `DATABASE_PRODUCTION_SETUP_REPORT.md` | إعداد Neon ومتغيرات الاتصال وسياسة الأسرار. |
| فحص Git read-only في 19 أغسطس 2026 | رأس GitHub main الحالي وحالة working tree. |

# تقرير المرحلة 13 — تبديل المتاجر وإنشاء متاجر متعددة للتاجر

**الحالة:** مكتملة ومندمجة إلى `main` عبر PR #5 في `2026-08-24T08:58:52Z`. الالتزام المدمج هو `c10c98083da4e543ef731c9cd086686eb1accd6b`. لم ينفذ نشر يدوي إلى production؛ staging هي بيئة التحقق الآلية فقط. [8]

## الملخص التنفيذي

نفذت المرحلة 13 القدرة التشغيلية لتاجر واحد على امتلاك وإدارة حتى **ثلاثة متاجر إجمالاً**، مع إبقاء كل جلسة تاجر مقيدة بمتجر واحد. يمكن للتاجر عرض متاجره، إنشاء متجر جديد ضمن الحد الخادمي، ثم التبديل الصريح إلى متجر يملكه. لا تُوسّع عملية التبديل صلاحية الجلسة السابقة ولا تحولها إلى جلسة عامة؛ بل تصدر جلسة جديدة مقيدة بالمتجر الهدف وتبقى السابقة صالحة لمتجرها الأصلي فقط. [1] [2]

تمت المحافظة على نطاق المرحلة 12 بالكامل. لا توجد migration ولا تغير في Prisma schema، ولم يتغير Checkout أو حجز المخزون أو الطلبات أو العملاء. يعيد إنشاء المتجر استخدام `createStoreFoundation` ضمن معاملة Prisma الذرية القائمة، فلا تبقى بيانات متجر أو إعدادات يتيمة عند فشل إعداد الأساس. [3]

## النطاق المنفذ

| المجال | التنفيذ | دليل التنفيذ |
|---|---|---|
| تعداد متاجر التاجر | `GET /merchant/stores` يعيد متاجر subject التاجر فقط بالحقول `id`, `name`, `slug`, `isActive` | [1] |
| تبديل السياق | `POST /merchant/stores/switch` يتحقق من ملكية المتجر ونشاطه، ثم يصدر session جديدة مقيدة بالمتجر ويعيد `redirectTo` | [1] [2] |
| إنشاء متجر | `POST /merchant/stores` يتحقق من الاسم وslug والحد، ثم ينشئ foundation ذرياً ويجعل المتجر الجديد سياق الجلسة | [1] [3] |
| الحد المؤقت | حد خادمي قابل للاستبدال لاحقاً: `MAX_STORES_PER_MERCHANT = 3`؛ المتجر الرابع يعيد `403 / STORE_LIMIT_REACHED` | [1] [4] |
| لوحة التاجر | Store Switcher حقيقي مع قائمة وحالات تحميل وخطأ وإعادة محاولة ونموذج إنشاء ورسائل عربية | [5] |
| CI | أضيف اختبار S13 الخلفي إلى `ci / integration` وقبول المتصفح إلى الوظيفة غير الحاجبة | [6] |

> **قاعدة الجلسة الملزمة:** لا توجد جلسة تاجر عامة. يحمل JWT وسجل `merchant_sessions` معرف متجر واحد، وتتحقق الطبقة الخدمية من اقتران `merchantId + storeId + tokenHash`. [2]

## عقود API

| المسار | التفويض | النجاح | الرفض المتوقع |
|---|---|---|---|
| `GET /api/merchant/stores` | Bearer أو cookie جلسة تاجر | `200` وقائمة متاجر المالك فقط | `401 MISSING_SESSION` |
| `POST /api/merchant/stores/switch` | جلسة تاجر قائمة | `200`، cookie جلسة جديدة، و`redirectTo` | `404 MERCHANT_STORE_CONTEXT_NOT_FOUND` لمتجر أجنبي أو غير نشط |
| `POST /api/merchant/stores` | جلسة تاجر قائمة | `201`، cookie جلسة جديدة، و`redirectTo` | `422 INVALID_STORE_NAME/INVALID_STORE_SLUG`، `409 DUPLICATE_STORE_SLUG`، `403 STORE_LIMIT_REACHED` |

لا تعيد مسارات المرحلة 13 access token في جسم الاستجابة. يتم تعيين cookie `codiq_session` المحمي فقط؛ ويبقى authorization مشتقاً من الجلسة الخادمية لا من `merchantId` أو `storeId` يرسله العميل. [1] [2]

## قرارات التنفيذ المثبتة

> **حد المتاجر المجمد:** «MAXIMUM 3 STORES PER MERCHANT TOTAL, INCLUDING THE FIRST STORE». يفرض الخادم هذا الحد، ويعيد للمتجر الرابع `403 STORE_LIMIT_REACHED`. [4]

> **تبديل الجلسة:** جلسة المتجر السابق تبقى صالحة لمتجرها الأصلي حتى انتهاء صلاحيتها أو إلغائها، بينما جلسة التبديل الجديدة صالحة للمتجر الهدف فقط. لا يوجد revoke تلقائي ولا جلسة متعددة المتاجر. [4]

## الاختبارات المنفذة ونتائجها

| الفحص | النتيجة | التغطية المثبتة |
|---|---:|---|
| `pnpm check` | Passed | TypeScript للواجهة |
| `pnpm phase1:typecheck` | Passed | TypeScript للخلفية |
| `pnpm phase13:test` | Passed | S13-01 إلى S13-08: القائمة، عزل A/B، جلسة جديدة، جلسة قديمة، 404 لمتجر أجنبي، slug، التعارض، حد الثلاثة، والذرية |
| `pnpm phase13:browser` | Passed | S13-09: تسجيل الدخول، إنشاء متجر، تبديل سطح المكتب، وتبديل 390px |
| `pnpm phase9b:browser` | Passed | UI-01 إلى UI-07 وUI-12، وعزل الطلب/العنوان/cookie وidempotency والتسعير والمخزون |
| `pnpm phase1:test` | Passed | الهوية، الأساس، العزل، والجلسات |
| `pnpm phase5:test` | Passed | IDOR وعزل المتاجر |
| `pnpm phase6:test` | Passed | التوفير اليدوي وعزل التاجر/العميل |
| `pnpm phase7:test` | Passed | الكتالوج والمخزون وعزل المنتجات |
| `pnpm phase8a:test` | Passed | دورة الطلبات والتزامن والعزل |
| `pnpm phase9a:test` | Passed | السلة وCheckout والحجز وidempotency والتوصيل |
| `pnpm build` | Passed | بناء التطبيق المركب |

اختبار S13 الذري يجبر فشل provisioning بعد إنشاء المتجر داخل المعاملة، ثم يثبت عدم بقاء متجر جزئي أو صفوف foundation يتيمة. كما يثبت الاختبار أن جلسة A القديمة تستمر على A وأن جلسة B الجديدة تُرفض على A بـ`403 STORE_BOUNDARY_DENIED`. [7]

## ضمانات الأمن والعزل

| الضمان | حالة التحقق |
|---|---|
| لا تعداد لمتاجر تاجر آخر | متحقق: S13-01 وS13-04 |
| لا تبديل URL صامت | متحقق: كل تبديل يتطلب endpoint وجلسة جديدة؛ `requireMerchantStore` قائم [2] |
| جلسة A لا تدخل B | متحقق: `403 STORE_BOUNDARY_DENIED` في S13-02 وS13-03 |
| جلسة B لا تعود إلى A | متحقق: `403 STORE_BOUNDARY_DENIED` في S13-03 |
| slug آمن وفريد | متحقق: `422` للصيغة و`409` للتعارض [7] |
| حد 3 خادمي لا واجهي فقط | متحقق: S13-07 يعيد `403 STORE_LIMIT_REACHED` [7] |
| إنشاء ذري بلا بقايا | متحقق: S13-08 [3] [7] |

## الملفات التي تغيرت

| الملف | الغرض |
|---|---|
| `phase1-backend/src/services/merchant-store.service.ts` | منطق القائمة والتبديل والإنشاء والحد والذرية |
| `phase1-backend/src/http/app.ts` | مسارات API المرحلة 13 وربط cookie الجلسة الجديدة |
| `client/src/components/MerchantStoreSwitcher.tsx` | مكون التبديل والإنشاء وحالات الواجهة |
| `client/src/pages/MerchantDashboard.tsx` | ربط المكون الحقيقي بلوحة التاجر |
| `phase1-backend/tests/phase13.store-switcher.integration.ts` | S13-01 إلى S13-08 |
| `phase1-backend/tests/phase13.browser-flow.mjs` | S13-09 على سطح المكتب والجوال |
| `.github/workflows/ci.yml` و`package.json` | أوامر الاختبار وإدراجها في CI |
| `todo.md` و`reports/PHASE13_REPORT.md` | توثيق التنفيذ والبوابات |

## البنود المتعمدة خارج النطاق

لم تنفذ المرحلة 13 خططاً أو اشتراكات أو Billing أو حدوداً مبنية على plans أو موظفين/RBAC أو إشعارات أو نطاقات أو تخصيص storefront أو تسجيل عام للتاجر أو OTP/SMS أو شحن أو microservices. هذه البنود تبقى ملك مراحل لاحقة. [4]

## ملاحظات معروفة

يبقى B-15 ديناً تقنياً معروفاً لاختبار Browser — phase 6 في CI؛ لا يتعلق بمنطق المرحلة 13، والوظيفة ما زالت مرئية وغير حاجبة وفق قرار 11A. مر قبول S13-09 محلياً على سطح المكتب والجوال، لكن تشغيل CI رقم `32707836198` أوقف خطوات Browser اللاحقة بعد فشل Phase 6، ولذلك تظهر خطوات Phase 7/8B/9B/13 في CI بوصفها skipped لا فاشلة. لم تُخفَ هذه الحقيقة ولم تتغير B-15 ضمن المرحلة. كما يبقى تحذير حجم bundle أكبر من 500KB تحذيراً غير حاجب مسجلاً؛ لم تعالج المرحلة أياً منهما لتجنب توسعة النطاق.

## حالة Git وPR

نفذ الالتزام الوظيفي `563eb58` بعنوان `Phase 13: Implement secure multi-store switching`، ثم وثق التحقق في `c10c980`. أُغلق Pull Request [#5](https://github.com/phsaifaldin/CODIQ/pull/5) بدمجه إلى `main` عند `c10c98083da4e543ef731c9cd086686eb1accd6b`. أحدث CI على `main` بعد الدمج هو التشغيل [`32709048351`](https://github.com/phsaifaldin/CODIQ/actions/runs/32709048351) وحالته `success`. [8]

## تحقق ما بعد الدمج

أعيدت بوابة TypeScript والتكامل والبناء على الالتزام المطابق لرأس `main`. اجتازت اختبارات المراحل 1 و5 و6 و7 و8A و9A و13، ثم اجتاز قبول Storefront UI-01 إلى UI-07 وUI-12 بعد الدمج. أعيد أيضاً قبول S13-09 على الخادم المركب المؤقت: أنشئ متجر من سطح المكتب، وعادت الجلسة إلى المتجر الأول، ثم بدلت الواجهة المحمولة 390px إلى المتجر الثاني. الاستجابة العامة لـstaging بقيت `{"status":"ok","env":"staging"}`. التفاصيل الكاملة في [`POST_PHASE13_VERIFICATION_REPORT.md`](./POST_PHASE13_VERIFICATION_REPORT.md). [9]

## المراجع

[1]: ../phase1-backend/src/services/merchant-store.service.ts "خدمة متاجر التاجر"
[2]: ../phase1-backend/src/auth/identity.ts "إنشاء والتحقق من جلسات الهوية"
[3]: ../phase1-backend/src/services/store-bootstrap.service.ts "التهيئة الذرية لأساس المتجر"
[4]: ../upload/pasted_content.txt "أمر تنفيذ المرحلة 13 وقراراتها"
[5]: ../client/src/components/MerchantStoreSwitcher.tsx "واجهة تبديل وإنشاء متاجر التاجر"
[6]: ../.github/workflows/ci.yml "CI للمرحلة 13"
[7]: ../phase1-backend/tests/phase13.store-switcher.integration.ts "اختبارات العزل والحد والذرية للمرحلة 13"
[8]: https://github.com/phsaifaldin/CODIQ/pull/5 "Pull Request #5 — الحالة والدمج"
[9]: ./POST_PHASE13_VERIFICATION_REPORT.md "تقرير التحقق بعد دمج المرحلة 13"

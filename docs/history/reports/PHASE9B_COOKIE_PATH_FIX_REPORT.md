# تقرير إصلاح Cookie Path المحدود — PHASE 9B

**الحالة:** متوقف بانتظار توجيه المستخدم بعد فشل اختبار البيئة المحلية.
**الفرع/الرأس الحالي:** `92bccfcad3b3fe46bfc64720c4fbb3c229d4ee28`.
**لا يوجد push أو commit جديد.**

## Root Cause

تُركّب واجهة الخادم الموحد API المرحلة 9A تحت البادئة `/api`، لذلك تستخدم واجهة Storefront طلبات مثل `/api/store/:storeSlug/cart` و`/api/store/:storeSlug/account`. في المقابل، كانت Cookies الخاصة بسلة الضيف وجلسة العميل تقيد نفسها بـ`Path=/store/:storeSlug`. هذا المسار ليس بادئة لمسار الـAPI الفعلي؛ لذلك لا يرسل المتصفح تلك Cookies إلى endpoints التشغيلية الخاصة بالـStorefront.

## Exact File Changed

| الملف | التغيير |
|---|---|
| `phase1-backend/src/http/app.ts` | **ملف الإنتاج الوحيد الذي عُدّل ضمن الإصلاح.** |
| `phase1-backend/tests/phase9b.cookie-session.acceptance.mjs` | اختبار قبول محلي جديد للتحقق من Cookie Path وسلة الضيف وجلسة العميل ونطاقهما. |

## Exact Change Made

أضيفت الدالة `storefrontCookiePath(storeSlug)` في السطر 39 من `phase1-backend/src/http/app.ts` لتعيد `/api/store/<encoded-storeSlug>`. ثم استُخدمت هذه الدالة، من دون تغيير الأسماء أو المحتوى أو SameSite أو HttpOnly أو Secure أو مدة الجلسة، في النقاط الثلاث التالية:

| الدالة | السطر | التعديل المحدود |
|---|---:|---|
| `setCustomerSession` | 65 | جعل `path` مسار API الفعلي للجلسة. |
| `setGuestCartCookie` | 69 | جعل `path` مسار API الفعلي لسلة الضيف. |
| `clearGuestCartCookie` | 73 | جعل مسار الحذف مطابقاً لمسار الإنشاء. |

لم يتغير Prisma أو Schema أو migrations أو PostgreSQL أو Neon أو Environment Variables أو API contracts أو منطق الحسابات والجلسات والتفويض والسلة والطلب والـcheckout والمخزون.

## Tests Executed

| الاختبار | النتيجة | الدليل |
|---|---|---|
| `pnpm build` | **Passed** | اكتمل بناء Vite و`dist/index.js` بنجاح. ظهر تحذير bundle-size فقط، بلا failure. |
| `DATABASE_URL=… node phase1-backend/tests/phase9b.cookie-session.acceptance.mjs` | **Failed — قبل بدء سيناريو المتصفح** | فشل Prisma عند السطر 38 من الاختبار أثناء `TRUNCATE` بسبب رفض مصادقة PostgreSQL للحساب المحلي `codiq_dev`. |

## Tests Passed

| الاختبار | الحالة |
|---|---|
| Build الإنتاجي | Passed |

## Tests Failed

| الاختبار | ملف/سطر الفشل | السبب |
|---|---|---|
| Cookie / Customer Session / Guest Cart acceptance | `phase1-backend/tests/phase9b.cookie-session.acceptance.mjs:38` | `PrismaClientInitializationError`: بيانات اعتماد قاعدة البيانات المحلية للحساب `codiq_dev` غير صالحة أو غير متاحة في بيئة الاختبار الحالية. |

لم يصل الاختبار إلى تشغيل الخادم أو فتح المتصفح أو إنشاء Cookie. لذلك لا توجد نتيجة صالحة بعد لتأكيد الإرسال إلى `/api/store/:storeSlug` أو لتأكيد عدم الإرسال إلى مسارات أخرى.

## Regression Results

لم تُشغّل اختبارات Regression لـPHASE 9A أو 8A أو 8B أو 1–7، عملاً بشرط التوقف عند أول failure. لم تُجر أي محاولة إصلاح إضافية، ولم يُعاد توجيه الاختبارات إلى Neon أو أي قاعدة إنتاجية.

## git status --short

```text
 M client/src/App.tsx
 M phase1-backend/src/http/app.ts
 M todo.md
?? PHASE9B_COOKIE_PATH_BLOCKER.md
?? client/src/components/StorefrontProvider.tsx
?? client/src/components/StorefrontShell.tsx
?? client/src/components/StorefrontStates.tsx
?? client/src/lib/storefront-api.ts
?? client/src/pages/CustomerAuthPage.tsx
?? client/src/pages/CustomerOrderDetailPage.tsx
?? client/src/pages/CustomerOrdersPage.tsx
?? client/src/pages/StorefrontCartPage.tsx
?? client/src/pages/StorefrontCatalogPage.tsx
?? client/src/pages/StorefrontCheckoutPage.tsx
?? client/src/pages/StorefrontProductPage.tsx
?? phase1-backend/tests/phase9b.cookie-session.acceptance.mjs
```

## Latest Commit Hash

`92bccfcad3b3fe46bfc64720c4fbb3c229d4ee28`

## هل بقيت أي مشكلة؟

نعم. بقيت **مشكلة بيئة الاختبار المحلية**: تعذر المصادقة بقاعدة PostgreSQL المحلية وفق الاتصال المحدد للاختبار. لا يوجد حتى الآن failure مثبت في Cookie Path نفسه أو في منطق التطبيق؛ لكن لا يمكن اعتماد الإصلاح أو متابعة اختبارات PHASE 9B قبل توفير اتصال تطوير محلي/معزول صالح، ثم إعادة تشغيل الاختبار نفسه أولاً. لم يُنفّذ أي تغيير إضافي لمعالجة هذه المشكلة.

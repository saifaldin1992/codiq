# PHASE 9B — تقرير فجوة حرجة: نطاق Cookies الخاص بالـStorefront

**الحالة:** متوقف بانتظار قرار صريح.
**النطاق:** واجهة Storefront وحساب العميل في PHASE 9B فقط.
**تاريخ المراجعة:** 18 أغسطس 2026.

## الملخص التنفيذي

أثناء ربط واجهة PHASE 9B بعقود API المثبتة في PHASE 9A، ظهرت فجوة فعلية بين نطاق مسارات الواجهة العامة ونطاق Cookies التي يصدرها الخادم. تتصفح الواجهة العامة عبر المسارات `/store/:storeSlug/...`، لكنها تستدعي الـAPI نفسه-الأصل عبر `/api/store/:storeSlug/...`. في المقابل، يضبط الخادم Cookie جلسة العميل وCookie سلة الضيف بمسار محدود يبدأ بـ`/store/:storeSlug`.

وفق قواعد المطابقة القياسية للـCookies، لن يرسل المتصفح Cookie ذات `Path=/store/<slug>` مع طلب موجه إلى `/api/store/<slug>/...`. وبذلك لا تصل جلسة العميل أو رمز سلة الضيف إلى `GET /api/store/:storeSlug/cart` أو إلى عمليات الإضافة أو تسجيل الدخول أو الـcheckout. هذا يمنع إكمال UI-01 ويكسر سلوك Guest Cart وCustomer Session رغم أن طبقة الخلفية 9A نفسها لا تعاني خللاً عندما تُستدعى مباشرة بلا بادئة `/api`.

> **هذه فجوة عقدية/تكاملية وليست مشكلة شكلية في الواجهة. لا يمكن إصلاحها محلياً في React، ولا يجوز للواجهة استخراج HttpOnly cookies أو تخزين tokens في localStorage أو إضافة Authorization header.**

## الدليل الفني

| الطبقة | الدليل الحالي | الأثر |
|---|---|---|
| مسارات الواجهة | الصفحات العامة مسجلة تحت `/store/:storeSlug/...` | هذا هو المسار الذي يفتحه الزائر في المتصفح. |
| مسار الـAPI نفسه-الأصل | طبقة `storefront-api.ts` تستخدم `/api/store/:storeSlug/...` | كل طلبات السلة والحساب والـcheckout تمر من بادئة `/api`. |
| تركيب التطبيق الإنتاجي | `server/index.ts` يركّب `createCodiqApi()` تحت `app.use("/api", ...)` | يصبح المسار الفعلي للـAPI هو `/api/store/:storeSlug/...`. |
| Cookie جلسة العميل | `setCustomerSession()` يضبط `path: /store/<slug>` | المتصفح لا يرسلها إلى `/api/store/<slug>/...`. |
| Cookie سلة الضيف | `setGuestCartCookie()` يضبط `path: /store/<slug>` | لا تستطيع طلبات `/api` قراءة سلة الضيف أو متابعة الدمج. |

## تأثير الفجوة على متطلبات PHASE 9B

| التدفق | النتيجة المتوقعة دون إصلاح | لماذا لا يمكن التحايل من الواجهة |
|---|---|---|
| إضافة منتج كسلة ضيف | قد يصدر الخادم Cookie، لكن القراءة والكتابة اللاحقة عبر `/api/...` لا تستقبلها. | Cookie هي HttpOnly؛ لا يسمح النطاق بتعديلها أو نسخها من JavaScript. |
| تسجيل العميل بعد سلة ضيف | لا يصل Guest Cart Cookie إلى endpoint التسجيل، فلا يحدث الدمج الموثق في 9A. | منع المستخدم من تسجيل الدخول ليس حلاً، والدمج المحلي محظور. |
| قراءة الحساب والعناوين والطلبات | تعود `401 CUSTOMER_SESSION_REQUIRED` بعد نجاح التسجيل/الدخول. | لا يجوز تخزين `accessToken` الراجع من الخادم أو إرساله يدوياً من العميل. |
| Checkout COD | يفشل قبل المعاملة بـ`401 CUSTOMER_SESSION_REQUIRED`. | لا يمكن للواجهة تجاوز `requireStorefrontCustomer`. |
| UI-01 وUI-03 | لا يمكن إثبات التدفق العام أو idempotency عبر الواجهة. | سيصبح الاختبار دليلاً على الفجوة لا على اكتمال 9B. |

## تحليل السبب الجذري

السبب هو اختلاف prefix بين مستوى العرض ومستوى الـAPI بعد تركيب خادم 9A تحت `/api` في الخادم الموحد. كانت دوال Storefront داخل `createCodiqApi()` تستخدم `request.params.storeSlug` لصنع Cookies بمسار `/store/<slug>`، وهو صالح عندما يكون API نفسه تحت `/store/<slug>` في خادم 9A المستقل. لكن بعد التركيب الإنتاجي يصبح الطلب `/api/store/<slug>`؛ لذلك لم يعد مسار Cookie بادئة للمسار الذي يتعامل مع الجلسة.

لا علاقة للفجوة بـPrisma أو PostgreSQL أو الحجوزات أو state machine أو منطق checkout. وهي لا تتطلب migration أو تعديل schema.

## الملفات المتأثرة

| الملف | الدور | وضعه الحالي |
|---|---|---|
| `phase1-backend/src/http/app.ts` | يحدد مسار Cookies للعميل والضيف ويقرأهما من الطلبات | يحتاج إصلاحاً محدوداً بعد موافقة المستخدم. |
| `server/index.ts` | يركّب API تحت `/api` | لا يحتاج تغييراً في الإصلاح المقترح. |
| `client/src/lib/storefront-api.ts` | يستدعي API نفسه-الأصل تحت `/api/store/...` | صحيح من حيث نفس الأصل ولا يحتاج token/client secret. |
| صفحات PHASE 9B | تعتمد Cookies المرسلة تلقائياً من المتصفح | لا يجوز أن تعالج Cookies مباشرة. |

## الإصلاح المقترح — محدود ومتوافق

تعديل محدد في `phase1-backend/src/http/app.ts` فقط لتحديد نطاق الـCookies وفق المسار الفعلي للـAPI. الخيارات السليمة هي:

1. **المفضل:** ضبط `path` للـCustomer/Guest storefront Cookies على `/api/store/<encoded-slug>`، لأن كل استهلاك تشغيلي لهذه Cookies يتم اليوم عبر endpoints مركبة تحت `/api/store/<slug>` في الخادم الموحد.
2. **بديل أوسع لكن أقل تقييداً:** ضبط `path: "/"` مع الحفاظ على أسماء Cookies المقيدة بالـslug. هذا يوسع إرسال Cookie داخل نفس الأصل بلا ضرورة، ولذلك لا أوصي به ما دام الخيار الأول كافياً.

يبقى اسم الـCookie مختلفاً لكل متجر (`codiq_customer_session_<slug>` و`codiq_cart_<slug>`)، ويستمر التحقق server-side من `storeSlug` وcustomer/store ownership. لا يتم حفظ أي token في JavaScript أو localStorage أو sessionStorage.

## اختبار التحقق المطلوب بعد الموافقة

بعد تنفيذ الإصلاح المحدود، يجب إضافة/تشغيل تحقق يغطي بالتحديد:

1. طلب UI/API إلى `/api/store/:slug/cart/items` ينشئ Guest Cart Cookie ذات Path متوافق مع `/api/store/:slug`.
2. قراءة `/api/store/:slug/cart` من نفس browser context تعيد العنصر المضاف.
3. التسجيل أو الدخول من الواجهة يدمج سلة الضيف عبر Cookie ويعيد سلة العميل.
4. `GET /api/store/:slug/account` بعد تسجيل الدخول يعيد العميل الحالي، ولا ينجح عند تغيير `storeSlug` إلى متجر آخر.
5. Checkout عبر الواجهة يصل للخادم بجلسة العميل ويحافظ على Idempotency-Key وcartVersion.
6. اختبار Regression كامل لـPHASE 9A للتأكد من أن الخادم المستقل لا يتأثر، ثم UI-01 إلى UI-07.

## حدود التوقف الحالية

لم يتم تنفيذ أي تعديل في `phase1-backend/src/http/app.ts` أو `server/index.ts`. لم تُنشأ migration، ولم يُعدّل Prisma أو PostgreSQL أو Neon. لم يُنشأ commit أو push. لا يجري حالياً أي عمل على PHASE 9C أو PHASE 10.

## القرار المطلوب

أحتاج موافقة صريحة ومحدودة على إصلاح Cookie Path في `phase1-backend/src/http/app.ts`، وفق الخيار المفضل: ربط مسار Cookie بـ`/api/store/<storeSlug>`، ثم إضافة اختبار قبول/تكامل يثبت استمرار السلة والجلسة عبر نفس الأصل. بعد ذلك فقط أستأنف PHASE 9B واختباراتها.

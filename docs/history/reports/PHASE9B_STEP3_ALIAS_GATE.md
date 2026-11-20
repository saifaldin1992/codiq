# بوابة الخطوة 3 — تدقيق aliases تسجيل العميل القديمة

**الحالة:** يتطلب قرار مالك المشروع قبل أي تعديل.
**نطاق هذه الوثيقة:** مراجعة قراءة فقط للكود الحالي، بلا حذف أو تحويل أو تعديل API.

## النتيجة المختصرة

المساران القديمان التاليان لا يطبقان حماية Storefront 9A الكاملة، ولا ينبغي إبقاؤهما كمسارات تشغيلية عامة:

| المسار | السلوك الحالي | الحماية الناقصة |
|---|---|---|
| `POST /stores/:storeSlug/account/register` | يستدعي `registerCustomer(..., requirePhone: false)` ويعيد account فقط. | لا `requireTrustedWriteOrigin`، لا `limitStorefrontWrite`، لا session Cookie، لا Guest→Customer cart merge، ولا هاتف إلزامي. |
| `POST /stores/:storeSlug/account/login` | يستدعي `loginCustomer(..., requirePhone: false)` ويعيد access token/redirect. | لا `requireTrustedWriteOrigin`، لا `limitStorefrontWrite`، لا customer Cookie، لا merge لسلة الضيف، ويسمح بتسجيل الدخول بالبريد legacy بدلاً من الهاتف الإلزامي. |

المسارات المقابلة في 9A هي `/store/:storeSlug/account/register` و`/store/:storeSlug/account/login`. وهي تطبق Origin check، rate limit، `requirePhone: true`، customer session Cookie ضمن المسار المتجري، ودمج سلة الضيف بعد المصادقة الناجحة.

## الأدلة

| المصدر | الدليل |
|---|---|
| `phase1-backend/src/http/app.ts:204–205` | aliases القديمة تستدعي `requirePhone: false` مباشرة، من دون `requireTrustedWriteOrigin` أو rate limit أو cookie أو merge. |
| `phase1-backend/src/http/app.ts:254–274` | Storefront routes الجديدة تطبق `requireTrustedWriteOrigin` و`limitStorefrontWrite` و`requirePhone: true` و`setCustomerSession` و`mergeGuestCartIntoCustomer`. |
| `phase1-backend/src/auth/auth.service.ts:54–64` | عند `requirePhone=false` يسمح التسجيل بغياب الهاتف إذا وُجد البريد، ويرمي شرط البريد legacy فقط. |
| `phase1-backend/src/auth/auth.service.ts:67–79` | عند `requirePhone=false` يسمح الدخول بالبريد؛ يعيد access token ولا ينشئ Cookie أو cart merge بنفسه. |

## الأثر الأمني والوظيفي

هذه ليست مجرد aliases متوافقة: إنها مسارات عامة بديلة تستطيع تجاوز هوية الهاتف الإلزامية، وحماية Origin، وحد المعدل، ودورة Cookie/merge المعتمدة في 9A. لا يظهر من الكود أنها مستخدمة في صفحات Storefront الجديدة، لأن طبقة الواجهة تستدعي `/api/store/...`، لكن وجودها التشغيلي يظل سطحاً متباين الحماية.

## التوصية

**التوصية: توحيد aliases القديمة مع مسارات Storefront المحمية، مع إبقاء الردود المتوافقة حيثما يلزم، بدلاً من حذفها مباشرة.**

السبب هو أن تقرير 9A يذكر هذه المسارات كـaliases انتقالية، والحذف المباشر قد يكسر اختبارات المرحلة الأولى أو أي مستهلك legacy غير موثق. التوحيد المقترح، بعد الموافقة، يجب أن يجعلها تمر عبر الحماية نفسها كاملة: Origin check، rate limit، هاتف إلزامي، session Cookie، وGuest→Customer merge. ثم تضاف اختبارات توافق صريحة قبل اعتبار حذفها في مرحلة لاحقة.

> **القرار المطلوب عند البوابة:** هل توافق على **توحيد aliases القديمة مع مسارات Storefront بنفس الحماية** مع الحفاظ على توافق الرد الممكن، أم تطلب **حذفها** بعد مراجعة تأثيره على توافق المرحلة الأولى؟

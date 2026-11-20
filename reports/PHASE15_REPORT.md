# تقرير المرحلة 15 — الإشعارات عبر Outbox

**الحالة:** التنفيذ مكتمل على الفرع `phase15-notifications-outbox` وكل بوابات القبول المحلية خضراء. الدمج عبر PR بعد اخضرار `ci / integration`، وبعد دمج المرحلة 14 (PR #7) الذي يسبقه في السلسلة.

**سند القرارات:** بموجب التفويض الكامل من المالك (2026-08-25)، حُسم قرارا الخطة المفوضان — القناة الأولى (بريد عبر SMTP مجرد، وSMS العراقي stub صريح) ونمط العامل (عملية نظام مستقلة) — وتوثيقهما في `docs/adr/ADR-004-notification-outbox-and-provider.md`.

## النطاق المنفذ مقابل متطلبات الخطة

| المتطلب الرسمي | التنفيذ |
|---|---|
| `notification_outbox` في نفس المعاملة | هجرة `20260825120000_phase15_notification_outbox` + كتابة داخل نفس `TransactionClient` في checkout (Serializable) وانتقالات الحالة وكل مسارات إنقاص المخزون (كتالوج + إتمام storefront) |
| الأحداث الثلاثة | `order.created` (تاجر + زبون عند توفر بريده)، `order.status_changed` (تاجر + زبون)، `low_stock` بدلالة **عبور الحد** مع dedupe فريد |
| عامل منفصل | `dist/worker.js` عملية OS مستقلة؛ claim ذري موسوم، backoff أسّي 30s×2^n، `dead_letter` بعد 5، و`skipped` الصادق عند غياب مزود/عنوان |
| Provider abstraction | `sendEmail`/`sendSms` واجهة واحدة؛ مزود حقيقي واحد (SMTP عبر env) + stub SMS + مزود وهمي للاختبارات |
| تفعيل `notification_settings` | مفتاح `isEnabled` + تفضيلات ثلاث لكل متجر عبر API محكومة بـ`settings.manage` بقائمة سماح صارمة، دون كشف أي secret |
| سجل لوحة التاجر | `GET .../notifications/log` مرقّم بملخصات آمنة فقط؛ واجهة `NotificationCenter` في لوحة التاجر وقسم إعدادات لوحة الموظف (أُغلق placeholder الإعدادات) |

## عقود API الجديدة

| المسار | التفويض | النجاح | الرفض |
|---|---|---|---|
| `GET /api/merchant/stores/:slug/notifications/settings` | مالك المتجر أو staff بـ`settings.manage` | `200` عرض آمن (بلا apiKey) | `403 STAFF_PERMISSION_DENIED` / `403 STORE_BOUNDARY_DENIED` |
| `PUT` نفسه | نفسه + Origin موثوق | `200` بعد allowlist (`isEnabled`, `preferences.{orderCreated,orderStatusChanged,lowStock}`) | `422` لأي مفتاح/نوع غريب |
| `GET .../notifications/log?limit&cursor` | نفسه | `200` صفوف بحالة الإرسال والمحاولات وملخص آمن | كما أعلاه |

## بوابة القبول — النتائج الفعلية

| الفحص | النتيجة |
|---|---:|
| `pnpm check` / `phase1:typecheck` / `pnpm build` (بما فيه bundle العامل) | PASS |
| `migrate deploy` للهجرات العشر ثم `migrate status` | PASS نظيف |
| **الذرية**: checkout حقيقي ⇒ صفا order.created في نفس المعاملة؛ replay بمفتاح idempotency لا يضيف شيئاً؛ معاملة مُجهضة تُظهر الصفوف داخلها ولا تُبقي أثراً بعد التراجع | PASS |
| تغيير حالة مخوّل (بجلسة staff حقيقية) ⇒ صفان؛ محاولة تاجر آخر ⇒ `403` وصفر صفوف | PASS |
| low_stock: العبور يطلق مرة؛ البقاء منخفضاً لا يكرر؛ إعادة التعبئة ثم عبور جديد يطلق ثانية | PASS |
| بوابة التفضيلات: إيقاف `orderStatusChanged` يحذف صف التاجر ويبقي صف الزبون | PASS |
| العامل: نجاح الدفعة الأولى بالكامل؛ فشل مصطنع ⇒ `retry_scheduled` بمحاولة 1 وbackoff مستقبلي؛ غير مستحق لا يُلتقط؛ يُرسل عند استحقاقه | PASS |
| dead_letter بعد 5 محاولات فاشلة بالضبط | PASS |
| **التسليم exactly-once**: عاملان متسابقان على 6 صفوف ⇒ 6 إرسالات بالضبط | PASS |
| بلا مزود ⇒ `skipped` بنتيجة `no_provider_configured` (لا ادعاء إرسال) | PASS |
| العزل: تاجر آخر `403` للإعدادات والسجل؛ store_staff بلا `settings.manage` ⇒ `403 STAFF_PERMISSION_DENIED` (تغطية endpoint لهذا الكود أخيراً)؛ ترقيته store_manager ⇒ `200`؛ سجل متجر باء فارغ | PASS |
| متجر معطّل الإشعارات لا يُدرج شيئاً إطلاقاً | PASS |
| `pnpm phase15:browser`: حالة فارغة ← تفعيل من الواجهة (PUT 200) ← checkout حقيقي ← ظهور الصف برقم الطلب وحالته في السجل (لقطتان) | PASS |
| الانحدار التكاملي 1، 5، 6، 7، 8A، 9A، 13، 14 | PASS جميعها |
| انحدار المتصفح 6، 8B، 9B (+cookie)، 13، 14 | PASS جميعها |

## إصلاح حتمية موثق

اكتُشف انحراف ساعة بين حاوية PostgreSQL (WSL) ومضيف Windows جعل صفوف الاختبار الاصطناعية «غير مستحقة» لحظياً. صفوف الاختبار الاصطناعية تثبّت الآن `nextAttemptAt` في الماضي صراحة (تشغيلان متتاليان PASS). دلالة الإنتاج لم تتغير (انحراف الثواني يعني تأخيراً بريئاً لا فقداناً).

## خارج النطاق (كما تنص الخطة)

حملات جماعية، مزودون متعددون، webhooks واردة، دفع/توصيل، وأي تعديل على هوية/صلاحيات المرحلة 14 أو production. تفعيل القناة فعلياً على staging يتطلب فقط إضافة متغيرات SMTP إلى بيئة Railway.

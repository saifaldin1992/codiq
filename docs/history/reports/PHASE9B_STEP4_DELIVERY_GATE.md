# بوابة الخطوة 4 — تدقيق تكلفة التوصيل في Checkout

**الحالة:** قرار مالك المشروع مطلوب قبل أي تنفيذ.
**نطاق هذه الوثيقة:** مراجعة قراءة فقط للكود والمخطط الحاليين؛ لم تُنفذ migration أو تعديلات على checkout.

## النتيجة

لا يقرأ Checkout الحالي جدول `delivery_rates`، ولا يحسب تكلفة التوصيل بحسب المحافظة، ولا يكتب قيمة محسوبة في `delivery_fee_iqd`. ينشئ الطلب بقيمة `total_iqd = subtotal_iqd` ويترك `delivery_fee_iqd` على قيمته الافتراضية `0`.

## الأدلة

| المصدر | الدليل الفعلي |
|---|---|
| `phase1-backend/src/services/storefront.service.ts:228–237` | checkout يجلب/ينشئ العنوان ويأخذ `governorate` منه فقط؛ لا يوجد استعلام `deliveryRate` أو `delivery_rates`. |
| `phase1-backend/src/services/storefront.service.ts:245–294` | معاملة checkout تحسب `subtotalIqd` فقط، ثم تنشئ الطلب بـ`totalIqd: subtotalIqd`، من دون `deliveryFeeIqd` أو قراءة rate حسب المحافظة. |
| `prisma/schema.prisma:124–136` | يوجد جدول `delivery_rates` مقيد بـ`storeId + governorate`، ويحمل `amountIqd` و`isEnabled`. |
| `prisma/schema.prisma:256–279` | يوجد في الطلب `deliveryFeeIqd` بقيمة افتراضية `0`، وحقل المحافظة؛ البنية تستوعب التسعير لكن checkout لا يستعملها. |
| `phase1-backend/src/services/store-bootstrap.service.ts:32` | تؤسس المتاجر صفوف المحافظات بقيمة `0` و`isEnabled: false`، وهي ليست تكلفة شحن تشغيلية فعالة. |

## الاستنتاج

لا يمكن تقديم اختبار نجاح لتسعير التوصيل الآن، لأن السلوك غير منفذ. هذا ليس خللاً في حجز المخزون أو idempotency؛ إنه فجوة وظيفية مستقلة في حساب سعر الطلب.

## خيارا القرار

| الخيار | ما سينفذ | أثره | هل يحتاج migration؟ |
|---|---|---|---|
| **A — إضافتها الآن ضمن 9B** | القراءة المتزامنة لـ`delivery_rates` ضمن transaction، التحقق من governorate/rate المفعّل، snapshot لـ`deliveryFeeIqd`، ثم `totalIqd = subtotalIqd + deliveryFeeIqd` مع تحديث fingerprint واختبارات negative/idempotency. | يغير عقد Checkout 9A وسلوك إجمالي الطلب، ويستلزم مراجعة شاملة لاختبارات الأسعار وidempotency. | **لا**؛ الحقول والجدول موجودان بالفعل. |
| **B — تأجيل صريح** | الإبقاء على COD بسعر منتجات فقط و`delivery_fee_iqd=0`، وتسجيل أن تسعير التوصيل خارج نطاق 9B الحالي. | لا يغير عقود أو معاملات 9A؛ يجب أن تمنع واجهة المتجر أي ادعاء بأن الإجمالي يشمل تكلفة توصيل محسوبة. | لا. |

> **القرار المطلوب عند البوابة:** هل توافق على الخيار **A** لإضافة تسعير التوصيل الآن ضمن 9B، أم الخيار **B** لتأجيله صراحةً؟

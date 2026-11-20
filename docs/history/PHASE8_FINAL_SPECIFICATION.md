# codiq — مواصفات المرحلة الثامنة النهائية قبل التنفيذ

**الحالة:** وثيقة موافقة فقط؛ لا كود، ولا migration، ولا commit، ولا تغيير في `main`.  
**الهدف:** إدارة دورة حياة الطلبات الموجودة بأمان داخل متجر واحد للتاجر، مع إشراف قراءة عالمي لمالك المنصة.  
**غير مشمول:** إنشاء الطلب، العميل تشغيليًا، Storefront، Checkout، الدفع، الشحن، المخزون الآلي، والاشتراكات.

> هذه الوثيقة هي النسخة المرجعية النهائية للمرحلة الثامنة. تستبدل أي صياغة سابقة متعارضة وتُقرأ بجانب `PHASE8_ARCHITECTURAL_REVIEW.md` و`PROJECT_ENGINEERING_PRINCIPLES.md`.

## A. State Machine النهائية

كل انتقال يحدث داخل معاملة PostgreSQL/Prisma واحدة، يزيد `version` بمقدار واحد، ويضيف صفًا واحدًا إلى `order_status_events`. لا يوجد انتقال رجوعي إلى `new`، ولا توجد إعادة فتح لحالة نهائية.

| الحالة الحالية | التسميات العربية في الواجهة | الحالات التالية المسموحة | الحالة النهائية |
|---|---|---|---|
| `new` | جديدة / بحاجة لإجراء | `processing`، `cancelled`، `rejected` | لا |
| `processing` | قيد المعالجة | `preparation`، `cancelled` | لا |
| `preparation` | قيد التجهيز | `out_for_delivery`، `cancelled` | لا |
| `out_for_delivery` | قيد التوصيل | `completed`، `returned` | لا |
| `completed` | مكتملة | `returned` | لا |
| `cancelled` | ملغاة | لا شيء | نعم |
| `rejected` | مرفوضة | لا شيء | نعم |
| `returned` | مرتجعة | لا شيء | نعم |

| القاعدة | الاستجابة الإلزامية |
|---|---|
| أي انتقال غير وارد في الجدول، ومنها `processing → new` | `422 / INVALID_ORDER_TRANSITION` |
| `completed → returned` | مشروع؛ يحدث التحديث والحدث معًا. |
| نسختان متنافستان من `expectedVersion` نفسه | طلب واحد `200` والثاني `409 / ORDER_VERSION_CONFLICT`. |
| حالة نهائية إلى أي حالة | `422 / INVALID_ORDER_TRANSITION`. |

## B. Acceptance Criteria النهائية

| المجال | معيار القبول الإلزامي |
|---|---|
| قائمة التاجر | تعرض طلبات متجر جلسة التاجر فقط، بحد افتراضي 25 وcursor وترشيح `status` و`from` و`to` و`q`. |
| تفاصيل الطلب | تعرض snapshots البنود والأسعار والإجمالي ومصدر الطلب وسجل الحالة؛ لا تتغير عند تعديل المنتج لاحقًا. |
| انتقال صحيح | `new → processing` يعيد `200`، يزيد النسخة، ويضيف حدثًا واحدًا يتضمن الحالة السابقة والجديدة والفاعل والوقت. |
| انتقال معتمد نهائي | `completed → returned` يعيد `200` ويضيف حدثًا مطابقًا ولا يعيد فتح الطلب. |
| انتقال ممنوع | `processing → new` و`new → completed` يعيدان `422` ولا يعدلان الطلب ولا ينشئان حدثًا. |
| إلغاء بعد التوصيل | `out_for_delivery → cancelled` يعيد `422 / INVALID_ORDER_TRANSITION`؛ لا تعديل ولا حدث. |
| التزامن | تغييرين بنفس النسخة: واحد فقط ينجح؛ الآخر `409` بلا حدث إضافي. |
| إشراف المالك | يعرض طلبات المتاجر A وB وتفاصيلها وسجلها عبر مسارات المنصة؛ لا زر ولا endpoint تغيير حالة. |
| عزل التاجر | slug متجر آخر يعيد `403`، و`orderId` لمتجر آخر تحت slug صحيح يعيد `404`، ولا يتغير طلب أو سجل. |
| العميل | أي Customer token لمسار طلبات التاجر أو المالك يعيد `403 / IDENTITY_BOUNDARY_DENIED`. |
| المخزون | لا تتغير `stock_quantity` ولا `inventory_movements` عند أي انتقال حالة. |
| الأداء | قوائم الطلبات لا تجلب مجموعة غير محدودة، وتستعمل فهارس المتجر/الحالة/الوقت. |

## C. جميع Database Changes المقترحة

كل التغييرات **additive-first** ولا تُنفذ قبل الموافقة. لا يوجد `DROP` أو حذف بيانات أو تحويل تخميني للبيانات القديمة.

| الجدول | التغيير المقترح | القيد أو الغرض |
|---|---|---|
| `store_orders` | `customer_id UUID NULL` | FK إلى `customers` بـ`ON DELETE RESTRICT`؛ حقل توافق فقط، بلا Customer endpoint أو منطق عميل في هذه المرحلة. |
| `store_orders` | `customer_email`, `recipient_phone`, `shipping_governorate`, `shipping_address_line1`, `shipping_address_line2` nullable | snapshots مستقبلية للطلب؛ لا CRUD عناوين في المرحلة. |
| `store_orders` | `subtotal_iqd`, `delivery_fee_iqd DEFAULT 0`, `discount_iqd DEFAULT 0` | تركيب إجمالي مستقبلي مع تحقق مبالغ غير سالبة. |
| `store_orders` | `payment_status DEFAULT 'unpaid'`, `source DEFAULT 'legacy'` | توافق دفع ومصدر طلب لاحق؛ لا دفع أو إنشاء طلب الآن. |
| `store_orders` | `version DEFAULT 1`, `status_updated_at`, `updated_by_kind` nullable | optimistic concurrency وتدقيق تشغيل الحالة. |
| `store_orders` | CHECK لحالات الطلب المعتمدة، يطبق كـ`NOT VALID` ثم `VALIDATE`. | يمنع حالة مستقبلية غير معتمدة بعد فحص القيم القديمة. |
| `order_items` | `sku` snapshot nullable | توافق كتالوج مستقبلي؛ تبقى snapshots الاسم/السعر القائمة مصدر الحقيقة. |
| `order_status_events` جديد | `id`, `store_id`, `order_id`, `from_status`, `to_status`, `actor_kind`, `actor_id`, `note`, `created_at` | سجل append-only؛ `actor_kind` يسمح بالقيم المستقبلية `merchant`, `platform_owner`, `customer`, `system` لكن المرحلة تستخدم `merchant` فقط. |

### الفهارس وTriggers

| العنصر | الغرض |
|---|---|
| `store_orders(store_id, status, created_at DESC, id DESC)` | قائمة حالة التاجر والـcursor. |
| `store_orders(store_id, created_at DESC, id DESC)` | قائمة جميع طلبات متجر واحد. |
| `store_orders(status, created_at DESC, id DESC)` | إشراف مالك المنصة بمرشح حالة. |
| `order_status_events(store_id, order_id, created_at DESC)` | سجل طلب سريع ومقيد بالمتجر. |
| Trigger سلامة الحدث | يرفض event يربط `store_id` بطلب يعود إلى متجر آخر. |
| Trigger immutability | يرفض `UPDATE` أو `DELETE` على `order_status_events`، حتى عند تجاوز API. |

في الإنتاج ذي الجداول الكبيرة، تنشأ الفهارس الجديدة عبر `CREATE INDEX CONCURRENTLY` في خطوة تشغيل منفصلة قابلة للرصد لتفادي قفل طويل.

## D. جميع API Endpoints

### التاجر — تتطلب جلسة `merchant` وتطابق `storeSlug` مع `claims.storeId` وملكية التاجر

| الطريقة والمسار | الوظيفة | النتيجة الناجحة |
|---|---|---:|
| `GET /api/merchant/stores/:storeSlug/orders` | قائمة cursor-paginated؛ `status`, `from`, `to`, `q`, `limit`, `cursor`. | `200` |
| `GET /api/merchant/stores/:storeSlug/orders/:orderId` | تفاصيل الطلب وبنوده وsnapshots وسجل الحالة. | `200` |
| `POST /api/merchant/stores/:storeSlug/orders/:orderId/status` | `toStatus`, `expectedVersion`, `note?`؛ يطبق State Machine. | `200` |
| `GET /api/merchant/stores/:storeSlug/orders/:orderId/history` | سجل الأحداث append-only. | `200` |

### مالك المنصة — تتطلب جلسة `platform_owner` فقط، للقراءة فقط

| الطريقة والمسار | الوظيفة | النتيجة الناجحة |
|---|---|---:|
| `GET /api/platform/orders` | قائمة عالمية؛ `storeSlug`, `merchantId`, `status`, `from`, `to`, `q`, `limit`, `cursor`. | `200` |
| `GET /api/platform/orders/:orderId` | تفاصيل عالميّة للطلب مع المتجر والتاجر والبنود والسجل. | `200` |
| `GET /api/platform/orders/:orderId/history` | سجل الأحداث العالمي. | `200` |

لا توجد API للعميل، ولا API للاشتراكات أو الخطط أو feature gating، ولا API لإنشاء طلب أو دفع أو شحن. لا يقبل أي endpoint `storeId` من body أو query لتحديد حدود التفويض.

## E. جميع الصفحات

### لوحة التاجر

| الصفحة | المسار | التغيير |
|---|---|---|
| جميع الطلبات | `/merchant/stores/{storeSlug}/dashboard/orders` | قائمة فعلية بترشيح وبحث وcursor pagination. |
| بحاجة لإجراء / جديدة | `/orders/action-needed` و`/orders/new` | مرشح `new`؛ يسمح فقط بالانتقالات المباشرة المعروضة. |
| قيد المعالجة | `/orders/processing` | مرشح `processing`. |
| قيد التجهيز | `/orders/preparation` | مرشح `preparation`. |
| قيد التوصيل | `/orders/out-for-delivery` | مرشح `out_for_delivery`. |
| مكتملة / ملغاة / مرفوضة / مرتجعة | مساراتها الحالية المقابلة | قوائم قراءة مرشحة بالحالة. |
| تفاصيل الطلب | `/merchant/stores/{storeSlug}/dashboard/orders/{orderId}` | تفاصيل وسجل حالة وزر انتقال للحالات التالية المسموحة فقط. |

تبقى صفحات التسليم والتسويات والتقارير placeholders.

### لوحة مالك المنصة

| الصفحة | المسار | التغيير |
|---|---|---|
| جميع الطلبات | `/platform/dashboard/orders` | قائمة إشراف عالمية مقسمة إلى صفحات مع المتجر والتاجر والحالة. |
| صفحات الحالات | مسارات حالات الطلب الحالية | قوائم إشراف قراءة فقط مرشحة بالحالة. |
| تفاصيل الطلب | `/platform/dashboard/orders/{orderId}` | تفاصيل وسجل حالة للقراءة فقط. |

لا تنشأ صفحات Customer أو Storefront أو Checkout أو Subscription في هذه المرحلة.

## F. كل ما لن يُنفذ في المرحلة الثامنة

| المجال المؤجل | ما لا ينفذ الآن |
|---|---|
| Customer | Account، Profile، Addresses، Storefront endpoints، order endpoints، أو أي منطق عميل تشغيلي. |
| Storefront وCheckout | Host/domain resolving، واجهة عامة، Cart، Checkout، إنشاء طلب، Guest Checkout. |
| الدفع والتسليم | COD confirmation، بوابات الدفع، شركات الشحن، رسوم توصيل محسوبة، تتبع أو تسليم فعلي. |
| المخزون | حجز، خصم، استعادة، منع oversell، أو أي حركة عند تغيير الحالة. |
| الاشتراكات | `plans`، `plan_features`، `merchant_subscriptions`، `subscription_usage`، وFeature Gating. |
| المنصة | تسويات، عمولات، فواتير، تقارير مالية، استثناء تعديل إداري للمالك. |
| التكاملات | رسائل، Webhooks، queues، إشعارات، أو معالجة خلفية مجدولة. |

## G. نقاط التوافق المستقبلي

| المحور | ما تحافظ عليه المرحلة الثامنة | ما يؤجل صراحة |
|---|---|---|
| Storefront | `store_id` وحدود نطاق المتجر وsnapshots الطلب تسمح بواجهة عامة لاحقًا. | route resolving والنطاقات وواجهة الكتالوج العامة. |
| Customer | `customer_id` nullable وsnapshots؛ الهوية المحلية المنفصلة تبقى آمنة. | حساب العميل وملفه وعناوينه وطلباته. |
| Checkout | تركيب الإجمالي و`source` ونسخ بنود الطلب جاهزة لإنشاء ذري لاحقًا. | Cart، validation، إنشاء طلب، والدفع. |
| Subscription | لا يوجد افتراض بحدود خطة داخل أوامر المرحلة. | plans وentitlements وfeature limits؛ نقطة الدمج المستقبلية قبل أوامر الإنشاء فقط. |
| PostgreSQL/Prisma/Express | هجرات additive، فهارس متجرية، معاملات ذرية، وخدمات مقيدة بالجلسة. | أي تغيير معماري أو MySQL/tRPC. |
| R2/S3-compatible | صور المنتجات تبقى مراجعها مستقلة عن الطلب. | وثائق شحن أو ملفات طلب جديدة. |

## بوابة الموافقة النهائية

يتطلب بدء التنفيذ موافقة صريحة على البنود A–G أعلاه. بعد الموافقة فقط يقسم التنفيذ إلى **8A** (المخطط، الخدمة، المعاملات، Triggers، اختبارات IDOR) و**8B** (الواجهات، اختبار المتصفح، Acceptance Tests). لا يُنفذ أي migration destructive أو تغيير في `main` قبل هذه الموافقة.

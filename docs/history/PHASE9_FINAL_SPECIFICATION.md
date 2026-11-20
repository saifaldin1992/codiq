# المرحلة 9 — واجهة المتجر وحساب الزبون

**الحالة:** النسخة النهائية للمراجعة قبل التنفيذ.  
**قرار ملزم:** لا يبدأ أي كود للمرحلة 9، ولا migration، ولا تعديل قاعدة بيانات، ولا commit قبل موافقة صريحة لاحقة على هذه الوثيقة.  
**القرارات المثبتة:** سلة موحدة، دخول الهاتف وكلمة المرور مع بريد اختياري، بصمة SHA-256 لرمز سلة الضيف فقط، وحجز مخزون منفصل عند checkout من دون جعل خدمة انتقال حالات 8A العامة تعدل المخزون مباشرة.

---

## A. الهدف وحدود المرحلة

تبني المرحلة 9 سطح Storefront وظيفياً منفصلاً عن لوحة التاجر والمالك. يستطيع الزائر تصفح منتجات متجر واحد وسلته، ثم يسجل أو يدخل بهوية زبون خاصة بذلك المتجر عند تأكيد طلب COD. بعد ذلك يراجع الزبون طلباته وتفاصيلها وسجل التتبع الآمن. لا تغير المرحلة 9 صلاحيات المنصة أو التاجر ولا تستبدل PostgreSQL أو Express أو Prisma أو التخزين المتوافق مع S3.

يعالج التنفيذ على مرحلتين فرعيتين متتاليتين داخل المرحلة 9، حفاظاً على بوابة إثبات واضحة:

| المرحلة الفرعية | النطاق | بوابة الإغلاق |
|---|---|---|
| **9A** | المخطط، الهوية، السلات، الدمج، checkout، حجز المخزون، وواجهات API واختبارات العزل. | اجتياز اختبارات قاعدة البيانات وIDOR والتزامن والحجز قبل واجهات Storefront. |
| **9B** | صفحات الكتالوج والسلة والحساب والطلبات واختبارات المتصفح وقبول المستخدم. | اجتياز سيناريوهات الواجهة والـRegression قبل طلب اعتماد المرحلة 9. |

| داخل التنفيذ | خارج التنفيذ الصريح |
|---|---|
| كتالوج عام وسلة ضيف/عميل وcheckout COD. | SMS/OTP أو مزود رسائل أو إثبات الهاتف فعلياً. |
| حساب زبون هاتف/كلمة مرور وعناوين وسجل طلبات. | دفع إلكتروني أو بطاقات أو محافظ أو تحصيل مزود خارجي. |
| حجز مخزون عند إنشاء طلب Storefront وتسويته عند اكتمال/إرجاع الطلب. | كوبونات وخصومات وشحن طرف ثالث وإشعارات وتقييمات. |
| One UI وظيفي RTL وحالات loading/error/empty. | صقل تصميم نهائي وقوالب متجر متقدمة وCMS وSEO متقدم. |
| تنظيف كسول للسلات المنتهية. | مؤقتات داخل process أو تنظيف مجدول؛ ينظر إليه كتطوير تشغيلي لاحق مستقل. |

---

## B. Prisma / PostgreSQL Schema Changes النهائية

تطبق هذه التغييرات بهجرات PostgreSQL additive-first بعد الموافقة. لا تحمل الهجرة بيانات اختبار جديدة، ولا تنسخ الأسرار، ولا تسقط أعمدة أو جداول موجودة من دون خطة انتقال صريحة. كل قيود العزل المهمة تطبق في PostgreSQL، لا في React أو Express فقط.

### B.1 تعديل `customers`

حقل `password_hash` وحقل `phone` موجودان بالفعل. التغيير الفعلي هو نقل تعريف الدخول إلى هاتف معياري وترك البريد اختيارياً، مع الحفاظ على الحسابات اليدوية القديمة التي قد تملك بريداً ولا تملك هاتفاً بعد.

| العمود أو الفهرس | Prisma / PostgreSQL النهائي | الغرض |
|---|---|---|
| `email` | `text NULL` | البريد اختيارياً للـStorefront؛ لا يولد بريد مزيف. |
| `phone` | `text NULL` | قيمة العرض الأصلية التي يكتبها المستخدم إن احتفظنا بها. |
| `phone_normalized` | `text NULL` | الهاتف بصيغة E.164؛ المعرف الفعلي لتسجيل ودخول العميل. |
| `phone_verified_at` | `timestamptz NULL` | جاهزية OTP فقط؛ لا تفعّل SMS في هذه المرحلة. |
| `password_hash` | قائم، غير قابل للإرجاع | كلمة المرور لا تحفظ أبداً كنص صريح. |
| `customers_store_email_present_uq` | `UNIQUE (store_id, email) WHERE email IS NOT NULL` | يمنع تكرار البريد داخل المتجر عند وجوده فقط. |
| `customers_store_phone_present_uq` | `UNIQUE (store_id, phone_normalized) WHERE phone_normalized IS NOT NULL` | يمنع تكرار الهاتف المعياري في متجر واحد، ويسمح به في متجر آخر. |
| `customers_store_phone_idx` | `INDEX (store_id, phone_normalized)` | مسار login وتحديد الحساب داخل tenant. |
| `customers_id_store_uq` | `UNIQUE (id, store_id)` | مرجع مركب من العناوين والطلبات يثبت أن العميل يخص المتجر نفسه. |

كل تسجيل Storefront جديد يتطلب `phone_normalized` و`full_name` وكلمة مرور صالحة. لا يجعل الهاتف غير الموثق «موثقاً» لمجرد التسجيل؛ تعني `phone_verified_at = NULL` أن SMS/OTP لم ينفذ بعد. الحساب اليدوي القديم الذي لا هاتف له لا يدخل بهاتف حتى يحدث التاجر ملفه مستقبلاً.

### B.2 جدول السلة الموحد `shopping_carts`

لا يستخدم التصميم جدول `guest_carts` منفصلاً أو علاقة `cart_items` polymorphic. الجدول الموحد يجعل كل item مرتبطاً بسلة واحدة يحميها FK قياسي.

| العمود | النوع والقاعدة |
|---|---|
| `id`, `store_id` | UUID؛ مع unique مركب `(id, store_id)`. |
| `owner_kind` | `text NOT NULL CHECK (owner_kind IN ('guest','customer'))`. |
| `customer_id` | UUID nullable؛ يملأ لسلة العميل فقط. |
| `session_token_hash` | `text nullable`؛ SHA-256 hex لرمز الضيف فقط، ولا يخزن الرمز الخام. |
| `status` | `text NOT NULL CHECK (status IN ('active','merged','converted','expired'))`. |
| `version` | `integer NOT NULL DEFAULT 1 CHECK (version > 0)`؛ optimistic concurrency. |
| `expires_at` | `timestamptz nullable`؛ مطلوب للضيف، و`NULL` لسلة العميل النشطة. |
| `last_activity_at`, `created_at`, `updated_at` | تدقيق وتطبيق عمر الضيف. |
| `merged_into_cart_id` | UUID nullable؛ مرجع تدقيقي لسلة العميل التي استقبلت الدمج. |
| `converted_order_id` | UUID nullable؛ مرجع تدقيقي للطلب الناتج من checkout. |

#### قيود `shopping_carts`

| الاسم المنطقي | القيد |
|---|---|
| `shopping_carts_owner_shape_ck` | عندما `owner_kind='guest'`: `customer_id IS NULL` و`session_token_hash IS NOT NULL` و`expires_at IS NOT NULL`. وعندما `owner_kind='customer'`: `customer_id IS NOT NULL` و`session_token_hash IS NULL`. |
| `shopping_carts_customer_store_fk` | `FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT`. |
| `shopping_carts_merged_store_fk` | `FOREIGN KEY (merged_into_cart_id, store_id) REFERENCES shopping_carts(id, store_id) ON DELETE RESTRICT`. |
| `shopping_carts_converted_store_fk` | `FOREIGN KEY (converted_order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT`. |
| `shopping_carts_active_customer_uq` | `UNIQUE (store_id, customer_id) WHERE status='active' AND owner_kind='customer'`. |
| `shopping_carts_active_guest_token_uq` | `UNIQUE (store_id, session_token_hash) WHERE status='active' AND owner_kind='guest'`. |
| `shopping_carts_store_status_expiry_idx` | `INDEX (store_id, status, expires_at)`. |
| `shopping_carts_store_customer_status_idx` | `INDEX (store_id, customer_id, status)`. |

### B.3 جدول `cart_items`

| العمود | النوع والقاعدة |
|---|---|
| `id`, `cart_id`, `store_id`, `product_id` | UUID؛ `store_id` مقصود لحماية FK المركب. |
| `quantity` | `integer NOT NULL CHECK (quantity > 0)`؛ تتأكد الخدمة من حد أعلى منطقي للكمية. |
| `price_snapshot_iqd` | `integer NOT NULL CHECK (price_snapshot_iqd >= 0)`. |
| `created_at`, `updated_at` | `timestamptz`. |

| الاسم المنطقي | القيد أو الفهرس |
|---|---|
| `cart_items_cart_store_fk` | `FOREIGN KEY (cart_id, store_id) REFERENCES shopping_carts(id, store_id) ON DELETE CASCADE`. |
| `cart_items_product_store_fk` | `FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE RESTRICT`. |
| `products_id_store_uq` | إضافة `UNIQUE (id, store_id)` إلى `products` لدعم FK السابق. |
| `cart_items_cart_product_uq` | `UNIQUE (cart_id, product_id)`؛ المنتج نفسه سطر واحد فقط داخل السلة. |
| `cart_items_cart_idx` | `INDEX (cart_id, created_at, id)`. |

هذا القيد المركب يمنع بنيوياً عنصر سلة Store-A من الإشارة إلى منتج Store-B حتى في حال خطأ endpoint أو تغيّر العميل لطلب HTTP يدوياً.

### B.4 جدول `customer_addresses`

| العمود | النوع والقاعدة |
|---|---|
| `id`, `customer_id`, `store_id` | UUID؛ مرجع مركب إلى العميل والمتجر. |
| `recipient_name` | `text NOT NULL`، قيمة تسليم ظاهرة. |
| `full_address` | `text NOT NULL`، لا يجبر على تنسيق مزود شحن في هذه المرحلة. |
| `city`, `governorate` | `text NOT NULL`؛ المحافظة تستخدم لاحقاً في delivery rate. |
| `phone_contact_normalized` | `text NOT NULL` بصيغة E.164. |
| `is_default` | `boolean NOT NULL DEFAULT false`. |
| timestamps | `created_at`, `updated_at`. |

| الاسم المنطقي | القيد أو الفهرس |
|---|---|
| `customer_addresses_customer_store_fk` | `FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT`. |
| `customer_addresses_id_store_uq` | `UNIQUE (id, store_id)`؛ يستخدمه checkout في FK مركب. |
| `customer_addresses_default_uq` | `UNIQUE (customer_id, store_id) WHERE is_default`. |
| `customer_addresses_customer_idx` | `INDEX (store_id, customer_id, created_at DESC, id DESC)`. |

لا يجعل checkout عنواناً حياً مصدراً لتاريخ الطلب. تنسخ بياناته عند الطلب إلى حقول `store_orders` الموجودة بالفعل، لذلك لا يغير تحديث أو حذف عنوان لاحق طلباً سابقاً.

### B.5 جدول `checkout_requests` وسلوك idempotency

مفتاح idempotency لا يخزن كنص خام داخل الطلب. يُستخدم جدول منفصل لأنه يميز بين طلب ناجح وإعادة محاولة متزامنة ومحاولة بالمفتاح نفسه والبيانات المختلفة.

| العمود | القاعدة |
|---|---|
| `id`, `store_id`, `customer_id` | UUID؛ FK مركب للعميل داخل المتجر. |
| `key_hash` | SHA-256 لمفتاح `Idempotency-Key` المرسل في header؛ لا يحفظ المفتاح الخام. |
| `request_fingerprint` | SHA-256 لنسخة السلة والعنوان و`payment_method_code` وبيانات checkout المسموح بها. |
| `status` | `processing` أو `succeeded` أو `failed`. |
| `order_id` | nullable حتى نجاح إنشاء الطلب، ثم FK مركب للطلب والمتجر. |
| `created_at`, `updated_at` | تدقيق زمني. |

| الاسم المنطقي | القيد |
|---|---|
| `checkout_requests_customer_store_fk` | `FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT`. |
| `checkout_requests_order_store_fk` | `FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT`. |
| `checkout_requests_key_uq` | `UNIQUE (store_id, customer_id, key_hash)`. |
| `checkout_requests_lookup_idx` | `INDEX (store_id, customer_id, created_at DESC)`. |

### B.6 تعديل `store_orders` و`order_items`

`customer_id` موجود بالفعل في `store_orders`، لكنه يحتاج ضمان المطابقة مع المتجر. ويضاف ما يلزم للـCOD ومفاتيح العلاقات المركبة فقط.

| التغيير | القاعدة النهائية |
|---|---|
| `store_orders_id_store_uq` | `UNIQUE (id, store_id)` لدعم مراجع السلات والحجوزات والطلبات المتشعبة. |
| `store_orders_customer_store_fk` | استبدال FK المفرد بـ`FOREIGN KEY (customer_id, store_id) REFERENCES customers(id, store_id) ON DELETE RESTRICT`. يبقى `customer_id` nullable للبيانات legacy فقط؛ كل طلب Storefront جديد يفرضه التطبيق. |
| `payment_method_code` | `text NOT NULL DEFAULT 'legacy'` مع CHECK يسمح `legacy` و`cod` فقط في هذه المرحلة. |
| `source` | الطلب الجديد يحفظ `storefront`؛ يسمح قيد المصدر بالقيم الموجودة `legacy` و`storefront`. |
| `order_status_events` | عند إنشاء Storefront order، insert وحيد append-only: `NULL → new`, `actor_kind='customer'`, و`actor_id=customer_id`. قيد 8A يسمح `customer` بالفعل. |
| `order_items` | تستمر لقطات الاسم وSKU والسعر والكمية والإجمالي؛ لا حاجة لعمود سلة أو cart ID في order item. |

لا يضاف `guest_cart_id` إلى `store_orders`. بعد الدمج أو checkout تكون سلة الضيف في حالة غير نشطة، والربط التدقيقي الآمن يكون من `shopping_carts.converted_order_id` إلى الطلب، لا بالعكس.

### B.7 جدول `inventory_reservations`

الحجز يفصل **المتاح للبيع** عن كمية المخزون الفعلية. لا ينقص `products.stock_quantity` عند إنشاء الطلب؛ بدلاً من ذلك لا يسمح checkout جديد بتجاوز `stock_quantity - active_reservations`.

| العمود | النوع والقاعدة |
|---|---|
| `id`, `store_id`, `order_id`, `product_id` | UUID؛ روابط مركبة إلى الطلب والمنتج داخل المتجر. |
| `quantity` | `integer NOT NULL CHECK (quantity > 0)`. |
| `status` | `active`, `released`, `consumed` عبر CHECK؛ لا تصبح عودة البضاعة قراراً مخزنياً تلقائياً. |
| `return_disposition` | `text NOT NULL DEFAULT 'not_returned' CHECK (return_disposition IN ('not_returned','pending_inspection'))`. |
| `release_reason` | nullable؛ `cancelled`, `rejected` أو future `expired`. لا يستخدم للإرجاع. |
| `created_at`, `released_at`, `consumed_at`, `returned_at` | تدقيق كامل لدورة الحجز. |

| الاسم المنطقي | القيد أو الفهرس |
|---|---|
| `inventory_reservations_order_product_uq` | `UNIQUE (order_id, product_id)`؛ حجز واحد لكل بند طلب. |
| `inventory_reservations_order_store_fk` | `FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT`. |
| `inventory_reservations_product_store_fk` | `FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE RESTRICT`. |
| `inventory_reservations_available_idx` | `INDEX (store_id, product_id) WHERE status='active'`. |
| `inventory_reservations_order_idx` | `INDEX (store_id, order_id, status)`. |

لا يوجد `expires_at` للحجز النشط في المرحلة 9. إنقاص الحجز بمرور الوقت بينما الطلب ما زال مفتوحاً يعيد خطر oversell ويخالف الوعد للزبون. **انتهاء السلة** يسبق الحجز؛ أما الحجز لا ينتهي إلا بانتقال حالة واضح أو workflow مستقبلية تضيف حالة order انتهاء صريحة. عند حالة الطلب `returned` يسجل `return_disposition='pending_inspection'` فقط؛ لا يُعاد المنتج إلى المتاح قبل فحص مستقل لاحق. هذا قرار متعمد، لا نقص وظيفي.

---

## C. دورة حياة السلة، الدمج، الجلسات، والتزامن

### C.1 دورة حياة `shopping_carts`

```text
لا سلة
  └─ أول POST لإضافة منتج ─→ guest / active

guest / active ── تسجيل أو دخول ناجح ─→ merged → customer / active
customer / active ── checkout ناجح ─→ converted
guest / active ── expires_at <= now ─→ expired
```

إنشاء cart ضيف عند أول كتابة فقط يمنع ملء قاعدة البيانات بسلات لزوار كتالوج لم يضيفوا شيئاً. يولد الخادم token عشوائياً من cryptographic source، يرسل token في cookie متجرية، ويخزن SHA-256 فقط. يمدد `expires_at` إلى سبعة أيام عند النشاط الكتابي الناجح؛ لا يعيد access لسلة انتهت صلاحيتها حتى لو أعيد token قديم.

### C.2 عزل cookie والجلسة

| النوع | الاسم المقترح | خصائص الكوكي | قاعدة التفويض |
|---|---|---|---|
| سلة ضيف | `codiq_cart_{storeSlug}` | `HttpOnly`, `Secure` في الإنتاج، `SameSite=Lax`, `Path=/api/store/{storeSlug}`، عمر أقصى حتى expiry. | يتم حل المتجر من path ثم مطابقة `store_id + SHA-256(cookie) + status=active + expires_at>now`. |
| جلسة عميل | `codiq_customer_session_{storeSlug}` | `HttpOnly`, `Secure` في الإنتاج، `SameSite=Lax`, `Path=/api/store/{storeSlug}`، عمر 8 ساعات أو السياسة المعتمدة. | `verifyTypedSession(...,'customer')` ثم `customer.store_id = resolvedStore.id`. |

لا تستخدم المرحلة 9 cookie التاجر/المالك، ولا تقبل `cartId`, `customerId`, `storeId` أو raw token من body. في الطلبات المسببة للكتابة تحقق الخدمة `Origin` أو آلية CSRF متوافقة مع الواجهة قبل استعمال cookie، إلى جانب `SameSite=Lax`، لمنع طلبات cross-site المصادقة بالكوكي.

### C.3 الدمج Guest → Customer

يجري register/login ثم الدمج في transaction واحدة من مستوى `Serializable` مع retry محدود ومعامل معالجة للأخطاء القابلة للإعادة. ترتب أقفال الصفوف تصاعدياً حسب UUID لتفادي deadlock: cart الضيف، cart العميل، ثم عناصر cart، ثم المنتجات اللازمة لتحديث لقطة السعر.

1. يحل الخادم `storeSlug` ويتحقق أن account الهاتف يقع في المتجر نفسه.
2. يقفل cart الضيف إذا وجد عبر hash cookie، ويتأكد من `active` و`expires_at > now`.
3. يقفل أو ينشئ cart العميل النشطة بالـunique partial index؛ لا يبقى للعميل سلتان نشطتان في المتجر نفسه.
4. لكل `product_id`، يجمع كمية عنصر الضيف مع عنصر العميل إن وجد في سطر واحد فقط، ويأخذ السعر الحالي للمنتج الفعال في `price_snapshot_iqd` وفق القرار المعتمد.
5. يرفع `version` للسلة العميل ويعلم الضيف `merged` مع `merged_into_cart_id`، ثم يمسح cookie الضيف فقط بعد commit.
6. إذا أعيد login/register أو حدث refresh، لا تعاد عملية الدمج لأن cart الضيف لم يعد `active`.

إذا أصبح منتج غير فعال أثناء الدمج، لا يختفي سراً: يبقى سطر السلة لعرضه بوضوح، لكن checkout يرفضه بـ`422 PRODUCT_UNAVAILABLE` حتى يزيله العميل أو يعاد تفعيله. لا تحجز عملية الدمج مخزوناً.

### C.4 انتهاء السلات

لا يلزم عمل مجدول لكي تكون السلة المنتهية غير قابلة للاستخدام. كل `GET/PATCH/DELETE/merge/checkout` يفحص expiration ويحول `active → expired` بمعاملة قصيرة، ثم يمسح cookie ويعيد سلة فارغة أو `422 CART_EXPIRED` حسب endpoint. التنظيف الدوري لمحو صفوف expired مؤجل؛ عند الحاجة له سيكون endpoint منشوراً ومحمياً وidempotent، لا مؤقتاً داخل process.

---

## D. Checkout Transaction وIdempotency وحجز المخزون

### D.1 مدخل checkout

المسار `POST /store/:storeSlug/checkout` لا يقبل checkout ضيفاً. تحتاج الطلبات:

| مدخل | القاعدة |
|---|---|
| customer session | مطلوب ومثبت بالمتجر. |
| `Idempotency-Key` header | مطلوب؛ طول/شكل محدودان، ويتحول إلى SHA-256 قبل تخزينه. |
| address | `addressId` يخص العميل والمتجر، أو payload عنوان جديد يمرر التحقق ثم يحفظ معاملاتيًا عند الحاجة. |
| payment method | `cod` فقط؛ أي قيمة أخرى `422 PAYMENT_METHOD_NOT_SUPPORTED`. |
| cart version | يُقرأ من الخادم ويقارن أثناء lock؛ لا تثق الواجهة بسعر أو إجمالي أو product IDs. |

محاولة API مباشرة من ضيف تعيد `401 CUSTOMER_SESSION_REQUIRED` ولا تنشئ cart reservation أو order أو event. توجيه واجهة `/checkout` إلى login تجربة مستخدم فقط وليس بديلاً عن الحارس الخادمي.

### D.2 استراتيجية `Serializable` وlocking

تفتح الخدمة transaction `Serializable` قابلة للإعادة في أخطاء serialization/deadlock المعروفة. داخلها يحصل الترتيب الآتي، ولا ينفذ أي side effect خارجي قبل commit:

1. يحل المتجر ثم يقفل سجل `checkout_requests` للمفتاح hash، أو ينشئه بحالة `processing`.
2. إذا كان المفتاح سبق أن نجح وبصمة الطلب مطابقة، يعيد order نفسه فوراً. وإن اختلفت البصمة يعيد `409 IDEMPOTENCY_KEY_REUSED`.
3. يقفل cart العميل النشطة (`FOR UPDATE`) ويتحقق من `status='active'`, `version`، وعدم الفراغ، ومطابقة store/customer.
4. يقفل صفوف products بترتيب `product_id` تصاعدي (`FOR UPDATE`) ثم يحسب `available = stock_quantity - SUM(active inventory_reservations.quantity)` لكل منتج داخل المعاملة.
5. يرفض على أول منتج غير فعال أو كمية غير متاحة بـ`422`; تتراجع المعاملة كلها ولا ينشأ order أو reservation أو حركة مخزون.
6. ينشئ `store_orders` بالحالة `new`, `source='storefront'`, `payment_method_code='cod'`, `payment_status='unpaid'`, والـsnapshots المحسوبة من السلة والعنوان.
7. ينشئ `order_items`, event `NULL → new` بفاعل customer، و`inventory_reservations` بحالة `active` لكل item.
8. يحول cart إلى `converted`, يربطه بالطلب، ويغير `checkout_requests` إلى `succeeded` مع `order_id`، ثم commit.

الاستجابة الأولى الناجحة `201`. إعادة إرسال المفتاح نفسه والبصمة نفسها تعيد `200` مع order نفسه. إذا انقطع اتصال العميل بعد commit وقبل وصول الاستجابة، فالطلب التالي بالمفتاح نفسه يستعيد الطلب ولا ينشئ طلباً ثانياً.

### D.3 سلوك idempotency بالتفصيل

| الحالة | النتيجة |
|---|---|
| مفتاح جديد + cart صالح | يعالج request وينشئ order واحداً فقط. |
| نفس المفتاح والبصمة بعد النجاح | `200` والـorder السابق نفسه، بلا event أو reservation إضافيين. |
| نفس المفتاح وبصمة مختلفة | `409 IDEMPOTENCY_KEY_REUSED`، ولا يلمس السلة أو المخزون. |
| طلبان متزامنان بالمفتاح نفسه | واحد فقط يملك lock؛ الآخر ينتظر ثم يقرأ succeeded ويعيد order نفسه. |
| طلبان متزامنان بمفتاحين مختلفين للسلة نفسها | واحد فقط يحول السلة؛ الآخر يرى `converted` أو version conflict ويرجع `409 CART_ALREADY_CHECKED_OUT`. |
| فشل قبل commit | rollback كامل؛ لا order ولا reservation ولا cart converted، ويمكن إعادة المحاولة بنفس المفتاح. |

### D.4 دورة حياة `inventory_reservations`

تعتمد كل معالجة reservation على transaction مستقلة عن service 8A العامة، وتستدعى فقط في طبقة Storefront order workflow بعد نجاح انتقال الحالة المصرح. لا تتغير انتقالات 8A للطلبات legacy أو التاجر من تلقاء نفسها.

| حدث الطلب | حالة reservation قبل/بعد | أثر المخزون وحركة التدقيق |
|---|---|---|
| checkout ناجح | لا يوجد → `active` | لا ينقص `stock_quantity`. المتاح للبيع ينقص حسابياً بالحجز النشط. |
| checkout يفشل أو rollback | لا يوجد | لا يوجد أثر. |
| `new → cancelled` | `active → released` بسبب `cancelled` | لا حركة مخزون لأن المخزون لم ينقص؛ يعود الحجز للمتاح. |
| `new → rejected` | `active → released` بسبب `rejected` | لا حركة مخزون؛ يعود الحجز للمتاح. |
| `processing/preparation → cancelled` | `active → released` بسبب `cancelled` | لا حركة مخزون؛ يعود الحجز للمتاح. |
| `out_for_delivery → returned` | يبقى `active`، و`return_disposition → pending_inspection` | لا حركة مخزون ولا تحرير للحجز؛ يبقى المنتج غير متاح للبيع حتى فحص المرتجع مستقبلاً. |
| `out_for_delivery → completed` | `active → consumed` | ينقص `products.stock_quantity` بالحجز نفسه، وينشئ `inventory_movements` بسبب `storefront_cod_completed` في transaction نفسها. |
| `completed → returned` | يبقى `consumed`، و`return_disposition → pending_inspection` | لا تزيد `stock_quantity` ولا تنشأ حركة مخزون. قرار صلاحية المنتج وإعادة بيعه مؤجل إلى Workflow المرتجعات المستقبلي. |
| انتهاء سلة ضيف | لا reservation أصلاً | لا أثر. |
| انتهاء حجز زمني | **غير موجود في المرحلة 9** | لا يحل الحجز بوقت فقط بينما الطلب مفتوح؛ يحتاج workflow انتهاء order صريح في مرحلة مستقبلية. |

تقرأ طبقة حجز Storefront الطلب بفاعلية `source='storefront'` ووجود reservations؛ أي order قديم/يدوي من 8A لا يمر بهذه الآثار. عند `cancelled`, `rejected`, `returned`, `completed` تطبق عملية update المشروطة بالحالة السابقة وبـ`return_disposition` (`WHERE status='active'` أو `consumed`) لتكون idempotent. إذا أعيد طلب transition بسبب network error، يحمي `expectedVersion` في 8A والـconditional update من التكرار.

> يظل مبدأ 8A قائماً: **انتقال الحالة المجرد لا يغير المخزون مباشرة**. آثار المخزون أعلاه وظيفة reservation مستقلة خاصة بطلب Storefront، تربط فقط بعد التحقق من انتقال الحالة وتنفذ في معاملة واحدة. ولا يعد `returned` قراراً آلياً بأن البضاعة سليمة أو قابلة للبيع؛ تحصر المرحلة 9 أثره في تسجيل `pending_inspection`. لذلك تبقى اختبارات 8A للطلبات غير المحجوزة بلا حركة مخزون، ولا تنشئ المرحلة 9 أي حركة `storefront_returned_restored`.

---

## E. Customer Session / Cookie Isolation وواجهات API

### E.1 قواعد التفويض العامة

كل endpoint يحل `storeSlug` أولاً. endpoints العامة تقيد كل product/cart query بـ`store_id`. endpoints العميل تتحقق من typed customer session ثم تعيد قراءة `customers.store_id` وتقارنه بالمتجر المحلول. لا تعيد `403` لتعريف order/address خارج ملكية العميل؛ تعيد `404` لإخفاء وجوده. لا يقبل أي endpoint `storeId` من العميل.

| السطح | قاعدة التفويض |
|---|---|
| Storefront عام | متجر موجود ونشط، ومنتج من المتجر نفسه و`is_active=true`. |
| Cart ضيف | cookie token hash + cart `active` + store match + لم تنته الصلاحية. |
| Cart عميل | customer session + customer/store match؛ لا يعود cart ضيف بعد merge. |
| Account/Address | customer session + address/customer/store composite ownership. |
| Checkout | customer session + cart customer active + cart/store/customer match + idempotency. |
| Orders | customer session + `store_orders.customer_id = session.subjectId` + order/store match. |
| Merchant/Platform | لا تتغير endpoints 1–8؛ لا ينال customer token حقاً فيها. |

### E.2 جميع endpoints المرحلة 9

| الطريقة والمسار | المصادقة | التفويض والسلوك |
|---|---|---|
| `GET /store/:storeSlug/products` | عام | قائمة cursor-paginated للمنتجات الفعالة فقط؛ تصنيف وصور عامة آمنة. |
| `GET /store/:storeSlug/products/:productId` | عام | منتج فعال من المتجر نفسه فقط. |
| `GET /store/:storeSlug/products/:productId/images/:imageId` | عام مقيد | صورة منتج فعال ومتجر مطابق فقط؛ لا رابط S3 خام. |
| `GET /store/:storeSlug/cart` | cookie ضيف أو session عميل اختياري | سلة العميل إن دخل، وإلا سلة الضيف المطابقة، أو فارغة بعد expiration. |
| `POST /store/:storeSlug/cart/items` | cookie ضيف أو session عميل اختياري + حماية CSRF | ينشئ/يحدث السلة المصرح بها ويأخذ price snapshot. |
| `PATCH /store/:storeSlug/cart/items/:itemId` | مالك cart | كمية موجبة داخل cart الصحيح فقط. |
| `DELETE /store/:storeSlug/cart/items/:itemId` | مالك cart | حذف item من cart الصحيح فقط. |
| `POST /store/:storeSlug/account/register` | عام + rate limit | هاتف/كلمة مرور/اسم؛ ينشئ customer session ثم يدمج guest cart. |
| `POST /store/:storeSlug/account/login` | عام + rate limit | رد `401` موحد لفشل الاعتماد؛ يدمج guest cart بعد session صحيحة. |
| `POST /store/:storeSlug/account/logout` | customer session | يلغي customer session ويمسح cookie الخاص بهذا المتجر فقط. |
| `GET /store/:storeSlug/account` | customer session | profile آمن بلا password hash أو session hash. |
| `GET /POST /store/:storeSlug/account/addresses` | customer session | قائمة/إنشاء عناوين العميل داخل المتجر. |
| `PATCH /DELETE /store/:storeSlug/account/addresses/:addressId` | customer session | ملكية address بالـFK المركب؛ `404` خارج النطاق. |
| `POST /store/:storeSlug/checkout` | customer session + `Idempotency-Key` | checkout COD transaction كما في القسم D. |
| `GET /store/:storeSlug/account/orders` | customer session | cursor-paginated للطلبات المملوكة للعميل فقط. |
| `GET /store/:storeSlug/account/orders/:orderId` | customer session | order snapshots/حالة العميل فقط؛ `404` لغير المالك. |
| `GET /store/:storeSlug/account/orders/:orderId/history` | customer session | timeline آمن يخفي `actor_id` وnote الداخلية. |

### E.3 أكواد الرفض الملزمة

| الرمز | الحالة |
|---|---|
| `400 INVALID_PHONE / INVALID_ADDRESS / INVALID_IDEMPOTENCY_KEY` | مدخلات غير صالحة. |
| `401 CUSTOMER_SESSION_REQUIRED / INVALID_CUSTOMER_CREDENTIALS` | غياب session أو فشل login موحد. |
| `403 STORE_BOUNDARY_DENIED / IDENTITY_BOUNDARY_DENIED` | session متجر أو هوية خاطئة. |
| `404 STORE_NOT_FOUND / RESOURCE_NOT_FOUND` | مورد متجر آخر أو غير فعال أو غير مملوك. |
| `409 DUPLICATE_CUSTOMER_PHONE / CART_VERSION_CONFLICT / IDEMPOTENCY_KEY_REUSED / CART_ALREADY_CHECKED_OUT` | تعارض هوية أو تزامن. |
| `422 CART_EXPIRED / CART_EMPTY / PRODUCT_UNAVAILABLE / INSUFFICIENT_AVAILABLE_STOCK / PAYMENT_METHOD_NOT_SUPPORTED` | قاعدة أعمال غير قابلة للتنفيذ. |
| `429 RATE_LIMITED` | حماية register/login/cart write/checkout من الإساءة. |

تظل المسارات السابقة `/stores/:storeSlug/account/*` aliases انتقالية فقط في 9A؛ لا تحذف حتى تمر اختبارات توافق صريحة. الواجهة الجديدة تستخدم `/store/:storeSlug/...` بصورة موحدة.

---

## F. واجهات Storefront المطلوبة في 9B

| المسار الأمامي | الصفحة | نقاط القبول البصرية والوظيفية |
|---|---|---|
| `/store/{slug}` | كتالوج المتجر | منتجات فعالة، بحث/تصنيف إن أضيفا ضمن API، دخول للسلة، RTL وحالات empty/error. |
| `/store/{slug}/products/{productId}` | تفاصيل المنتج | سعر وسعر snapshot يطبق عند الإضافة، صورة آمنة، كمية، زر إضافة. |
| `/store/{slug}/cart` | السلة | تعديل/حذف، السعر المحفوظ، رسالة انتهاء/منتج غير متاح، لا حجز مخزون عند الإضافة. |
| `/store/{slug}/checkout` | checkout COD | يعيد الضيف إلى login/register؛ العنوان، تأكيد COD، منع submit مزدوج، نتيجة idempotent. |
| `/store/{slug}/account/register` | التسجيل | هاتف + كلمة مرور + اسم؛ لا يعلن وجود الهاتف قبل التسجيل. |
| `/store/{slug}/account/login` | الدخول | اعتماد هاتف/كلمة مرور ودمج سلة؛ رد متسق. |
| `/store/{slug}/account/orders` | سجل الطلبات | قائمة العميل المقيدة، cursor، حالات واضحة. |
| `/store/{slug}/account/orders/{orderId}` | تفاصيل وتتبع | order snapshot وtimeline آمنين؛ لا ملاحظات تشغيل داخلية. |

تبنى الواجهات بتصميم One UI عربي وظيفي: بطاقات واضحة، عناصر كبيرة للمس، تركيز لوحة مفاتيح مرئي، وARIA صحيحة وحالات loading/error/empty. الصقل التسويقي الكامل خارج المرحلة.

---

## G. Acceptance Tests وRegression Requirements النهائية

### G.1 اختبارات مخطط وعزل قاعدة البيانات — 9A

| المعرف | الاختبار | النتيجة الملزمة |
|---|---|---|
| DB-01 | إدراج هاتفين متماثلين معيارياً في Store-A. | رفض SQL `23505`; الهاتف نفسه في Store-B يقبل. |
| DB-02 | محاولة `cart_item` بــcart Store-A ومنتج Store-B عبر SQL مباشر. | رفض FK مركب، ولا يصل خطأ التطبيق إلى بيانات المتجر الآخر. |
| DB-03 | محاولة address بعميل A و`store_id` B. | رفض FK مركب. |
| DB-04 | محاولة order بعميل من متجر آخر. | رفض `store_orders_customer_store_fk`. |
| DB-05 | سلتان نشطتان لنفس customer/store أو token ضيف نشط مكرر. | رفض unique partial index. |
| DB-06 | تعديل/حذف event order بعد إنشاء Storefront order. | رفض Trigger 8A `23514`. |

### G.2 اختبارات سلة وضيف ودمج — 9A

| المعرف | الاختبار | النتيجة الملزمة |
|---|---|---|
| CART-01 | متصفحان في المتجر نفسه يضيفان منتجات. | سلتان مستقلتان؛ لا يظهر عنصر A في B. |
| CART-02 | تعديل raw cart ID أو token أو storeSlug. | لا قراءة ولا كتابة؛ `403` أو `404` حسب المورد. |
| CART-03 | تغيير سعر المنتج بعد الإضافة. | cart يحافظ على `price_snapshot_iqd` الأصلي. |
| CART-04 | cart ضيف أقدم من 7 أيام. | تتحول إلى `expired`, تمسح cookie، ولا تستعاد. |
| MERGE-01 | guest cart بثلاثة items + حساب جديد. | تنتقل الثلاثة مرة واحدة إلى customer cart. |
| MERGE-02 | cart عميل موجودة + cart ضيف فيها product مشترك. | تجمع الكميات في سطر واحد وتحدث snapshot للسعر الحالي. |
| MERGE-03 | طلبا login متزامنان للسلة الضيف نفسها. | دمج واحد، لا ازدواج في العناصر، وguest cart `merged` مرة واحدة. |
| MERGE-04 | cookie ضيف لمتجر A أثناء login Store-B. | لا دمج ولا كشف؛ يبقى cart A معزولاً. |

### G.3 اختبارات checkout وidempotency والحجز — 9A

| المعرف | الاختبار | النتيجة الملزمة |
|---|---|---|
| CO-01 | ضيف يستدعي checkout مباشرة. | `401`، ولا order/reservation/movement. |
| CO-02 | checkout صالح COD. | order `new`، event customer، order items snapshots، reservations active، cart converted. |
| CO-03 | إعادة POST بالمفتاح والبصمة نفسيهما. | order نفسه، لا duplication في reservations/events. |
| CO-04 | المفتاح نفسه وبصمة address/cart مختلفة. | `409 IDEMPOTENCY_KEY_REUSED`. |
| CO-05 | مفتاحان متزامنان للسلة نفسها. | order واحد؛ الآخر `409` أو نتيجة request الناجح وفق lock. |
| CO-06 | سلتان تشتريان كمية تتجاوز المتاح بالتزامن. | ينجح نطاق المتاح فقط؛ لا negative availability أو oversell. |
| CO-07 | منتج inactive أو نفد خلال transaction. | `422` وrollback كامل بلا order جزئي أو cart converted. |
| INV-01 | `cancelled` أو `rejected` لطلب storefront محجوز. | reservation `released`، لا inventory movement، ويعود المتاح. |
| INV-02 | `out_for_delivery → returned` قبل إكمال. | يبقى الحجز `active` مع `return_disposition='pending_inspection'`؛ لا حركة مخزون ولا تحرير للمتاح. |
| INV-03 | `out_for_delivery → completed`. | reservation `consumed` وحركة واحدة وإنقاص stock في transaction واحدة. |
| INV-04 | `completed → returned`. | يبقى الحجز `consumed` مع `return_disposition='pending_inspection'`؛ لا زيادة في `stock_quantity` ولا حركة restore. |
| INV-05 | إعادة transition بالـexpectedVersion القديم. | `409` ولا حركة أو reservation إضافية. |

### G.4 اختبارات العميل والـIDOR والواجهة — 9B

| المعرف | الاختبار | النتيجة الملزمة |
|---|---|---|
| ACC-01 | تسجيل الهاتف نفسه في متجرين. | حسابان مستقلان؛ لا مشاركة جلسة أو طلب أو عنوان. |
| ACC-02 | جلسة عميل Store-A على account/orders Store-B. | `403 STORE_BOUNDARY_DENIED`. |
| ACC-03 | Customer-A يفتح orderId لـCustomer-B في المتجر نفسه أو متجر آخر. | `404` بلا تسريب. |
| ACC-04 | Customer token يستدعي merchant/platform endpoints. | `403 IDENTITY_BOUNDARY_DENIED`. |
| UI-01 | تصفح→إضافة→سلة ضيف→login→checkout→تفاصيل order. | تسلسل كامل واضح، مع بقاء items ومعلومات الخطأ المناسبة. |
| UI-02 | الهاتف المحمول وRTL ولوحة المفاتيح. | cart/account/checkout قابل للاستخدام، focus وARIA ورسائل عربية ظاهرة. |
| UI-03 | submit متكرر أو شبكة تتأخر بعد checkout. | زر محمي، واسترجاع order idempotent لا create مكرر. |

### G.5 متطلبات Regression للمراحل 8A و8B

لا تعتمد المرحلة 9 قبل اجتياز الحزمة التالية من دون تخفيف لأي انتظار سابق:

| الحزمة | متطلبات الانحدار |
|---|---|
| **8A** | تبقى State Machine كما هي: `processing → new` و`out_for_delivery → cancelled` تعيدان `422`؛ تزامن status يعيد `409`؛ append-only events وstore-match trigger يعيدان `23514`; انتقال الحالة لطلب legacy لا ينشئ inventory movement، ولا يؤدي `completed → returned` إلى أي إعادة مخزون تلقائية. |
| **8B** | جميع M-01–M-22 وO-01–O-07 وU-01–U-04 تنجح. مالك المنصة يظل قراءة فقط؛ التاجر لا يرى Storefront customer data خارج نطاق متجره؛ واجهة إدارة الحالات لا تظهر إجراء مخالفاً. |
| **1–7** | عزل تاجر/متجر وemail rules والإضافة اليدوية والمنتجات والتصنيفات والصور تستمر، ويحدث فقط تحديث متعمد لاختبارات customer login القديمة من email إلى phone. |
| **9A/9B** | اختبارات PostgreSQL المباشرة، API integration، ومتصفح حي بجلسات منفصلة للضيف وCustomer-A وCustomer-B وMerchant-A وMerchant-B وOwner. |

## قرار التنفيذ المطلوب

هذه النسخة تثبت دورة الحجز بالكامل: لا reservation عند cart، ولا خصم stock عند checkout، ولا انتهاء زمني لحجز order مفتوح، والإطلاق عند الإلغاء/الرفض والاستهلاك عند الإكمال يحدثان فقط في معاملات خاصة بطلب Storefront بعد انتقال حالة صحيح. أما الإرجاع فيسجل `pending_inspection` فقط، ولا يعيد أي كمية إلى المخزون قبل Workflow مرتجعات مستقل. كما تثبت أن خدمة 8A العامة تبقى بلا أثر مخزون مباشر.

لن يبدأ التنفيذ قبل موافقتك الصريحة على هذه الوثيقة كاملة، بما فيها جداول `checkout_requests` و`inventory_reservations`، وسياسة عدم انتهاء reservation زمنياً، وربط settlement بطلب Storefront فقط.

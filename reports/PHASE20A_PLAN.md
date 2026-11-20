# خطة تنفيذ CODIQ Phase 20A — متغيرات المنتج (Product Variants)

**التاريخ:** 2026-08-26 · **المصدر:** بند سجل الدين **D-07** (Critical تنافسي عالمي) · **الحالة:** خطة معتمدة للتنفيذ (read-only design — لا كود بعد)
**قرار المالك:** تقديم متغيرات المنتج قبل المرحلة 20 لأن كلفتها المعمارية تتضاعف بعد المرحلتين 20 و23.

مصدر التحقق المعماري الذي بُنيت عليه هذه الخطة:
- Schema: `prisma/schema.prisma`
- Checkout core: `phase1-backend/src/services/storefront.service.ts`
- Catalog/inventory: `phase1-backend/src/services/product-catalog.service.ts`
- Settlement caller: `phase1-backend/src/services/order-lifecycle.service.ts`
- Low-stock trigger: `phase1-backend/src/notifications/notification-outbox.service.ts`
- نمط الهجرة: `prisma/migrations/20260818011500_storefront_customer_carts_reservations_9a` و`20260817093000_store_scoped_product_management`
- نمط اختبار التزامن/IDOR: `phase1-backend/tests/phase9a.storefront.integration.mjs`

---

## 0. القرار المعماري الحاكم: نموذج «Default Variant» الضمني

**التوصية القاطعة: Option A — كل منتج يملك دائماً صفاً واحداً على الأقل في `product_variants` (default variant ضمني)، لا `variantId` قابل للـnull.**

السبب: أخطر شيفرة في النظام هي دالة `checkout` والـ`settleStorefrontReservations` داخل serializable transaction. لو اخترنا `variantId` قابلاً للـnull لأنشأنا **مسارين** في كل موضع قفل/توفّر/تسوية (product-level للـlegacy وvariant-level للجديد). Option A يجعل المخزون والسعر يعيشان **حصراً** على المتغير، فتصبح رياضيات الـcheckout مساراً واحداً بلا فروع null — وهو الأأمن، ويطابق نموذج Shopify داخلياً.

مقابل ذلك: أعمدة `products.stock_quantity` / `price_iqd` / `low_stock_threshold` / `is_low_stock` تصبح vestigial. حفاظاً على additive-first لا نحذفها في 20A؛ نجمّدها (نتوقف عن القراءة/الكتابة في مسار الشراء) ونتركها لهجرة تنظيف لاحقة بعد الاستقرار — rollback-safe.

---

## 1. Data Model — جدول `product_variants`

### 1.1 الحقول
```
product_variants
  id                 uuid PK default gen_random_uuid()
  store_id           uuid NOT NULL           -- denormalized للعزل والـFK المركّب
  product_id         uuid NOT NULL
  sku                text NOT NULL
  name               text NOT NULL           -- تسمية المتغير: "أحمر / L"
  price_iqd          integer NOT NULL CHECK (>= 0)
  stock_quantity     integer NOT NULL DEFAULT 0 CHECK (>= 0)
  low_stock_threshold integer NOT NULL DEFAULT 0 CHECK (>= 0)
  is_low_stock       boolean GENERATED ALWAYS AS (stock_quantity <= low_stock_threshold) STORED
  is_default         boolean NOT NULL DEFAULT false
  is_active          boolean NOT NULL DEFAULT true
  position           integer NOT NULL DEFAULT 0
  options            jsonb NOT NULL DEFAULT '{}'   -- {"size":"L","color":"أحمر"}
  created_at / updated_at timestamptz
```

### 1.2 مفاتيح الهوية المركّبة (لإنفاذ same-store AND same-product في القاعدة)
```
UNIQUE (id, store_id)
UNIQUE (id, product_id, store_id)
FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE
```
المفتاح الثلاثي `(id, product_id, store_id)` يمكّن `cart_items` / `inventory_reservations` / `order_items` من FK مركّب يضمن أن المتغير يخص هذا المنتج وهذا المتجر معاً — إغلاق IDOR على مستوى المخطط.

### 1.3 نطاق تفرّد SKU
`UNIQUE (store_id, sku)` بنمط `products_store_sku_key`. القرار المعتمد: الفضاءان منفصلان؛ `variant.sku` هو المرجعي الشرائي، و`products.sku` معرّف تجميعي legacy. أثناء الـbackfill يرث default variant قيمة `products.sku` حرفياً.

### 1.4 فهارس + trigger العزل
```
CREATE INDEX product_variants_store_product_idx ON product_variants(store_id, product_id, position);
CREATE INDEX product_variants_store_stock_idx   ON product_variants(store_id, stock_quantity);
CREATE INDEX product_variants_store_low_stock_idx ON product_variants(store_id, is_low_stock) WHERE is_low_stock;
CREATE UNIQUE INDEX product_variants_one_default_uq ON product_variants(product_id) WHERE is_default;
```
مع إعادة استخدام دالة الحارس القائمة `codiq_guard_product_child_store()` عبر trigger جديد.

### 1.5 صحّة منتج بلا متغيرات
لا يوجد «منتج بلا متغيرات» بعد 20A: الـbackfill يضمن default variant، وإنشاء أي منتج جديد ينشئ default variant في نفس المعاملة.

---

## 2. Retargeting — الجداول الأبناء (additive-first)

لكل جدول: ADD `variant_id` nullable → backfill من default variant → FK مركّب → NOT NULL حيث ينطبق → تبديل قيود التفرّد.

### 2.1 `cart_items`
- `variant_id` NOT NULL بعد الـbackfill.
- FK: `(variant_id, product_id, store_id) → product_variants(id, product_id, store_id)` RESTRICT.
- تبديل التفرّد: `UNIQUE (cart_id, product_id)` → `UNIQUE (cart_id, variant_id)` (سطران لنفس المنتج بمتغيرين يجب أن يتعايشا).
- `price_snapshot_iqd` = لقطة سعر المتغير.

### 2.2 `inventory_reservations`
- `variant_id` NOT NULL + نفس FK المركّب.
- تبديل التفرّد: `UNIQUE (order_id, product_id)` → `UNIQUE (order_id, variant_id)`.
- تبديل الفهرس الجزئي للتوفّر: `(store_id, product_id) WHERE status='active'` → `(store_id, variant_id) WHERE status='active'`.

### 2.3 `order_items`
- `variant_id` يبقى nullable (سطور legacy تحمل `product_id NULL` أصلاً) + FK مفرد RESTRICT.
- ADD `variant_name text NULL`؛ `sku` يصبح لقطة SKU المتغير؛ بقية اللقطات ثابتة.

### 2.4 `inventory_movements`
- ADD `variant_id` nullable؛ الحركات الجديدة تُكتب به.

### 2.5 `notification_outbox`
- القرار المعتمد: لا عمود جديد في 20A — إثراء الـpayload فقط (تسمية المتغير + SKU في `productName`)، والـdedupeKey يصبح `low_stock:${variantId}:${stock}`.

---

## 3. Checkout Invariants — مواضع التغيير الشاملة (أعلى خطر)

المرجع `storefront.service.ts`. الضمانات الواجب بقاؤها: cartVersion optimistic check، FOR UPDATE قبل فحص التوفّر، التوفّر = مخزون − حجوزات نشطة، idempotency عبر `checkout_requests`، serializable + retries محدودة (P2002/P2034/40001)، خصم المخزون عند الإكمال فقط.

### 3.1 دالة `checkout` (L297–365)

| الموضع | الحالي (product-level) | بعد 20A (variant-level) |
|---|---|---|
| L320 | ترتيب `productIds` ثابت | `variantIds` مرتبة (لتفادي deadlock) |
| L321–328 | `SELECT ... FROM products ... FOR UPDATE` | **حرِج:** قفل المتغير + الأب معاً: `SELECT v..., p.is_active FROM product_variants v JOIN products p ON p.id=v.product_id AND p.store_id=v.store_id WHERE v.store_id=$1 AND v.id IN (...) ORDER BY v.id FOR UPDATE OF v, p` — يبقي barrier الاختبار (`ILIKE '%FOR UPDATE%'`) محقّقاً |
| L329–330 | فحص `product.isActive` | فحص `product_active AND variant_active`؛ رمز `PRODUCT_UNAVAILABLE` كما هو |
| L331–337 | حجوزات وgroupBy على `productId` | على `variantId`؛ نفس رياضيات `INSUFFICIENT_AVAILABLE_STOCK` |
| L347–348 | إنشاء items وreservations بـ`productId` | + `variantId` و`variantName` ولقطات المتغير |
| L349–362 | cartVersion + idempotency + بنية retry | **بلا أي تغيير** |

### 3.2 `settleStorefrontReservations` (L381–405)

| الموضع | الحالي | بعد 20A |
|---|---|---|
| L396–397 | قراءة وخصم `products` بشرط `stock >= qty` | قراءة وخصم `product_variants` بنفس الشرط الذرّي — الخصم-عند-الإكمال-فقط |
| L399 | حركة مخزون بـproductId | + variantId |
| L400–402 | low-stock بأرقام المنتج | بأرقام **المتغير** |
| البقية | released/returned/consumed | بلا تغيير |

### 3.3 السلة والدمج
- `addCartItem`: المدخل `variantId`؛ التحقق يجلب المتغير النشط ومنتجه النشط؛ اللقطة من المتغير؛ مفتاح `cartId_variantId`.
- `mergeGuestCartIntoCustomer`: `findUnique cartId_productId` → `cartId_variantId`؛ بنية retry تبقى.
- `cartPayload`: يضيف `variantId`/`variantName` وأرقام المتغير.

---

## 4. Availability + Low-Stock على مستوى المتغير

- `publicProducts`: توفّر المنتج = «أي متغير نشط متوفّر» (OR)؛ نطاق سعر min–max للعرض.
- `publicProduct`: يعيد `variants[]` بتوفّر مستقل لكل متغير دون كشف الكمية.
- فلتر low-stock للتاجر: المنتج low-stock إذا `EXISTS variant WHERE is_low_stock` (بالفهرس الجزئي).
- trigger «العبور نزولاً» يبقى منطقه؛ يُستدعى بأرقام المتغير.

---

## 5. API + UI Surface

### 5.1 Backend
- `createProduct`: منتج + default variant في معاملة واحدة؛ `assertWithinPlanLimit "max_products"` يبقى على صفوف Product (قرار معتمد — لا حد متغيرات في 20A).
- `updateProduct`: فصل حقول المنتج عن حقول المتغير.
- `adjustInventory`: variant-scoped عبر `/variants/:variantId/inventory`.
- `deleteProduct`: CASCADE على المتغيرات، وRESTRICT من order_items/reservations يمنع الحذف إن كان أي متغير مُشاراً.
- CRUD متغيرات جديد: list/create/update/adjust/delete (حذف default الوحيد أو المُشار إليه مرفوض) تحت `/merchant/stores/:storeSlug/catalog/products/:productId/variants` بنفس `requireStoreActor` والصلاحيات.
- Storefront: `POST /cart/items` يقبل `variantId`؛ `publicProduct(s)` يعيدان المتغيرات.

### 5.2 واجهة التاجر
`ProductCatalogManager.tsx`: محرّر متغيرات (SKU/سعر/مخزون/options لكل متغير)؛ صف المخزون متغير-محور؛ شارة low-stock مشتقة من المتغيرات.

### 5.3 واجهة الـStorefront
`storefront-api.ts`: `variants[]` في `ProductDetail`، `variantId` في السلة؛ `StorefrontProductPage.tsx`: منتقي متغيرات يحدّث السعر والتوفّر.

---

## 6. Migration / Backfill

هجرة واحدة `phase20a_product_variants` بالترتيب:
1. CREATE TABLE بالقيود والفهارس والـtrigger.
2. Backfill default variant (1:1) من `products` بوراثة sku/price/stock/threshold/is_active.
3. لكل جدول ابن: ADD → UPDATE من default variant → FK مركّب → NOT NULL حيث ينطبق → تبديل التفرّد والفهارس.
4. الحجوزات النشطة وقت الهجرة تُنقل إلى default variant (صحيح لأنه يرث مخزون المنتج).
5. تجميد أعمدة `products` المخزونية (لا DROP في 20A).
6. تحديث `schema.prisma` بmodel `ProductVariant` والعلاقات.

ملاحظة تشغيلية: لو كانت بيانات الإنتاج كبيرة وقت التطبيق → backfill مُجزّأ + فهارس CONCURRENTLY (يُقيَّم عندها).

---

## 7. Test Plan — `phase20a.variants.integration.mjs`

على نمط phase9a (نفس الـharness + الحاجز عبر `pg_stat_activity`):
1. **آخر وحدة على متغير — تزامن حقيقي:** checkoutان متزامنان على متغير `stock=1` → واحد 201 والآخر `INSUFFICIENT_AVAILABLE_STOCK`؛ المتغير الشقيق لا يتأثر.
2. **تعطيل المنتج الأب أثناء الشراء:** يثبت أن JOIN + `FOR UPDATE OF v, p` حافظ على ضمان `PRODUCT_UNAVAILABLE` بصفر آثار.
3. **عزل مخزون بين المتغيرات** + low-stock للمتغير الصحيح فقط.
4. **IDOR بالـSQL الخام:** إدراج بمتغير من متجر/منتج آخر → `23503`؛ default ثانٍ → `23505`؛ وعبر API → 404.
5. **لا انحدار على منتجات default-only:** تطابق أرقام phase9a حرفياً (5→3 بعد completed، reservation consumed).
6. **idempotency + cartVersion بلا تغيير.**
7. **التوفّر العام** لكل متغير دون كشف الكمية.

---

## 8. Rollout — التقسيم على نمط 8A/8B

- **20A-1 (Backend/Schema — نواة الخطر):** الجدول + الهجرة/الـbackfill + إعادة توجيه checkout/settlement/catalog + الاختبار التكاملي. تُغلق بوابة الإثبات قبل أي واجهة.
- **20A-2 (UI + Acceptance):** محرّر متغيرات التاجر + منتقي الـStorefront + اختبار متصفح `phase20a.browser-acceptance.mjs`.

---

## 9. القرارات — حُسمت بتفويض المالك (2026-08-26) وفق توصيات الخطة

1. فضاء SKU: **منفصلان**، `variant.sku` هو المرجعي. ✅
2. حدود الخطة: **يبقى `max_products` على صفوف Product**؛ حد المتغيرات مؤجل. ✅
3. low-stock outbox: **إثراء payload فقط** في 20A. ✅
4. أعمدة `products` المخزونية: **تجميد لا حذف** في 20A. ✅
5. options: **JSONB حر** في 20A؛ normalize لاحقاً إن لزم فلترة بالخيارات. ✅
6. حجم بيانات الإنتاج وقت الهجرة: يُقيَّم عند نشر الإنتاج (staging أولاً دائماً). ✅

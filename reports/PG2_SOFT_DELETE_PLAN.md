# PG-2 — خطة الحذف الناعم وسلة المحذوفات

**أُنشئت:** 2026-08-27 · **الطريقة:** ثلاثة تصاميم مستقلة بزوايا انطلاق متعمَّدة الاختلاف، قيّمها ثلاثة محكّمين بعدسات منفصلة (الصحة · قابلية الصيانة · تجربة التاجر)، ثم رُكّبت الخطة من الفائز مطعَّماً بأفضل أفكار الخاسرين.

**الترتيب النهائي:**
- minimal: 22/30
- structural: 20/30
- product: 20/30

**لماذا تُحفظ الخطة قبل التنفيذ:** لأن التصميم هنا حسم مقايضات لا إجابة واحدة لها — أبرزها تصادم القيود الفريدة عند الاستعادة — ومن يقرأ الكود بعد ستة أشهر يحتاج أن يعرف **لماذا** اختير هذا الفرع لا ذاك.

---
# PG-2 — الحذف الناعم وسلة المحذوفات: خطة التنفيذ النهائية

> **الأساس:** تصميم «minimal» (22/30). مُطعَّم بأربع أفكار من الخاسرين: جدار المفاتيح الأجنبية في التنقية (structural)، وعمود `deleted_event_id` (structural)، وعمودا `purge_blocked_at/reason` وورقة الـ409 التي تمنح التاجر مراده (product)، وختم اللقطة بترِيغر (structural + product).
> **كل واقعة أدناه تحقّقت منها في `D:\saif\codiq\CODIQ` على `main`.** لم أعدّل ولا أودعتُ شيئاً.

---

## 0. تصحيحات واقعية تسبق القرارات (تحقّقت منها بنفسي)

| الادعاء | الحكم | الدليل |
|---|---|---|
| الحذف الصلب يبيد `inventory_movements` بـCascade | **صحيح** | `prisma/migrations/20260817093000_store_scoped_product_management/migration.sql:33` — `product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE` |
| **لغم الترِيغر** الذي سمّاه محكّم correctness أخطرَ خلل | **صحيح ومؤكَّد** | `20260817093000/migration.sql:69-83` جسم `codiq_guard_product_child_store` يقرأ `SELECT store_id ... WHERE id = NEW.product_id` ويرمي `23514` إن كانت `NULL`؛ و`:89-91` يربطه بـ`BEFORE INSERT OR UPDATE OF store_id, product_id ON inventory_movements`. و`SET NULL` هو `UPDATE` على `product_id` ⇒ كل تنقية تُجهَض. **الإصلاح جزء من الهجرة الأولى.** |
| **خلل قفل الكوبون** الذي سمّاه محكّم maintainability | **صحيح ومؤكَّد** | `phase1-backend/src/services/coupon.service.ts:78-84`: `SELECT ... FROM coupons WHERE store_id = $1 AND code_normalized = $2 FOR UPDATE` ثم `const row = rows[0]` — بلا `ORDER BY` وبلا `deleted_at`. **الإصلاح سطر واحد، وهو إلزامي في هذه الخطة.** |
| «تسريب عام قائم: صورة منتج تُخدَم بلا ربط — `storefront.ts:33`» (واقعة تصميم structural) | **ملفَّقة** | `phase1-backend/src/http/routes/storefront.ts:30-36`: السطر 32 هو `await publicProduct(store.id, request.params.productId);` قبل قراءة الصورة، و`publicProduct` يفلتر `isActive: true` (`storefront.service.ts:175`) ويرمي 404. **لا تسريب** ⇒ لا مبرّر لتوسيع النطاق إلى `product_images`، ولا حاجة لعمود حذف عليها. |
| «`cart_items` تشير إلى العرض فترفع FK violation» (structural §6) | **مستحيل** | Postgres لا يقبل مفتاحاً أجنبياً نحو عرض؛ وبعد `RENAME` تتبع المفاتيح الجدول. الضمانة المزعومة غير موجودة. |
| الكوبونات والموظفون لهم حذف اليوم | **خطأ** | `coupon.service.ts:184` تعليق «no DELETE by design»؛ `staff.service.ts:91-127` تعطيل + إبطال جلسات فقط. PG-2 **يُنشئ** الحذف لهما. |
| `deleteProduct` يفحص الطلبات فقط | **صحيح** | `product-catalog.service.ts:296-302` — `orderItem.count` وحده. و`cart_items.product` و`inventory_reservations.product` كلاهما `Restrict` (`schema.prisma:531,595`)، و`errors.ts` **بلا أي فرع P2003** ⇒ **حذف منتج في سلة زبون حيّة = 500 عامة اليوم**. المعيار الخامس مكسور في الإنتاج. |
| كل قراءات الـStorefront تفلتر `isActive` | **صحيح** | `storefront.service.ts:115` (`publicCategories`)، `:147` (`publicProducts`)، `:175` (`publicProduct`)، `:201-202` (`addCartItem`)، `:262` (دمج سلة الضيف)، `:415` (قفل الشراء `p.is_active` داخل `FOR UPDATE OF v, p`)، `:548` (إعادة الطلب). |
| أسماء القيود الفريدة الحقيقية | مُثبتة | `products_store_id_sku_key` · `product_variants_store_sku_key` · **`product_categories_store_normalized_name_key`** (لا `..._store_id_normalized_name_key` كما ادّعى تصميم product) · `coupons_store_code_unique` · `store_staff_memberships_unique_staff_store` |
| `product_categories` بلا `is_active` | **صحيح** | `schema.prisma:341-359` |
| استيراد CSV إنشاء فقط (لا UPDATE) | **صحيح** | `csv-transfer.service.ts:229` رسالة `SKU_EXISTS` «الاستيراد إنشاء فقط (v1) ولا يُحدّث الموجود» ⇒ خطر «بعث منتج من السلة» غير قائم؛ الخطر الحقيقي **معاكس**: SKU يمسكه منتج محذوف يرفض استيراداً مشروعاً. |

---

## 1. القرار في كل مفترق من الستة

### أ. تصادم القيود الفريدة → **يُحرَّر الرمز عند الحذف؛ الاستعادة هي التي تتفاوض**

فهارس فريدة **جزئية** `WHERE deleted_at IS NULL` تحلّ محلّ القيود الكاملة الخمسة. المنتج المحذوف لا يمسك SKU ولا الاسم ولا الرمز ولا مقعد العضوية.

**السبب الواحد:** الحالة الخاسرة المقابلة («رمز مستعمل» بلا منتج مرئي يحمله) تصيب **كل** تاجر في **أول** استعمال وتُقرأ عطلاً؛ أما هذه فتصيب أقلّية أعادت استعمال الرمز خلال 30 يوماً، ولها سياق كامل وقرار واضح لحظة وقوعها.

**ماذا يرى التاجر في الحالة الخاسرة:** الاستعادة تُرجع **409** تسمّي الخاطف وتفتح مساراً، لا رفضاً:
```json
{"error":{"code":"SKU_TAKEN_BY_ACTIVE_PRODUCT",
 "message":"الرمز «SKU-100» يحمله الآن منتج آخر: «قميص قطني أزرق». اختر رمزاً جديداً للمنتج المستعاد.",
 "conflicts":[{"scope":"product","sku":"SKU-100","liveId":"…","liveName":"قميص قطني أزرق"}]}}
```
والمسار نفسه يقبل تجاوزاً في المعاملة ذاتها: `POST …/trash/product/:id/restore {"sku":"SKU-100-1","variantSkus":{"<variantId>":"SKU-100-1-S"},"categoryId":"…"|null}`. الواجهة تفتح حقلاً مملوءاً مسبقاً بـ`SKU-100-1`. **لا إعادة تسمية صامتة أبداً** — الـSKU مفتاح لدى التاجر (ملصقات، مورّد، CSV).

**العضوية حالة خاصة أجمل:** إن عاد الشخص إلى الفريق، الاستعادة تُرجع **409 `STAFF_ALREADY_ON_TEAM`** مع رابط إلى العضوية الحيّة، والواجهة لا تعرض زرّ الاستعادة أصلاً — التاجر حصل على مراده.

### ب. تسرّب الصفوف المحذوفة → **ثلاث طبقات: ثابتة بنيوية + ترشيح صريح مرئي في المسارات الخام + حارس AST يكسر CI**

1. **الثابتة البنيوية:** الحذف الناعم يكتب `deleted_at` و`is_active=false` معاً، وقيد `CHECK (deleted_at IS NULL OR is_active = false)` يجعل خرقها مستحيلاً حتى من `psql`. هذا يُغلق **كل** السطح العام بصفر تعديل — بما فيه قفل الشراء بـSQL الخام.
2. **الترشيح الصريح في المسارين الخامين الحسّاسين** (`coupon.service.ts:78` و`storefront.service.ts:414`): يُضاف `AND deleted_at IS NULL` نصّاً. هذا **إلزامي لا احتياطي**: بدونه يُرجع قفل الكوبون صفوفاً متعددة و`rows[0]` يختار عشوائياً فيرفض كوبوناً صالحاً بـ422 على مسار الشراء. وهو أيضاً ما يجعل الحماية **مرئية في مكان استعمالها** بدل أن تكون ضمنية — وهو ردّ مباشر على أضعف نقطة أقرّ بها التصميم الفائز.
3. **السطح التاجري:** ترشيح صريح عبر ثابتَي `LIVE`/`TRASHED` + **حارس AST** يمرّ على `phase1-backend/src` ويُفشل CI بـ`file:line` عند أي نداء قراءة على النماذج الخمسة بلا `deletedAt` وبلا إدراج في `ALLOWLIST` مع سبب نصّي إلزامي — ويمسح كذلك كل قالب `$queryRaw`/`$executeRaw` يذكر `FROM products|product_variants|coupons|store_staff_memberships`.

**لماذا لا العرض (`products_all` + VIEW)؟** نصف قطر انفجاره المنصة كلها بلا طرح تدريجي، على خمسة سلوكيات Postgres غير مقيسة في هذا المشروع (منها `FOR UPDATE` عبر عرض في مسار الدفع)، ومبرّره المعلن — «تسريب صورة المنتج» — واقعة ملفَّقة. **لماذا لا `$extends`؟** لا يعترض القراءات المتداخلة (`_count`, `include`) ولا SQL الخام إطلاقاً، فيعطي إحساس ضمانة بلا ضمانة.

### ج. إنقاذ سجل الحركات → **`Cascade` ← `SET NULL` + `product_id` قابل للعدم + لقطة تُختم بترِيغر + إصلاح لغم الترِيغر**

المحفوظ في الحركة: `product_name` (NOT NULL) · `product_sku` (NOT NULL) · `variant_name` · `variant_sku` — نفس أعمدة `order_items` حرفاً (`schema.prisma:457-459`). تُختم في **ترِيغر `BEFORE INSERT`** لا في الخدمة، لأن `inventoryMovement.create` مكتوب اليوم في **ستة** مواضع (`product-catalog.service.ts:219, 264, 277, 341, 368` و`csv-transfer.service.ts:331, 339`) وسابعٌ يُكتب بعد شهر.

**ليست لقطة كاملة**، لأن الحركة تجيب سؤالاً واحداً: «أي صنف، أي رمز، ±كم، لماذا، متى». السعر والوصف لا يعنيان قارئ سجل كمّيات، والجدول عالي الكتابة. واللقطة الكاملة موجودة أصلاً في `store_audit_events.metadata` لصفّ واحد لحظة الحذف.

**والإصلاح الذي بدونه لا شيء من هذا يعمل:** `codiq_guard_product_child_store` يُعاد تعريفه بسطر `IF NEW.product_id IS NULL THEN RETURN NEW; END IF;` قبل أي شيء.

### د. التنقية بعد 30 يوماً → **قاعدة البيانات تقرّر، لا قائمة `NOT EXISTS` في الكود**

الوظيفة لا تعرف شيئاً عن الدفتر: تحاول `DELETE` لكل صف **في معاملته الخاصة**، وتعامل `P2003 / 23503` **نتيجة مسمّاة** (`purge_blocked`) لا خطأً. كل ما هو مالي أو تدقيقي مربوط بـ`Restrict` (`order_items`, `cart_items`, `inventory_reservations`, `coupon_redemptions`, `store_orders.coupon_id`) فيرفضه Postgres تلقائياً — **وأي مفتاح أجنبي مقيِّد يُضاف بعد سنتين يصير محمياً بلا أن يعلم كاتبه بوجود التنقية**. الصف المحجوب يُختم `purge_blocked_at/purge_block_reason` ويظهر للتاجر بشارة **«محفوظ لسجلاتك»** بلا عدّاد، بدل أن يختفي بصمت أو يعلق بلا تفسير.

**ما يُحذف صلباً:** صف المنتج → ومعه متغيّراته وصوره و`notification_outbox` (Cascade) وبايتات الصور في المخزن · صف التصنيف · صف الكوبون · صف العضوية بعد حذف جلساتها المُبطلة (`staff_sessions` بـ`Restrict` — `schema.prisma:662`).
**ما لا يُمسّ أبداً:** `inventory_movements` (تُصفَّر إلى NULL وتبقى مقروءة باللقطة — **هذا هو D-48 محلولاً**) · `order_items` · `coupon_redemptions` · `ledger_entries` · `store_audit_events` · صف `Staff` نفسه (هوية عابرة للمتاجر).

**الترتيب داخل الدفعة إلزامي:** المنتجات → التصنيفات → الكوبونات → العضويات، **ثم إعادة محاولة واحدة لكل ما حُجب في هذا المرور** قبل ختمه. بدون ذلك يُختم تصنيفٌ فارغ `purge_blocked` للأبد لأن منتجه المُبان كان لا يزال يشير إليه لحظة محاولته (`products.category_id` بـ`Restrict` — `schema.prisma:293`). والصفوف المختومة تُعاد محاولتها في كل مرور لاحق (الفرز `purge_blocked_at NULLS FIRST` يمنعها من تجويع الجدد)، فالحجب حالة قابلة للشفاء لا حكم مؤبَّد.

**أين يعمل:** فاصل زمني **ثالث** داخل عملية العامل المستقل `phase1-backend/src/notifications/worker-entry.ts`، بجوار `startOutboxWorker` و`startAbandonedCartScanner`، بنفس نمط `abandoned-cart-scanner.ts` حرفياً (حارس تداخل، `try/catch` لا يقتل الفاصل، دالة `purgeExpiredSoftDeletes({now})` مُصدَّرة تقودها الاختبارات مباشرة). الدورة 6 ساعات عبر `CODIQ_TRASH_PURGE_INTERVAL_MS`، دفعة 200. **أبداً داخل مسار HTTP (ADR-004).**

### هـ. سجل التدقيق → **جدول واحد `store_audit_events`، فاعل مُلتقَط نصّاً، بلا مفتاح أجنبي على الكيان**

**الفاعل:** `merchant | staff | platform_owner | system`، من `requireStoreActor` الذي يعيد اليوم `{kind:"merchant"|"staff", id, membershipId?}` (`staff-permissions.ts:162,173`) — بلا أي تغيير في المصادقة. `system` للتنقية.
**جدول واحد لا أربعة**، لأن سطح القراءة خطّ زمني واحد؛ أربعة جداول = `UNION` رباعي في كل قراءة وأربع هجرات لكل حقل.
**ما يبقى مفيداً بعد عام:** `actor_label` و`entity_label` و`entity_secondary` **لقطات نصية** لا مفاتيح (الموظف قد يغادر والمنتج قد يُنقّى؛ سطر «حذفه `staff:8f2c…`» عديم القيمة)، و`entity_id` **بلا FK عمداً** لأن الكيان قد يُنقّى، و`metadata jsonb` تحمل اللقطة الكاملة لحظة الحذف.
**من يقرأ:** **التاجر وحده في v1** بصلاحية جديدة `catalog.audit.view` (لـ`store_manager` لا `store_staff` — وإلا رأى الموظف من عطّله). المالك مستبعد صراحةً (§6).

**والعمود الذي يجعل الاستعادة صحيحة بنيوياً:** `deleted_event_id` على كل صف محذوف، مفتاح أجنبي إلى حدث التدقيق الذي قتله بـ`ON DELETE RESTRICT`. الاستعادة تُحيي فقط ما ماتَ **بنفس الحدث** — فمتغيّر حذفه التاجر الاثنين لا يُبعث الخميس مع استعادة المنتج. اتفاقٌ يصير حقيقة.

### و. الأربعة ليست متساوية → **الاستثناءات مسمّاة، والتوحيد في الطبقة البنيوية فقط**

| | المنتج | التصنيف | الكوبون | عضوية الموظف |
|---|---|---|---|---|
| **اليوم** | حذف صلب (+ عطل 500) | حذف صلب محروس بـ409 | لا حذف — `is_active` | لا حذف — `is_active` + إبطال جلسات |
| **حرّاس 409** | مرتبط بطلب (قائم) · **في سلة حيّة (جديد)** · **حجز نشط (جديد)** | أبناء أحياء · **منتجات حيّة فقط** (لا تُحتسب المحذوفة) | لا حارس | **لا تُحذف آخر عضوية بصلاحية `team.manage`** (جديد — يمنع قفل المتجر) |
| **تعدية الحذف** | `deleted_at` + `deleted_event_id` على المتغيّرات؛ **حذف صلب لـ`cart_items` مع `version+1` للسلة** | **لا تعدية** — المنتجات تحتفظ بـ`category_id` | — | `permission_overrides` تبقى (Cascade) |
| **أثر جانبي** | `is_active=false` (المنتج وكل متغيّراته) | لا `is_active` أصلاً | `is_active=false` | `is_active=false` + `permissionVersion+1` + **إبطال الجلسات فوراً** |
| **يُحرَّر رمزه** | ✔ SKU (منتج + متغيّرات) | ✔ `normalized_name` | ✔ `code_normalized` | ✔ مقعد `(staff_id, store_id)` |
| **التنقية** | ✔ (تُحجب إن بِيع) | ✔ (بعد منتجاته) | ✔ (تُحجب إن استُرد مرة) | ✔ بعد حذف جلساتها المُبطلة |
| **الاستعادة** | كاملة من `deleted_was_active` + المتغيّرات بنفس الحدث + **إحياء تصنيفها إن كان في السلة** | تافهة | كاملة **إلا النافذة الزمنية** | العضوية + التجاوزات، **بلا جلسات** |

**الاستثناءات الستة المسمّاة صراحةً:**
1. **المنتج وحده يُفرّغ من السلال.** هذا يصلح العطل الحيّ (500 اليوم) ويحقق «الاختفاء الفوري من كل القوائم» لسلال قائمة. لا مقابل له عند الثلاثة الآخرين.
2. **التصنيف يُحسب حارسه بالمنتجات الحيّة فقط.** لو احتسبنا المحذوفة (كما فعل التصميم الفائز) لعجز التاجر 30 يوماً عن حذف تصنيف يراه فارغاً برسالة «يحتوي منتجات» — أي إعادة إنتاج لنمط «يبدو عطلاً» نفسه الذي رفضناه في مفترق (أ). **والثمن مدفوع في الاستعادة لا في الحذف:** استعادة منتج تُحيي تصنيفه المحذوف في المعاملة نفسها، وإن كان الاسم قد صار لتصنيف حيّ آخر تُرجع 409 `CATEGORY_NAME_TAKEN` ويقبل الجسم `categoryId` بديلاً (أو `null`).
3. **الكوبون لا يضمن «الحالة الكاملة» بالمعنى الحرفي.** كوبون انتهت `ends_at` وهو في السلة يعود **منتهياً** — لا نمدّد عرضاً تجارياً بأثر رجعي. الواجهة تقولها قبل الاستعادة.
4. **الكوبون يمسك سجل استخداماته أبداً.** `coupon_redemptions` دفتر؛ عدّ `max_uses_total` يشمل استرجاعات كوبون محذوف لأنها حدثت فعلاً.
5. **الموظف: المحذوف هو العضوية لا الهوية.** `Staff.email` فريد عالمياً و`StoreStaffMembership` لكل متجر؛ متجرٌ لا يملك حذف إنسان قد يعمل في متاجر أخرى.
6. **`is_active` لم يعد وحيداً في المعنى.** التعطيل = «موقوف، ما زال في القائمة»؛ الحذف = «خارج القائمة، في السلة». الواجهة تسمّيهما بوضوح («إيقاف» مقابل «إزالة من الفريق»).
7. **`deleteVariant` يبقى حذفاً صلباً** — المتغيّر ليس كياناً في النطاق المعتمد، وحرّاسه الثلاثة (`product-catalog.service.ts:385-390`) كافية. يُضاف له `LIVE` فقط.

---

## 2. الهجرات — SQL كامل، additive-first، ثلاث هجرات مستقلة

**لماذا ثلاث لا واحدة:** الهجرة الأولى تُصلح D-48 وحدها ويمكن نشرها وحدها والتراجع عنها وحدها. الثالثة تعتمد على الثانية (مفتاح أجنبي إلى `store_audit_events`).

---

### 2.1 `prisma/migrations/20260828090000_pg2a_inventory_movement_rescue/migration.sql`

```sql
-- PG-2 (أ) — إنقاذ سجل حركات المخزون (بند الدين D-48).
-- مستقلة تماماً عن الحذف الناعم: تُصلح فقدان الأثر عند أي حذف صلب للمنتج،
-- قديماً كان أو مستقبلياً، وتُنشر وحدها بأمان.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) اللغم أولاً. codiq_guard_product_child_store مربوط بـ
--    BEFORE INSERT OR UPDATE OF store_id, product_id ON inventory_movements
--    (20260817093000/migration.sql:89-91)، وجسمه (:76-80) يرمي 23514 حين
--    يكون product_id بلا متجر. و ON DELETE SET NULL هو UPDATE على product_id،
--    فبدون هذا السطر يشتعل الترِيغر عند كل تنقية ويُجهض الحذف والدفعة كلها —
--    في عامل خلفي بلا مسار HTTP، أي فشل صامت لا يراه أحد.
--    آمن على قاعدة حيّة: CREATE OR REPLACE FUNCTION لا يقفل أي جدول، والسلوك
--    القديم محفوظ حرفياً لكل صف product_id غير NULL.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION codiq_guard_product_child_store()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  product_store_id uuid;
BEGIN
  -- PG-2: بعد تحويل inventory_movements.product_id إلى ON DELETE SET NULL،
  -- التصفير عملية مشروعة ولا متجرَ ليُطابَق. لا تُزل هذا السطر.
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT store_id INTO product_store_id FROM products WHERE id = NEW.product_id;
  IF product_store_id IS NULL OR product_store_id <> NEW.store_id THEN
    RAISE EXCEPTION 'CODIQ_PRODUCT_STORE_MISMATCH: child resource must belong to the product store'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) أعمدة اللقطة. كلها nullable عند الإضافة ⇒ ALTER فوري بلا إعادة كتابة
--    الجدول (Postgres 11+ لا يعيد كتابة الجدول لعمود nullable بلا DEFAULT).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_movements
  ADD COLUMN product_name text,
  ADD COLUMN product_sku  text,
  ADD COLUMN variant_name text,
  ADD COLUMN variant_sku  text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) تعبئة رجعية. كل صف قائم اليوم يملك منتجاً حيّاً بحكم الـCascade القديم
--    (ما سبق أُبيد فعلاً ولا شيء يُستعاد منه). الجدول ما زال صغيراً في هذه
--    المرحلة؛ إن تجاوز مليون صف مستقبلاً، تُقسَّم هذه العبارة إلى دفعات
--    بـ ctid ويُنقل SET NOT NULL إلى هجرة تالية.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE inventory_movements m
SET product_name = p.name,
    product_sku  = p.sku
FROM products p
WHERE p.id = m.product_id AND m.product_name IS NULL;

UPDATE inventory_movements m
SET variant_name = v.name,
    variant_sku  = v.sku
FROM product_variants v
WHERE v.id = m.variant_id AND m.variant_name IS NULL;

-- شبكة أمان: أي صف تخلّف (لا يُفترض وجوده) يبقى مقروءاً بدل أن يُفشل القيد.
UPDATE inventory_movements SET product_name = '(منتج محذوف)' WHERE product_name IS NULL;
UPDATE inventory_movements SET product_sku  = '(غير معروف)'  WHERE product_sku  IS NULL;

ALTER TABLE inventory_movements
  ALTER COLUMN product_name SET NOT NULL,
  ALTER COLUMN product_sku  SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) الختم بترِيغر لا في الخدمة: inventoryMovement.create مكتوب اليوم في ستة
--    مواضع (product-catalog.service.ts:219,264,277,341,368 و
--    csv-transfer.service.ts:331,339)، والسابع سيُكتب بلا مراجعة. الترِيغر
--    يجعل الصف مكتفياً بذاته مهما كان كاتبه — بما فيه SQL خام في اختبار.
--    اسمه يبدأ بحرف بعد g فيعمل بعد ترِيغر الحراسة (Postgres يرتّب أبجدياً)،
--    وهو غير مهمّ منطقياً إذ لا يلمس store_id ولا product_id.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION codiq_stamp_inventory_movement_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND NEW.product_name IS NULL THEN
    SELECT name, sku INTO NEW.product_name, NEW.product_sku
    FROM products WHERE id = NEW.product_id;
  END IF;
  IF NEW.variant_id IS NOT NULL AND NEW.variant_name IS NULL THEN
    SELECT name, sku INTO NEW.variant_name, NEW.variant_sku
    FROM product_variants WHERE id = NEW.variant_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_stamp_snapshot
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION codiq_stamp_inventory_movement_snapshot();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) القلب: Cascade ← SetNull.
--    • DROP NOT NULL توسيعٌ لا تضييق: كل صف قائم يبقى صالحاً.
--    • ADD CONSTRAINT ... NOT VALID يتجنّب مسح الجدول كاملاً تحت قفل؛
--      ثم VALIDATE يأخذ SHARE UPDATE EXCLUSIVE فقط ولا يمنع القراءة والكتابة.
--    • مفتاح مفرد لا مركّب (product_id, store_id) عمداً: SET NULL على مفتاح
--      مركّب يصفّر store_id أيضاً — كارثة عزل. store_id له مفتاحه المستقل إلى
--      stores، والعزل محفوظ.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_movements ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_product_id_fkey;
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_product_id_fkey;

-- ملاحظة: variant_id هو SET NULL أصلاً (20260826120000:151). بعد هذه الهجرة
-- يمكن أن تصل حركة بمفتاحين NULL معاً — وأعمدة اللقطة هي كل ما يبقى منها.
CREATE INDEX inventory_movements_orphan_idx
  ON inventory_movements (store_id, created_at DESC) WHERE product_id IS NULL;
```

---

### 2.2 `prisma/migrations/20260828090100_pg2b_store_audit_events/migration.sql`

```sql
-- PG-2 (ب) — سجل تدقيق «من فعل ماذا» على مستوى المتجر.
-- جدول جديد بالكامل: صفر أثر على أي كتابة أو قراءة قائمة.

CREATE TABLE store_audit_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  entity_type      text NOT NULL,
  -- بلا مفتاح أجنبي عمداً: سجل «من فعل ماذا» يجب أن يعيش أطول من موضوعه،
  -- والتنقية بعد 30 يوماً تحذف الكيان صلباً. Cascade يمحو السجل و Restrict
  -- يحظر التنقية؛ كلاهما يُبطل الميزة.
  entity_id        uuid NOT NULL,
  entity_label     text NOT NULL,   -- لقطة الاسم لحظة الفعل
  entity_secondary text,            -- SKU أو رمز الكوبون أو بريد الموظف
  action           text NOT NULL,
  actor_kind       text NOT NULL,
  actor_id         uuid,            -- بلا FK: ثلاث هويات مختلفة + NULL للنظام
  actor_label      text NOT NULL,   -- لقطة الاسم/البريد لحظة الفعل
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_audit_events_entity_type CHECK (entity_type IN
    ('product','product_variant','product_category','coupon','staff_membership')),
  CONSTRAINT store_audit_events_action CHECK (action IN
    ('soft_deleted','restored','purged','purge_blocked')),
  CONSTRAINT store_audit_events_actor_kind CHECK (actor_kind IN
    ('merchant','staff','platform_owner','system')),
  -- النظام وحده بلا فاعل، وكل فاعل بشري له معرّف.
  CONSTRAINT store_audit_events_actor_pair CHECK ((actor_kind = 'system') = (actor_id IS NULL))
);

-- ترقيم keyset على (created_at DESC, id DESC) كبقية قوائم المنصة.
CREATE INDEX store_audit_events_store_created_idx
  ON store_audit_events (store_id, created_at DESC, id DESC);
CREATE INDEX store_audit_events_entity_idx
  ON store_audit_events (store_id, entity_type, entity_id, created_at DESC);

-- سجل التدقيق غير قابل للتعديل ولا للحذف من أي واجهة (نمط
-- codiq_prevent_ledger_entry_mutation و codiq_prevent_order_status_event_mutation).
CREATE OR REPLACE FUNCTION codiq_prevent_store_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CODIQ_AUDIT_EVENT_IMMUTABLE: store audit events are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER store_audit_events_immutable
BEFORE UPDATE OR DELETE ON store_audit_events
FOR EACH ROW EXECUTE FUNCTION codiq_prevent_store_audit_event_mutation();
```

> **تنبيه مقصود:** الترِيغر يمنع `DELETE` على صفوف التدقيق. حذف متجر (`stores` Cascade) سيصطدم به. القرار: `ON DELETE CASCADE` من `stores` يبقى، والترِيغر يُستثنى منه بشرط `IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM stores WHERE id = OLD.store_id) THEN RAISE …` — أي **يمنع الحذف إلا حين يكون المتجر نفسه يُحذف**. يُضاف هذا الشرط حرفياً في الترِيغر أعلاه قبل الـ`RAISE`. لا يوجد اليوم أي مسار يحذف متجراً، لكن ترك فخّ لمسار مستقبلي غير مقبول.

---

### 2.3 `prisma/migrations/20260828090200_pg2c_soft_delete_trash/migration.sql`

```sql
-- PG-2 (ج) — الحذف الناعم وسلة المحذوفات للكيانات الأربعة (+ متغيّرات المنتج).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) الأعمدة. كلها nullable ⇒ ALTER فوري بلا إعادة كتابة ولا backfill.
--    deleted_event_id: مفتاح أجنبي إلى حدث التدقيق الذي قتل الصف. RESTRICT
--    لأن الحدث يجب أن يبقى ما دام الصف يشير إليه — وهو ما يجعل الاستعادة
--    «تُحيي فقط ما ماتَ بنفس الحدث» حقيقةً بنيوية لا اتفاقاً.
--    deleted_was_active: لقطة is_active قبل الحذف؛ بدونها تعود المسودة منشورة.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

ALTER TABLE product_variants
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean;

ALTER TABLE product_categories
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

ALTER TABLE coupons
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

ALTER TABLE store_staff_memberships
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_event_id   uuid REFERENCES store_audit_events(id) ON DELETE RESTRICT,
  ADD COLUMN deleted_was_active boolean,
  ADD COLUMN purge_blocked_at   timestamptz,
  ADD COLUMN purge_block_reason text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) الثابتة البنيوية: «محذوف ⇒ غير نشط».
--    هذه هي الضمانة التي تُغلق كل السطح العام — بما فيه قفل الشراء بـSQL خام
--    (storefront.service.ts:415 يقرأ p.is_active داخل FOR UPDATE OF v, p) —
--    بصفر تعديل على مسار الدفع.
--    ⚠ فكّ أيٍّ من هذه القيود يفتح المحذوف على الـStorefront في اللحظة نفسها.
--    NOT VALID ثم VALIDATE: لا قفل ACCESS EXCLUSIVE طويل. كل الصفوف الحالية
--    deleted_at IS NULL فالتحقق فوري.
--    وثابتة ثانية: deleted_at و deleted_event_id يتحركان معاً، دائماً.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE products ADD CONSTRAINT products_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT products_deleted_implies_inactive;
ALTER TABLE products ADD CONSTRAINT products_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT products_deleted_pair;
ALTER TABLE products ADD CONSTRAINT products_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT products_purge_block_requires_deleted;

ALTER TABLE product_variants ADD CONSTRAINT product_variants_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE product_variants VALIDATE CONSTRAINT product_variants_deleted_implies_inactive;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE product_variants VALIDATE CONSTRAINT product_variants_deleted_pair;

ALTER TABLE coupons ADD CONSTRAINT coupons_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE coupons VALIDATE CONSTRAINT coupons_deleted_implies_inactive;
ALTER TABLE coupons ADD CONSTRAINT coupons_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE coupons VALIDATE CONSTRAINT coupons_deleted_pair;
ALTER TABLE coupons ADD CONSTRAINT coupons_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE coupons VALIDATE CONSTRAINT coupons_purge_block_requires_deleted;

ALTER TABLE store_staff_memberships ADD CONSTRAINT ssm_deleted_implies_inactive
  CHECK (deleted_at IS NULL OR is_active = false) NOT VALID;
ALTER TABLE store_staff_memberships VALIDATE CONSTRAINT ssm_deleted_implies_inactive;
ALTER TABLE store_staff_memberships ADD CONSTRAINT ssm_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE store_staff_memberships VALIDATE CONSTRAINT ssm_deleted_pair;
ALTER TABLE store_staff_memberships ADD CONSTRAINT ssm_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE store_staff_memberships VALIDATE CONSTRAINT ssm_purge_block_requires_deleted;

ALTER TABLE product_categories ADD CONSTRAINT product_categories_deleted_pair
  CHECK ((deleted_at IS NULL) = (deleted_event_id IS NULL)) NOT VALID;
ALTER TABLE product_categories VALIDATE CONSTRAINT product_categories_deleted_pair;
ALTER TABLE product_categories ADD CONSTRAINT product_categories_purge_block_requires_deleted
  CHECK (purge_blocked_at IS NULL OR deleted_at IS NOT NULL) NOT VALID;
ALTER TABLE product_categories VALIDATE CONSTRAINT product_categories_purge_block_requires_deleted;
-- product_categories بلا is_active: publicCategories يشترط منتجاً نشطاً في
-- الشجرة (storefront.service.ts:115-119)، فتصنيف محذوف لا يظهر علناً بنيوياً.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) تحرير فضاء الرموز: القيد الكامل ← فهرس فريد جزئي.
--    الأسماء أدناه هي أسماء القيود الفعلية في القاعدة (تحققت منها في الهجرات)،
--    لا الأسماء التي يولّدها Prisma افتراضياً.
--    الإسقاط والإنشاء داخل معاملة الهجرة الواحدة ⇒ لا نافذة يرى فيها أي اتصال
--    آخر الجدول بلا حماية فرادة.
--    أسماء الفهارس مقصودة: errors.ts:34-37 يطابق target.includes("product_categories"
--    | "coupons" | "product_variants" | "products") بهذا الترتيب، فكل اسم يقع
--    في فرعه الصحيح ورسائل 409 القائمة تبقى تعمل بلا تعديل.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE products DROP CONSTRAINT products_store_id_sku_key;
CREATE UNIQUE INDEX products_store_sku_live_key
  ON products (store_id, sku) WHERE deleted_at IS NULL;

ALTER TABLE product_variants DROP CONSTRAINT product_variants_store_sku_key;
CREATE UNIQUE INDEX product_variants_store_sku_live_key
  ON product_variants (store_id, sku) WHERE deleted_at IS NULL;

ALTER TABLE product_categories DROP CONSTRAINT product_categories_store_normalized_name_key;
CREATE UNIQUE INDEX product_categories_store_name_live_key
  ON product_categories (store_id, normalized_name) WHERE deleted_at IS NULL;

ALTER TABLE coupons DROP CONSTRAINT coupons_store_code_unique;
CREATE UNIQUE INDEX coupons_store_code_live_key
  ON coupons (store_id, code_normalized) WHERE deleted_at IS NULL;

ALTER TABLE store_staff_memberships DROP CONSTRAINT store_staff_memberships_unique_staff_store;
CREATE UNIQUE INDEX store_staff_memberships_staff_store_live_key
  ON store_staff_memberships (staff_id, store_id) WHERE deleted_at IS NULL;

-- المتغيّر الافتراضي: منتج محذوف يجب ألّا يحجز مقعد «الافتراضي» عن نسخة حيّة
-- لو أُعيد إنشاء المنتج بنفس المعرّف مستقبلاً؛ والأهم أنه لا يجب أن يمنع
-- ترِيغر codiq_create_default_product_variant من العمل.
DROP INDEX product_variants_one_default_uq;
CREATE UNIQUE INDEX product_variants_one_default_uq
  ON product_variants (product_id) WHERE is_default AND deleted_at IS NULL;

-- ⚠ (id, store_id) و (id, product_id, store_id) و (id, staff_id, store_id)
--   تبقى قيوداً كاملة غير جزئية: هي أهداف المفاتيح الأجنبية المركّبة التي
--   يقوم عليها عزل المتاجر كله (cart_items, inventory_reservations,
--   product_variants, staff_sessions). لمسها يهدم النموذج.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) فهارس السلة والتنقية. جزئية على الصفوف المحذوفة وحدها ⇒ صغيرة جداً.
--    ترتيب الكنس (purge_blocked_at NULLS FIRST, deleted_at) يضمن أن الصفوف
--    المحجوبة تُعاد محاولتها بلا أن تُجوّع الصفوف الجديدة.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX products_store_trash_idx ON products (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX products_purge_sweep_idx ON products (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX product_categories_store_trash_idx ON product_categories (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX product_categories_purge_sweep_idx ON product_categories (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX coupons_store_trash_idx ON coupons (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX coupons_purge_sweep_idx ON coupons (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX ssm_store_trash_idx ON store_staff_memberships (store_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX ssm_purge_sweep_idx ON store_staff_memberships (purge_blocked_at NULLS FIRST, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX product_variants_product_trash_idx ON product_variants (product_id, deleted_event_id)
  WHERE deleted_at IS NOT NULL;
```

---

## 3. تغييرات `prisma/schema.prisma`

```prisma
model Product {
  // … الحقول القائمة بلا تغيير …
  deletedAt        DateTime? @map("deleted_at")        @db.Timestamptz(6)
  deletedEventId   String?   @map("deleted_event_id")  @db.Uuid
  deletedWasActive Boolean?  @map("deleted_was_active")
  purgeBlockedAt   DateTime? @map("purge_blocked_at")  @db.Timestamptz(6)
  purgeBlockReason String?   @map("purge_block_reason") @db.Text
  deletedEvent     StoreAuditEvent? @relation("ProductDeletedEvent", fields: [deletedEventId], references: [id], onDelete: Restrict)

  // PG-2: @@unique([storeId, sku]) أُزيل. البديل فهرس فريد جزئي
  // products_store_sku_live_key ON (store_id, sku) WHERE deleted_at IS NULL
  // يعيش في الهجرة 20260828090200 وحدها — نفس سياسة plans_single_recommended
  // (20260827170000) و order_tags. لا تُعده إلى هنا: عودته تقفل الـSKU
  // على منتج في سلة المحذوفات.
  @@unique([id, storeId])
  @@index([storeId])
  // … بقية الفهارس كما هي …
}
```
نفس النمط حرفياً على `ProductVariant` (بلا أعمدة التنقية) و`ProductCategory` (بلا `deletedWasActive`) و`Coupon` و`StoreStaffMembership` — مع **إزالة** `@@unique([storeId, sku], map:"product_variants_store_sku_key")` و`@@unique([storeId, normalizedName])` و`@@unique([storeId, codeNormalized], map:"coupons_store_code_unique")` و`@@unique([staffId, storeId], map:"store_staff_memberships_unique_staff_store")`، وإبقاء كل `@@unique([id, …])` كما هي.

```prisma
model InventoryMovement {
  productId   String?  @map("product_id") @db.Uuid   // كان String
  productName String   @map("product_name") @db.Text
  productSku  String   @map("product_sku")  @db.Text
  variantName String?  @map("variant_name") @db.Text
  variantSku  String?  @map("variant_sku")  @db.Text
  product     Product? @relation(fields: [productId], references: [id], onDelete: SetNull)
  // … البقية كما هي …
  @@index([storeId, createdAt(sort: Desc)], map: "inventory_movements_orphan_idx")
}

model StoreAuditEvent {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  storeId         String   @map("store_id") @db.Uuid
  entityType      String   @map("entity_type") @db.Text
  entityId        String   @map("entity_id") @db.Uuid
  entityLabel     String   @map("entity_label") @db.Text
  entitySecondary String?  @map("entity_secondary") @db.Text
  action          String   @db.Text
  actorKind       String   @map("actor_kind") @db.Text
  actorId         String?  @map("actor_id") @db.Uuid
  actorLabel      String   @map("actor_label") @db.Text
  metadata        Json     @default("{}") @db.JsonB
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  store           Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  deletedProducts    Product[]              @relation("ProductDeletedEvent")
  deletedVariants    ProductVariant[]       @relation("VariantDeletedEvent")
  deletedCategories  ProductCategory[]      @relation("CategoryDeletedEvent")
  deletedCoupons     Coupon[]               @relation("CouponDeletedEvent")
  deletedMemberships StoreStaffMembership[] @relation("MembershipDeletedEvent")

  @@index([storeId, createdAt(sort: Desc), id(sort: Desc)], map: "store_audit_events_store_created_idx")
  @@index([storeId, entityType, entityId, createdAt(sort: Desc)], map: "store_audit_events_entity_idx")
  @@map("store_audit_events")
}
```
و`Store` يكسب `auditEvents StoreAuditEvent[]`.

**أثر تصريفي مقصود ومرغوب:** إزالة `@@unique([storeId, codeNormalized])` تكسر `prisma.coupon.findUnique({ where: { storeId_codeNormalized } })` في `coupon.service.ts:122, 195, 223`. **هذا فشل تصريف يُراد وقوعه**: المترجم نفسه يفرض تحويلها إلى `findFirst({ where: { storeId, codeNormalized, ...LIVE } })`. `storeId_sku` و`staffId_storeId` و`storeId_normalizedName` غير مستعملة كمدخل مركّب في أي مكان (تحققت بـgrep على `phase1-backend/src` و`client/src`).

---

## 4. الملفات المتأثرة

### ملفات جديدة (خلفية)

| الملف | ما فيه |
|---|---|
| `D:\saif\codiq\CODIQ\phase1-backend\src\services\soft-delete\constants.ts` | `export const LIVE = { deletedAt: null } as const;` و`TRASHED`، و`TRASH_RETENTION_DAYS = 30`. الرمز الوحيد الذي يُنشر في كل `where`. |
| `…\src\services\soft-delete\audit-log.service.ts` | `recordAuditEvent(tx, {...}): Promise<string>` — يُنادى **قبل** كتابة `deleted_at` لأن `deleted_event_id` مفتاح أجنبي إليه؛ و`listAuditEvents(storeId, cursor)` بترقيم keyset. |
| `…\src\services\soft-delete\soft-delete.service.ts` | `softDelete(entity, storeId, id, actor)` · `restore(entity, storeId, id, actor, overrides)` · `listTrash(storeId, entityType?)`. الملف **الوحيد** المسموح له بكتابة `deletedAt`. جدول تعريفي واحد لكل كيان: اسم النموذج، الحرّاس السابقة، بنّاء اللقطة، الآثار الجانبية. |
| `…\src\services\soft-delete\purge-job.ts` | `purgeExpiredSoftDeletes({ now, batchSize })` — كل صف في معاملته الخاصة، ترتيب المرور إلزامي، إعادة محاولة واحدة في نهاية المرور، `P2003 → purge_blocked`. + `startTrashPurger(intervalMs)` بنمط `abandoned-cart-scanner.ts`. |
| `…\src\http\routes\trash.ts` | `GET /merchant/stores/:storeSlug/trash?entityType=` · `POST …/trash/:entityType/:id/restore` · `GET …/audit-events`. |
| `…\tests\pg2.integration.mjs` و`…\tests\pg2.no-deleted-leak.test.ts` | §5. |
| `client\src\components\TrashBin.tsx` و`DeleteConfirmSheet.tsx` و`ActivityLog.tsx` | §4 واجهة. |

### ملفات معدَّلة (خلفية)

| الملف:الموضع | التغيير |
|---|---|
| `prisma\schema.prisma` | §3. |
| **`…\src\services\coupon.service.ts:81`** | **إضافة `AND deleted_at IS NULL` إلى `lockCouponForCheckout`** — بدونه يُرجع القفل صفوفاً متعددة و`rows[0]` يرفض كوبوناً صالحاً بـ422 على مسار الشراء. **أخطر سطر في الخطة.** |
| **`…\src\services\storefront.service.ts:416-418`** | إضافة `AND v.deleted_at IS NULL AND p.deleted_at IS NULL` إلى استعلام قفل الشراء — الثابتة تغطيه، لكن الترشيح الصريح يجعل الحماية مرئية في مكان استعمالها بدل أن تكون ضمنية. |
| `…\src\services\coupon.service.ts:122,195,223` | `findUnique({storeId_codeNormalized})` → `findFirst({ storeId, codeNormalized, ...LIVE })`. |
| `…\src\services\coupon.service.ts:183`، وتعليق الرأس :184 | `listCoupons` → `LIVE`؛ حذف عبارة «no DELETE by design» التي صارت غير صحيحة؛ إضافة `deleteCoupon`/`restoreCoupon` بتفويض إلى `soft-delete.service`. |
| `…\src\services\product-catalog.service.ts:42,48` | `scopedProduct` و`scopedCategory` → `...LIVE`. |
| `…\:69,83,96,116` | `categoryAncestorDepth` · `categoryDescendantIds` · `categorySubtreeHeight` · `resolveParentCategoryId` → `LIVE` (فرع محذوف لا يُحتسب في ميزانية العمق). |
| `…\:150` | `listCategories` → `LIVE` **و** `_count: { select: { products: { where: LIVE } } }` — وإلا عدّ التصنيف منتجات في السلة. |
| `…\:170-177` | `deleteCategory` → `softDelete`؛ `childCount` و**`productCount` كلاهما `LIVE`** (409 `CATEGORY_IN_USE` للمنتجات الحيّة فقط — قرار §1.و.2). |
| `…\:179,182` | `listProducts` والـcursor → `LIVE`. |
| `…\:296-302` | `deleteProduct` → ثلاثة حرّاس (طلب · **سلة حيّة** · **حجز نشط**) ثم `softDelete`. |
| `…\:305,318,413,417,421` | `scopedVariant` و`assertVariantSkuAvailable` و`allocateCopySku` (الفرعان) → `LIVE` — وإلا بقي `-COPY` محجوزاً بنسخة محذوفة. |
| `…\:381-392` | `deleteVariant` يبقى صلباً؛ فحوصه تُرشَّح `LIVE`. |
| `…\:500` | `productImageForStore` → المنتج `LIVE`. |
| `…\src\services\staff.service.ts:44,85` | `listStoreTeam` و`requireMembershipInStore` → `LIVE`؛ إضافة `removeStoreMembership` (حارس «آخر مدير» + `permissionVersion+1` + إبطال الجلسات + `assertDemoWritable`) و`restoreStoreMembership`. |
| `…\src\services\csv-transfer.service.ts:224,225` | **حرج**: كشف تعارض SKU → `LIVE`. بدونه يرفض المستورد صفّاً مشروعاً بـ`SKU_EXISTS` بسبب رمز يمسكه منتج في السلة، والتاجر لا يرى المنتج المعتدي في أي شاشة. |
| `…\:239,356,371` | `existingCategories` والتصدير → `LIVE`. |
| `…\src\services\merchant-search.service.ts:154,155` | → `LIVE`. |
| `…\src\services\entitlement.service.ts:65` | `product.count` → `LIVE`: منتج في السلة **لا** يستهلك حصة الخطة، وإلا عجز تاجر على الحد عن استبدال منتج 30 يوماً. `:66` عدّ الموظفين يفلتر `isActive` أصلاً فيكفي. `:68` تجميع الصور **يبقى بلا ترشيح** عمداً — البايتات مخزَّنة فعلاً (§6). |
| `…\src\services\analytics.service.ts:198` | `coupon.findMany` → `LIVE`. الـ`$queryRaw:135` على `order_items` لا يتغيّر — يقرأ لقطات. |
| `…\src\services\abandoned-cart.service.ts` (قراءتا الكوبون) و`…\src\notifications\abandoned-cart-scanner.ts:60` | → `LIVE` (الثابتة تكفي؛ الترشيح ليمرّ الحارس ويوثّق النية). |
| `…\src\auth\auth.service.ts` و`…\src\auth\staff-permissions.ts` (قراءتا العضوية) | → `LIVE`: تسجيل الدخول ورفع الصلاحيات لا يريان عضوية محذوفة. |
| **`…\src\http\errors.ts`** | **فرع P2003 جديد قبل `console.error`** (`errors.ts:43`): خريطة `error.meta?.constraint` → 409 عربية — `cart_items_*` → `PRODUCT_IN_ACTIVE_CART`، `inventory_reservations_*` → `PRODUCT_HAS_ACTIVE_RESERVATION`، `order_items_*` → `PRODUCT_REFERENCED_BY_ORDER`، `product_categories*` → `CATEGORY_IN_USE`، `coupon_redemptions_*` → `COUPON_REFERENCED_BY_REDEMPTION` — وفرع نصّي للـSQL الخام (`23503`). **هذا وحده يُغلق باباً مفتوحاً اليوم يُنتج 500 عامة.** |
| `…\src\http\routes\catalog.ts:28,35,37` | الحذفان يفوّضان إلى `softDelete` ويعيدان **200** بجسم `{ id, deletedAt, purgeAt }` بدل 204 (الواجهة تحتاج `purgeAt` وزر «تراجع»)؛ الجلب المفرد المضمّن → `LIVE`. |
| `…\src\http\routes\orders.ts:26,31` | منتقي المنتجات للطلب اليدوي → `LIVE`. بدونه يُنشئ تاجرٌ طلباً على منتج في السلة فيصير `order_item` يمنع تنقيته للأبد. |
| `…\src\http\routes\team.ts` و`…\marketing.ts` | مسارا حذف/استعادة العضوية والكوبون. |
| `…\src\auth\staff-permissions.ts:11-23,31-34` | ثلاث صلاحيات: `catalog.trash.view` · `catalog.trash.restore` · `catalog.audit.view` — كلها لـ`store_manager` فقط (`store_staff` لا يرى من عطّله). |
| `…\src\notifications\worker-entry.ts` | فاصل ثالث `startTrashPurger` + `console.log` + `purger.stop()` في `shutdown`. |
| `package.json` | `"pg2:test": "tsx phase1-backend/tests/pg2.integration.mjs"`. |

### واجهة أمامية

| الملف | التغيير |
|---|---|
| `client\src\components\DeleteConfirmSheet.tsx` (جديد، مشترك للأربعة) | ورقة تقول الحقيقة **قبل** الفعل: «سيختفي **قميص قطني** من متجرك فوراً. تستطيع استعادته خلال ٣٠ يوماً. **سجل حركة المخزون (١٤ حركة) يُحفظ دائماً.**» — بعدد الحركات الحقيقي من الخادم. وعند 409: **صندوق داخل الورقة نفسها لا toast** — «مباع في ٣ طلبات — لا يُحذف حفاظاً على سجلّها. **تريد إخفاءه من متجرك بدلاً من ذلك؟**» + زرّ ينفّذ `isActive=false` في النقرة نفسها. التاجر أراد «اختفِ من متجري» لا «امحُ من القاعدة». |
| `client\src\components\TrashBin.tsx` (جديد) | `/merchant/stores/:slug/trash` — أربعة تبويبات، كل سطر: الاسم، الرمز، **من حذفه**، **«يُحذف نهائياً بعد ١٢ يوماً»** (أيام معدودة لا طابع زمني)، و`deletedAt` كمميّز إلزامي (صفّان محذوفان قد يحملان نفس الرمز — وهو صحيح ومقصود). السطور المحجوبة: شارة **«محفوظ لسجلاتك»** بلا عدّاد، مع سبب مقروء. |
| `client\src\components\ActivityLog.tsx` (جديد) | تبويب خامس: خطّ زمني عربي — «سارة (موظفة) حذفت المنتج «قميص قطني» — أمس ٣:١٤ م». |
| `ProductCatalogManager.tsx:87,121,303` · `CouponsManager.tsx` · `StoreTeamManager.tsx` | استبدال `window.confirm` بالورقة المشتركة؛ رسالة النجاح تحمل زر **«تراجع»** يستدعي الاستعادة فوراً؛ معالجة `SKU_TAKEN_BY_ACTIVE_PRODUCT` بحقل رمز مملوء مسبقاً؛ تسمية «إيقاف» مقابل «إزالة من الفريق». |
| `MerchantDashboard.tsx` | تسجيل الشاشتين خلف الصلاحيتين الجديدتين. |

---

## 5. حالات الاختبار

ملف تكامل واحد `D:\saif\codiq\CODIQ\phase1-backend\tests\pg2.integration.mjs` (قالب `phase20b1.integration.mjs`) + حارس ثابت `pg2.no-deleted-leak.test.ts`.

### المعيار 1 — الاختفاء الفوري

- **T1** منتج نشط → `DELETE` → في **نفس** الطلب: `GET /store/:slug/products` لا يحويه · `GET …/products/:id` = 404 · `GET …/products/:pid/images/:iid` = 404 · `listProducts` التاجرية · البحث الموحّد · تصدير CSV · منتقي الطلب اليدوي (`orders.ts:26`) — كلها صفر/404، بلا انتظار أي وظيفة.
- **T2 — الشراء أثناء الحذف (يُثبت أن الثابتة تحمي SQL الخام):** زبون يضع المنتج في سلته، التاجر يحذف، الزبون يُنهي الشراء → **422 `PRODUCT_UNAVAILABLE`**، لا 500 ولا نجاح.
- **T3** تصنيف محذوف يختفي من `publicCategories` و`listCategories`.
- **T4** `addCartItem` بـ`variantId` تابع لمنتج محذوف → **404** لا 500.

### المعيار 2 — لا يُفقد أي أثر تدقيق مخزوني (هذا هو D-48)

- **T5** منتج بمخزون 10 (`initial_stock`) ثم تعديل إلى 4 (`manual_adjustment`) → حذف ناعم → **الحركتان موجودتان و`product_id` سليم**.
- **T6 — الاختبار الذي يفشل على `main` اليوم:** تشغيل `purgeExpiredSoftDeletes({ now: +31d })` → المنتج مُزال، **الحركتان ما زالتا موجودتين** بـ`product_id IS NULL` و`product_name` و`product_sku` تقرآن القيم الأصلية.
- **T7 — لغم الترِيغر صراحةً:** نفس السيناريو، مع تأكيد أن التنقية **لا ترمي `CODIQ_PRODUCT_STORE_MISMATCH`** وأن `purgeExpiredSoftDeletes` تُرجع `{ purged: 1, blocked: 0 }`. هذا الاختبار يفشل بلا إصلاح `codiq_guard_product_child_store`، ونجاحه هو البرهان الوحيد على أن المعيار الرابع يعمل أصلاً.
- **T8 — حركة بمرجعين مصفَّرين:** حذف متغيّر غير افتراضي (يصفّر `variant_id`) ثم حذف المنتج وتنقيته (يصفّر `product_id`) → صفّ بمفتاحين NULL؛ `product_name`/`product_sku` مقروءان وقائمة حركات المتجر تعرضه بلا 500.

### المعيار 3 — الاستعادة بالحالة الكاملة

- **T9** منتج بتصنيف + ٣ متغيّرات (أحدها معطّل) + صورتين + `requiresPrescription=true` + مخزون 7 → حذف → استعادة → مقارنة عميقة لحمولة `productPayload` قبل/بعد (بتجاهل `updatedAt`) = تطابق تام، وترتيب المتغيّرات محفوظ.
- **T10** منتج كان **مسودة** (`isActive=false`) يعود مسودة — يُثبت `deleted_was_active`.
- **T11 — الحالة الحدّية التي وجدها محكّم maintainability (الاستعادة الانتقائية):** التاجر يحذف المتغيّر «أحمر — L» يوم الاثنين، ثم يحذف المنتج كلّه يوم الأربعاء، ثم يستعيد المنتج يوم الخميس → **«أحمر — L» يبقى في السلة**. يُثبت أن `deleted_event_id` يمنع البعث الصامت.
- **T12** استعادة عضوية → التجاوزات عادت، **والجلسات لم تعُد** (يسجّل الدخول من جديد).

### المعيار 4 — التنقية بعد 30 يوماً

- **T13** `now: +29d` → صفر منقّى؛ `now: +31d` → منقّى. واستدعاء ثانٍ للماسح: صفر تغييرات (idempotent).
- **T14 — جدار الدفتر:** منتج محذوف يُزرع له `order_item` → عند `+31d` **لا يُحذف**، يُختم `purge_blocked_at`، `order_items` سليم، **ولا استثناء يتسرّب من الوظيفة**، والنتيجة `{ purged: 0, blocked: 1 }`.
- **T15** كوبون له `coupon_redemptions` → `purge_blocked`؛ كوبون بلا استرجاعات → يُنقّى فعلاً.
- **T16 — عضوية بجلسات مُبطلة:** `staff_sessions.membership_id` بـ`Restrict` (`schema.prisma:662`) → التنقية تحذف الجلسات المُبطلة أولاً ثم العضوية؛ صف `Staff` **باقٍ**، و`order_status_events.actor_id` ما زال يشير إليه.
- **T17 — الحالة الحدّية التي وجدها تصميم product (التصنيف المحجوب أبداً):** حذف المنتج الوحيد في تصنيف «الصيف» ثم حذف التصنيف؛ عند `+31d` في **مرور واحد** → **الاثنان اختفيا وصفر `purge_blocked`**. يُثبت ترتيب المرور + إعادة المحاولة في نهايته. ويُختبر العكس: لو كان المنتج مباعاً (محجوباً) فالتصنيف يُختم محجوباً كذلك بسبب مقروء.

### المعيار 5 — 409 واضحة لا 500 عامة

- **T18** منتج مرتبط بطلب → **409 `PRODUCT_REFERENCED_BY_ORDER`**، والجسم يحمل `hint: "deactivate"` الذي تعرضه الورقة كزرّ «أخفِه بدلاً من ذلك».
- **T19 — العطل الحيّ:** منتج داخل سلة زبون حيّة → اليوم **500 `INTERNAL_ERROR`**؛ بعد التنفيذ **409 `PRODUCT_IN_ACTIVE_CART`**. الاختبار يفشل قبل الإصلاح ويمرّ بعده.
- **T20** منتج بحجز مخزون نشط → **409 `PRODUCT_HAS_ACTIVE_RESERVATION`**.
- **T21** `DELETE` صلب مباشر عبر `$executeRaw` على منتج مرتبط بطلب → يصل إلى `errorHandler` فيخرج **409** لا 500 (يُثبت فرع P2003 الجديد).
- **T22** استعادة بـSKU مأخوذ → **409 `SKU_TAKEN_BY_ACTIVE_PRODUCT`** بالحمولة الكاملة؛ ثم إعادة الاستعادة بـ`{"sku":"SKU-100-1"}` تنجح.

### الحالات الحدّية الإضافية (كلها من نقد المحكّمين)

- **E1 — قفل الكوبون:** كوبون `SUMMER` حيّ + كوبون `SUMMER` محذوف في المتجر نفسه → `previewCoupon` و`lockCouponForCheckout` كلاهما يجد **الحيّ حصراً**، والشراء ينجح. يُشغَّل **عشر مرات متتالية** لأن الخطأ متقطّع بطبيعته (`rows[0]` بلا `ORDER BY`). **هذا الاختبار وحده يحرس أخطر خلل سمّاه المحكّمون.**
- **E2 — استيراد CSV:** SKU `ABC` يمسكه منتج محذوف → رفع CSV يحوي `ABC` **ينجح** ويُنشئ صفّاً جديداً حيّاً؛ القديم يبقى محذوفاً؛ `products_store_sku_live_key` غير مخروق؛ والتنقية عند `+31d` تُزيل القديم وحده.
- **E3 — رمزان متطابقان في السلة:** حذف `ABC` → إنشاء `ABC` → حذفه → صفّان محذوفان بنفس SKU (صحيح ومقصود). السلة تعرضهما مميَّزين بـ`deletedAt`؛ استعادة الأول تنجح، والثاني تُعيد 409 تسمّي الأول.
- **E4 — المتغيّر الافتراضي عند إعادة الاستعمال:** إنشاء منتج بـSKU حرّرَه منتج محذوف ⇒ `codiq_create_default_product_variant` يُدرج متغيّراً افتراضياً بنفس الرمز ⇒ **لا يخرق** `product_variants_store_sku_live_key` لأن متغيّرات المنتج المحذوف محذوفة معه. يفشل بلا تعدية الحذف إلى المتغيّرات.
- **E5 — الثابتة نفسها:** محاولة `UPDATE products SET is_active = true WHERE deleted_at IS NOT NULL` عبر `$executeRaw` → **تُرفض بـ23514**. يُثبت أن حماية الـStorefront بنيوية لا عُرفية.
- **E6 — تصنيف محذوف واستعادة منتجه:** حذف منتج ثم حذف تصنيفه (مسموح الآن، فالمنتجات الحيّة صفر) ثم استعادة المنتج → **التصنيف يُحيا في المعاملة نفسها** ويعود المنتج مصنَّفاً. وإن كان الاسم قد صار لتصنيف حيّ → **409 `CATEGORY_NAME_TAKEN`**، ثم الاستعادة بـ`{"categoryId": null}` تنجح والمنتج يعود بلا تصنيف.

### الحارس الثابت `pg2.no-deleted-leak.test.ts`

يمرّ على `phase1-backend/src` بـ`ts.createSourceFile`:
1. كل `CallExpression` شكله `<x>.(product|productVariant|productCategory|coupon|storeStaffMembership).(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate|groupBy)` يجب أن يذكر وسيطه `deletedAt` أو `LIVE` أو `TRASHED`، أو يكون في `ALLOWLIST` بـ`file:line` **وسبب نصّي إلزامي**.
2. كل `TaggedTemplateExpression` لـ`$queryRaw`/`$executeRaw` يذكر `FROM products|product_variants|coupons|store_staff_memberships` يجب أن يذكر `deleted_at`. (بعد إصلاحَي `coupon.service.ts:81` و`storefront.service.ts:416` لا يبقى أي مُدرَج في قائمة السماح لهذا الشقّ — وهذا مقصود.)
3. كتابة `deletedAt` مسموحة حصراً في `services/soft-delete/*.ts`.
4. كل `_count`/`include` على العلاقات الخمس داخل النماذج المُراقَبة يجب أن يحمل `where` فيه `deletedAt` (يغطي `listCategories:151`).
5. **حارس مخطط تشغيلي** يُنادى من `pg2.integration.mjs`: يستعلم `pg_constraint` و`pg_indexes` ويؤكّد وجود القيود الأربعة `*_deleted_implies_inactive` والفهارس الخمسة `*_live_key`، وغيابَ القيود الكاملة القديمة. يمنع هجرة مستقبلية تعيد القيد الكامل فتقفل الـSKU.

---

## 6. ما استُبعد عمداً — الحدود المعلنة

1. **نمط العرض (`products_all` + `VIEW products`).** هو الآلية الوحيدة التي تجعل التسرّب مستحيلاً حقاً بما فيه القراءات المتداخلة. رُفض لثلاثة أسباب: نصف قطر انفجاره المنصة كلها في لحظة واحدة بلا طرح تدريجي على متجر دفع-عند-الاستلام حيّ؛ ويعتمد على خمسة سلوكيات Postgres غير مقيسة في هذا المشروع (أخطرها `SELECT … FOR UPDATE` عبر عرض في مسار الدفع)؛ ومبرّره المعلن — «تسريب صورة المنتج» — واقعة ملفَّقة أثبتُّ بطلانها في §0. **الثمن المقبول بوعي:** حمايتنا للسطح التاجري فحص ثابت (lint) لا قيد قاعدة. غطاؤه أن السطح الذي يؤذي الزبون مقفل بنيوياً؛ تسريب في قائمة تاجرية = صفّ زائد يراه صاحبه، وتسريب في الـStorefront = بيع منتج غير موجود.
2. **الاعتماد الوحيد على `deleted ⇒ is_active=false`.** التصميم الفائز أورث حماية عشرة مسارات من عمود موجود، واعترف بأن العمود صار يحمل معنيين. **خفّفنا ذلك بالترشيح الصريح في المسارين الخامين** (`coupon.service.ts:81`، `storefront.service.ts:416`) فصارت الحماية مرئية حيث تُستعمل. لكن `publicProducts` و`publicProduct` وقراءات السلة ما زالت تعتمد على الثابتة وحدها. **إن ظهر مستقبلاً متطلّب يفصل «مسودة» عن «محذوف»** (إعادة نشر مجدولة، وضع إجازة)، الواجب هو إضافة `LIVE` إلى تلك القراءات الأربع **قبل** فكّ أي قيد `*_deleted_implies_inactive` — والتعليق فوق القيد يقولها حرفياً، واختبار E5 يحرسها.
3. **حذف المتغيّرات ليس في النطاق.** `deleteVariant` يبقى حذفاً صلباً محروساً؛ المتغيّر يُحذف ناعماً **فقط** بالتبعية مع أبيه. حذف متغيّر منفرد إلى سلة المحذوفات بند مستقل.
4. **قراءة المالك لسجل التدقيق مستبعدة في v1.** لوحة المالك لا تملك اليوم أي سطح تدقيق لكل متجر، وإضافته نطاق لم يشتره التفويض. الجدول store-scoped فإضافته لاحقاً استعلام واحد + شاشة.
5. **سجل التدقيق يسجّل `soft_deleted|restored|purged|purge_blocked` فقط.** لا يُعاد تجهيز الطفرات القائمة (تعديل منتج، تغيير سعر، تبديل دور). البند يبيع «من حذف ماذا»، والجدول مفتوح للنمو بلا هجرة.
6. **`max_image_storage_mb` يظل يحسب صور المنتجات المحذوفة.** البايتات مخزَّنة فعلاً في S3 حتى التنقية. بالمقابل `max_products` و`max_staff` **لا** يحسبان المحذوف — «محذوف» يجب أن يعني «تحرّرت الحصة». التفاوت مقصود ومُعلَن في الواجهة.
7. **حذف منتج في متجر بمئة ألف سلة نشطة** يحذف `cart_items` بعبارة واحدة داخل معاملة الحذف. عند ذلك الحجم يجب أن يصير دفعات في العامل، وليس كذلك في v1.
8. **مدة الـ30 يوماً ثابت في الكود (`TRASH_RETENTION_DAYS`) لا إعداد متجر.** أول تاجر يطلب 90 يوماً يحتاج عموداً على `stores` وهجرة.
9. **حذف شجرة فرعية من التصنيفات مستبعد.** 409 `CATEGORY_HAS_CHILDREN` يبقى كما هو؛ حذف تصنيف بأبنائه ميزة أخرى.
10. **الصفوف المحجوبة عن التنقية تبقى إلى الأبد.** أي منتج بِيع مرة واحدة يصير `purge_blocked` ويبقى صفّه في `products` للأبد. السلة تُفرَغ كما وُعد؛ القرص لا. البديل (تجريد الصف من محتواه) يُتلف بالضبط الأثر الذي يقول المعيار الثاني إنه يجب ألا يُفقد. **اخترنا الوعد الذي يمكن الوفاء به وسمّينا الآخر.**

---

## 7. قرار مطلوب من المالك

**واحد فقط، وله افتراضٌ منفَّذ حتى يُقال غير ذلك:**

> **معيار القبول الخامس مكتوب: «محاولة حذف عنصر مرتبط بطلب تعيد 409 واضحة».** هذه الخطة تنفّذه **حرفياً**: منتج بِيع مرة واحدة **لا يدخل سلة المحذوفات إطلاقاً** — يُرفض بـ409 مع زرّ «أخفِه من متجرك بدلاً من ذلك» ينفّذ `is_active=false` في النقرة نفسها.
>
> والثمن أن **أشيع حالة في متجر عامل** (منتج بِيع ثم توقف التاجر عن بيعه) لا تصل إلى الميزة أبداً: التاجر يحصل على «إخفاء» لا على «سلة محذوفات». تصميم structural اقترح **نقل** الـ409 من الحذف الناعم إلى التنقية الدائمة — أي أن كل شيء يدخل السلة، والدفتر يُحمى عند التنقية بجدار المفاتيح الأجنبية (الموجود أصلاً في هذه الخطة).
>
> **البديلان:**
> - **(أ) الحرفي — منفَّذ افتراضياً:** 409 عند الحذف. آمن، ومطابق للنص المعتمد، وثمنه أن الميزة لا تغطي أشيع حالة.
> - **(ب) الموسَّع:** يُرفع حارس `PRODUCT_REFERENCED_BY_ORDER` من `softDelete`، فيدخل المنتج المباع السلة ويعود منها، وعند اليوم 31 يصير `purge_blocked` ويبقى بشارة «محفوظ لسجلاتك». **الفرق في الكود: إزالة أربعة أسطر وتعديل اختبار T18.** لا هجرة ولا تغيير معماري — الجدار الذي يحمي الدفتر مبنيّ في الحالتين.
>
> **توصيتي: (ب).** حراس «السلة الحيّة» و«الحجز النشط» يبقيان (يحميان عملية جارية الآن)، أما «بِيع قبل شهرين» فليس سبباً لمنع التاجر من إزالته من متجره إلى سلة يستطيع التراجع عنها. لكن (ب) **يعدّل معياراً معتمداً**، فلا أنفّذه بلا كلمتك.

**قراران ثانويان مُحسمان هندسياً، مذكوران للعلم لا للتصويت:** مدة الاحتفاظ 30 يوماً ثابتة (§6.8)، وقراءة سجل التدقيق للتاجر وحده في v1 (§6.4).

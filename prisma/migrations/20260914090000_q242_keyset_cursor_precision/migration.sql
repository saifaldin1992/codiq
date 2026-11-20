-- ق-242 — دقّة المؤشّر تساوي دقّة العمود.
--
-- العيب: `encodeListCursor` يسلسل تاريخاً بدقّة **الميلي ثانية**
-- (`Date.toISOString()`)، بينما كلّ عمودٍ يرتّب عليه keyset مخزَّنٌ
-- `timestamptz(6)` — أي **الميكرو ثانية**. فالجانبان لا يتّفقان على القيمة
-- نفسها، والنتيجة عيبان متقابلان:
--
--   · الصفحات الصاعدة تعيد **صفّ الحدّ نفسه** في أوّل الصفحة التالية، كلّما
--     كان للقيمة المخزَّنة جزءٌ دون الميلي (أي نحو ٩٩٩ مرّة من ألف).
--     وبـ`limit=1` لا يتقدّم المؤشّر أبداً — حلقةٌ لا تنتهي.
--
--   · الصفحات النازلة **تُسقِط بصمت** كلَّ صفٍّ يشارك صفَّ الحدّ في ميلي ثانيته
--     ولم يكن على الصفحة. وهذا يصيب ما يُكتب في عبارةٍ واحدة
--     (`createMany`)، ودفقَ طلباتٍ متزامنة — وأسوأُه `exportOrdersCsv`:
--     يمشي على تاريخ الطلبات كلّه بالمؤشّر نفسه، فيخرج تصديرُ المحاسب ناقصاً
--     طلبات، بلا خطأ وبلا طريقةٍ لملاحظته.
--
-- العلاج: يُجعَل المخزون بدقّة ما يستطيع المؤشّر حمله. PostgreSQL يقرّب عند
-- الكتابة، فـ`now()` من المحرّك أو من افتراض العمود يهبط عند الميلي ثانية
-- التي تحملها JS، ويتّفق الجانبان بالبناء لا بالاتّفاق.
--
-- التقريب يصنع تعادلاتٍ جديدة (`.494832` و`.494901` كلاهما `.495`) — وهذا
-- بالضبط ما وُجد فاصلُ `id` من أجله، وهو مفروضٌ على كلّ قائمةٍ من قوائم
-- keyset الاثنتين والثلاثين بحارسها.
--
-- ⚠️ **الوقت جزءٌ من هذه الهجرة.** تضييق دقّة عمودٍ زمنيّ يعيد كتابة الجدول
-- كاملاً تحت قفل ACCESS EXCLUSIVE: اليوم — بثلاثة تجّار وأربعة طلبات — ذلك
-- أجزاءٌ من الثانية؛ وعلى مليون طلبٍ هو انقطاع. تُنفَّذ الآن لهذا السبب.
--
-- الأعمدة أدناه ليست قائمةً مكتوبةً بيد: هي كلُّ عمودٍ تاريخيٍّ يظهر في
-- `phase1-backend/tests/keyset-index.map.json` — السجلّ الذي يفرض CI أن يحمل
-- صفّاً لكلّ نداء `keysetWhere`. وحارس ق-242 يؤكّد أنّ كلَّ صفٍّ فيه يشير إلى
-- عمودٍ بدقّة (3)، فقائمةٌ جديدة على عمود (6) تُسقِط البناء.

ALTER TABLE "coupons" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "customers" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "inventory_movements" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "inventory_reservations" ALTER COLUMN "inspected_at" TYPE timestamptz(3);
ALTER TABLE "inventory_reservations" ALTER COLUMN "returned_at" TYPE timestamptz(3);
ALTER TABLE "loyalty_entries" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "merchants" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "notification_complaints" ALTER COLUMN "reported_at" TYPE timestamptz(3);
ALTER TABLE "notification_outbox" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "order_notes" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "plan_upgrade_requests" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "platform_audit_events" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "pos_ticket_shortfalls" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "product_reviews" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "products" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "products" ALTER COLUMN "deleted_at" TYPE timestamptz(3);
ALTER TABLE "return_requests" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "settlements" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "shopping_carts" ALTER COLUMN "last_activity_at" TYPE timestamptz(3);
ALTER TABLE "store_audit_events" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "store_orders" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "stores" ALTER COLUMN "created_at" TYPE timestamptz(3);
ALTER TABLE "wishlist_items" ALTER COLUMN "created_at" TYPE timestamptz(3);

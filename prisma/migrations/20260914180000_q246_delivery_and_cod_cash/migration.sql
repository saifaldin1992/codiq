-- ق-246 — التوصيل ونقدُ الاستلام: من أخذ الطرد، ومتى، وهل وصل نقدُه.
--
-- المنصّة تسليمٌ عند الاستلام بحكم السوق: الطردُ يذهب إلى شركة توصيل، والشركة
-- تحصّل النقد من الزبون وتردّه للتاجر لاحقاً. حتّى اليوم لم يكن على الطلب أثرٌ
-- لأيٍّ من ذلك — لا مَن أخذه، ولا رقمُ بوليصته، ولا متى خرج، ولا هل عاد نقدُه.
-- فالتاجر يطابق مع الناقل بدفترٍ ورقيّ، والمنصّة التي تعرف كلّ طلبٍ لا تعرف
-- أهمَّ ما يحدث له بعد أن يغادر الرفّ.
--
-- أربعةُ أعمدةٍ فارغةٌ افتراضاً — لا تغيّر صفّاً قائماً ولا سلوكاً قائماً:
--
--   courier_name      من أخذ الطرد (نصٌّ حرّ: شركاتُ التوصيل في العراق كثيرة
--                     ولا سجلَّ مركزيّاً لها؛ القائمةُ المقترحة على الشاشة هي
--                     أسماءُ المتجر نفسه السابقة)
--   tracking_number   رقمُ البوليصة عند الناقل
--   handed_over_at    لحظةُ التسليم للناقل — تُملأ عند «قيد التوصيل» أو بيد
--   cod_collected_at  لحظةُ استلام التاجر نقدَ هذا الطلب من الناقل
--
-- الدقّة (3) على الأعمدة الزمنيّة عمداً — قاعدةُ ق-242 وإن لم يرتّب عليها keyset:
-- عمودٌ زمنيٌّ جديد يُولَد بالدقّة التي تحملها JavaScript، فلا يُعاد كتابةُ جدولٍ
-- لأجله لاحقاً.
--
-- `NOT VALID` ثمّ `VALIDATE` هو نمط البيت لقيود CHECK على store_orders (pos_foundation):
-- الإضافةُ لا تقفل الجدول، والتحقّقُ يمرّ على الصفوف القائمة بلا قفلٍ حصريّ.
ALTER TABLE store_orders
  ADD COLUMN courier_name text,
  ADD COLUMN tracking_number text,
  ADD COLUMN handed_over_at timestamptz(3),
  ADD COLUMN cod_collected_at timestamptz(3);

ALTER TABLE store_orders ADD CONSTRAINT store_orders_courier_name_length
  CHECK (courier_name IS NULL OR char_length(courier_name) BETWEEN 1 AND 120) NOT VALID;
ALTER TABLE store_orders VALIDATE CONSTRAINT store_orders_courier_name_length;

ALTER TABLE store_orders ADD CONSTRAINT store_orders_tracking_number_length
  CHECK (tracking_number IS NULL OR char_length(tracking_number) BETWEEN 1 AND 120) NOT VALID;
ALTER TABLE store_orders VALIDATE CONSTRAINT store_orders_tracking_number_length;

-- النقدُ لا يُستلَم عن طلبٍ لم يُسلَّم للناقل: القيدُ يقول ذلك بحيث لا تستطيع
-- كتابةٌ من أيّ مسارٍ أن تصنع صفّاً «استُلم نقدُه» ولم يخرج قطّ.
ALTER TABLE store_orders ADD CONSTRAINT store_orders_cod_after_handover
  CHECK (cod_collected_at IS NULL OR handed_over_at IS NOT NULL) NOT VALID;
ALTER TABLE store_orders VALIDATE CONSTRAINT store_orders_cod_after_handover;

-- بيانُ الشحنات والمطابقةُ كلاهما يسأل: طلباتُ هذا المتجر التي خرجت في هذه
-- النافذة. جزئيٌّ لأنّ الطلبات التي لم تخرج بعد — وهي الأكثر في أيّ لحظة — لا
-- تدخل الفهرس أصلاً. ينتهي بـ(handed_over_at, id) لأنّ البيان والمطابقة يمشيان
-- صفحةً صفحةً على هذا المفتاح — الترشيحُ والترتيبُ من فهرسٍ واحدٍ بلا فرز.
--
-- القياس (2026-09-14، ١٢٠٬٠٠٣ طلبٍ خارجٍ في متجرٍ واحد، صفحةُ ٢٠٠ والمؤشّرُ في
-- منتصف القائمة، وسيطُ خمس تشغيلاتٍ بعد تسخين، EXPLAIN ANALYZE على النصّ الذي
-- يُصدره Prisma فعلاً): بالفهرس Index Scan في 0.18 ms؛ بدونه Seq Scan ثمّ Sort
-- في 154.1 ms — ٨٥٠ ضعفاً، وكلُّ صفحةٍ تدفعها من جديد.
CREATE INDEX store_orders_store_handed_over_idx
  ON store_orders (store_id, handed_over_at, id)
  WHERE handed_over_at IS NOT NULL;

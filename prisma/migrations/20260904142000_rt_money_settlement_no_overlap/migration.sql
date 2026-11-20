-- 19-د (عدسة المال) — الفترة تُسوّى مرة واحدة.
--
-- `createSettlement` كان يقرأ الدفتر ويكتب صف تسوية دون أن ينظر إلى التسويات
-- الموجودة أصلاً. ولا شيء آخر كان يمنعه: الدفتر لا يحمل علامة «سُوِّيت» — وهو
-- ملحق فقط فلا يمكن ختمه لاحقاً — والجدول لم يحمل أي قيد فريد أو قيد استبعاد.
-- نقرتان، أو موظفان، أو إعادة محاولة بعد مهلة نجحت فعلاً، أو مدى متداخل: كل
-- قيد داخل الفترة يُدفع مرتين. ثم `settlements_immutable` يجعل المكرَّر دائماً:
-- لا يُحذف ولا يُصحَّح.
--
-- الحارس الأول في الخدمة (409 على فترة تبدأ قبل نهاية آخر تسوية) يقرأ داخل
-- معاملته، فلا يرى طلباً متزامناً لم يُثبَّت بعد. هذا القيد هو الذي يحسم السباق:
-- الاستبعاد يعمل على مستوى الفهرس، فطلبان في اللحظة نفسها لا ينجحان معاً.
--
-- `tstzrange` بحدود `[from, to)` — فترتان متلاصقتان (تنتهي واحدة حيث تبدأ
-- الأخرى) لا تتداخلان، وهو ما تفعله التسوية الطبيعية بالضبط.
--
-- ── لماذا لا تفشل هذه الهجرة على صفوف قائمة ──────────────────────────────────
-- قيد الاستبعاد لا يقبل NOT VALID (تلك للـ CHECK والمفاتيح الأجنبية فقط)، وقد
-- تحمل قاعدة بيانات حيّة تسويات متداخلة سلفاً — فالعيب أعلاه ربما وقع فعلاً.
-- لذلك يُفحص التداخل أولاً: إن وُجد، تُترك القاعدة بلا قيد ويُرفع تحذير مقروء
-- في سجل الهجرة بدل أن تنهار الترقية، ويبقى حارس الخدمة عاملاً في كل الأحوال.
-- تنظيف التسويات المتداخلة الموجودة قرار مالك على مال دُفع، لا أثر جانبي لهجرة.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  overlapping integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_no_overlap') THEN
    RETURN;
  END IF;

  SELECT count(*) INTO overlapping
  FROM settlements a
  JOIN settlements b
    ON a.merchant_id = b.merchant_id
   AND a.id < b.id
   AND tstzrange(a.period_from, a.period_to) && tstzrange(b.period_from, b.period_to);

  IF overlapping > 0 THEN
    RAISE WARNING 'codiq 19-د: % overlapping settlement pair(s) already exist, so settlements_no_overlap was NOT created. The service-level guard still refuses new overlaps; the existing rows need an owner decision (settlements are immutable).', overlapping;
    RETURN;
  END IF;

  ALTER TABLE settlements ADD CONSTRAINT settlements_no_overlap
    EXCLUDE USING gist (merchant_id WITH =, tstzrange(period_from, period_to) WITH &&);
END $$;

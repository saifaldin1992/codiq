-- 19-د (عدسة المال) — خصم النقاط يصل إلى الدفتر.
--
-- ── ما كان مكسوراً ──────────────────────────────────────────────────────────
-- المندوب يحصّل `store_orders.total_iqd` = المجموع − الكوبون − خصم النقاط +
-- التوصيل. والدفتر كان يقيّد `subtotal_iqd = subtotal − discount` فقط: الكوبون
-- مطروح، وخصم النقاط لا يظهر في أي عمود. ثم `netPayout` يحسب ما تدين به
-- المنصة للتاجر بأنه `subtotal + delivery − commission` فوق تلك الصفوف نفسها،
-- و`createSettlement` يدفع الرقم ذاته. فكل طلب فيه صرف نقاط يدفع للتاجر
-- `خصم النقاط − العمولة` أكثر مما دفعه أحد.
--
-- بضاعة 20,000 + توصيل 3,000 وصرف نقاط 3,000: المحصَّل 20,000، والمدفوع 22,600.
--
-- ── الإصلاح المحافظ ─────────────────────────────────────────────────────────
-- العمود يحمل خصم النقاط إلى القيد، ويُطرح في `netPayout` وفي المجاميع
-- الموقّعة. أساس العمولة لم يتحرك: «العمولة على المجموع بعد الخصم» (قرار
-- 20B-1 §8.4) قرار مالك مسجَّل، وهل يجب أن يخفّض صرف النقاط العمولة كما يفعل
-- الكوبون سؤال مالك لا سؤال هندسة — فتُرك كما هو.
--
-- ── لماذا العمود يقبل NULL ──────────────────────────────────────────────────
-- الدفتر ملحق فقط (append-only) بحكم trigger: لا يمكن تعديل الصفوف القديمة
-- ولا تصحيحها. صفوف ما قبل هذه الهجرة تأخذ 0 من الـ DEFAULT فتبقى قراءتها
-- اليوم كما هي بالضبط — لا يُعاد كتابة رقم دُفع فعلاً. والعمود nullable لأن
-- «غير معروف» و«صفر» ليسا الشيء نفسه في دفتر لا يُصحَّح، والقارئ يوحّدهما إلى 0
-- في مكان واحد.
--
-- `settlements` يحمل العمود نفسه: التسوية تخزّن مكوّناتها لا مجموعها، فلو لم
-- تحمل خصم النقاط لبقي «إجمالي ما دُفع» في المحفظة مضخّماً بعد الإصلاح.

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS loyalty_discount_iqd INTEGER DEFAULT 0;

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS loyalty_discount_iqd INTEGER DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_loyalty_discount_ck') THEN
    ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_loyalty_discount_ck
      CHECK (loyalty_discount_iqd IS NULL OR loyalty_discount_iqd >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_loyalty_discount_ck') THEN
    ALTER TABLE settlements ADD CONSTRAINT settlements_loyalty_discount_ck
      CHECK (loyalty_discount_iqd IS NULL OR loyalty_discount_iqd >= 0);
  END IF;
END $$;

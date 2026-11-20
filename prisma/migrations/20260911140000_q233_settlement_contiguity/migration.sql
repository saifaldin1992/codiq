-- ق-233 (عدسة المال) — لا فترةَ تُدفع مرّتين، ولا لحظةَ لا تُدفع أبداً.
--
-- `settlements_no_overlap` أغلق نصف التلاصق: لا لحظة داخل تسويتين. والنصف
-- الآخر بقي مفتوحاً — لا لحظة خارج كلّ التسويات — فسقط المال بين تسويةٍ
-- وأختها واختفى من الشاشات الثلاث معاً:
--
--   · ليس في التسوية الأولى — قيوده أُنشئت بعد نهاية فترتها؛
--   · ولا في الثانية — أُنشئت قبل بداية فترتها؛
--   · ولا في «المستحق للتاجر» — `merchantWallet` يفتح نافذته عند آخر
--     `period_to`، وهي أبعد منها جميعاً.
--
-- ولم يكن زلّةً نادرة بل السلوك الافتراضيّ: `settlementPeriod` يقصّ النهاية
-- إلى اللحظة الحاضرة، فتنتهي تسوية العصر عند 14:03؛ ثمّ ترسل شاشة التسوية مدى
-- تواريخ **التقرير** للفترة التالية، وهو يبدأ من منتصف ليلةٍ ما. كلّ دورةٍ
-- تترك ثقباً، و`settlements_immutable` يجعل الثقب أبدياً.
--
-- والتسوية الأولى لها الثقب نفسه من طرفها الآخر: قيدٌ أقدم من `period_from`
-- لا يدخل تسويةً أبداً، ويخرج من «المستحق» لحظة وجودها.
--
-- لماذا مُشغِّل لا قيد: التلاصق علاقةٌ بين صفَّين (نهاية هذا = بداية ذاك)،
-- وCHECK يرى صفّه وحده، وقيد الاستبعاد ينفي التداخل ولا يوجب الجوار. المُشغِّل
-- يقرأ الصفّ السابق داخل المعاملة نفسها — والقفل الاستشاريّ على التاجر يمنع
-- طلبين متزامنين من رؤية «لا سابق» معاً ثمّ كتابة فترتين متباعدتين.
--
-- ── لماذا لا تفشل هذه الهجرة على صفوف قائمة ──────────────────────────────────
-- قاعدةٌ حيّة قد تحمل ثقوباً سلفاً — فالعيب أعلاه ربما وقع فعلاً. المُشغِّل
-- يُنشأ على أيّة حال لأنّه يحكم على الإدخال الجديد وحده، لكنّ الثقوب القائمة
-- تُحصى وتُرفع تحذيراً مقروءاً: سدُّها دفعُ مالٍ أو إعادةُ كتابته، وذاك قرار
-- مالكٍ لا أثرٌ جانبيّ لهجرة (والتسويات غير قابلة للتعديل أصلاً).

CREATE OR REPLACE FUNCTION codiq_guard_settlement_contiguous() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_to timestamptz;
  earliest_entry timestamptz;
BEGIN
  -- One writer at a time per merchant: without this, two concurrent first
  -- settlements each read «no previous» and both commit, leaving a hole between
  -- them that neither transaction could see.
  PERFORM pg_advisory_xact_lock(hashtext('codiq_settlement:' || NEW.merchant_id::text));

  SELECT max(period_to) INTO previous_to
  FROM settlements
  WHERE merchant_id = NEW.merchant_id AND id <> NEW.id;

  IF previous_to IS NOT NULL THEN
    -- STRICTLY GREATER, not «different». A period that starts BEFORE the last
    -- one ended is an overlap, and `settlements_no_overlap` already owns that
    -- refusal (23P01) — it is an index-level exclusion, so it also settles the
    -- race between two concurrent writers, which a trigger reading rows cannot.
    -- Raising here as well would steal a rule this table already enforces and
    -- change the error code the callers have been reading since 19-د. One rule,
    -- one owner: the constraint takes «paid twice», the trigger takes «paid
    -- never», and between them every instant belongs to exactly one period.
    IF NEW.period_from > previous_to THEN
      RAISE EXCEPTION 'codiq ق-233: settlement period_from % must equal the previous period_to % for merchant % — a gap between settlements is money on no screen at all', NEW.period_from, previous_to, NEW.merchant_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- The FIRST settlement: it must not start after the merchant's oldest ledger
  -- entry, or that entry belongs to no period and leaves `pending` forever.
  SELECT min(l.created_at) INTO earliest_entry
  FROM ledger_entries l
  JOIN stores s ON s.id = l.store_id
  WHERE s.merchant_id = NEW.merchant_id;

  IF earliest_entry IS NOT NULL AND NEW.period_from > earliest_entry THEN
    RAISE EXCEPTION 'codiq ق-233: first settlement period_from % is after the merchant''s earliest ledger entry % — those entries would be paid by no settlement ever', NEW.period_from, earliest_entry
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS settlements_contiguous ON settlements;
CREATE TRIGGER settlements_contiguous
  BEFORE INSERT ON settlements
  FOR EACH ROW EXECUTE FUNCTION codiq_guard_settlement_contiguous();

DO $$
DECLARE
  holes integer;
BEGIN
  SELECT count(*) INTO holes
  FROM (
    SELECT period_from, lag(period_to) OVER (PARTITION BY merchant_id ORDER BY period_from) AS previous_to
    FROM settlements
  ) ordered
  WHERE previous_to IS NOT NULL AND period_from > previous_to;

  IF holes > 0 THEN
    RAISE WARNING 'codiq ق-233: % existing settlement gap(s) found. New settlements can no longer create one, but the money already inside them is in no settlement and in no pending balance — closing it pays real money, so it needs an owner decision (settlements are immutable).', holes;
  END IF;
END $$;

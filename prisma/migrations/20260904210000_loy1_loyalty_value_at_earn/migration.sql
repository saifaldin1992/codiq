-- LOY-1 «النقطة تحمل قيمتها يوم رُبحت» — a point keeps the value it was earned at.
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- A balance was stored in POINTS and priced at REDEMPTION time from the store's
-- current `loyalty_point_value_iqd`. So a merchant who lowered that rate did not
-- change his future generosity — he RETROACTIVELY CONFISCATED value a customer
-- had already earned. Points a shopper was told were worth 5,000 IQD became
-- worth 500 while he slept, from a settings screen, with no record that anything
-- had been taken from him.
--
-- That destroys the only thing a loyalty programme exists to buy: the shopper's
-- confidence that what he earned stays his. A programme he cannot trust is worse
-- than no programme, because he priced his last purchase on a promise.
--
-- 19-د named this exact hole and left it open on purpose («WHAT THIS DOES NOT
-- CLOSE, deliberately») because re-pricing an outstanding balance is a product
-- decision, not an engineering one. It is now decided.
--
-- ============================================================================
-- THE RULE
-- ============================================================================
--
-- A rate change applies to points earned from that moment ON. Every point
-- already earned redeems at the rate it was earned at.
--
-- RAISING the rate is left alone deliberately: it is the merchant's own
-- generosity, it can only harm himself, and a shopper is never surprised by
-- being paid more. Only the confiscating direction needed a structure.
--
-- A second thing falls out of this for free: the liability is now an EXACT
-- number — SUM(points remaining × the rate they were earned at) — instead of a
-- figure that moves every time somebody edits a settings field.
--
-- ============================================================================
-- WHY THIS COLUMN AND NOT A NEW TABLE
-- ============================================================================
--
-- `loyalty_entries` already IS the append-only truth, and it already carries a
-- per-row money snapshot (`value_iqd`, what a spend was worth). A LOT is
-- therefore not a new concept needing a new table — it is an `earned` row that
-- now knows its own rate. The remaining balance stays a FOLD of this log, in one
-- place in `loyalty.service.ts`, exactly as the total has always been a SUM of
-- it. Nothing new can drift out of step with the history, because there is
-- nothing new to drift.
--
-- ============================================================================
-- WHY NOW, AND WHAT THIS DOES IF A BALANCE EXISTS
-- ============================================================================
--
-- Nobody holds a balance yet: the programme ships off (`loyalty_enabled` false)
-- and no store has switched it on. Today this is one additive column. After
-- launch it becomes the migration nobody wants to write — «at what rate do we
-- convert the balances people are already holding?» — with a real answer owed to
-- real customers.
--
-- The backfill below is written to be correct anyway. Every pre-existing earn
-- row is stamped with its store's CURRENT rate, which is by construction exactly
-- what those points are worth today under the old rule. No balance changes value
-- at the migration boundary, in either direction; the rule simply starts
-- applying from the next rate change onward.
--
-- The immutability trigger has to stand down for that one statement — it refuses
-- every UPDATE, including this one. It is dropped and recreated inside the same
-- transaction, so the table is never writable outside this migration.

ALTER TABLE loyalty_entries
  ADD COLUMN IF NOT EXISTS point_value_iqd integer;

COMMENT ON COLUMN loyalty_entries.point_value_iqd IS
  'LOY-1: IQD ONE point of this lot was worth when it was EARNED. Set on `earned` rows only — a spend can span several lots at several rates, and its total is already in value_iqd.';

DROP TRIGGER IF EXISTS loyalty_entries_immutable ON loyalty_entries;

UPDATE loyalty_entries entry
   SET point_value_iqd = store.loyalty_point_value_iqd
  FROM stores store
 WHERE store.id = entry.store_id
   AND entry.kind = 'earned'
   AND entry.point_value_iqd IS NULL;

CREATE TRIGGER loyalty_entries_immutable
BEFORE UPDATE OR DELETE ON loyalty_entries
FOR EACH ROW EXECUTE FUNCTION loyalty_entries_immutable();

-- A point that does not know what it was worth is a point nobody can honour.
-- The constraint is what makes «earned at a rate» structural rather than a
-- convention the next writer of this table has to remember.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loyalty_entries_point_value_ck') THEN
    ALTER TABLE loyalty_entries ADD CONSTRAINT loyalty_entries_point_value_ck
      CHECK (
        (kind = 'earned'  AND point_value_iqd IS NOT NULL AND point_value_iqd >= 1)
        OR (kind <> 'earned' AND point_value_iqd IS NULL)
      );
  END IF;
END $$;

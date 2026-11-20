-- P27-12 (ق-100) — merchant identity: a personal name and an Iraqi phone that is
-- unique across the whole platform, which is what lets P27-21 accept a phone at
-- sign-in.
--
-- Why this is safe on a live database:
--
-- 1) All three columns are nullable with no DEFAULT. In PostgreSQL that is a
--    catalogue-only change: no table rewrite, no backfill, not one row touched.
--    The ACCESS EXCLUSIVE lock is held for a fraction of a millisecond.
--
-- 2) The format CHECK is written «IS NULL OR …» so every merchant that already
--    exists passes it. ADD CONSTRAINT CHECK does scan the table to validate, and
--    `merchants` is an identity table with tens of rows, so the scan is
--    milliseconds. If it ever grows, the replacement is NOT VALID followed by
--    VALIDATE, exactly as pg2c did — unnecessary at this size.
--
-- 3) The partial unique index takes a SHARE lock (writes wait, reads do not) for
--    as long as it builds. CONCURRENTLY is not available because migrations in
--    this repository are wrapped in BEGIN/COMMIT, and that trade is deliberate
--    and acceptable on a table this small.
--
-- Why a PARTIAL unique index rather than a plain UNIQUE — and the first reason is
-- not the obvious one:
--   * a plain UNIQUE on a nullable column does work (NULL is distinct from NULL
--     by default), but that is leaning on a default PostgreSQL 15 itself made
--     configurable with NULLS NOT DISTINCT. Stating the predicate makes the
--     intent structural instead of implied.
--   * it matches every precedent in this repository: customers_store_phone_present_uq,
--     plans_single_recommended, products_store_sku_live_key, coupons_store_code_live_key.
--   * the index stays smaller — the older merchants with no phone are not indexed.
--   * and the one that matters most: Prisma cannot express a partial index. Keeping
--     it here ALONE is what stops the schema from generating a second, full unique
--     index and creating drift.
--   The only cost: a phone lookup is findFirst rather than findUnique — which is
--   precisely what loginCustomer already does.
--
-- The index name deliberately does NOT contain the string «phone_normalized».
-- The P2002 map in http/errors.ts matches that substring and answers
-- DUPLICATE_CUSTOMER_PHONE with an English message about «this store» — a
-- customer's message, meaningless for a merchant whose uniqueness spans the whole
-- platform. The name is the third line of defence here; the first is a translation
-- in the service itself and the second an explicit branch above that line.
--
-- The REQUIREMENT lives in the code, not in the database: all three merchant
-- creation paths refuse without a phone, while the column stays permissive so the
-- migration cannot fail on the first merchant that already exists. And «an older
-- merchant» is defined as phone_normalized IS NULL — the same predicate as the
-- index, so there is no second flag to keep in step.

BEGIN;

ALTER TABLE merchants
  ADD COLUMN owner_name TEXT,
  ADD COLUMN phone TEXT,
  ADD COLUMN phone_normalized TEXT;

-- Iraqi mobile only: +964 then 7 then nine digits. This is a real cash-on-delivery
-- channel (a call, a WhatsApp message) and a landline does not serve it. Widening
-- it later is a two-line migration (DROP CONSTRAINT then ADD), and this repository
-- has already widened a CHECK that way in 20260828090300.
ALTER TABLE merchants
  ADD CONSTRAINT merchants_contact_phone_format
  CHECK (phone_normalized IS NULL OR phone_normalized ~ '^\+9647[0-9]{9}$');

CREATE UNIQUE INDEX merchants_contact_phone_uq
  ON merchants (phone_normalized)
  WHERE phone_normalized IS NOT NULL;

COMMIT;

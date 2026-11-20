-- PG-6 (ق-74) «البحث العربي الذكي» — one Arabic normalizer, nine shadow
-- columns, nine GIN trigram indexes. Strictly ADDITIVE: nothing is dropped,
-- no constraint changes shape, and every existing query keeps its old column.
--
-- WHY IT LIVES IN POSTGRES. The gate is «احمد» must find «أحمد» and «فاطمه»
-- must find «فاطمة». That is letter-identity folding, and the moment the fold
-- has TWO implementations — one that writes the indexed value and one that
-- builds the needle — a single divergent codepoint returns zero rows with no
-- error anywhere. So there is exactly ONE implementation, it is this function,
-- and the needle passes through the same function object as the column:
--
--   WHERE codiq_ar_normalize_v1($1) <% products.search_name
--
-- A `GENERATED ALWAYS AS (…) STORED` column also computes itself for every
-- existing row inside the ALTER, so there is no backfill script and no
-- half-normalized window; and no write path can forget it — not the catalog
-- service, not the CSV importer, not the duplicate flow, not the till.
--
-- ⚠ THE LOCK. `ADD COLUMN … GENERATED ALWAYS AS … STORED` REWRITES the table
--   and holds ACCESS EXCLUSIVE for the duration. On current production data
--   (ق-119: 9.8 MB across 47 tables) that is milliseconds — but run this in the
--   low-traffic window and never combine it with a long statement in the same
--   transaction, because everything queues behind the rewrite.
--
-- ⚠ `_v1` IS LOAD-BEARING. A STORED generated column records a dependency on
--   the function, but REPLACING THE FUNCTION BODY DOES NOT RECOMPUTE THE STORED
--   VALUES. Old rows would keep the old normalization while new rows got the
--   new one, and the search would half-break in silence. So changing the rules
--   means: a new codiq_ar_normalize_v2, new search_*_v2 columns, new indexes, a
--   cutover in the engine, then dropping v1 — four migrations. NEVER an
--   in-place CREATE OR REPLACE on this function.
--
-- PROBES, RUN BEFORE THIS FILE WAS WRITTEN (the md1 convention — paste the
-- measurement, do not assume it):
--
--   SELECT version();
--     PostgreSQL 16.15  — the same major as CI (.github/workflows/ci.yml: postgres:16)
--   SELECT extname, extversion FROM pg_extension;
--     pg_trgm 1.6, pgcrypto 1.3, plpgsql 1.0  — and nothing else.
--   CREATE EXTENSION unaccent; SELECT proname, pronargs, provolatile
--     FROM pg_proc WHERE proname='unaccent';
--     unaccent/1 -> 's', unaccent/2 -> 's'.  STABLE, not IMMUTABLE: it resolves
--     a mutable text-search dictionary at call time, so it may not appear in a
--     generated column or an expression index at all.
--   SELECT unaccent('أحمد'), unaccent('فاطمة'), unaccent('مُحَمَّد'), unaccent('مصطفى');
--     أحمد | فاطمة | مُحَمَّد | مصطفى  — the identity on all four. unaccent does
--     not touch Arabic, so it could not satisfy this gate even if it were
--     immutable. It was DROPped again; no new extension is installed here.
--   SELECT word_similarity('احمر','احمد'), word_similarity('سعيد','احمد'),
--          word_similarity('احمد','محمد'), similarity('احمد علي الجبوري','احمد');
--     0.6 | 0 | 0.4 | 0.3125
--     Note the last one: plain `similarity` is set-symmetric, so a needle inside
--     a three-word name scores 0.31 and is useless here. `word_similarity`
--     scores the needle against the best-matching EXTENT of the haystack and
--     returns 1.0 for the same pair — which is why `<%` is the operator below
--     and `%` is not.
--
-- THRESHOLD 0.4, and `<%` compares with >= (measured: ws=0.4 matches at
-- threshold 0.4, and ws=0.6 matches at threshold 0.6). The default 0.6 is a
-- coin-flip on the gate example — «احمر» → «احمد» scores exactly 0.6 — and a
-- rule that passes by landing precisely on the boundary is not a rule. 0.4
-- keeps the gate honest in both directions: «احمر» finds «احمد» (0.6) and
-- «سعيد» does not (0.0). Its cost, stated plainly: «احمد» also reaches «محمد»
-- (0.4), which lands BELOW every exact-substring hit in the engine's ranking.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) The extension. Already installed by 20260827190000_md1_search_and_tag_indexes;
--    repeated here so this file stands alone on a fresh database.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) The normalizer. Four passes, built only from regexp_replace, translate and
--    btrim — every one of which is IMMUTABLE, which is what lets this function
--    be IMMUTABLE and therefore appear in a generated column.
--
--    Every codepoint is written as a U&'\XXXX' escape rather than as the letter
--    itself. Two reasons: an invisible character (tatweel, ZWNJ, RLM) is
--    unreviewable as a literal, and `shared/search/arabic-normalize.ts` must be
--    written from the SAME list — `pnpm search:mirror` compares two copies of
--    one specification, not two specifications.
--
--    PASS 1 — DELETE. Tatweel; every harakah U+064B–U+065F, which INCLUDES the
--    combining maddah U+0653, hamza-above U+0654 and hamza-below U+0655;
--    superscript alef; the Quranic marks; and the invisibles — ALM, ZWSP, ZWNJ,
--    ZWJ, LRM, RLM and the bidi isolates.
--
--    Deleting the combining marks FIRST is what makes decomposed input work
--    with no normalize() call (PostgreSQL 16 has none usable inside an
--    IMMUTABLE SQL function). Decomposed «أ» is U+0627 U+0654, which pass 1
--    reduces to U+0627; precomposed «أ» is U+0623, which pass 2 folds to the
--    same U+0627. Both keyboard forms converge. Verified for أ آ ؤ ئ.
--
--    The invisible range is NOT optional. ZWNJ and RLM arrive routinely from a
--    WhatsApp or Word paste and break matching with no visible cause.
--
--    PASS 2 — FOLD, one-to-one via translate:
--      آ أ إ ٱ ٲ ٳ ٵ  → ا     (gate: «احمد» ⇄ «أحمد»)
--      ؤ             → و
--      ئ ى ی ې ۍ     → ي     (alef maksura + the Farsi/Kurdish yeh look-alikes;
--                             «مصطفى» ⇄ «مصطفي»)
--      ة ە           → ه     (gate: «فاطمه» ⇄ «فاطمة»)
--      ک             → ك     (Farsi/Kurdish keheh)
--      ٠–٩ and ۰–۹   → 0–9   (both Arabic-Indic ranges; load-bearing for SKUs,
--                             order numbers and phone probes typed on an Arabic
--                             keyboard)
--    DELIBERATELY NOT FOLDED: ڕ ڵ ۆ ێ گ چ پ ژ. Those are Kurdish letters with
--    no Arabic look-alike anyone substitutes; folding them would destroy
--    Kurdish distinctions before phase 22 (ق-29, D-23) begins. Only the three
--    look-alikes an Arabic keyboard actually produces are folded — ک ی ە.
--
--    PASS 3 — ASCII case fold with translate, NOT lower(). lower() is
--    collation-dependent: a glibc or ICU upgrade under a STORED generated
--    column changes the function's output for NEW rows while old rows keep the
--    old value — silent, undetectable drift, and unfixable without a rewrite.
--    translate cannot drift. Arabic is unicameral, so nothing is lost.
--
--    PASS 4 — WHITESPACE. The class is explicit for the same reason the others
--    are: `\s` means one thing to PostgreSQL's regex and another to
--    JavaScript's, and the mirror guard must compare copies, not dialects.
--
--    PUNCTUATION IS LEFT ALONE, on purpose. SKUs and order numbers are
--    structured (ORD-1001, AB-0001) and the fold is symmetric anyway — needle
--    and haystack pass through this same function — so stripping punctuation
--    buys nothing and surprises SKU search.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION codiq_ar_normalize_v1(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT btrim(
    regexp_replace(
      translate(
        translate(
          regexp_replace(
            $1,
            -- pass 1: tatweel | harakat + combining hamza/maddah | superscript
            -- alef | Quranic marks | ALM, ZWSP/ZWNJ/ZWJ/LRM/RLM, bidi isolates
            U&'[\0640\064B-\065F\0670\06D6-\06DC\06DF-\06E8\06EA-\06ED\061C\200B-\200F\2066-\2069]',
            '', 'g'
          ),
          -- pass 2 FROM: آأإٱٲٳٵ | ؤ | ئىیېۍ | ةە | ک | ٠-٩ | ۰-۹
          U&'\0622\0623\0625\0671\0672\0673\0675'
            || U&'\0624'
            || U&'\0626\0649\06CC\06D0\06CD'
            || U&'\0629\06D5'
            || U&'\06A9'
            || U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'
            || U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
          -- pass 2 TO:   ااااااا | و | ييييي | هه | ك | 0-9 | 0-9
          U&'\0627\0627\0627\0627\0627\0627\0627'
            || U&'\0648'
            || U&'\064A\064A\064A\064A\064A'
            || U&'\0647\0647'
            || U&'\0643'
            || '0123456789'
            || '0123456789'
        ),
        -- pass 3: ASCII case fold
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'abcdefghijklmnopqrstuvwxyz'
      ),
      -- pass 4: every run of whitespace becomes one space, then btrim
      U&'[\0009-\000D\0020\00A0\2000-\200A\2028\2029\202F\205F\3000]+', ' ', 'g'
    )
  );
$fn$;

COMMENT ON FUNCTION codiq_ar_normalize_v1(text) IS
  'PG-6 (ق-74) Arabic search normalization, version 1. IMMUTABLE in the English sense too: the STORED generated columns that depend on it are NOT recomputed by CREATE OR REPLACE, so a rule change means a _v2 function, _v2 columns, new indexes and a cutover — never an edit here.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) The SQL twin of escapeLikeNeedle (merchant-search.service.ts:92-94).
--    It exists so the LIKE needle is escaped AFTER normalization without the
--    needle ever leaving the database. Prisma does not escape LIKE
--    metacharacters inside `contains`, and in raw SQL nothing does it at all —
--    so a merchant typing «%» gets wildcard behaviour on five of the six
--    surfaces today. Postgres LIKE uses backslash as its default escape
--    character when no ESCAPE clause is given, which is the form the engine emits.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION codiq_like_escape(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT replace(replace(replace($1, '\', '\\'), '%', '\%'), '_', '\_');
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) The shadow columns. One ALTER per table ⇒ ONE rewrite per table, not three.
--    They are READ-ONLY: Postgres rejects any write to a generated column, so a
--    `data:` object that names one fails the INSERT. The schema declarations
--    copy the `is_low_stock` pattern (20260817093000) exactly.
--
--    `customers.phone_normalized` and `store_orders.recipient_phone` get NO
--    shadow column: they already hold digits-only / E.164 values produced by
--    toE164, so the normalizer is a no-op on them and a generated column would
--    be pure storage. They get the trigram index directly.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN search_name        text GENERATED ALWAYS AS (codiq_ar_normalize_v1(name)) STORED,
  ADD COLUMN search_sku         text GENERATED ALWAYS AS (codiq_ar_normalize_v1(sku)) STORED,
  ADD COLUMN search_description text GENERATED ALWAYS AS (codiq_ar_normalize_v1(description)) STORED;

ALTER TABLE customers
  ADD COLUMN search_full_name text GENERATED ALWAYS AS (codiq_ar_normalize_v1(full_name)) STORED,
  ADD COLUMN search_email     text GENERATED ALWAYS AS (codiq_ar_normalize_v1(email)) STORED;

ALTER TABLE store_orders
  ADD COLUMN search_order_number text GENERATED ALWAYS AS (codiq_ar_normalize_v1(order_number)) STORED,
  ADD COLUMN search_customer_name text GENERATED ALWAYS AS (codiq_ar_normalize_v1(customer_name)) STORED;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) The indexes. SINGLE-COLUMN, deliberately — do NOT "improve" this by adding
--    store_id. A composite GIN (store_id, col) via btree_gin was MEASURED in
--    this repo and the planner never chose it, not even with seqscan and
--    indexscan disabled (20260827190000_md1_search_and_tag_indexes:15-22). The
--    single-column trigram index is chosen immediately and `store_id` becomes a
--    heap filter over the handful of trigram matches, so the work scales with
--    MATCHES rather than with the size of the store. Tenancy is unaffected:
--    store_id is in the WHERE of every statement the engine builds, and the
--    engine's signature takes storeId as its first non-optional argument.
--
--    gin_trgm_ops serves LIKE, %, <% and %> alike, so ONE index per column
--    carries both the exact-substring path and the typo-tolerant path.
--
--    CREATE INDEX, not CONCURRENTLY: prisma migrate deploy wraps a migration
--    file in a transaction and CONCURRENTLY cannot run inside one. Existing
--    house pattern (md1 uses plain CREATE INDEX IF NOT EXISTS).
--
--    The four md1 indexes on the RAW columns stay. They are still referenced
--    until the last surface is converted; dropping them is a separate,
--    greppable follow-up in 20-3 once no query names a raw column. Additive-first.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS products_search_name_trgm_idx        ON products     USING GIN (search_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_search_sku_trgm_idx         ON products     USING GIN (search_sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_search_description_trgm_idx ON products     USING GIN (search_description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS customers_search_full_name_trgm_idx  ON customers    USING GIN (search_full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customers_search_email_trgm_idx      ON customers    USING GIN (search_email gin_trgm_ops);
-- The customer directory searches this column today through an unanchored LIKE
-- with NO index at all.
CREATE INDEX IF NOT EXISTS customers_phone_normalized_trgm_idx  ON customers    USING GIN (phone_normalized gin_trgm_ops);

CREATE INDEX IF NOT EXISTS store_orders_search_order_number_trgm_idx  ON store_orders USING GIN (search_order_number gin_trgm_ops);
-- NEW CAPABILITY: until now no surface searched the customer's name on an
-- order, so a merchant holding a name and no order number could not find it.
CREATE INDEX IF NOT EXISTS store_orders_search_customer_name_trgm_idx ON store_orders USING GIN (search_customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS store_orders_recipient_phone_trgm_idx      ON store_orders USING GIN (recipient_phone gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) The threshold, at the DATABASE level.
--
--    `<%` reads pg_trgm.word_similarity_threshold, default 0.6. It must NEVER
--    be set per request: Neon serves POOLED connections, and a bare `SET` (or
--    set_limit()) leaks the threshold into the next tenant's request. `SET
--    LOCAL` inside prisma.$transaction would be correct but costs an
--    interactive transaction on the hottest read path. ALTER DATABASE … SET
--    costs nothing per request and makes an ad-hoc psql session behave the way
--    production does — which is exactly what you want when someone re-measures.
--
--    ⚠ CAVEAT: it applies to NEW sessions only. CI gets a fresh database;
--    production picks it up as the pool recycles. `GET /ready` reports the
--    effective value (searchThreshold) so a stale pool is visible instead of
--    mysterious.
--
--    Wrapped so a role without ALTER DATABASE rights degrades to a WARNING and
--    the default 0.6 rather than failing the deploy — the gate still passes at
--    0.6, it is merely less tolerant, and /ready will say so.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET pg_trgm.word_similarity_threshold = 0.4', current_database());
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'PG-6: could not set pg_trgm.word_similarity_threshold on % — the search falls back to the 0.6 default. GET /ready reports the effective value.', current_database();
END $$;

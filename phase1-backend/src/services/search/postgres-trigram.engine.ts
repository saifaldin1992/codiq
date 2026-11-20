/**
 * PG-6 (ق-74) — the pg_trgm engine. THE ONLY FILE IN THE REPOSITORY THAT
 * CONTAINS SEARCH SQL.
 *
 * SHAPE OF A REQUEST: `1 + N` short statements.
 *
 * Statement 0 normalizes the needle ONCE, in the database:
 *
 *   SELECT codiq_ar_normalize_v1($1), codiq_like_escape(codiq_ar_normalize_v1($1));
 *
 * and the engine then binds the resulting VALUES into the N column statements.
 * That is deliberate, not lazy: putting the function call inside the search
 * query (or in a CTE) makes the `<%` operand non-constant and hands the planner
 * an excuse to skip the GIN index. With a constant the plan is stable and is
 * exactly the plan `pg6.arabic-search.integration.mjs` asserts. It also means
 * the needle is normalized by the IDENTICAL function object that produced the
 * indexed column — which is the entire reason the normalizer lives in Postgres.
 *
 * Statements 1..N — one per (table, column), issued by the caller in one
 * `Promise.all`:
 *
 *   SELECT id, (col LIKE '%'||$2||'%') AS exact, word_similarity($3, col) AS rank
 *   FROM   <table>
 *   WHERE  store_id = $1::uuid AND <live filter> AND <match>
 *   ORDER  BY exact DESC, rank DESC, id DESC
 *   LIMIT  $4                                   -- limit + 1: the hasMore probe
 *
 * ONE PREDICATE PER STATEMENT is a measured requirement, not a style choice.
 * `name ILIKE q OR sku ILIKE q` on 8,013 products in this repo: Seq Scan, 8012
 * rows removed by filter, 39.4 ms — versus a Bitmap Index Scan over one heap
 * block, 1.0 ms, for the split query (migration
 * 20260827190000_md1_search_and_tag_indexes:33-40). The planner refuses a
 * BitmapOr across two DIFFERENT columns and falls back to a sequential scan.
 * Two predicates on ONE column are a different case: they ride one index and
 * the planner does combine them, which is what `<match>` below relies on.
 *
 * ── WHERE THE FUZZY BRANCH APPLIES, AND WHY IT IS NOT EVERYWHERE ────────────
 *
 * `<match>` is `col LIKE '%needle%'` — the exact-substring answer, always — and
 * for human-NAME columns with a single-token needle it also ORs in the
 * typo-tolerant `needle <% col`.
 *
 * ⚠ DEVIATION FROM THE BLUEPRINT, deliberate and measured. §2.5 puts `<%` on
 *   every column. Two measurements on this database say that is wrong:
 *
 *   word_similarity('sf-1757000000001-A2C4E6', 'sf-1757000000002-9B3D5F') ≈ 0.5
 *       Two order numbers minted seconds apart share their whole prefix. A
 *       fuzzy match on an IDENTIFIER does not help a merchant — it shows him
 *       the WRONG order, confidently, and it would make md1's cross-store
 *       assertion pass for the wrong reason. Identifiers (sku, order number,
 *       email, phone) are exact-substring only: mistype one character of a SKU
 *       and you get nothing, which is the correct answer.
 *
 *   word_similarity('قميص باء', 'قميص المرح') = 0.556
 *       A MULTI-WORD needle scores on its best single word alone, so a
 *       deliberate phrase turns into a one-word match. Typo tolerance is a
 *       per-word notion; a needle carrying a space is a phrase the merchant
 *       meant, and it stays exact.
 *
 *   The gate is untouched by both restrictions: «احمر» → «احمد» is a
 *   single-token name (word_similarity 0.6 ≥ the 0.4 threshold) and «سعيد» →
 *   «احمد» is 0.0.
 *
 * BOTH PATHS RIDE ONE INDEX. `gin_trgm_ops` serves LIKE, `%`, `<%` and `%>`
 * alike. `LIKE` gives the exact-substring answer and must rank first; `<%`
 * gives typo tolerance without the length dilution that makes plain `%`
 * useless here — `similarity('احمد علي الجبوري','احمد')` is 0.31 because
 * similarity is set-symmetric, while `word_similarity` scores the needle
 * against the best-matching EXTENT of the haystack and returns 1.0.
 *
 * TENANCY IS A PREDICATE, NEVER AN INDEX PROPERTY. `store_id = $1` is in the
 * WHERE of every statement and is applied as a heap filter over the trigram
 * matches, so the work scales with MATCHES rather than with store size — the
 * md1 finding, restated. Do NOT "improve" this by adding `store_id` to the GIN
 * index: the composite via btree_gin was measured here and the planner never
 * chose it, not even with seqscan and indexscan disabled.
 *
 * SOFT DELETE. `deleted_at IS NULL` is written into the products statement AND
 * `...LIVE` is re-applied on every caller's Prisma hydration. Belt and braces.
 * The static guard (`tests/helpers/deleted-leak-guard.ts`, rule 2) reads the
 * `Prisma.sql` templates below directly, so the predicate cannot be dropped
 * without failing the build.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import type { PlatformSearchTarget, SearchEngine, SearchHit, SearchPage, SearchRequest, SearchTarget } from "./search.types.js";

const EMPTY_PAGE: SearchPage = { hits: [], hasMore: false };

/**
 * The column each target reads. Frozen, keyed by a closed union, and the ONLY
 * source of an identifier that reaches `Prisma.raw` — so no user input can ever
 * become part of an identifier.
 */
const COLUMN: Record<SearchTarget, string> = {
  "products.name": "search_name",
  "products.sku": "search_sku",
  "products.description": "search_description",
  "customers.fullName": "search_full_name",
  "customers.email": "search_email",
  // `phone_normalized` and `recipient_phone` have NO shadow column: they already
  // hold digits-only / E.164 values produced by toE164, so the normalizer is a
  // no-op on them and a generated column would be pure storage. They carry the
  // trigram index directly.
  "customers.phone": "phone_normalized",
  "orders.orderNumber": "search_order_number",
  "orders.customerName": "search_customer_name",
  "orders.recipientPhone": "recipient_phone",
};

/** The index each target is expected to ride. Asserted by the plan gate; not used at runtime. */
export const EXPECTED_INDEX: Record<SearchTarget, string> = {
  "products.name": "products_search_name_trgm_idx",
  "products.sku": "products_search_sku_trgm_idx",
  "products.description": "products_search_description_trgm_idx",
  "customers.fullName": "customers_search_full_name_trgm_idx",
  "customers.email": "customers_search_email_trgm_idx",
  "customers.phone": "customers_phone_normalized_trgm_idx",
  "orders.orderNumber": "store_orders_search_order_number_trgm_idx",
  "orders.customerName": "store_orders_search_customer_name_trgm_idx",
  "orders.recipientPhone": "store_orders_recipient_phone_trgm_idx",
};

/** The table each target scans — the one the plan gate must find no Seq Scan on. */
export const TABLE_OF: Record<SearchTarget, string> = {
  "products.name": "products",
  "products.sku": "products",
  "products.description": "products",
  "customers.fullName": "customers",
  "customers.email": "customers",
  "customers.phone": "customers",
  "orders.orderNumber": "store_orders",
  "orders.customerName": "store_orders",
  "orders.recipientPhone": "store_orders",
};

/** The only columns a human types a name into — and therefore the only ones typo tolerance belongs on. */
const FUZZY_TARGETS: ReadonlySet<SearchTarget> = new Set<SearchTarget>(["products.name", "customers.fullName", "orders.customerName"]);

interface HitRow {
  id: string;
  exact: boolean;
  rank: number;
}

interface Needle {
  normalized: string;
  like: string;
}

/**
 * Statement 0. Returns `null` when the needle normalizes away to nothing — a
 * query made only of harakat or invisibles — so the caller skips the N column
 * statements entirely instead of asking the database to match the empty string.
 */
async function normalizeNeedle(raw: string): Promise<Needle | null> {
  const rows = await prisma.$queryRaw<Array<{ normalized: string | null; like: string | null }>>`
    SELECT codiq_ar_normalize_v1(${raw}) AS normalized,
           codiq_like_escape(codiq_ar_normalize_v1(${raw})) AS like
  `;
  const normalized = rows[0]?.normalized ?? "";
  const like = rows[0]?.like ?? "";
  return normalized.length ? { normalized, like } : null;
}

/** `col LIKE '%needle%'`, plus `needle <% col` where typo tolerance is earned. See the header. */
function matchPredicate(target: SearchTarget, needle: Needle): Prisma.Sql {
  const column = Prisma.raw(COLUMN[target]);
  const substring = Prisma.sql`${column} LIKE '%' || ${needle.like} || '%'`;
  const fuzzy = FUZZY_TARGETS.has(target) && !needle.normalized.includes(" ");
  return fuzzy ? Prisma.sql`(${substring} OR ${needle.normalized} <% ${column})` : substring;
}

/**
 * `products` is a PG-2 watched table, so `deleted_at IS NULL` is written into
 * the template itself — where the static leak guard reads it.
 */
function productsStatement(target: SearchTarget, storeId: string, needle: Needle, limit: number): Prisma.Sql {
  const column = Prisma.raw(COLUMN[target]);
  return Prisma.sql`
    SELECT id::text AS id,
           (${column} LIKE '%' || ${needle.like} || '%') AS exact,
           word_similarity(${needle.normalized}, ${column}) AS rank
    FROM products
    WHERE store_id = ${storeId}::uuid
      AND deleted_at IS NULL
      AND ${matchPredicate(target, needle)}
    ORDER BY exact DESC, rank DESC, id DESC
    LIMIT ${limit + 1}
  `;
}

function customersStatement(target: SearchTarget, storeId: string, needle: Needle, limit: number): Prisma.Sql {
  const column = Prisma.raw(COLUMN[target]);
  return Prisma.sql`
    SELECT id::text AS id,
           (${column} LIKE '%' || ${needle.like} || '%') AS exact,
           word_similarity(${needle.normalized}, ${column}) AS rank
    FROM customers
    WHERE store_id = ${storeId}::uuid
      AND ${matchPredicate(target, needle)}
    ORDER BY exact DESC, rank DESC, id DESC
    LIMIT ${limit + 1}
  `;
}

function ordersStatement(target: SearchTarget, storeId: string | null, needle: Needle, limit: number): Prisma.Sql {
  const column = Prisma.raw(COLUMN[target]);
  // The platform-owner variant is cross-tenant BY DESIGN and reaches this
  // builder only through `searchPlatformOrders`, which has no storeId to
  // forget. Every store-scoped caller goes through `search`, whose signature
  // makes storeId the first non-optional argument.
  const tenant = storeId === null ? Prisma.sql`TRUE` : Prisma.sql`store_id = ${storeId}::uuid`;
  return Prisma.sql`
    SELECT id::text AS id,
           (${column} LIKE '%' || ${needle.like} || '%') AS exact,
           word_similarity(${needle.normalized}, ${column}) AS rank
    FROM store_orders
    WHERE ${tenant}
      AND ${matchPredicate(target, needle)}
    ORDER BY exact DESC, rank DESC, id DESC
    LIMIT ${limit + 1}
  `;
}

function statementFor(target: SearchTarget, storeId: string | null, needle: Needle, limit: number): Prisma.Sql {
  if (target.startsWith("products.")) {
    if (storeId === null) throw new Error("searchEngine: product search is store-scoped; there is no cross-tenant variant.");
    return productsStatement(target, storeId, needle, limit);
  }
  if (target.startsWith("customers.")) {
    if (storeId === null) throw new Error("searchEngine: customer search is store-scoped; there is no cross-tenant variant.");
    return customersStatement(target, storeId, needle, limit);
  }
  return ordersStatement(target, storeId, needle, limit);
}

function toPage(rows: HitRow[], limit: number): SearchPage {
  const hits: SearchHit[] = rows.slice(0, limit).map((row) => ({ id: row.id, exact: row.exact === true, rank: Number(row.rank) }));
  return { hits, hasMore: rows.length > limit };
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    // A programming error, not a user one: every surface clamps its own limit
    // before it gets here, so an out-of-range value means a caller skipped its
    // schema — and a silent clamp would hide that.
    throw new Error(`searchEngine: limit must be an integer between 1 and 500, received ${limit}.`);
  }
  return limit;
}

export const postgresTrigramEngine: SearchEngine = {
  name: "pg-trgm",

  async search(target: SearchTarget, request: SearchRequest): Promise<SearchPage> {
    const limit = assertLimit(request.limit);
    if (!request.storeId) throw new Error("searchEngine: storeId is mandatory on every store-scoped search.");
    const needle = await normalizeNeedle(request.needle);
    if (!needle) return EMPTY_PAGE;
    const rows = await prisma.$queryRaw<HitRow[]>(statementFor(target, request.storeId, needle, limit));
    return toPage(rows, limit);
  },

  async searchPlatformOrders(target: PlatformSearchTarget, request: Omit<SearchRequest, "storeId">): Promise<SearchPage> {
    const limit = assertLimit(request.limit);
    const needle = await normalizeNeedle(request.needle);
    if (!needle) return EMPTY_PAGE;
    const rows = await prisma.$queryRaw<HitRow[]>(statementFor(target, null, needle, limit));
    return toPage(rows, limit);
  },

  /**
   * THIS TOOK PRODUCTION'S `/ready` DOWN WITH A 500 ON 2026-09-05, MINUTES AFTER
   * THE DEPLOY THAT SHIPPED PG-6.
   *
   *     ERROR: unrecognized configuration parameter "pg_trgm.word_similarity_threshold"
   *
   * `pg_trgm` registers that GUC from its shared library, and PostgreSQL loads
   * an extension's library LAZILY — on the first use of one of its functions or
   * operators IN THAT BACKEND. `CREATE EXTENSION` puts the catalog entries in
   * the database; it does not load the module into every future connection. So a
   * fresh pooled connection that has not yet answered a search does not know the
   * parameter exists, and `current_setting` raises 42704 rather than returning a
   * default.
   *
   * It passed everywhere else for the most misleading possible reason: CI,
   * staging and every local run execute the pg6 suite (or some search) on the
   * same connection FIRST, which loads the module — so the read only ever fails
   * on a connection where nobody has searched yet. Production, where nobody has
   * searched at all, is precisely that case. A green test suite could not have
   * caught this; only a first request on a cold production connection could.
   *
   * Two changes, and the order matters:
   *
   *   1. `word_similarity('','')` is called first. It is a pg_trgm function, so
   *      it forces the library to load, which makes the GUC exist — and it also
   *      makes the number that comes back the number a REAL search on this
   *      connection would use, which is the whole point of reporting it (ق-144:
   *      `ALTER DATABASE … SET` applies to new sessions only, so a long-lived
   *      pooled connection can silently keep the old 0.6).
   *   2. It is wrapped. A diagnostic field must never be able to take down the
   *      endpoint that carries it — `/ready` also reports the database, the mail
   *      channel and the six configuration groups, and losing all of that
   *      because one optional number could not be read is a worse failure than
   *      the number being unknown.
   */
  async threshold(): Promise<string> {
    try {
      const rows = await prisma.$queryRaw<Array<{ value: string }>>`
        SELECT current_setting('pg_trgm.word_similarity_threshold') AS value
        FROM (SELECT word_similarity('', '')) AS load_the_pg_trgm_module`;
      return rows[0]?.value ?? "unknown";
    } catch {
      // Honest, and never fatal: the caller prints this string as-is.
      return "unavailable";
    }
  },
};

/**
 * The JSON query plan for the statement the engine ACTUALLY runs — the same
 * `Prisma.Sql` object, prefixed with EXPLAIN and executed with the same bound
 * values. A hand-copied lookalike would keep passing after the engine changed,
 * which is the one failure mode a plan gate cannot afford.
 *
 * Owner decision 9 makes the plan a HARD gate — a Seq Scan on a searched table
 * is always a bug, on any machine — while the milliseconds are reported only.
 *
 * Not part of `SearchEngine`: an engine that is not pg_trgm has no EXPLAIN to
 * give, and the interface is the swap boundary.
 */
export async function explainSearch(target: SearchTarget, request: SearchRequest & { storeId: string | null }): Promise<unknown> {
  const needle = await normalizeNeedle(request.needle);
  if (!needle) throw new Error(`explainSearch: «${request.needle}» normalizes to the empty string — there is no query to plan.`);
  const statement = statementFor(target, request.storeId, needle, assertLimit(request.limit));
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`EXPLAIN (FORMAT JSON) ${statement.text}`, ...statement.values);
  return rows[0]?.["QUERY PLAN"];
}

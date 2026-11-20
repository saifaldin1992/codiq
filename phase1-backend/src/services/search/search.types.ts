/**
 * PG-6 (ق-74) — the search engine's contract.
 *
 * THE ONE RULE THAT MAKES THIS PHASE SAFE TO SHIP FIRST: the engine returns
 * IDS AND RANKS AND NOTHING ELSE. It never mints a cursor, never shapes an
 * envelope, never selects a business field and never opens a transaction. Every
 * caller hydrates by id through Prisma with its own `select`, its own PG-2
 * `...LIVE` filter and its own response shape, and paginates with whatever
 * mechanism its endpoint already uses.
 *
 * That is not tidiness. It is what keeps 20-1 contract-neutral: zero response
 * envelopes and zero cursor formats change here, so sub-phase 20-2 sweeps the
 * search endpoints along with the other sixty-five list routes in one pass
 * instead of redoing this work. It is also what keeps the PG-2 soft-delete leak
 * guard able to SEE the hydration — a guard cannot lint a row the engine
 * already materialized.
 */

/**
 * One (table, column) pair, and one search statement.
 *
 * ⚠ DEVIATION FROM THE BLUEPRINT, deliberate. §2.6 sketches this union as the
 *   three tables. It cannot be: §2.5's measured rule is ONE PREDICATE PER
 *   STATEMENT — `name ILIKE q OR sku ILIKE q` was measured on 8,013 products in
 *   this repo at 39.4 ms with a Seq Scan against 1.0 ms with a Bitmap Index
 *   Scan for the split query, because the planner refuses a BitmapOr here. A
 *   target that named only the table would have to OR its columns internally
 *   and would reintroduce exactly the plan the indexes exist to avoid. So the
 *   target IS the column, and a caller that wants three columns issues three
 *   calls in one `Promise.all` and merges the heads — which is what
 *   `merchant-search.service.ts` already does today.
 */
export type SearchTarget =
  | "products.name"
  | "products.sku"
  | "products.description"
  | "customers.fullName"
  | "customers.email"
  | "customers.phone"
  | "orders.orderNumber"
  | "orders.customerName"
  | "orders.recipientPhone";

/** The subset a platform owner may search across every tenant at once. */
export type PlatformSearchTarget = Extract<SearchTarget, `orders.${string}`>;

export interface SearchHit {
  readonly id: string;
  /** An exact-substring hit. Ranks above every fuzzy hit, always. */
  readonly exact: boolean;
  /** `word_similarity(needle, column)` — the needle against the best-matching extent of the haystack. */
  readonly rank: number;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  /** The probe row came back: more rows matched than `limit` returned. */
  readonly hasMore: boolean;
}

export interface SearchRequest {
  /**
   * Mandatory, FIRST, and never optional — a structural protection, not a
   * convention. No caller composes SQL here, so there is no code path that can
   * omit the tenant predicate.
   */
  readonly storeId: string;
  /** RAW user text. The engine normalizes it IN SQL, with the same function object that produced the indexed value. */
  readonly needle: string;
  readonly limit: number;
}

export interface SearchEngine {
  /** Surfaced in logs and in `GET /ready`, so «which engine answered» is never a guess. */
  readonly name: string;
  search(target: SearchTarget, request: SearchRequest): Promise<SearchPage>;
  /** Platform-owner order search: no storeId, deliberately and visibly separate. */
  searchPlatformOrders(target: PlatformSearchTarget, request: Omit<SearchRequest, "storeId">): Promise<SearchPage>;
  /** The effective `pg_trgm.word_similarity_threshold` on this connection — reported by `/ready`. */
  threshold(): Promise<string>;
}

/**
 * Merges several single-column pages into one ranked id list. Each input is
 * already sorted by the same comparator and capped at the same probe size, so
 * the union's best N is the true global best N — the argument
 * `merchant-search.service.ts:123-135` makes for its two-column merge, now
 * applied to ranks instead of to names.
 *
 * A row that matched on two columns keeps its BEST hit: exactness wins, then
 * rank. Ties break on id so the order is total and stable, which is the
 * property 20-2's `(rank, id)` keyset will depend on.
 */
export function mergeSearchPages(pages: readonly SearchPage[], limit: number): SearchPage {
  const best = new Map<string, SearchHit>();
  for (const page of pages) {
    for (const hit of page.hits) {
      const current = best.get(hit.id);
      if (!current || compareHits(hit, current) < 0) best.set(hit.id, hit);
    }
  }
  const ordered = Array.from(best.values()).sort(compareHits);
  return {
    hits: ordered.slice(0, limit),
    // More matched than fits: either a single column said so, or the merged
    // union itself overflows the caller's page.
    hasMore: ordered.length > limit || pages.some((page) => page.hasMore),
  };
}

/** `exact DESC, rank DESC, id DESC` — the engine's ORDER BY, in TypeScript, for the merge. */
export function compareHits(left: SearchHit, right: SearchHit): number {
  if (left.exact !== right.exact) return left.exact ? -1 : 1;
  if (left.rank !== right.rank) return right.rank - left.rank;
  return right.id.localeCompare(left.id);
}

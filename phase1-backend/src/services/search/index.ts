/**
 * PG-6 (ق-74) — the ONLY module anything outside `services/search/` imports.
 *
 * The engine is swappable for real, not decoratively:
 *
 *  1. **Ids and ranks only.** The engine never selects a business field, never
 *     mints a cursor and never opens a transaction. Every caller hydrates by id
 *     through Prisma with its own `select`, its own PG-2 `...LIVE` and its own
 *     envelope — which is what keeps 20-1 contract-neutral and what keeps the
 *     soft-delete leak guard able to see the hydration.
 *  2. **Pagination stays with the caller**, unchanged, so 20-2 converts the
 *     search endpoints in the same sweep as every other list route.
 *  3. **One import boundary.** `postgres-trigram.engine.js` is imported here and
 *     nowhere else; a second engine is a new file plus one value in
 *     `config.searchEngine`, never an edit to a caller.
 */
import { config } from "../../config.js";
import { postgresTrigramEngine } from "./postgres-trigram.engine.js";
import type { SearchEngine } from "./search.types.js";

const ENGINES: Record<string, SearchEngine> = {
  "pg-trgm": postgresTrigramEngine,
};

function selectEngine(): SearchEngine {
  const engine = ENGINES[config.searchEngine];
  if (!engine) {
    // Loud at startup rather than mysteriously empty at request time: a typo in
    // CODIQ_SEARCH_ENGINE would otherwise look exactly like «nothing matches».
    throw new Error(`Unknown CODIQ_SEARCH_ENGINE «${config.searchEngine}». Known engines: ${Object.keys(ENGINES).join(", ")}.`);
  }
  return engine;
}

export const searchEngine: SearchEngine = selectEngine();

export { explainSearch, marketProductMatch, normalizedSearchTerm } from "./postgres-trigram.engine.js";
export type { MarketProductMatch } from "./postgres-trigram.engine.js";
export { compareHits, mergeSearchPages } from "./search.types.js";
export type { PlatformSearchTarget, SearchEngine, SearchHit, SearchPage, SearchRequest, SearchTarget } from "./search.types.js";

/**
 * Hydration helper: reorders rows fetched by `id IN (…)` back into the engine's
 * ranking. Prisma cannot preserve the order of an `in` filter, and every caller
 * would otherwise re-implement this map — usually by sorting on `createdAt` and
 * quietly throwing the ranking away.
 */
export function inSearchOrder<T extends { id: string }>(hits: readonly { id: string }[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  for (const hit of hits) {
    const row = byId.get(hit.id);
    // A missing row is normal, not an error: the caller's own `...LIVE` filter
    // or `isActive` predicate may legitimately drop a hit the engine returned.
    if (row) ordered.push(row);
  }
  return ordered;
}

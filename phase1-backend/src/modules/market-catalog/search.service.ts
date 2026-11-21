/**
 * Market search helpers: counting what people search for (words only — no
 * shopper, session or address is stored), the popular terms, and the
 * as-you-type suggestions (store and category names tolerate a spelling slip,
 * so «سماعة» suggests «سمّاعات»).
 *
 * A term appears in «عمليات بحث شائعة» only after several searches over the
 * week, so one person's unusual query (a name, a phone number) is never shown
 * back to everyone.
 */
import { prisma } from "../../db/prisma.js";
import { baghdadDay } from "../../services/store-traffic.service.js";
import { marketProductMatch } from "../../services/search/index.js";

export const POPULAR_MIN_SEARCHES = 3;
const DIGITS_ONLY = /^[\d\s+]+$/;

export async function recordSearch(normalized: string): Promise<void> {
  const term = normalized.trim().slice(0, 60);
  // Numbers alone are phone numbers and order numbers far more often than products.
  if (term.length < 2 || DIGITS_ONLY.test(term)) return;
  const day = baghdadDay();
  await prisma.$executeRaw`
    INSERT INTO market_search_terms (term, day, searches) VALUES (${term}, ${day}::date, 1)
    ON CONFLICT (term, day) DO UPDATE SET searches = market_search_terms.searches + 1`;
}

/** Bounded: the top ten of the week. */
export async function popularSearches() {
  const rows = await prisma.$queryRaw<Array<{ term: string; searches: number }>>`
    SELECT term, sum(searches)::int AS searches FROM market_search_terms
     WHERE day > current_date - 7
     GROUP BY term HAVING sum(searches) >= ${POPULAR_MIN_SEARCHES}
     ORDER BY sum(searches) DESC, term
     LIMIT 10`;
  return { terms: rows.map((row) => row.term) };
}

/** As-you-type: a few products, stores and categories. Bounded by design (5 + 3 + 5). */
export async function searchSuggestions(raw: string) {
  const match = await marketProductMatch(raw);
  if (!match) return { products: [], stores: [], categories: [] };
  const [products, stores, categories] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT p.id, p.name FROM products p
        JOIN stores st ON st.id = p.store_id JOIN merchants m_acc ON m_acc.id = st.merchant_id
       WHERE st.market_status = 'listed' AND st.is_active AND m_acc.is_active AND p.is_active AND p.deleted_at IS NULL AND ${match.where}
       ORDER BY (CASE WHEN ${match.exact} THEN 1 ELSE 0 END + ${match.rank}) DESC, p.id DESC
       LIMIT 5`,
    prisma.$queryRaw<Array<{ slug: string; name: string }>>`
      SELECT st.slug, st.name FROM stores st JOIN merchants m_acc ON m_acc.id = st.merchant_id
       WHERE st.market_status = 'listed' AND st.is_active AND m_acc.is_active
         AND (codiq_ar_normalize_v1(st.name) LIKE '%' || ${match.like} || '%' OR ${match.normalized} <% codiq_ar_normalize_v1(st.name))
       ORDER BY word_similarity(${match.normalized}, codiq_ar_normalize_v1(st.name)) DESC, st.id LIMIT 3`,
    prisma.$queryRaw<Array<{ slug: string; name: string }>>`
      SELECT slug, name_ar AS name FROM market_categories
       WHERE is_active AND (codiq_ar_normalize_v1(name_ar) LIKE '%' || ${match.like} || '%' OR ${match.normalized} <% codiq_ar_normalize_v1(name_ar))
       ORDER BY word_similarity(${match.normalized}, codiq_ar_normalize_v1(name_ar)) DESC, sort_order, id LIMIT 5`,
  ]);
  return { products, stores, categories };
}

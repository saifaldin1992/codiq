/**
 * The market's category tree. Small (tens of rows) and read on almost every
 * market page, so it is held in memory for a minute — an owner's change shows
 * within that, and a thousand shoppers cost one query a minute.
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";

export type MarketCategoryNode = { id: number; slug: string; name: string; parentId: number | null; children: MarketCategoryNode[] };

const TTL_MS = 60_000;
let cached: { at: number; roots: MarketCategoryNode[]; byId: Map<number, MarketCategoryNode>; bySlug: Map<string, MarketCategoryNode> } | null = null;

async function load() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  const rows = await prisma.marketCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, slug: true, nameAr: true, parentId: true } });
  const byId = new Map<number, MarketCategoryNode>(rows.map((row) => [row.id, { id: row.id, slug: row.slug, name: row.nameAr, parentId: row.parentId, children: [] }]));
  const roots: MarketCategoryNode[] = [];
  for (const node of Array.from(byId.values())) {
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    // A child of an inactive parent is not shown: it would be unreachable from the tree.
    if (node.parentId === null) roots.push(node);
    else if (parent) parent.children.push(node);
  }
  cached = { at: Date.now(), roots, byId, bySlug: new Map(Array.from(byId.values()).map((node) => [node.slug, node])) };
  return cached;
}

/** For tests and for the owner's edits: the next read rebuilds the tree. */
export function forgetMarketCategories() {
  cached = null;
}

export async function marketCategoryTree() {
  return { categories: (await load()).roots };
}

/** The category and every category under it — what «products in Electronics» means. */
export async function categoryWithDescendants(slug: string): Promise<{ node: MarketCategoryNode; ids: number[] }> {
  const node = (await load()).bySlug.get(slug);
  if (!node) throw new HttpError(404, "CATEGORY_NOT_FOUND", "هذه الفئة غير موجودة.");
  return { node, ids: [node.id, ...node.children.map((child) => child.id)] };
}

export async function marketCategoryExists(id: number): Promise<boolean> {
  return (await load()).byId.has(id);
}

export async function marketCategoryPage(slug: string) {
  const { node, ids } = await categoryWithDescendants(slug);
  const tree = await load();
  const parent = node.parentId === null ? null : tree.byId.get(node.parentId) ?? null;
  // The stores that sell in this category, best first — «تسوّق مباشرة من المتاجر».
  const stores = await prisma.$queryRaw<Array<{ slug: string; name: string; logo_object_key: string | null; is_brand: boolean; products: number }>>`
    SELECT st.slug, st.name, st.logo_object_key, st.is_brand, count(*)::int AS products
      FROM products p
      JOIN stores st ON st.id = p.store_id
      JOIN merchants m_acc ON m_acc.id = st.merchant_id
      LEFT JOIN product_categories pc ON pc.id = p.category_id AND pc.store_id = p.store_id
      LEFT JOIN store_market_metrics m ON m.store_id = st.id
     WHERE st.market_status = 'listed' AND st.is_active AND m_acc.is_active
       AND p.is_active AND p.deleted_at IS NULL
       AND COALESCE(p.market_category_id, pc.market_category_id) = ANY(${ids}::int[])
     GROUP BY st.id, st.slug, st.name, st.logo_object_key, st.is_brand, m.score
     ORDER BY COALESCE(m.score, 0) DESC, count(*) DESC, st.id
     LIMIT 12`;
  const logo = (row: { slug: string; logo_object_key: string | null }) =>
    row.logo_object_key ? `/api/store/${encodeURIComponent(row.slug)}/logo?v=${encodeURIComponent(row.logo_object_key.split("/").pop()?.split(".")[0] ?? "0")}` : null;
  return {
    category: { id: node.id, slug: node.slug, name: node.name },
    parent: parent ? { slug: parent.slug, name: parent.name } : null,
    children: node.children.map((child) => ({ id: child.id, slug: child.slug, name: child.name })),
    stores: stores.map((row) => ({ slug: row.slug, name: row.name, logoUrl: logo(row), isBrand: row.is_brand, products: row.products })),
    brands: stores.filter((row) => row.is_brand).map((row) => ({ slug: row.slug, name: row.name, logoUrl: logo(row) })),
  };
}

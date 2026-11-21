/**
 * ق-203 — ONE walker for the nested category tree.
 *
 * The storefront's filter and the merchant's category screen each carried a
 * copy of this walk; the rebuilt storefront needs it in a third place (the
 * header drawer) and a fourth (the breadcrumb). Written once, here, so the
 * four never disagree about what «depth 3» means.
 */
export type TreeCategory = { id: string; name: string; parentCategoryId?: string | null };
export type TreeNode<T extends TreeCategory> = {
  category: T;
  depth: number;
  children: TreeNode<T>[];
};

/** Parent → children, orphans (a parent the list does not carry) treated as roots. */
export function childrenByParent<T extends TreeCategory>(
  categories: readonly T[]
): Map<string | null, T[]> {
  const known = new Set(categories.map((category) => category.id));
  const children = new Map<string | null, T[]>();
  for (const category of categories) {
    const parentId =
      category.parentCategoryId && known.has(category.parentCategoryId)
        ? category.parentCategoryId
        : null;
    children.set(parentId, [...(children.get(parentId) ?? []), category]);
  }
  return children;
}

/** The tree, roots first, three levels deep — the server's own ceiling. */
export function buildCategoryTree<T extends TreeCategory>(
  categories: readonly T[],
  maxDepth = 3
): TreeNode<T>[] {
  const children = childrenByParent(categories);
  const build = (parentId: string | null, depth: number): TreeNode<T>[] =>
    (children.get(parentId) ?? []).map((category) => ({
      category,
      depth,
      children: depth < maxDepth ? build(category.id, depth + 1) : [],
    }));
  return build(null, 1);
}

/** Depth-first flattening with the depth beside each row — what a select or an indented list wants. */
export function flattenCategoryTree<T extends TreeCategory>(
  categories: readonly T[],
  maxDepth = 3
): Array<{ category: T; depth: number }> {
  const rows: Array<{ category: T; depth: number }> = [];
  const walk = (nodes: TreeNode<T>[]) => {
    for (const node of nodes) {
      rows.push({ category: node.category, depth: node.depth });
      walk(node.children);
    }
  };
  walk(buildCategoryTree(categories, maxDepth));
  return rows;
}

/** Root → … → the category itself; empty when the id is unknown. */
export function categoryPath<T extends TreeCategory>(
  categories: readonly T[],
  categoryId: string | null | undefined
): T[] {
  if (!categoryId) return [];
  const byId = new Map(categories.map((category) => [category.id, category]));
  const path: T[] = [];
  let current = byId.get(categoryId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentCategoryId ? byId.get(current.parentCategoryId) : undefined;
  }
  return path;
}

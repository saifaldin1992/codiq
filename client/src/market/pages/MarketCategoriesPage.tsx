/** «الفئات» — the market's tree: every main category with its sub-categories. */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, LoaderCircle } from "lucide-react";
import { marketGet } from "../market-api";

export type CategoryNode = { id: number; slug: string; name: string; children: CategoryNode[] };

export function MarketCategoriesPage() {
  const [tree, setTree] = useState<CategoryNode[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { marketGet<{ categories: CategoryNode[] }>("/api/market/categories").then((body) => setTree(body.categories)).catch((error: Error) => setFailure(error.message)); }, []);

  return (
    <div className="space-y-4" data-testid="market-categories">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">الفئات</h1>
      {failure ? <p className="text-sm text-[var(--codiq-danger)]">تعذّر تحميل الفئات — {failure}</p> : null}
      {!tree && !failure ? <p className="text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      <ul className="space-y-3">
        {tree?.map((root) => (
          <li key={root.id} className="rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm">
            <Link href={`/c/${root.slug}`} className="flex items-center justify-between text-sm font-black text-[var(--codiq-text)]" data-testid={`market-category-${root.slug}`}>
              {root.name} <span className="flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]">تصفّح القسم <ChevronLeft className="h-4 w-4" /></span>
            </Link>
            {root.children.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {root.children.map((child) => (
                  <Link key={child.id} href={`/c/${child.slug}`} className="rounded-full bg-[var(--codiq-surface-sunken)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)]" data-testid={`market-category-${child.slug}`}>{child.name}</Link>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

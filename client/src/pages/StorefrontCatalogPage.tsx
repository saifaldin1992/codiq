/**
 * ق-203 — the catalog: `/products` (all, a search, a rail's «عرض الكل») and
 * `/categories/:id` (a category, its children rolled up server-side). The
 * query, the category and the sort live in the URL, so a header search has
 * somewhere to send the shopper, a category can be linked and shared, and
 * the browser's Back does what he expects.
 */
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { ArrowRight, ChevronLeft, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLatestRequest } from "@/hooks/useLatestRequest";
import { useStorefront } from "@/components/StorefrontProvider";
import { ProductCard } from "@/components/ProductCard";
import { EmptyState, ErrorState, LoadingState } from "@/components/StorefrontStates";
import { buildCategoryTree, categoryPath } from "@/lib/category-tree";
import { errorMessage, ProductSort, StorefrontProduct, storefrontApi } from "@/lib/storefront-api";
import { trackAddToCart } from "@/lib/storefront-pixels";

const SORT_LABELS: Record<ProductSort, string> = { newest: "الأحدث", best_selling: "الأكثر مبيعاً", top_rated: "الأعلى تقييماً" };

function readSort(raw: string | null): ProductSort {
  return raw === "best_selling" || raw === "top_rated" ? raw : "newest";
}

export default function StorefrontCatalogPage() {
  const { storeSlug, categoryId: routeCategoryId } = useParams<{ storeSlug: string; categoryId?: string }>();
  const [, navigate] = useLocation();
  const { categories, setCart, setNotice } = useStorefront();
  // The URL is the state, read through `useSearch()`. wouter's `location` is the
  // PATH only, so a memo keyed on it never saw `?q=…` or `?sort=…` change: a
  // search or a sort typed on this page navigated, the address bar changed, and
  // the products did not — the filters only worked on a fresh page load.
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const query = params.get("q")?.trim() ?? "";
  const sort = readSort(params.get("sort"));
  const categoryId = routeCategoryId ?? params.get("categoryId") ?? "";
  const [products, setProducts] = useState<StorefrontProduct[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [queryDraft, setQueryDraft] = useState(query);
  useEffect(() => { setQueryDraft(query); }, [query]);

  const tree = useMemo(() => buildCategoryTree(categories), [categories]);
  const crumbs = useMemo(() => categoryPath(categories, categoryId || null), [categories, categoryId]);
  const current = crumbs[crumbs.length - 1] ?? null;
  const children = useMemo(() => {
    const find = (nodes: typeof tree): typeof tree => { for (const node of nodes) { if (node.category.id === categoryId) return node.children; const deeper = find(node.children); if (deeper.length) return deeper; } return []; };
    return categoryId ? find(tree) : tree;
  }, [tree, categoryId]);

  const beginRequest = useLatestRequest();
  const load = useCallback(async (next?: string | null, append = false) => {
    const isCurrent = beginRequest();
    try {
      append ? setMoreLoading(true) : setLoading(true);
      setError(null);
      const data = await storefrontApi.listProducts(storeSlug, { categoryId: categoryId || undefined, query: query || undefined, sort }, next);
      if (!isCurrent()) return;
      setProducts((previous) => append ? [...previous, ...data.products.filter((product) => !previous.some((item) => item.id === product.id))] : data.products);
      setCursor(data.nextCursor);
    } catch (caught) { if (isCurrent()) setError(errorMessage(caught)); }
    finally { if (isCurrent()) { setLoading(false); setMoreLoading(false); } }
  }, [beginRequest, storeSlug, categoryId, query, sort]);
  useEffect(() => { void load(); }, [load]);

  function go(next: { q?: string; sort?: ProductSort; categoryId?: string }) {
    const search = new URLSearchParams();
    const q = next.q ?? query; const s = next.sort ?? sort;
    if (q) search.set("q", q);
    if (s !== "newest") search.set("sort", s);
    const category = next.categoryId ?? categoryId;
    const base = category ? `/store/${storeSlug}/categories/${category}` : `/store/${storeSlug}/products`;
    const suffix = search.toString();
    navigate(`${base}${suffix ? `?${suffix}` : ""}`);
  }
  function submitSearch(event: FormEvent) { event.preventDefault(); go({ q: queryDraft.trim(), categoryId: "" }); }
  async function add(productId: string) {
    setAdding(productId);
    try {
      const data = await storefrontApi.addCartItem(storeSlug, productId, 1);
      setCart(data.cart);
      setNotice("تمت إضافة المنتج إلى السلة.");
      const added = products.find((product) => product.id === productId);
      if (added) trackAddToCart(added.minPriceIqd ?? added.priceIqd);
    } catch (caught) { setNotice(errorMessage(caught)); }
    finally { setAdding(null); }
  }

  const title = query ? `نتائج البحث عن «${query}»` : current ? current.name : "كل المنتجات";
  const hasFilters = Boolean(query || categoryId || sort !== "newest");

  return (
    <section className="space-y-6">
      <nav aria-label="مسار التصفح" className="flex flex-wrap items-center gap-1 text-xs text-[var(--storefront-muted)]">
        <Link href={`/store/${storeSlug}`} className="hover:text-[var(--storefront-accent)]">الرئيسية</Link>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        <Link href={`/store/${storeSlug}/products`} className="hover:text-[var(--storefront-accent)]">المنتجات</Link>
        {crumbs.map((crumb) => <span key={crumb.id} className="flex items-center gap-1"><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /><Link href={`/store/${storeSlug}/categories/${crumb.id}`} className={crumb.id === current?.id ? "font-bold text-[var(--storefront-text)]" : "hover:text-[var(--storefront-accent)]"}>{crumb.name}</Link></span>)}
      </nav>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <h1 className="text-2xl font-black tracking-tight text-[var(--storefront-text)] sm:text-3xl">{title}</h1>
        <label className="flex items-center gap-2 text-sm text-[var(--storefront-muted)]">ترتيب حسب
          <select value={sort} onChange={(event) => go({ sort: readSort(event.target.value) })} aria-label="ترتيب المنتجات" className="h-10 rounded-xl border border-[var(--storefront-border)] bg-[var(--storefront-surface)] px-3 text-sm font-bold text-[var(--storefront-text)] outline-none focus:border-[var(--storefront-accent)]">
            {(Object.keys(SORT_LABELS) as ProductSort[]).map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
          </select>
        </label>
      </div>
      {children.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="التصنيفات الفرعية">
          {children.map((node) => <li key={node.category.id}><Link href={`/store/${storeSlug}/categories/${node.category.id}`} className="inline-flex items-center rounded-full border border-[var(--storefront-border)] bg-[var(--storefront-surface)] px-3.5 py-1.5 text-sm font-bold text-[var(--storefront-text)] hover:border-[var(--storefront-accent)] hover:text-[var(--storefront-accent)]">{node.category.name}</Link></li>)}
        </ul>
      ) : null}
      <div className="flex flex-col gap-3 rounded-[22px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-3 sm:flex-row sm:items-center">
        <form onSubmit={submitSearch} role="search" className="relative flex-1">
          <label className="sr-only" htmlFor="catalog-search">تصفية المنتجات بالاسم أو الوصف</label>
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--storefront-muted)]" />
          <input id="catalog-search" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="ابحث باسم المنتج أو وصفه" className="h-11 w-full rounded-xl border border-[var(--storefront-border)] bg-[var(--storefront-canvas)] pr-10 pl-3 text-sm outline-none focus:border-[var(--storefront-accent)]" />
          <button type="submit" className="sr-only">بحث</button>
        </form>
        {hasFilters ? <Button type="button" variant="outline" className="h-11 rounded-xl" onClick={() => { setQueryDraft(""); navigate(`/store/${storeSlug}/products`); }}><X className="ml-1 h-4 w-4" />مسح عوامل التصفية</Button> : null}
      </div>
      {loading ? <LoadingState label="جارٍ تحميل المنتجات…" /> : error ? <ErrorState message={error} retry={() => void load()} /> : !products.length ? (
        <EmptyState title={hasFilters ? "لا توجد نتائج مطابقة" : "لا توجد منتجات متاحة"} detail={hasFilters ? "جرّب عبارة بحث أو تصنيفاً مختلفاً." : "لم يضف هذا المتجر منتجات فعالة بعد."} action={{ label: "العودة إلى الرئيسية", onClick: () => navigate(`/store/${storeSlug}`) }} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
            {products.map((product) => <ProductCard key={product.id} slug={storeSlug} product={product} adding={adding === product.id} onAdd={(id) => void add(id)} />)}
          </div>
          {cursor ? <div className="flex justify-center"><Button type="button" variant="outline" disabled={moreLoading} className="rounded-xl" onClick={() => void load(cursor, true)}>{moreLoading ? "جارٍ التحميل…" : "تحميل المزيد"}</Button></div> : null}
        </>
      )}
      <Link href={`/store/${storeSlug}`} className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--storefront-accent)] hover:underline"><ArrowRight className="h-4 w-4" />العودة إلى الرئيسية</Link>
    </section>
  );
}

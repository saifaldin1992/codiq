/** «منتجات المتجر» — one store's whole catalogue in the market, with search, filters and sorts. */
import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { ChevronLeft, Search } from "lucide-react";
import { ProductBrowser } from "../components/ProductBrowser";

export function MarketStoreProductsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const base = useMemo(() => ({ store: slug, q: query || undefined }), [slug, query]);
  return (
    <div className="space-y-4" data-testid="market-store-products-page">
      <Link href={`/s/${encodeURIComponent(slug)}`} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]"><ChevronLeft className="h-4 w-4 rotate-180" /> رجوع للمتجر</Link>
      <form onSubmit={(event) => { event.preventDefault(); setQuery(draft.trim()); }} role="search">
        <label className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface)] px-3 py-2.5 shadow-sm">
          <Search className="h-4 w-4 text-[var(--codiq-text-muted)]" />
          <input value={draft} onChange={(event) => setDraft(event.target.value)} type="search" placeholder="ابحث في المتجر…" className="w-full bg-transparent text-sm outline-none" data-testid="market-store-products-search" />
        </label>
      </form>
      <ProductBrowser key={query} base={base} defaultSort={query ? "relevance" : "newest"} testId="market-store-products-list" emptyTitle={query ? "لا توجد نتائج مطابقة في هذا المتجر" : "لا توجد منتجات معروضة حالياً"} />
    </div>
  );
}

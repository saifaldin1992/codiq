/**
 * البحث — before typing: your recent searches (this browser only) and the
 * week's popular ones; while typing: products, stores and categories as you
 * go; after submitting: the full, filterable results.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Clock, Grid2x2, Search, Store, TrendingUp, X } from "lucide-react";
import { marketGet } from "../market-api";
import { clearRecentSearches, readRecentSearches, rememberSearch } from "../market-products";
import { ProductBrowser } from "../components/ProductBrowser";
import { PhotoPickerButton } from "./MarketImageSearchPage";
import { setPendingPhoto } from "../market-photo";

type Suggestions = {
  products: { id: string; name: string }[];
  stores: { slug: string; name: string }[];
  categories: { slug: string; name: string }[];
};

export function MarketSearchPage() {
  const query = new URLSearchParams(useSearch()).get("q")?.trim() ?? "";
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState(query);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [popular, setPopular] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>(() => readRecentSearches());

  useEffect(() => {
    setDraft(query);
    if (query) {
      rememberSearch(query);
      setRecent(readRecentSearches());
    }
  }, [query]);
  useEffect(() => {
    marketGet<{ terms: string[] }>("/api/market/search/popular")
      .then((body) => setPopular(body.terms))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const term = draft.trim();
    if (term.length < 2 || term === query) {
      setSuggestions(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      marketGet<Suggestions>(`/api/market/search/suggest?q=${encodeURIComponent(term)}`, {
        signal: controller.signal,
      })
        .then(setSuggestions)
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft, query]);

  const go = (term: string) => {
    const clean = term.trim();
    if (clean) navigate(`/search?q=${encodeURIComponent(clean)}`);
  };
  const base = useMemo(() => ({ q: query }), [query]);

  return (
    <div className="space-y-4" data-testid="market-search">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          go(draft);
        }}
        role="search"
        className="relative"
      >
        <label className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface)] px-3 py-2.5 shadow-sm">
          <Search className="h-4 w-4 text-[var(--codiq-text-muted)]" />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus={!query}
            type="search"
            enterKeyHint="search"
            placeholder="ابحث عن أي شيء…"
            className="w-full bg-transparent text-sm outline-none"
            data-testid="market-search-page-input"
          />
          {draft ? (
            <button type="button" aria-label="مسح" onClick={() => setDraft("")}>
              <X className="h-4 w-4 text-[var(--codiq-text-muted)]" />
            </button>
          ) : null}
          <PhotoPickerButton
            onPick={(file) => {
              setPendingPhoto(file);
              navigate(`/search/image?t=${Date.now()}`);
            }}
            testId="market-search-page-photo"
          />
        </label>
        {suggestions &&
        (suggestions.products.length ||
          suggestions.stores.length ||
          suggestions.categories.length) ? (
          <ul
            className="absolute inset-x-0 top-full z-20 mt-1 space-y-0.5 rounded-2xl bg-[var(--codiq-surface)] p-2 shadow-lg"
            data-testid="market-suggestions"
          >
            {suggestions.categories.map((category) => (
              <li key={category.slug}>
                <Link
                  href={`/c/${category.slug}`}
                  className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-[var(--codiq-text)] hover:bg-[var(--codiq-surface-sunken)]"
                >
                  <Grid2x2 className="h-4 w-4 text-[var(--codiq-accent)]" /> {category.name}
                </Link>
              </li>
            ))}
            {suggestions.stores.map((store) => (
              <li key={store.slug}>
                <Link
                  href={`/s/${encodeURIComponent(store.slug)}`}
                  className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-[var(--codiq-text)] hover:bg-[var(--codiq-surface-sunken)]"
                >
                  <Store className="h-4 w-4 text-[var(--codiq-accent)]" /> {store.name}
                </Link>
              </li>
            ))}
            {suggestions.products.map((product) => (
              <li key={product.id}>
                <Link
                  href={`/p/${product.id}`}
                  className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-[var(--codiq-text)] hover:bg-[var(--codiq-surface-sunken)]"
                >
                  <Search className="h-4 w-4 text-[var(--codiq-text-muted)]" /> {product.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </form>

      {query ? (
        <>
          <h1 className="text-base font-black text-[var(--codiq-text)]">نتائج «{query}»</h1>
          <ProductBrowser
            base={base}
            defaultSort="relevance"
            testId="market-search-results"
            emptyTitle="لا توجد نتائج مطابقة للبحث"
          />
        </>
      ) : (
        <div className="space-y-5">
          {recent.length ? (
            <section className="space-y-2" data-testid="market-recent-searches">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-black text-[var(--codiq-text)]">آخر بحثاتك</h2>
                <button
                  type="button"
                  onClick={() => {
                    clearRecentSearches();
                    setRecent([]);
                  }}
                  className="text-xs font-bold text-[var(--codiq-accent)]"
                >
                  مسح الكل
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recent.map((term) => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => go(term)}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-surface)] px-3 py-1.5 text-xs text-[var(--codiq-text-secondary)] shadow-sm"
                  >
                    <Clock className="h-3 w-3" /> {term}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {popular.length ? (
            <section className="space-y-2" data-testid="market-popular-searches">
              <h2 className="text-sm font-black text-[var(--codiq-text)]">عمليات بحث شائعة</h2>
              <div className="flex flex-wrap gap-2">
                {popular.map((term) => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => go(term)}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-accent-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-accent)]"
                  >
                    <TrendingUp className="h-3 w-3" /> {term}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <Link
            href="/categories"
            className="block rounded-[22px] bg-[var(--codiq-surface)] p-4 text-sm font-bold text-[var(--codiq-text)] shadow-sm"
          >
            تصفّح حسب الفئة
          </Link>
        </div>
      )}
    </div>
  );
}

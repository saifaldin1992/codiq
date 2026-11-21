/** One category: where it sits, its sub-categories, the stores and brands selling in it, and its products. */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { ChevronLeft, Grid2x2, LoaderCircle, Store } from "lucide-react";
import { marketGet, MarketApiError } from "../market-api";
import { ProductBrowser } from "../components/ProductBrowser";
import { MarketEmptyState } from "../MarketEmptyState";

type CategoryPage = {
  category: { id: number; slug: string; name: string };
  parent: { slug: string; name: string } | null;
  children: { id: number; slug: string; name: string }[];
  stores: {
    slug: string;
    name: string;
    logoUrl: string | null;
    isBrand: boolean;
    products: number;
  }[];
};

export function MarketCategoryPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [page, setPage] = useState<CategoryPage | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setPage(null);
    setMissing(false);
    marketGet<CategoryPage>(`/api/market/categories/${encodeURIComponent(slug)}`)
      .then(setPage)
      .catch((error) => setMissing(error instanceof MarketApiError && error.status === 404));
  }, [slug]);
  const base = useMemo(() => ({ category: slug }), [slug]);

  if (missing)
    return (
      <MarketEmptyState
        icon={Grid2x2}
        title="الفئة غير موجودة"
        action={
          <Link
            href="/categories"
            className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
          >
            كل الفئات
          </Link>
        }
      />
    );
  if (!page)
    return (
      <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );

  return (
    <div className="space-y-5" data-testid="market-category-page">
      <nav
        className="flex items-center gap-1 text-xs text-[var(--codiq-text-muted)]"
        aria-label="المسار"
      >
        <Link href="/categories" className="font-semibold text-[var(--codiq-accent)]">
          الفئات
        </Link>
        {page.parent ? (
          <>
            <ChevronLeft className="h-3 w-3" />
            <Link
              href={`/c/${page.parent.slug}`}
              className="font-semibold text-[var(--codiq-accent)]"
            >
              {page.parent.name}
            </Link>
          </>
        ) : null}
      </nav>
      <h1
        className="text-xl font-black text-[var(--codiq-text)]"
        data-testid="market-category-title"
      >
        {page.category.name}
      </h1>
      {page.children.length ? (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
          {page.children.map((child) => (
            <Link
              key={child.id}
              href={`/c/${child.slug}`}
              className="shrink-0 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-text)]"
            >
              {child.name}
            </Link>
          ))}
        </div>
      ) : null}
      {page.stores.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-black text-[var(--codiq-text)]">متاجر هذا القسم</h2>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 [scrollbar-width:none]">
            {page.stores.map((store) => (
              <Link
                key={store.slug}
                href={`/s/${encodeURIComponent(store.slug)}`}
                className="flex w-20 shrink-0 flex-col items-center gap-1 text-center"
              >
                {store.logoUrl ? (
                  <img
                    src={store.logoUrl}
                    alt=""
                    loading="lazy"
                    className="h-14 w-14 rounded-2xl bg-[var(--codiq-surface)] object-cover shadow-sm"
                  />
                ) : (
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
                    <Store className="h-6 w-6" />
                  </span>
                )}
                <span className="line-clamp-2 text-[10px] font-semibold text-[var(--codiq-text-secondary)]">
                  {store.name}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      <ProductBrowser
        base={base}
        defaultSort="recommended"
        testId="market-category-products"
        emptyTitle="لا توجد منتجات في هذه الفئة بعد"
      />
    </div>
  );
}

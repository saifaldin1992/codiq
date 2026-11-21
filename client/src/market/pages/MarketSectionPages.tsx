/** The pages a home block or a banner opens: a named section, a collection or discount event, and a mall. */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { Building2, LoaderCircle, Percent, Sparkles, Store } from "lucide-react";
import { marketGet, MarketApiError } from "../market-api";
import { SECTION_TITLES } from "../market-links";
import { ProductBrowser } from "../components/ProductBrowser";
import { Countdown } from "../components/Countdown";
import { MarketEmptyState } from "../MarketEmptyState";

type Sort = Parameters<typeof ProductBrowser>[0]["defaultSort"];
const SECTIONS: Record<string, { base: Record<string, string>; sort: Sort }> = {
  discounts: { base: { discount: "any" }, sort: "discount" },
  "half-price": { base: { discount: "50" }, sort: "discount" },
  new: { base: {}, sort: "newest" },
  trending: { base: {}, sort: "recommended" },
  "best-sellers": { base: {}, sort: "best_selling" },
  "sells-fast": { base: { sellsFast: "1" }, sort: "best_selling" },
  preorders: { base: { preorder: "1" }, sort: "newest" },
  "top-rated": { base: {}, sort: "rating" },
};

export function MarketSectionPage() {
  const { key = "" } = useParams<{ key: string }>();
  const section = SECTIONS[key];
  if (!section)
    return (
      <MarketEmptyState
        icon={Sparkles}
        title="القسم غير موجود"
        action={
          <Link
            href="/"
            className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
          >
            عودة للرئيسية
          </Link>
        }
      />
    );
  return (
    <div className="space-y-4" data-testid="market-section-page">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">{SECTION_TITLES[key]}</h1>
      <ProductBrowser
        key={key}
        base={section.base}
        defaultSort={section.sort}
        testId="market-section-products"
      />
    </div>
  );
}

type Collection = {
  slug: string;
  kind: string;
  title: string;
  subtitle: string | null;
  headlineDiscountPercent: number | null;
  endsAt: string | null;
};

export function MarketCollectionPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setCollection(null);
    setMissing(false);
    marketGet<{ collection: Collection }>(`/api/market/collections/${encodeURIComponent(slug)}`)
      .then((body) => setCollection(body.collection))
      .catch((error) => setMissing(error instanceof MarketApiError && error.status === 404));
  }, [slug]);
  const base = useMemo(() => ({ collection: slug }), [slug]);
  if (missing)
    return (
      <MarketEmptyState
        testId="market-collection-missing"
        icon={Sparkles}
        title="انتهى هذا العرض"
        body="تابع الرئيسية لعروض جديدة كل يوم."
        action={
          <Link
            href="/"
            className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
          >
            عودة للرئيسية
          </Link>
        }
      />
    );
  if (!collection)
    return (
      <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );
  return (
    <div className="space-y-4" data-testid="market-collection-page">
      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-accent)] p-5 text-[var(--codiq-surface)]">
        <p className="flex items-center gap-1 text-xs font-bold opacity-85">
          {collection.kind === "discount" ? (
            <>
              <Percent className="h-4 w-4" /> خصومات
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> مجموعة مختارة
            </>
          )}
        </p>
        <h1 className="text-2xl font-black" data-testid="market-collection-title">
          {collection.title}
        </h1>
        {collection.headlineDiscountPercent ? (
          <p className="text-sm font-bold">
            خصومات لحدّ {collection.headlineDiscountPercent.toLocaleString("ar-IQ")}%
          </p>
        ) : null}
        {collection.subtitle ? <p className="text-sm opacity-90">{collection.subtitle}</p> : null}
        {collection.endsAt ? (
          <span className="inline-block rounded-full bg-[var(--codiq-surface)] px-3 py-1">
            <Countdown until={collection.endsAt} testId="market-collection-countdown" />
          </span>
        ) : null}
      </section>
      <ProductBrowser
        base={base}
        defaultSort={collection.kind === "discount" ? "discount" : "recommended"}
        testId="market-collection-products"
        emptyTitle="لا توجد منتجات في هذه المجموعة"
      />
    </div>
  );
}

type Mall = {
  mall: { slug: string; name: string; description: string | null };
  stores: { slug: string; name: string; businessType: string | null; logoUrl: string | null }[];
};

export function MarketMallPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [data, setData] = useState<Mall | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setData(null);
    setMissing(false);
    marketGet<Mall>(`/api/market/malls/${encodeURIComponent(slug)}`)
      .then(setData)
      .catch((error) => setMissing(error instanceof MarketApiError && error.status === 404));
  }, [slug]);
  const base = useMemo(() => ({ mall: slug }), [slug]);
  if (missing)
    return (
      <MarketEmptyState
        icon={Building2}
        title="المول غير موجود"
        action={
          <Link
            href="/"
            className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
          >
            عودة للرئيسية
          </Link>
        }
      />
    );
  if (!data)
    return (
      <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );
  return (
    <div className="space-y-5" data-testid="market-mall-page">
      <section className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-black text-[var(--codiq-text)]">
          <Building2 className="h-6 w-6 text-[var(--codiq-accent)]" /> {data.mall.name}
        </h1>
        {data.mall.description ? (
          <p className="text-sm text-[var(--codiq-text-secondary)]">{data.mall.description}</p>
        ) : null}
      </section>
      {data.stores.length === 0 ? (
        <MarketEmptyState
          icon={Building2}
          title="لا يوجد محتوى في هذا المول بعد"
          body="لم يُضف هذا المول أيّ متاجر حتى الآن."
        />
      ) : (
        <>
          <section className="space-y-2" data-testid="market-mall-stores">
            <h2 className="text-sm font-black text-[var(--codiq-text)]">متاجر المول</h2>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 [scrollbar-width:none]">
              {data.stores.map((store) => (
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
                      className="h-14 w-14 rounded-2xl object-cover shadow-sm"
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
          <ProductBrowser base={base} defaultSort="recommended" testId="market-mall-products" />
        </>
      )}
    </div>
  );
}

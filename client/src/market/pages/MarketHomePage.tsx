/**
 * The market's front page, block by block in the owner's order (GET
 * /market/home). Banners, categories, collections and malls arrive resolved
 * in that one answer; product and store shelves fetch their own lists in
 * parallel; «شاهدته مؤخراً» and «مقترح لك» are built from this browser's own
 * history and stay hidden until there is one.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Building2, ChevronLeft, Percent, ShoppingBag, Sparkles, Store, Truck, Wallet } from "lucide-react";
import { marketGet } from "../market-api";
import { useShopper } from "../market-shopper";
import { useMarketLocation } from "../market-location";
import { marketStoresUrl } from "../use-market-stores";
import { queryString } from "../use-market-list";
import { readRecentProducts } from "../market-products";
import { BannerCarousel, type MarketBanner } from "../components/BannerCarousel";
import { ProductShelf } from "../components/ProductShelf";
import { StoreShelf } from "../components/StoreShelf";

type Collection = { slug: string; kind: string; title: string; subtitle: string | null; headlineDiscountPercent: number | null; endsAt: string | null; products: number };
type Mall = { slug: string; name: string; description: string | null; stores: number; logos: { slug: string; name: string; logoUrl: string | null }[] };
type Section = { id: string; kind: string; title: string | null; config: Record<string, unknown>; banners?: MarketBanner[]; categories?: { slug: string; name: string }[]; collections?: Collection[]; malls?: Mall[] };

const PRODUCT_KEYS = ["sort", "period", "category", "discount", "sellsFast", "preorder", "collection"] as const;

export function MarketHomePage() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [failure, setFailure] = useState(false);
  const [location] = useMarketLocation();
  const recent = useMemo(() => readRecentProducts(), []);
  const { shopper } = useShopper();

  useEffect(() => { marketGet<{ sections: Section[] }>("/api/market/home").then((body) => setSections(body.sections)).catch(() => setFailure(true)); }, []);
  const hasHero = sections?.some((section) => section.kind === "banners" && (section.banners?.length ?? 0) > 0);

  return (
    <div className="space-y-6" data-testid="market-home">
      {sections && !hasHero ? <Welcome /> : null}
      {failure ? <Welcome /> : null}
      {sections?.map((section) => {
        const all = (href: string) => <Link href={href} className="text-xs font-bold text-[var(--codiq-accent)]">عرض الكل</Link>;
        switch (section.kind) {
          case "banners": return <BannerCarousel key={section.id} banners={section.banners ?? []} testId={`market-home-banners-${String(section.config.placement)}`} />;
          case "categories": return section.categories?.length ? (
            <section key={section.id} className="space-y-2" data-testid="market-home-categories">
              <div className="flex items-end justify-between"><h2 className="text-base font-black text-[var(--codiq-text)]">{section.title ?? "الفئات"}</h2>{all("/categories")}</div>
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
                {section.categories.map((category) => <Link key={category.slug} href={`/c/${category.slug}`} className="shrink-0 rounded-2xl bg-[var(--codiq-surface)] px-4 py-3 text-xs font-bold text-[var(--codiq-text)] shadow-sm">{category.name}</Link>)}
              </div>
            </section>
          ) : null;
          case "products": {
            const params: Record<string, string | boolean | undefined> = { limit: "10", deliverTo: undefined };
            for (const key of PRODUCT_KEYS) { const value = section.config[key]; if (value !== undefined) params[key] = value as string | boolean; }
            const target = section.config.section ? `/section/${String(section.config.section)}` : null;
            return <ProductShelf key={section.id} testId={`market-home-products-${section.id}`} title={section.title ?? ""} url={`/api/market/products?${queryString(params)}`} action={target ? all(target) : undefined} />;
          }
          case "stores": return <StoreShelf key={section.id} testId={`market-home-stores-${section.id}`} title={section.title ?? ""} url={marketStoresUrl({ governorate: location?.governorateKey, district: location?.districtId ?? undefined, sort: String(section.config.sort ?? "recommended"), ambassador: section.config.ambassador === true, limit: 10 })} action={all("/stores")} />;
          case "collections": return section.collections?.length ? (
            <section key={section.id} className="space-y-2" data-testid="market-home-collections">
              <h2 className="text-base font-black text-[var(--codiq-text)]">{section.title}</h2>
              <div className="-mx-4 flex gap-3 overflow-x-auto px-4 [scrollbar-width:none]">
                {section.collections.map((collection) => (
                  <Link key={collection.slug} href={`/collection/${collection.slug}`} className="w-[220px] shrink-0 space-y-1 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid={`market-home-collection-${collection.slug}`}>
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">{collection.kind === "discount" ? <Percent className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}</span>
                    <p className="text-sm font-black text-[var(--codiq-text)]">{collection.title}</p>
                    <p className="text-[11px] text-[var(--codiq-text-muted)]">{collection.headlineDiscountPercent ? `خصومات لحدّ ${collection.headlineDiscountPercent.toLocaleString("ar-IQ")}% · ` : ""}{collection.products.toLocaleString("ar-IQ")} منتج</p>
                  </Link>
                ))}
              </div>
            </section>
          ) : null;
          case "malls": return section.malls?.length ? (
            <section key={section.id} className="space-y-2" data-testid="market-home-malls">
              <h2 className="text-base font-black text-[var(--codiq-text)]">{section.title}</h2>
              <div className="-mx-4 flex gap-3 overflow-x-auto px-4 [scrollbar-width:none]">
                {section.malls.map((mall) => (
                  <Link key={mall.slug} href={`/mall/${mall.slug}`} className="w-[200px] shrink-0 space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm">
                    <p className="flex items-center gap-1 text-sm font-black text-[var(--codiq-text)]"><Building2 className="h-4 w-4 text-[var(--codiq-accent)]" /> {mall.name}</p>
                    <div className="flex -space-x-2 space-x-reverse">
                      {mall.logos.map((logo) => logo.logoUrl ? <img key={logo.slug} src={logo.logoUrl} alt="" className="h-8 w-8 rounded-full border-2 border-[var(--codiq-surface)] object-cover" /> : <span key={logo.slug} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-[var(--codiq-surface)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Store className="h-4 w-4" /></span>)}
                    </div>
                    <p className="text-[11px] text-[var(--codiq-text-muted)]">{mall.stores.toLocaleString("ar-IQ")} متجر</p>
                  </Link>
                ))}
              </div>
            </section>
          ) : null;
          case "recently_viewed": return recent.length ? <ProductShelf key={section.id} testId="market-home-recent" title={section.title ?? "شاهدته مؤخراً"} url={`/api/market/products?${queryString({ ids: recent.slice(0, 24).join(","), limit: 24 })}`} /> : null;
          case "for_you": return recent.length ? <ProductShelf key={section.id} testId="market-home-for-you" title={section.title ?? "مقترح لك"} url={`/api/market/products?${queryString({ relatedTo: recent.slice(0, 10).join(","), limit: 10 })}`} /> : null;
          default: return null;
        }
      })}
      {sections && shopper ? <StoreShelf testId="market-home-purchased-from" title="اشتريت منها" subtitle="المتاجر التي طلبت منها سابقاً" url="/api/market/me/purchased-from" /> : null}
      {sections && shopper ? <StoreShelf testId="market-home-followed" title="متاجر تتابعها" url="/api/market/favourites/stores?limit=10" action={<Link href="/favourites?tab=stores" className="text-xs font-bold text-[var(--codiq-accent)]">عرض الكل</Link>} /> : null}
      {sections ? <Link href="/categories" className="flex items-center justify-between rounded-[22px] bg-[var(--codiq-surface)] p-4 text-sm font-bold text-[var(--codiq-text)] shadow-sm">تصفّح كل الفئات <ChevronLeft className="h-4 w-4" /></Link> : null}
    </div>
  );
}

function Welcome() {
  const promises = [
    { icon: ShoppingBag, text: "كل المتاجر في مكان واحد" },
    { icon: Sparkles, text: "عروض جديدة كل يوم" },
    { icon: Truck, text: "توصيل لباب بيتك" },
    { icon: Wallet, text: "ادفع نقداً عند الاستلام" },
  ];
  return (
    <div className="space-y-4" data-testid="market-home-welcome">
      <section className="rounded-[28px] bg-[var(--codiq-accent)] p-6 text-[var(--codiq-surface)] shadow-sm">
        <p className="text-xs font-bold opacity-80">أهلاً بك في السوق</p>
        <h1 className="mt-2 text-2xl font-black leading-tight">تسوّق من كل متاجر العراق بسلّة وحدة</h1>
        <Link href="/stores" className="mt-5 inline-flex items-center gap-2 rounded-full bg-[var(--codiq-surface)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-accent)]" data-testid="market-home-browse-stores"><Store className="h-4 w-4" /> تصفّح المتاجر</Link>
      </section>
      <ul className="grid grid-cols-2 gap-3">
        {promises.map(({ icon: Icon, text }) => <li key={text} className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface)] p-3 text-xs font-semibold text-[var(--codiq-text-secondary)] shadow-sm"><Icon className="h-5 w-5 shrink-0 text-[var(--codiq-accent)]" /> {text}</li>)}
      </ul>
    </div>
  );
}

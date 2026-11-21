/**
 * دليل المتاجر — shelves (recommended, top rated, fastest, most visited, top
 * sellers, new, ambassadors, near you) over a full, sortable, filterable list.
 * A search or a filter switches the page to the list alone, the way a shopper
 * who knows what he wants expects. The header's «التوصيل إلى» filters it all.
 */
import { useMemo, useState } from "react";
import { CircleHelp, Crosshair, LoaderCircle, Search, Store } from "lucide-react";
import { useMarketLocation } from "../market-location";
import { marketStoresUrl, useMarketStores } from "../use-market-stores";
import type { MarketStoreSort } from "../market-types";
import { StoreShelf } from "../components/StoreShelf";
import { StoreListRow } from "../components/StoreCards";
import { RankingSheet } from "../components/RankingSheet";
import { MarketEmptyState } from "../MarketEmptyState";

const SORTS: { value: Exclude<MarketStoreSort, "nearest">; label: string }[] = [
  { value: "recommended", label: "المقترحة" },
  { value: "rating", label: "الأعلى تقييماً" },
  { value: "response", label: "الأسرع ردّاً" },
  { value: "views", label: "الأكثر زيارة" },
  { value: "sales", label: "الأكثر مبيعاً" },
  { value: "newest", label: "الأحدث" },
];

type Position = { lat: number; lng: number };

export function MarketStoresPage() {
  const [location] = useMarketLocation();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Exclude<MarketStoreSort, "nearest">>("recommended");
  const [verified, setVerified] = useState(false);
  const [brand, setBrand] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [locating, setLocating] = useState<"idle" | "asking" | "denied" | "unavailable">("idle");

  const where = { governorate: location?.governorateKey, district: location?.districtId ?? undefined };
  const shelf = (sort: MarketStoreSort, extra: Record<string, string | number | boolean | undefined> = {}) => marketStoresUrl({ ...where, sort, limit: 10, ...extra });
  const focused = query.trim().length > 0 || verified || brand;
  const listUrl = useMemo(
    () => marketStoresUrl({ ...where, sort, q: query.trim() || undefined, verified, brand, limit: 20 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `where` is rebuilt from these two each render
    [location?.governorateKey, location?.districtId, sort, query, verified, brand],
  );
  const list = useMarketStores(listUrl);

  const locate = () => {
    if (!("geolocation" in navigator)) { setLocating("unavailable"); return; }
    setLocating("asking");
    navigator.geolocation.getCurrentPosition(
      (result) => { setPosition({ lat: result.coords.latitude, lng: result.coords.longitude }); setLocating("idle"); },
      (error) => setLocating(error.code === error.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  };

  return (
    <div className="space-y-6" data-testid="market-stores">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-black text-[var(--codiq-text)]">المتاجر</h1>
        <button type="button" onClick={() => setExplaining(true)} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]" data-testid="market-ranking-open">
          <CircleHelp className="h-4 w-4" /> كيف نرتّب المتاجر؟
        </button>
      </div>

      <label className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface)] px-3 py-2.5 shadow-sm">
        <Search className="h-4 w-4 text-[var(--codiq-text-muted)]" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث عن متجر…" className="w-full bg-transparent text-sm outline-none" data-testid="market-stores-search" />
      </label>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
        <FilterChip active={verified} onClick={() => setVerified((value) => !value)} testId="market-filter-verified">موثّقة</FilterChip>
        <FilterChip active={brand} onClick={() => setBrand((value) => !value)} testId="market-filter-brand">علامات تجاريّة</FilterChip>
        {location ? <span className="shrink-0 rounded-full bg-[var(--codiq-accent-soft)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-accent)]">{[location.governorateName, location.districtName].filter(Boolean).join(" · ")}</span> : null}
      </div>

      {!focused ? (
        <>
          <StoreShelf testId="market-shelf-recommended" title="متاجر مقترحة" subtitle="الأفضل أداءً مع الزبائن" url={shelf("recommended")} />
          <section className="space-y-2" data-testid="market-shelf-nearby">
            {position ? (
              <StoreShelf testId="market-shelf-nearest" title="بالقرب منك" subtitle="متاجر قريبة لتسريع التوصيل أو الاستلام" url={shelf("nearest", { lat: position.lat.toFixed(5), lng: position.lng.toFixed(5) })} />
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm">
                <div>
                  <p className="text-sm font-bold text-[var(--codiq-text)]">متاجر قريبة منك</p>
                  <p className="text-[11px] text-[var(--codiq-text-muted)]">
                    {locating === "denied" ? "فعّل صلاحيّة الموقع من إعدادات المتصفّح ثم أعد المحاولة." : locating === "unavailable" ? "تعذّر تحديد موقعك، حاول مرة أخرى." : "فعّل الموقع لنعرض المتاجر الأقرب إليك."}
                  </p>
                </div>
                <button type="button" onClick={locate} disabled={locating === "asking"} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--codiq-accent)] px-3 py-2 text-xs font-bold text-[var(--codiq-surface)] disabled:opacity-60" data-testid="market-locate">
                  {locating === "asking" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4" />} تشغيل الموقع
                </button>
              </div>
            )}
          </section>
          <StoreShelf testId="market-shelf-rating" title="الأعلى تقييماً" subtitle="أعلى متوسط تقييمات من الزبائن" url={shelf("rating")} />
          <StoreShelf testId="market-shelf-response" title="الأسرع استجابة" subtitle="الأسرع في قبول الطلبات" url={shelf("response")} />
          <StoreShelf testId="market-shelf-sales" title="الأكثر مبيعاً هذا الشهر" url={shelf("sales")} />
          <StoreShelf testId="market-shelf-views" title="الأكثر زيارة" url={shelf("views")} />
          <StoreShelf testId="market-shelf-ambassadors" title="سفراء السوق" subtitle="متاجر اختارها فريق المنصّة" url={shelf("recommended", { ambassador: true })} />
          <StoreShelf testId="market-shelf-newest" title="انضمّت حديثاً" url={shelf("newest")} />
        </>
      ) : null}

      <section className="space-y-3" data-testid="market-stores-list">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-black text-[var(--codiq-text)]">{focused ? "النتائج" : "كل المتاجر"}</h2>
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="رتّب حسب" className="rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text)]" data-testid="market-stores-sort">
            {SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        {list.failure ? <p className="text-center text-sm text-[var(--codiq-danger)]">{list.failure}</p> : null}
        {!list.stores && !list.failure ? <p className="py-8 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
        {list.stores?.length === 0 ? <MarketEmptyState icon={Store} title="لا توجد متاجر مطابقة" body={location ? "جرّب محافظة أخرى أو امسح البحث." : "جرّب كلمات أخرى."} testId="market-stores-empty" /> : null}
        <div className="space-y-3">{list.stores?.map((store) => <StoreListRow key={store.slug} store={store} />)}</div>
        {list.nextCursor ? (
          <button type="button" onClick={() => void list.loadMore()} disabled={list.loadingMore} className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]" data-testid="market-stores-more">
            {list.loadingMore ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} عرض المزيد
          </button>
        ) : null}
      </section>
      {explaining ? <RankingSheet onClose={() => setExplaining(false)} /> : null}
    </div>
  );
}

function FilterChip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} data-testid={testId}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${active ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "border-[var(--codiq-border)] bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`}>
      {children}
    </button>
  );
}

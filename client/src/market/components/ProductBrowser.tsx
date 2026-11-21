/**
 * A filterable, sortable, paged grid of market products — the body of the
 * category page, the search results and «كل المنتجات». The filters mirror the
 * server's query one to one (sort, period, price range, discount, rating,
 * condition, pre-order, in stock, delivers to my governorate).
 */
import { useMemo, useState } from "react";
import { LoaderCircle, PackageSearch, SlidersHorizontal, X } from "lucide-react";
import { useMarketLocation } from "../market-location";
import { queryString, useMarketList } from "../use-market-list";
import type { MarketProductCard } from "../market-products";
import { ProductCard } from "./ProductCard";
import { MarketEmptyState } from "../MarketEmptyState";

type Sort =
  | "relevance"
  | "recommended"
  | "newest"
  | "price_asc"
  | "price_desc"
  | "rating"
  | "best_selling"
  | "discount";
type Filters = {
  minPrice: string;
  maxPrice: string;
  discount: "" | "any" | "30" | "50";
  rating: "" | "3" | "excellent";
  condition: "" | "new" | "used";
  preorder: boolean;
  inStock: boolean;
  deliverable: boolean;
  period: "day" | "week" | "month" | "quarter";
};

const EMPTY: Filters = {
  minPrice: "",
  maxPrice: "",
  discount: "",
  rating: "",
  condition: "",
  preorder: false,
  inStock: false,
  deliverable: false,
  period: "month",
};
const SORTS: { value: Sort; label: string; hint: string }[] = [
  { value: "relevance", label: "الأكثر صلة", hint: "الأنسب لبحثك" },
  { value: "recommended", label: "المقترحة", hint: "الأكثر طلباً ومشاهدة" },
  { value: "newest", label: "الأحدث", hint: "أحدث المنتجات أولاً" },
  { value: "price_asc", label: "السعر: الأقل أولاً", hint: "من الأرخص إلى الأغلى" },
  { value: "price_desc", label: "السعر: الأعلى أولاً", hint: "من الأغلى إلى الأرخص" },
  { value: "rating", label: "الأعلى تقييماً", hint: "أفضل تقييمات الزبائن أولاً" },
  { value: "best_selling", label: "الأكثر مبيعاً", hint: "حسب الكميات المباعة" },
  { value: "discount", label: "أكبر خصم", hint: "أعلى نسبة تخفيض أولاً" },
];
const PERIODS: { value: Filters["period"]; label: string }[] = [
  { value: "day", label: "اليوم" },
  { value: "week", label: "هذا الأسبوع" },
  { value: "month", label: "هذا الشهر" },
  { value: "quarter", label: "آخر ٣ أشهر" },
];

export function ProductBrowser({
  base,
  defaultSort,
  testId,
  emptyTitle,
}: {
  base: Record<string, string | undefined>;
  defaultSort: Sort;
  testId: string;
  emptyTitle?: string;
}) {
  const [location] = useMarketLocation();
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [sheet, setSheet] = useState(false);
  const sorts = base.q ? SORTS : SORTS.filter((option) => option.value !== "relevance");

  const url = useMemo(
    () =>
      `/api/market/products?${queryString({
        ...base,
        sort,
        period: sort === "best_selling" ? filters.period : undefined,
        minPrice: filters.minPrice || undefined,
        maxPrice: filters.maxPrice || undefined,
        discount: filters.discount || undefined,
        rating: filters.rating || undefined,
        condition: filters.condition || undefined,
        preorder: filters.preorder,
        inStock: filters.inStock,
        deliverTo: filters.deliverable ? location?.governorateKey : undefined,
        limit: 24,
      })}`,
    [base, sort, filters, location?.governorateKey]
  );
  const list = useMarketList<MarketProductCard>(url, "products");
  const active = Object.entries(filters).filter(
    ([name, value]) => name !== "period" && value !== "" && value !== false
  ).length;

  return (
    <section className="space-y-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setSheet(true)}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-text)]"
          data-testid="market-filters-open"
        >
          <SlidersHorizontal className="h-4 w-4" /> الفلاتر{" "}
          {active ? (
            <span className="rounded-full bg-[var(--codiq-accent)] px-1.5 text-[10px] text-[var(--codiq-surface)]">
              {active.toLocaleString("ar-IQ")}
            </span>
          ) : null}
        </button>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as Sort)}
          aria-label="رتّب حسب"
          className="rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text)]"
          data-testid="market-products-sort"
        >
          {sorts.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {list.failure ? (
        <p className="text-center text-sm text-[var(--codiq-danger)]">{list.failure}</p>
      ) : null}
      {!list.items && !list.failure ? (
        <p className="py-8 text-center text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {list.items?.length === 0 ? (
        <MarketEmptyState
          testId={`${testId}-empty`}
          icon={PackageSearch}
          title={emptyTitle ?? "لا توجد منتجات مطابقة"}
          body={active ? "جرّب إزالة بعض الفلاتر." : "جرّب كلمات أخرى أو تصفّح الفئات."}
          action={
            active ? (
              <button
                type="button"
                onClick={() => setFilters(EMPTY)}
                className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
              >
                مسح الفلاتر
              </button>
            ) : undefined
          }
        />
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        {list.items?.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
      {list.nextCursor ? (
        <button
          type="button"
          onClick={() => void list.loadMore()}
          disabled={list.loadingMore}
          className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]"
          data-testid={`${testId}-more`}
        >
          {list.loadingMore ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null}{" "}
          عرض المزيد
        </button>
      ) : null}
      {sheet ? (
        <FilterSheet
          filters={filters}
          sort={sort}
          deliverableLabel={location ? `يوصّل إلى ${location.governorateName}` : null}
          onApply={(next) => {
            setFilters(next);
            setSheet(false);
          }}
          onClose={() => setSheet(false)}
        />
      ) : null}
    </section>
  );
}

function FilterSheet({
  filters,
  sort,
  deliverableLabel,
  onApply,
  onClose,
}: {
  filters: Filters;
  sort: Sort;
  deliverableLabel: string | null;
  onApply: (next: Filters) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Filters>(filters);
  const set = (patch: Partial<Filters>) => setDraft({ ...draft, ...patch });
  const min = Number(draft.minPrice || 0);
  const max = Number(draft.maxPrice || 0);
  const priceError =
    draft.maxPrice && max <= 0
      ? "أعلى سعر يجب أن يكون أكبر من صفر"
      : draft.minPrice && draft.maxPrice && min > max
        ? "أقل سعر أكبر من أعلى سعر"
        : null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--codiq-text)]/40"
      role="dialog"
      aria-modal="true"
      aria-label="الفلاتر"
      onClick={onClose}
      data-testid="market-filter-sheet"
    >
      <div
        className="max-h-[88vh] w-full max-w-[560px] space-y-5 overflow-y-auto rounded-t-[28px] bg-[var(--codiq-surface)] p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-base font-black text-[var(--codiq-text)]">الفلاتر</p>
          <button
            type="button"
            aria-label="إغلاق"
            className="rounded-full p-2 text-[var(--codiq-text-muted)]"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {sort === "best_selling" ? (
          <Group title="الفترة">
            <Chips value={draft.period} options={PERIODS} onPick={(period) => set({ period })} />
          </Group>
        ) : null}
        <Group title="نطاق السعر (د.ع)">
          <div className="flex items-center gap-2">
            <input
              value={draft.minPrice}
              onChange={(event) => set({ minPrice: event.target.value.replace(/[^\d]/g, "") })}
              inputMode="numeric"
              placeholder="أقل سعر"
              className="w-full rounded-xl border border-[var(--codiq-border)] px-3 py-2 text-sm"
              data-testid="market-filter-min-price"
            />
            <span className="text-[var(--codiq-text-muted)]">–</span>
            <input
              value={draft.maxPrice}
              onChange={(event) => set({ maxPrice: event.target.value.replace(/[^\d]/g, "") })}
              inputMode="numeric"
              placeholder="أعلى سعر"
              className="w-full rounded-xl border border-[var(--codiq-border)] px-3 py-2 text-sm"
              data-testid="market-filter-max-price"
            />
          </div>
          {priceError ? (
            <p className="text-xs text-[var(--codiq-danger)]">{priceError}</p>
          ) : (
            <p className="text-[11px] text-[var(--codiq-text-muted)]">
              اتركه فارغاً لعرض كل الأسعار.
            </p>
          )}
        </Group>
        <Group title="الخصم">
          <Chips
            value={draft.discount}
            options={[
              { value: "", label: "الكل" },
              { value: "any", label: "عليها خصم" },
              { value: "30", label: "خصم +30%" },
              { value: "50", label: "خصم +50%" },
            ]}
            onPick={(discount) => set({ discount })}
            testId="market-filter-discount"
          />
        </Group>
        <Group title="التقييم">
          <Chips
            value={draft.rating}
            options={[
              { value: "", label: "كل التقييمات" },
              { value: "3", label: "٣ نجوم فأكثر" },
              { value: "excellent", label: "تقييم ممتاز" },
            ]}
            onPick={(rating) => set({ rating })}
          />
        </Group>
        <Group title="الحالة">
          <Chips
            value={draft.condition}
            options={[
              { value: "", label: "الكل" },
              { value: "new", label: "جديد" },
              { value: "used", label: "مستعمل" },
            ]}
            onPick={(condition) => set({ condition })}
          />
        </Group>
        <Group title="أخرى">
          <Toggle
            label="المتوفّر فقط"
            checked={draft.inStock}
            onChange={(inStock) => set({ inStock })}
          />
          <Toggle
            label="الطلب المسبق فقط"
            checked={draft.preorder}
            onChange={(preorder) => set({ preorder })}
          />
          {deliverableLabel ? (
            <Toggle
              label={deliverableLabel}
              checked={draft.deliverable}
              onChange={(deliverable) => set({ deliverable })}
              testId="market-filter-deliverable"
            />
          ) : (
            <p className="text-[11px] text-[var(--codiq-text-muted)]">
              اختر محافظتك من «التوصيل إلى» لعرض ما يوصَّل إليك فقط.
            </p>
          )}
        </Group>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={priceError !== null}
            onClick={() => onApply(draft)}
            className="flex-1 rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-bold text-[var(--codiq-surface)] disabled:opacity-50"
            data-testid="market-filter-apply"
          >
            تطبيق
          </button>
          <button
            type="button"
            onClick={() => onApply(EMPTY)}
            className="rounded-full border border-[var(--codiq-border)] px-5 py-3 text-sm font-bold text-[var(--codiq-text)]"
          >
            مسح
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-bold text-[var(--codiq-text)]">{title}</p>
      {children}
    </div>
  );
}

function Chips<T extends string>({
  value,
  options,
  onPick,
  testId,
}: {
  value: T;
  options: { value: T; label: string }[];
  onPick: (value: T) => void;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.value || "all"}
          type="button"
          onClick={() => onPick(option.value)}
          aria-pressed={value === option.value}
          className={`rounded-full border px-3 py-1.5 text-xs font-bold ${value === option.value ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "border-[var(--codiq-border)] text-[var(--codiq-text-secondary)]"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="flex items-center justify-between rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2.5 text-sm text-[var(--codiq-text)]">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
    </label>
  );
}

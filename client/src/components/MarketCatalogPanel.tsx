/**
 * «بيانات السوق» — how this store's products appear in the shared market:
 * which market category each store category belongs to, and per product the
 * price before discount, condition, tags, specifications, pre-order dates,
 * the per-order cap and paid add-ons.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type MarketNode = { id: number; slug: string; name: string; children: MarketNode[] };
type Mapping = { categories: { id: string; name: string; marketCategoryId: number | null }[]; marketCategories: MarketNode[] };
type Addon = { id?: string; name: string; priceIqd: number; isActive: boolean };
type Row = {
  id: string; name: string; priceIqd: number; isActive: boolean; storeCategory: string | null; effectiveMarketCategoryId: number | null;
  marketCategoryId: number | null; compareAtPriceIqd: number | null; condition: "new" | "used" | "refurbished"; tags: string[]; specs: { name: string; value: string }[];
  isPreorder: boolean; preorderReleaseOn: string | null; preorderShipsBy: string | null; maxPerOrder: number | null; instalmentsEligible: boolean; instalmentsCashPrice: boolean; addons: Addon[];
};

const TAGS: { code: string; label: string }[] = [
  { code: "original", label: "أصلي" }, { code: "imported", label: "مستورد" }, { code: "warranty", label: "مضمون" }, { code: "limited_edition", label: "إصدار محدود" },
  { code: "exclusive", label: "حصري" }, { code: "free_delivery", label: "توصيل مجاني" }, { code: "free_returns", label: "إرجاع مجاني" },
];

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

function CategorySelect({ tree, value, onChange, testId, emptyLabel }: { tree: MarketNode[]; value: number | null; onChange: (value: number | null) => void; testId?: string; emptyLabel: string }) {
  return (
    <select value={value ?? ""} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)} className="w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm" data-testid={testId}>
      <option value="">{emptyLabel}</option>
      {tree.map((root) => (
        <optgroup key={root.id} label={root.name}>
          <option value={root.id}>{root.name} (عامّ)</option>
          {root.children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function MarketCatalogPanel({ storeSlug }: { storeSlug?: string }) {
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/market-catalog` : null;
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (after?: string | null) => {
    if (!base) return;
    const page = await call<{ products: Row[]; nextCursor: string | null }>(`${base}/products?limit=25${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
    setRows((current) => (after ? [...(current ?? []), ...page.products] : page.products));
    setCursor(page.nextCursor);
  }, [base]);

  useEffect(() => {
    if (!base) return;
    call<Mapping>(`${base}/categories`).then(setMapping).catch((error: Error) => setFailure(error.message));
    load().catch((error: Error) => setFailure(error.message));
  }, [base, load]);

  if (!base) return <p className="text-sm text-[var(--codiq-text-muted)]">اختر متجراً أولاً.</p>;
  const tree = mapping?.marketCategories ?? [];
  const nameOf = (id: number | null) => (id === null ? null : tree.flatMap((root) => [root, ...root.children]).find((node) => node.id === id)?.name ?? null);

  const mapCategory = async (categoryId: string, marketCategoryId: number | null) => {
    setFailure(null); setNotice(null);
    try {
      await call(`${base}/categories/${categoryId}`, { method: "PUT", body: JSON.stringify({ marketCategoryId }) });
      setMapping((current) => current && { ...current, categories: current.categories.map((row) => (row.id === categoryId ? { ...row, marketCategoryId } : row)) });
      setNotice("رُبط التصنيف بفئة السوق.");
      await load();
    } catch (error) { setFailure((error as Error).message); }
  };

  return (
    <div className="max-w-[960px] space-y-5" data-testid="market-catalog-panel">
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="market-catalog-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]" data-testid="market-catalog-notice"><CircleCheck className="h-4 w-4" /> {notice}</p> : null}

      <section className="space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <p className="text-base font-bold text-[var(--codiq-text)]">ربط تصنيفاتك بفئات السوق</p>
        <p className="text-sm text-[var(--codiq-text-secondary)]">يبحث الزبون في السوق بفئات موحّدة لكل المتاجر. اربط كل تصنيف عندك بالفئة المناسبة، فتظهر منتجاته فيها.</p>
        {!mapping ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : mapping.categories.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا توجد تصنيفات في متجرك بعد. يمكنك اختيار فئة السوق لكل منتج مباشرة أدناه.</p> : (
          <ul className="space-y-2">
            {mapping.categories.map((row) => (
              <li key={row.id} className="grid items-center gap-2 sm:grid-cols-2">
                <span className="text-sm font-semibold text-[var(--codiq-text)]">{row.name}</span>
                <CategorySelect tree={tree} value={row.marketCategoryId} onChange={(value) => void mapCategory(row.id, value)} emptyLabel="غير مربوط" testId={`market-map-${row.id}`} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <p className="text-base font-bold text-[var(--codiq-text)]">منتجاتك في السوق</p>
        {!rows ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
        <ul className="divide-y divide-[var(--codiq-border)]">
          {rows?.map((row) => (
            <li key={row.id} className="py-3" data-testid={`market-catalog-row-${row.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[var(--codiq-text)]">{row.name}</p>
                  <p className="text-xs text-[var(--codiq-text-muted)]">
                    {row.priceIqd.toLocaleString("ar-IQ")} د.ع{row.compareAtPriceIqd ? ` · قبل الخصم ${row.compareAtPriceIqd.toLocaleString("ar-IQ")}` : ""} · {nameOf(row.effectiveMarketCategoryId) ?? <span className="font-semibold text-[var(--codiq-warning)]">بلا فئة في السوق</span>}
                    {row.isPreorder ? " · طلب مسبق" : ""}{row.addons.length ? ` · ${row.addons.length} إضافة` : ""}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setEditing(editing === row.id ? null : row.id)} data-testid={`market-catalog-edit-${row.id}`}>{editing === row.id ? "إغلاق" : "تعديل"}</Button>
              </div>
              {editing === row.id ? <ProductEditor base={base} row={row} tree={tree} onSaved={(next, message) => { setRows((current) => current?.map((other) => (other.id === next.id ? next : other)) ?? null); setNotice(message); setFailure(null); }} onError={(message) => { setFailure(message); setNotice(null); }} /> : null}
            </li>
          ))}
        </ul>
        {cursor ? <Button variant="outline" className="w-full" onClick={() => void load(cursor).catch((error: Error) => setFailure(error.message))}>عرض المزيد</Button> : null}
      </section>
    </div>
  );
}

function ProductEditor({ base, row, tree, onSaved, onError }: { base: string; row: Row; tree: MarketNode[]; onSaved: (row: Row, message: string) => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState({ ...row, compare: row.compareAtPriceIqd?.toString() ?? "", max: row.maxPerOrder?.toString() ?? "" });
  const [addons, setAddons] = useState<Addon[]>(row.addons);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      const fields = await call<{ product: Row }>(`${base}/products/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          marketCategoryId: draft.marketCategoryId,
          compareAtPriceIqd: draft.compare ? Number(draft.compare) : null,
          condition: draft.condition,
          tags: draft.tags,
          specs: draft.specs.filter((spec) => spec.name.trim() && spec.value.trim()),
          isPreorder: draft.isPreorder,
          preorderReleaseOn: draft.isPreorder ? draft.preorderReleaseOn || null : null,
          preorderShipsBy: draft.isPreorder ? draft.preorderShipsBy || null : null,
          maxPerOrder: draft.max ? Number(draft.max) : null,
          instalmentsEligible: draft.instalmentsEligible,
          instalmentsCashPrice: draft.instalmentsEligible && draft.instalmentsCashPrice,
        }),
      });
      const withAddons = await call<{ product: Row }>(`${base}/products/${row.id}/addons`, { method: "PUT", body: JSON.stringify({ addons: addons.filter((addon) => addon.name.trim()).map(({ name, priceIqd, isActive }) => ({ name, priceIqd, isActive })) }) });
      onSaved({ ...fields.product, addons: withAddons.product.addons }, `حُفظت بيانات «${row.name}» في السوق.`);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm";
  return (
    <div className="mt-3 space-y-4 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4" data-testid="market-product-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span className="font-semibold">فئة السوق</span>
          <CategorySelect tree={tree} value={draft.marketCategoryId} onChange={(value) => set({ marketCategoryId: value })} emptyLabel={row.storeCategory ? `كما في تصنيف «${row.storeCategory}»` : "بلا فئة"} testId="market-editor-category" />
        </label>
        <label className="space-y-1 text-sm"><span className="font-semibold">السعر قبل الخصم (د.ع)</span>
          <input value={draft.compare} onChange={(event) => set({ compare: event.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" placeholder={`أعلى من ${row.priceIqd.toLocaleString("ar-IQ")}`} className={input} data-testid="market-editor-compare" />
        </label>
        <label className="space-y-1 text-sm"><span className="font-semibold">الحالة</span>
          <select value={draft.condition} onChange={(event) => set({ condition: event.target.value as Row["condition"] })} className={input}>
            <option value="new">جديد</option><option value="used">مستعمل</option><option value="refurbished">مجدّد</option>
          </select>
        </label>
        <label className="space-y-1 text-sm"><span className="font-semibold">الحدّ الأقصى لكل طلب</span>
          <input value={draft.max} onChange={(event) => set({ max: event.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" placeholder="بلا حدّ" className={input} data-testid="market-editor-max" />
        </label>
      </div>
      <div className="space-y-2"><p className="text-sm font-semibold">شارات المنتج</p>
        <div className="flex flex-wrap gap-2">
          {TAGS.map((tag) => (
            <label key={tag.code} className="flex items-center gap-1 rounded-full bg-[var(--codiq-surface)] px-3 py-1.5 text-xs">
              <input type="checkbox" checked={draft.tags.includes(tag.code)} onChange={(event) => set({ tags: event.target.checked ? [...draft.tags, tag.code] : draft.tags.filter((code) => code !== tag.code) })} data-testid={`market-editor-tag-${tag.code}`} /> {tag.label}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-2">
<div className="flex flex-wrap gap-4" data-testid="market-editor-instalments">
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={draft.instalmentsEligible} onChange={(event) => set({ instalmentsEligible: event.target.checked, ...(event.target.checked ? {} : { instalmentsCashPrice: false }) })} data-testid="market-editor-instalments-eligible" /> متاح بالتقسيط</label>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" disabled={!draft.instalmentsEligible} checked={draft.instalmentsCashPrice} onChange={(event) => set({ instalmentsCashPrice: event.target.checked })} data-testid="market-editor-instalments-cash" /> أقساط بسعر الكاش (يتحمّل المتجر رسوم الجهة)</label>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={draft.isPreorder} onChange={(event) => set({ isPreorder: event.target.checked })} data-testid="market-editor-preorder" /> طلب مسبق (يُحجز قبل وصول الشحنة)</label>
        {draft.isPreorder ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs"><span>يصدر في</span><input type="date" value={draft.preorderReleaseOn ?? ""} onChange={(event) => set({ preorderReleaseOn: event.target.value || null })} className={input} /></label>
            <label className="space-y-1 text-xs"><span>يُشحن بحلول</span><input type="date" value={draft.preorderShipsBy ?? ""} onChange={(event) => set({ preorderShipsBy: event.target.value || null })} className={input} /></label>
          </div>
        ) : null}
      </div>
      <div className="space-y-2"><p className="text-sm font-semibold">المواصفات</p>
        {draft.specs.map((spec, index) => (
          <div key={index} className="flex gap-2">
            <input value={spec.name} onChange={(event) => set({ specs: draft.specs.map((other, at) => (at === index ? { ...other, name: event.target.value } : other)) })} placeholder="مثال: الذاكرة" maxLength={40} className={input} />
            <input value={spec.value} onChange={(event) => set({ specs: draft.specs.map((other, at) => (at === index ? { ...other, value: event.target.value } : other)) })} placeholder="256GB" maxLength={120} className={input} />
            <button type="button" aria-label="حذف" onClick={() => set({ specs: draft.specs.filter((_, at) => at !== index) })}><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
          </div>
        ))}
        {draft.specs.length < 30 ? <Button type="button" size="sm" variant="outline" onClick={() => set({ specs: [...draft.specs, { name: "", value: "" }] })} data-testid="market-editor-add-spec"><Plus className="h-4 w-4" /> مواصفة</Button> : null}
      </div>
      <div className="space-y-2"><p className="text-sm font-semibold">إضافات اختياريّة بسعر</p>
        {addons.map((addon, index) => (
          <div key={index} className="flex items-center gap-2">
            <input value={addon.name} onChange={(event) => setAddons(addons.map((other, at) => (at === index ? { ...other, name: event.target.value } : other)))} placeholder="مثال: تغليف هدية" maxLength={80} className={input} />
            <input value={addon.priceIqd || ""} onChange={(event) => setAddons(addons.map((other, at) => (at === index ? { ...other, priceIqd: Number(event.target.value.replace(/[^\d]/g, "")) || 0 } : other)))} inputMode="numeric" placeholder="السعر" className={`${input} w-32`} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={addon.isActive} onChange={(event) => setAddons(addons.map((other, at) => (at === index ? { ...other, isActive: event.target.checked } : other)))} /> مفعّلة</label>
            <button type="button" aria-label="حذف" onClick={() => setAddons(addons.filter((_, at) => at !== index))}><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
          </div>
        ))}
        {addons.length < 20 ? <Button type="button" size="sm" variant="outline" onClick={() => setAddons([...addons, { name: "", priceIqd: 0, isActive: true }])} data-testid="market-editor-add-addon"><Plus className="h-4 w-4" /> إضافة</Button> : null}
      </div>
      <Button onClick={() => void save()} disabled={busy} data-testid="market-editor-save">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} حفظ</Button>
    </div>
  );
}

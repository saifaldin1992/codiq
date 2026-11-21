/**
 * «محتوى السوق» — the owner edits the market's front page and its editorial
 * content: the order of the home blocks, scheduled banners (with their views
 * and taps), curated collections and discount events, malls, and the market
 * category tree. Everything saves through /api/platform/market/* (brand.manage).
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, ImagePlus, LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type Tab = "home" | "banners" | "collections" | "malls" | "categories";
const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "الواجهة" }, { id: "banners", label: "البنرات" }, { id: "collections", label: "المجموعات والخصومات" }, { id: "malls", label: "المولات" }, { id: "categories", label: "الفئات" },
];

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

const input = "w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm";
const card = "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
const fromLocal = (value: string) => (value ? new Date(value).toISOString() : null);

export function PlatformMarketContentPanel() {
  const [tab, setTab] = useState<Tab>("home");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const report = { ok: (message: string) => { setNotice(message); setFailure(null); }, fail: (message: string) => { setFailure(message); setNotice(null); } };
  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market-content">
      <div className="flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <button key={entry.id} type="button" onClick={() => { setTab(entry.id); setFailure(null); setNotice(null); }} aria-pressed={tab === entry.id} data-testid={`market-content-tab-${entry.id}`}
            className={`rounded-full px-3 py-1.5 text-sm font-bold ${tab === entry.id ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}>{entry.label}</button>
        ))}
        <a href="/market" target="_blank" rel="noopener noreferrer" className="self-center text-sm font-bold text-[var(--codiq-accent)]">افتح السوق</a>
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="market-content-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]" data-testid="market-content-notice"><CircleCheck className="h-4 w-4" /> {notice}</p> : null}
      {tab === "home" ? <HomeTab report={report} /> : tab === "banners" ? <BannersTab report={report} /> : tab === "collections" ? <CollectionsTab report={report} /> : tab === "malls" ? <MallsTab report={report} /> : <CategoriesTab report={report} />}
    </div>
  );
}

type Report = { ok: (message: string) => void; fail: (message: string) => void };

// ── the front page ───────────────────────────────────────────────────────────

type HomeSection = { kind: string; title: string | null; isActive: boolean; config: Record<string, unknown> };
const KIND_LABELS: Record<string, string> = { banners: "بنرات", categories: "الفئات", products: "قائمة منتجات", stores: "قائمة متاجر", collections: "المجموعات", malls: "المولات", recently_viewed: "شاهدته مؤخراً", for_you: "مقترح لك" };
const PRODUCT_PRESETS: { label: string; title: string; config: Record<string, unknown> }[] = [
  { label: "أفضل التخفيضات", title: "أفضل التخفيضات", config: { sort: "discount", discount: "any", section: "discounts" } },
  { label: "نصف السعر", title: "نصف السعر", config: { sort: "discount", discount: "50", section: "half-price" } },
  { label: "وصل حديثاً", title: "وصل حديثاً", config: { sort: "newest", section: "new" } },
  { label: "الأكثر شعبية", title: "الأكثر شعبية", config: { sort: "trending", section: "trending" } },
  { label: "الأكثر مبيعاً هذا الأسبوع", title: "الأكثر مبيعاً", config: { sort: "best_selling", period: "week", section: "best-sellers" } },
  { label: "ينفد قريباً", title: "ينفد قريباً", config: { sort: "best_selling", sellsFast: true, section: "sells-fast" } },
  { label: "الطلب المسبق", title: "احجزها قبل وصولها", config: { sort: "newest", preorder: true, section: "preorders" } },
  { label: "الأعلى تقييماً", title: "الأعلى تقييماً", config: { sort: "rating", section: "top-rated" } },
];

function HomeTab({ report }: { report: Report }) {
  const [sections, setSections] = useState<HomeSection[] | null>(null);
  const [preset, setPreset] = useState("0");
  useEffect(() => { call<{ sections: HomeSection[] }>("/api/platform/market/home-sections").then((body) => setSections(body.sections.map(({ kind, title, isActive, config }) => ({ kind, title, isActive, config })))).catch((error: Error) => report.fail(error.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!sections) return <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  const move = (at: number, by: number) => { const next = [...sections]; const [row] = next.splice(at, 1); next.splice(at + by, 0, row); setSections(next); };
  const patch = (at: number, change: Partial<HomeSection>) => setSections(sections.map((row, index) => (index === at ? { ...row, ...change } : row)));
  const add = (section: HomeSection) => setSections([...sections, section]);
  const save = () => call<{ sections: HomeSection[] }>("/api/platform/market/home-sections", { method: "PUT", body: JSON.stringify({ sections }) }).then(() => report.ok("حُفظت واجهة السوق.")).catch((error: Error) => report.fail(error.message));
  return (
    <section className={card} data-testid="market-content-home">
      <p className="text-sm text-[var(--codiq-text-secondary)]">رتّب كتل الصفحة الرئيسيّة كما يراها المتسوّق من الأعلى إلى الأسفل. الكتلة المطفأة لا تظهر.</p>
      <ul className="space-y-2">
        {sections.map((section, at) => (
          <li key={at} className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--codiq-surface-sunken)] p-2" data-testid={`market-home-block-${at}`}>
            <span className="w-24 text-xs font-bold text-[var(--codiq-text-secondary)]">{KIND_LABELS[section.kind] ?? section.kind}{section.kind === "banners" ? ` · ${String(section.config.placement) === "home_strip" ? "شريط" : "رئيسيّ"}` : ""}</span>
            {section.kind === "banners" ? <span className="flex-1" /> : <input value={section.title ?? ""} onChange={(event) => patch(at, { title: event.target.value })} className={`${input} flex-1`} aria-label="عنوان الكتلة" />}
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={section.isActive} onChange={(event) => patch(at, { isActive: event.target.checked })} /> ظاهرة</label>
            <button type="button" aria-label="أعلى" disabled={at === 0} onClick={() => move(at, -1)}><ArrowUp className="h-4 w-4" /></button>
            <button type="button" aria-label="أسفل" disabled={at === sections.length - 1} onClick={() => move(at, 1)}><ArrowDown className="h-4 w-4" /></button>
            <button type="button" aria-label="حذف" onClick={() => setSections(sections.filter((_, index) => index !== at))}><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <select value={preset} onChange={(event) => setPreset(event.target.value)} className={`${input} w-auto`} aria-label="قائمة منتجات جاهزة">
          {PRODUCT_PRESETS.map((row, index) => <option key={row.label} value={index}>{row.label}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => { const row = PRODUCT_PRESETS[Number(preset)]; add({ kind: "products", title: row.title, isActive: true, config: row.config }); }}><Plus className="h-4 w-4" /> قائمة منتجات</Button>
        <Button size="sm" variant="outline" onClick={() => add({ kind: "banners", title: null, isActive: true, config: { placement: "home_strip" } })}><Plus className="h-4 w-4" /> شريط بنرات</Button>
        <Button size="sm" variant="outline" onClick={() => add({ kind: "stores", title: "سفراء السوق", isActive: true, config: { sort: "recommended", ambassador: true } })}><Plus className="h-4 w-4" /> متاجر</Button>
        <Button size="sm" variant="outline" onClick={() => add({ kind: "collections", title: "مجموعات مختارة", isActive: true, config: {} })}><Plus className="h-4 w-4" /> مجموعات</Button>
        <Button size="sm" variant="outline" onClick={() => add({ kind: "malls", title: "المولات", isActive: true, config: {} })}><Plus className="h-4 w-4" /> مولات</Button>
      </div>
      <Button onClick={() => void save()} data-testid="market-home-save">حفظ الترتيب</Button>
    </section>
  );
}

// ── banners ──────────────────────────────────────────────────────────────────

type Banner = { id: string; placement: string; title: string; subtitle: string | null; imageUrl: string | null; linkKind: string; linkTarget: string | null; startsAt: string | null; endsAt: string | null; sortOrder: number; isActive: boolean; isAd: boolean; views: number; clicks: number };
const PLACEMENTS: Record<string, string> = { home_hero: "الرئيسيّة — أعلى", home_strip: "الرئيسيّة — شريط", categories_top: "الفئات", search_top: "البحث" };
const LINKS: Record<string, string> = { none: "بلا رابط", store: "متجر (الرابط المختصر)", product: "منتج (المعرّف)", category: "فئة (الرابط)", collection: "مجموعة (الرابط)", mall: "مول (الرابط)", section: "قسم", search: "بحث (كلمة)" };
const EMPTY_BANNER = { placement: "home_hero", title: "", subtitle: "", linkKind: "none", linkTarget: "", startsAt: "", endsAt: "", sortOrder: 0, isActive: true, isAd: false };

function BannersTab({ report }: { report: Report }) {
  const [rows, setRows] = useState<Banner[] | null>(null);
  const [draft, setDraft] = useState<typeof EMPTY_BANNER & { id?: string }>(EMPTY_BANNER);
  const load = useCallback(() => call<{ banners: Banner[] }>("/api/platform/market/banners").then((body) => setRows(body.banners)).catch((error: Error) => report.fail(error.message)), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    const body = JSON.stringify({ placement: draft.placement, title: draft.title, subtitle: draft.subtitle.trim() || null, linkKind: draft.linkKind, linkTarget: draft.linkKind === "none" ? null : draft.linkTarget.trim() || null, startsAt: fromLocal(draft.startsAt), endsAt: fromLocal(draft.endsAt), sortOrder: draft.sortOrder, isActive: draft.isActive, isAd: draft.isAd });
    try {
      await call(draft.id ? `/api/platform/market/banners/${draft.id}` : "/api/platform/market/banners", { method: draft.id ? "PUT" : "POST", body });
      report.ok(draft.id ? "حُدّث البنر." : "أُضيف البنر.");
      setDraft(EMPTY_BANNER);
      await load();
    } catch (error) { report.fail((error as Error).message); }
  };
  const upload = async (id: string, file: File | undefined) => {
    if (!file) return;
    const form = new FormData(); form.append("image", file);
    try { await call(`/api/platform/market/banners/${id}/image`, { method: "POST", body: form }); report.ok("رُفعت الصورة."); await load(); } catch (error) { report.fail((error as Error).message); }
  };
  const remove = async (id: string) => { if (!window.confirm("حذف البنر نهائياً؟")) return; try { await call(`/api/platform/market/banners/${id}`, { method: "DELETE" }); report.ok("حُذف البنر."); await load(); } catch (error) { report.fail((error as Error).message); } };
  return (
    <div className="space-y-4" data-testid="market-content-banners">
      <section className={card}>
        <p className="text-base font-bold text-[var(--codiq-text)]">{draft.id ? "تعديل بنر" : "بنر جديد"}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="العنوان" maxLength={80} className={input} data-testid="banner-title" />
          <input value={draft.subtitle} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} placeholder="سطر ثانٍ (اختياريّ)" maxLength={140} className={input} />
          <select value={draft.placement} onChange={(event) => setDraft({ ...draft, placement: event.target.value })} className={input}>{Object.entries(PLACEMENTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <div className="flex gap-2">
            <select value={draft.linkKind} onChange={(event) => setDraft({ ...draft, linkKind: event.target.value })} className={input} data-testid="banner-link-kind">{Object.entries(LINKS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {draft.linkKind !== "none" ? <input value={draft.linkTarget} onChange={(event) => setDraft({ ...draft, linkTarget: event.target.value })} placeholder={draft.linkKind === "section" ? "discounts" : "الوجهة"} className={input} dir="ltr" data-testid="banner-link-target" /> : null}
          </div>
          <label className="space-y-1 text-xs"><span>يبدأ (اختياريّ)</span><input type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} className={input} /></label>
          <label className="space-y-1 text-xs"><span>ينتهي (اختياريّ)</span><input type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} className={input} /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /> مفعّل</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.isAd} onChange={(event) => setDraft({ ...draft, isAd: event.target.checked })} /> إعلان مدفوع (تظهر عليه كلمة «إعلان»)</label>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void save()} disabled={!draft.title.trim()} data-testid="banner-save">{draft.id ? "حفظ" : "إضافة"}</Button>
          {draft.id ? <Button variant="outline" onClick={() => setDraft(EMPTY_BANNER)}>إلغاء</Button> : null}
        </div>
      </section>
      <ul className="space-y-2">
        {rows?.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3" data-testid={`banner-row-${row.id}`}>
            <div className="h-14 w-28 overflow-hidden rounded-xl bg-[var(--codiq-accent-soft)]">{row.imageUrl ? <img src={row.imageUrl} alt="" className="h-full w-full object-cover" /> : null}</div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-[var(--codiq-text)]">{row.title} {row.isActive ? "" : <span className="text-xs text-[var(--codiq-text-muted)]">· مطفأ</span>}</p>
              <p className="text-xs text-[var(--codiq-text-muted)]">{PLACEMENTS[row.placement]} · {LINKS[row.linkKind]}{row.linkTarget ? `: ${row.linkTarget}` : ""} · {row.views.toLocaleString("ar-IQ")} مشاهدة · {row.clicks.toLocaleString("ar-IQ")} نقرة</p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]"><ImagePlus className="h-4 w-4" /> صورة<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void upload(row.id, event.target.files?.[0])} /></label>
            <Button size="sm" variant="outline" onClick={() => setDraft({ id: row.id, placement: row.placement, title: row.title, subtitle: row.subtitle ?? "", linkKind: row.linkKind, linkTarget: row.linkTarget ?? "", startsAt: toLocal(row.startsAt), endsAt: toLocal(row.endsAt), sortOrder: row.sortOrder, isActive: row.isActive, isAd: row.isAd })}>تعديل</Button>
            <button type="button" aria-label="حذف" onClick={() => void remove(row.id)}><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── collections ──────────────────────────────────────────────────────────────

type CollectionRow = { id: string; slug: string; kind: string; title: string; subtitle: string | null; headlineDiscountPercent: number | null; startsAt: string | null; endsAt: string | null; sortOrder: number; isActive: boolean; items: { productId: string; name: string; storeName: string }[] };
type Found = { id: string; name: string; store: { name: string } };

function ProductPicker({ onPick }: { onPick: (product: Found) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const search = () => { if (query.trim().length >= 2) call<{ products: Found[] }>(`/api/market/products?q=${encodeURIComponent(query.trim())}&limit=10`).then((body) => setFound(body.products)).catch(() => setFound([])); };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }} placeholder="ابحث عن منتج في السوق لإضافته" className={input} data-testid="collection-product-search" />
        <Button size="sm" variant="outline" onClick={search}><Search className="h-4 w-4" /></Button>
      </div>
      {found.length ? <ul className="space-y-1">{found.map((product) => <li key={product.id}><button type="button" onClick={() => onPick(product)} className="w-full rounded-lg bg-[var(--codiq-surface-sunken)] px-3 py-1.5 text-right text-xs" data-testid={`collection-pick-${product.id}`}>+ {product.name} · {product.store.name}</button></li>)}</ul> : null}
    </div>
  );
}

const EMPTY_COLLECTION = { slug: "", kind: "collection", title: "", subtitle: "", headline: "", startsAt: "", endsAt: "", isActive: true };

function CollectionsTab({ report }: { report: Report }) {
  const [rows, setRows] = useState<CollectionRow[] | null>(null);
  const [draft, setDraft] = useState<typeof EMPTY_COLLECTION & { id?: string }>(EMPTY_COLLECTION);
  const [items, setItems] = useState<{ productId: string; name: string }[]>([]);
  const load = useCallback(() => call<{ collections: CollectionRow[] }>("/api/platform/market/collections").then((body) => setRows(body.collections)).catch((error: Error) => report.fail(error.message)), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    const body = JSON.stringify({ slug: draft.slug.trim(), kind: draft.kind, title: draft.title, subtitle: draft.subtitle.trim() || null, headlineDiscountPercent: draft.headline ? Number(draft.headline) : null, startsAt: fromLocal(draft.startsAt), endsAt: fromLocal(draft.endsAt), sortOrder: 0, isActive: draft.isActive });
    try {
      const saved = await call<{ collection: CollectionRow }>(draft.id ? `/api/platform/market/collections/${draft.id}` : "/api/platform/market/collections", { method: draft.id ? "PUT" : "POST", body });
      await call(`/api/platform/market/collections/${saved.collection.id}/items`, { method: "PUT", body: JSON.stringify({ productIds: items.map((item) => item.productId) }) });
      report.ok("حُفظت المجموعة.");
      setDraft(EMPTY_COLLECTION); setItems([]);
      await load();
    } catch (error) { report.fail((error as Error).message); }
  };
  return (
    <div className="space-y-4" data-testid="market-content-collections">
      <section className={card}>
        <p className="text-base font-bold text-[var(--codiq-text)]">{draft.id ? "تعديل مجموعة" : "مجموعة أو خصم جديد"}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="العنوان" className={input} data-testid="collection-title" />
          <input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase() })} placeholder="الرابط: summer-phones" className={input} dir="ltr" disabled={Boolean(draft.id)} data-testid="collection-slug" />
          <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })} className={input}><option value="collection">مجموعة مختارة</option><option value="discount">حدث خصومات</option></select>
          <input value={draft.headline} onChange={(event) => setDraft({ ...draft, headline: event.target.value.replace(/[^\d]/g, "") })} placeholder="«خصومات لحدّ» ٪ (اختياريّ)" className={input} />
          <input value={draft.subtitle} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} placeholder="وصف قصير (اختياريّ)" className={`${input} sm:col-span-2`} />
          <label className="space-y-1 text-xs"><span>يبدأ</span><input type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} className={input} /></label>
          <label className="space-y-1 text-xs"><span>ينتهي (يظهر عدّاد تنازليّ)</span><input type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} className={input} /></label>
        </div>
        <ProductPicker onPick={(product) => setItems(items.some((item) => item.productId === product.id) ? items : [...items, { productId: product.id, name: product.name }])} />
        <ul className="space-y-1" data-testid="collection-items">{items.map((item) => <li key={item.productId} className="flex justify-between rounded-lg bg-[var(--codiq-surface-sunken)] px-3 py-1.5 text-xs">{item.name}<button type="button" aria-label="إزالة" onClick={() => setItems(items.filter((other) => other.productId !== item.productId))}><Trash2 className="h-3.5 w-3.5 text-[var(--codiq-danger)]" /></button></li>)}</ul>
        <div className="flex gap-2">
          <Button onClick={() => void save()} disabled={!draft.title.trim() || !draft.slug.trim()} data-testid="collection-save">حفظ</Button>
          {draft.id ? <Button variant="outline" onClick={() => { setDraft(EMPTY_COLLECTION); setItems([]); }}>إلغاء</Button> : null}
        </div>
      </section>
      <ul className="space-y-2">
        {rows?.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3">
            <div><p className="text-sm font-bold text-[var(--codiq-text)]">{row.title} <span className="text-xs font-normal text-[var(--codiq-text-muted)]" dir="ltr">/{row.slug}</span></p><p className="text-xs text-[var(--codiq-text-muted)]">{row.kind === "discount" ? "خصومات" : "مجموعة"} · {row.items.length} منتج{row.endsAt ? ` · حتى ${new Date(row.endsAt).toLocaleString("ar-IQ")}` : ""}{row.isActive ? "" : " · مطفأة"}</p></div>
            <div className="flex gap-2">
              <a href={`/market/collection/${row.slug}`} target="_blank" rel="noopener noreferrer" className="self-center text-xs font-bold text-[var(--codiq-accent)]">عرض</a>
              <Button size="sm" variant="outline" onClick={() => { setDraft({ id: row.id, slug: row.slug, kind: row.kind, title: row.title, subtitle: row.subtitle ?? "", headline: row.headlineDiscountPercent?.toString() ?? "", startsAt: toLocal(row.startsAt), endsAt: toLocal(row.endsAt), isActive: row.isActive }); setItems(row.items.map((item) => ({ productId: item.productId, name: item.name }))); }}>تعديل</Button>
              <button type="button" aria-label="حذف" onClick={() => { if (window.confirm("حذف المجموعة؟")) void call(`/api/platform/market/collections/${row.id}`, { method: "DELETE" }).then(() => { report.ok("حُذفت."); return load(); }).catch((error: Error) => report.fail(error.message)); }}><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── malls ────────────────────────────────────────────────────────────────────

type MallRow = { id: string; slug: string; name: string; description: string | null; sortOrder: number; isActive: boolean; stores: { slug: string; name: string; listed: boolean }[] };
const EMPTY_MALL = { slug: "", name: "", description: "", isActive: true };

function MallsTab({ report }: { report: Report }) {
  const [rows, setRows] = useState<MallRow[] | null>(null);
  const [draft, setDraft] = useState<typeof EMPTY_MALL & { id?: string }>(EMPTY_MALL);
  const [stores, setStores] = useState<{ slug: string; name: string }[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ slug: string; name: string }[]>([]);
  const load = useCallback(() => call<{ malls: MallRow[] }>("/api/platform/market/malls").then((body) => setRows(body.malls)).catch((error: Error) => report.fail(error.message)), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const search = () => { if (query.trim()) call<{ stores: { slug: string; name: string }[] }>(`/api/market/stores?q=${encodeURIComponent(query.trim())}&limit=10`).then((body) => setFound(body.stores)).catch(() => setFound([])); };
  const save = async () => {
    try {
      const saved = await call<{ mall: MallRow }>(draft.id ? `/api/platform/market/malls/${draft.id}` : "/api/platform/market/malls", { method: draft.id ? "PUT" : "POST", body: JSON.stringify({ slug: draft.slug.trim(), name: draft.name, description: draft.description.trim() || null, sortOrder: 0, isActive: draft.isActive }) });
      await call(`/api/platform/market/malls/${saved.mall.id}/stores`, { method: "PUT", body: JSON.stringify({ storeSlugs: stores.map((store) => store.slug) }) });
      report.ok("حُفظ المول."); setDraft(EMPTY_MALL); setStores([]); await load();
    } catch (error) { report.fail((error as Error).message); }
  };
  return (
    <div className="space-y-4" data-testid="market-content-malls">
      <section className={card}>
        <div className="grid gap-3 sm:grid-cols-2">
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="اسم المول" className={input} data-testid="mall-name" />
          <input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase() })} placeholder="الرابط: electronics-mall" className={input} dir="ltr" disabled={Boolean(draft.id)} data-testid="mall-slug" />
          <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="وصف (اختياريّ)" className={`${input} sm:col-span-2`} />
        </div>
        <div className="flex gap-2">
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }} placeholder="ابحث عن متجر في السوق لإضافته" className={input} />
          <Button size="sm" variant="outline" onClick={search}><Search className="h-4 w-4" /></Button>
        </div>
        {found.length ? <ul className="space-y-1">{found.map((store) => <li key={store.slug}><button type="button" onClick={() => setStores(stores.some((other) => other.slug === store.slug) ? stores : [...stores, store])} className="w-full rounded-lg bg-[var(--codiq-surface-sunken)] px-3 py-1.5 text-right text-xs">+ {store.name}</button></li>)}</ul> : null}
        <ul className="space-y-1">{stores.map((store) => <li key={store.slug} className="flex justify-between rounded-lg bg-[var(--codiq-surface-sunken)] px-3 py-1.5 text-xs">{store.name}<button type="button" aria-label="إزالة" onClick={() => setStores(stores.filter((other) => other.slug !== store.slug))}><Trash2 className="h-3.5 w-3.5 text-[var(--codiq-danger)]" /></button></li>)}</ul>
        <div className="flex gap-2"><Button onClick={() => void save()} disabled={!draft.name.trim() || !draft.slug.trim()}>حفظ</Button>{draft.id ? <Button variant="outline" onClick={() => { setDraft(EMPTY_MALL); setStores([]); }}>إلغاء</Button> : null}</div>
      </section>
      <ul className="space-y-2">
        {rows?.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3">
            <div><p className="text-sm font-bold text-[var(--codiq-text)]">{row.name}</p><p className="text-xs text-[var(--codiq-text-muted)]">{row.stores.length} متجر{row.stores.some((store) => !store.listed) ? ` · ${row.stores.filter((store) => !store.listed).length} خارج السوق لا تظهر` : ""}</p></div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { setDraft({ id: row.id, slug: row.slug, name: row.name, description: row.description ?? "", isActive: row.isActive }); setStores(row.stores.map(({ slug, name }) => ({ slug, name }))); }}>تعديل</Button>
              <button type="button" aria-label="حذف" onClick={() => { if (window.confirm("حذف المول؟")) void call(`/api/platform/market/malls/${row.id}`, { method: "DELETE" }).then(() => { report.ok("حُذف."); return load(); }).catch((error: Error) => report.fail(error.message)); }}><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── categories ───────────────────────────────────────────────────────────────

type CategoryRow = { id: number; slug: string; nameAr: string; parentId: number | null; sortOrder: number; isActive: boolean };

function CategoriesTab({ report }: { report: Report }) {
  const [rows, setRows] = useState<CategoryRow[] | null>(null);
  const [draft, setDraft] = useState({ slug: "", name: "", parentId: "" });
  const load = useCallback(() => call<{ categories: CategoryRow[] }>("/api/platform/market/categories").then((body) => setRows(body.categories)).catch((error: Error) => report.fail(error.message)), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const roots = rows?.filter((row) => row.parentId === null) ?? [];
  const update = (row: CategoryRow, change: Partial<CategoryRow>) => {
    const next = { ...row, ...change };
    void call(`/api/platform/market/categories/${row.id}`, { method: "PUT", body: JSON.stringify({ name: next.nameAr, parentId: next.parentId, sortOrder: next.sortOrder, isActive: next.isActive }) }).then(() => { report.ok("حُدّثت الفئة."); return load(); }).catch((error: Error) => report.fail(error.message));
  };
  const create = () => void call("/api/platform/market/categories", { method: "POST", body: JSON.stringify({ slug: draft.slug.trim(), name: draft.name.trim(), parentId: draft.parentId ? Number(draft.parentId) : null, sortOrder: 100 }) }).then(() => { report.ok("أُضيفت الفئة."); setDraft({ slug: "", name: "", parentId: "" }); return load(); }).catch((error: Error) => report.fail(error.message));
  return (
    <div className="space-y-4" data-testid="market-content-categories">
      <section className={card}>
        <p className="text-base font-bold text-[var(--codiq-text)]">فئة جديدة</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="الاسم" className={input} />
          <input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase() })} placeholder="الرابط: pets" className={input} dir="ltr" />
          <select value={draft.parentId} onChange={(event) => setDraft({ ...draft, parentId: event.target.value })} className={input}><option value="">فئة رئيسيّة</option>{roots.map((root) => <option key={root.id} value={root.id}>تحت: {root.nameAr}</option>)}</select>
        </div>
        <Button onClick={create} disabled={!draft.name.trim() || !draft.slug.trim()}>إضافة</Button>
      </section>
      <ul className="space-y-2">
        {roots.map((root) => (
          <li key={root.id} className="space-y-1 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3">
            <CategoryLine row={root} onChange={update} />
            <ul className="space-y-1 pr-6">{rows?.filter((row) => row.parentId === root.id).map((child) => <li key={child.id}><CategoryLine row={child} onChange={update} /></li>)}</ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CategoryLine({ row, onChange }: { row: CategoryRow; onChange: (row: CategoryRow, change: Partial<CategoryRow>) => void }) {
  const [name, setName] = useState(row.nameAr);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <input value={name} onChange={(event) => setName(event.target.value)} onBlur={() => { if (name.trim() && name !== row.nameAr) onChange(row, { nameAr: name.trim() }); }} className={`${input} w-56`} aria-label="اسم الفئة" />
      <span className="text-xs text-[var(--codiq-text-muted)]" dir="ltr">/{row.slug}</span>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={row.isActive} onChange={(event) => onChange(row, { isActive: event.target.checked })} /> ظاهرة</label>
    </div>
  );
}

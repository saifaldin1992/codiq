/**
 * ق-204 — the merchant's home, in the reference dashboard's arrangement and
 * the platform's own colours: the verification banner, a dismissible promo,
 * the store's identity strip with its balance and share button, four headline
 * numbers compared with yesterday, «ماذا يحدث اليوم؟», the key indicators over
 * a date range, the latest orders, and a side column with the balance, the
 * store's address and the settings. One request feeds all of it (ق-202).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, BadgeCheck, Banknote, BarChart3, Boxes, CalendarDays, Check, Clock3, Copy, ExternalLink, Eye, LayoutTemplate, LoaderCircle, MapPin, Settings2, Share2, ShoppingBag, Sparkles, TrendingDown, TrendingUp, Truck, Users, Wallet, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MerchantOnboarding } from "@/components/MerchantOnboarding";

type DaySummary = { day: string; salesIqd: number; ordersCount: number; visits: number; visitors: number; conversionPct: number | null };
type Home = {
  store: { name: string; slug: string; defaultSubdomain: string; customDomain: string | null; verifiedAt: string | null; addressLine: string | null; city: string | null; supportPhone: string | null; guestCheckoutEnabled: boolean; hasLogo: boolean };
  today: DaySummary; yesterday: DaySummary;
  range: { from: string; to: string };
  byStatus: { status: string; count: number; totalIqd: number }[];
  byPaymentMethod: { code: string; count: number; totalIqd: number }[];
  byHour: { hour: number; count: number }[];
  topProducts: { productId: string; name: string; units: number; revenueIqd: number }[];
  mostViewed: { productId: string; name: string; views: number }[];
  lowStock: { count: number; products: { id: string; name: string; stockQuantity: number; lowStockThreshold: number }[] };
  /** null for staff: the wallet is the merchant's, across all his stores (audit 14-أ). */
  wallet: { pendingNetIqd: number; pendingOrders: number; lastSettlement: { id: string; periodTo: string; netPayoutIqd: number; createdAt: string } | null } | null;
  recentOrders: { id: string; orderNumber: string; status: string; totalIqd: number; customerName: string; createdAt: string; paymentMethodCode: string; paymentStatus: string }[];
};

const number = new Intl.NumberFormat("ar-IQ");
const money = (value: number) => `${number.format(value)} د.ع`;
const STATUS_LABEL: Record<string, string> = { new: "جديد", processing: "قيد المعالجة", preparation: "قيد التجهيز", out_for_delivery: "قيد التوصيل", completed: "مكتمل", cancelled: "ملغى", rejected: "مرفوض", returned: "مرتجع" };
const PAYMENT_LABEL: Record<string, string> = { cod: "الدفع عند الاستلام", zaincash: "زين كاش", asiahawala: "آسيا حوالة", fib: "FIB", cash: "نقداً (الكاشير)", legacy: "—", market_card: "بطاقة (السوق)", market_instalments: "أقساط (السوق)" };
const PAYMENT_STATUS_LABEL: Record<string, string> = { unpaid: "غير مدفوع", paid: "مدفوع", awaiting_transfer: "بانتظار التحويل", awaiting_payment: "بانتظار الدفع", instalments: "بالأقساط", refunded: "أُعيد المبلغ" };
const PROMO_KEY = "codiq:merchant-home:promo:v1";

function baghdadDate(offsetDays = 0): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function rangeQuery(from: string, to: string) {
  return `from=${encodeURIComponent(`${from}T00:00:00+03:00`)}&to=${encodeURIComponent(`${to}T23:59:59+03:00`)}`;
}

/** «مقارنة بالأمس» — a ratio, or an honest word when there is nothing to compare with. */
function Delta({ today, yesterday, invert = false }: { today: number; yesterday: number; invert?: boolean }) {
  if (yesterday === 0 && today === 0) return <span className="text-[11px] font-semibold text-[var(--codiq-text-muted)]">لا شيء أمس ولا اليوم</span>;
  if (yesterday === 0) return <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--codiq-success)]"><TrendingUp className="h-3 w-3" />جديد اليوم — لا شيء أمس</span>;
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  if (pct === 0) return <span className="text-[11px] font-semibold text-[var(--codiq-text-muted)]">كالأمس تماماً</span>;
  const up = pct > 0;
  const good = invert ? !up : up;
  return <span className={`inline-flex items-center gap-1 text-[11px] font-bold ${good ? "text-[var(--codiq-success)]" : "text-[var(--codiq-danger)]"}`}>{up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{number.format(Math.abs(pct))}٪ مقارنة بالأمس</span>;
}

function Kpi({ label, value, icon: Icon, children, testId }: { label: string; value: string; icon: LucideIcon; children: React.ReactNode; testId: string }) {
  return (
    <article data-testid={testId} className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
      <div className="flex items-center justify-between"><p className="text-xs font-bold text-[var(--codiq-text-secondary)]">{label}</p><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Icon className="h-4 w-4" strokeWidth={1.9} /></span></div>
      <p className="mt-3 text-2xl font-black tabular-nums tracking-[-0.02em] text-[var(--codiq-text)]">{value}</p>
      <div className="mt-2">{children}</div>
    </article>
  );
}

function Bars({ rows, empty }: { rows: { label: string; count: number; hint?: string }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  if (!rows.length) return <p className="text-xs text-[var(--codiq-text-muted)]">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="text-xs">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold text-[var(--codiq-text)]">{row.label}</span><span className="tabular-nums text-[var(--codiq-text-muted)]">{number.format(row.count)}{row.hint ? ` · ${row.hint}` : ""}</span></div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--codiq-neutral-soft)]"><div className="h-full rounded-full bg-[var(--codiq-accent)]" style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

function Panel({ title, hint, children, testId }: { title: string; hint: string; children: React.ReactNode; testId?: string }) {
  return <section data-testid={testId} className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm"><h3 className="text-sm font-black text-[var(--codiq-text)]">{title}</h3><p className="mt-0.5 text-[11px] text-[var(--codiq-text-muted)]">{hint}</p><div className="mt-4">{children}</div></section>;
}

export function MerchantHome({ storeSlug, navigate }: { storeSlug?: string; navigate: (path: string) => void }) {
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(() => baghdadDate(-6));
  const [to, setTo] = useState(() => baghdadDate(0));
  const [promo, setPromo] = useState(() => { try { return localStorage.getItem(PROMO_KEY) !== "dismissed"; } catch { return true; } });
  const [copied, setCopied] = useState(false);
  const dashboard = (path: string) => (storeSlug ? `/merchant/stores/${encodeURIComponent(storeSlug)}/dashboard${path}` : `/merchant/dashboard${path}`);

  const load = useCallback(async () => {
    if (!storeSlug) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/dashboard/home?${rangeQuery(from, to)}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
      setHome(body.home as Home);
      setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر تحميل الرئيسية."); }
    finally { setLoading(false); }
  }, [storeSlug, from, to]);
  useEffect(() => { void load(); }, [load]);

  const storeUrl = useMemo(() => (storeSlug && typeof window !== "undefined" ? `${window.location.origin}/store/${storeSlug}` : ""), [storeSlug]);
  const todayLabel = useMemo(() => new Intl.DateTimeFormat("ar-IQ", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Baghdad" }).format(new Date()), []);
  async function share() {
    if (!storeUrl) return;
    try {
      if (navigator.share) { await navigator.share({ title: home?.store.name ?? storeSlug, url: storeUrl }); return; }
      await navigator.clipboard.writeText(storeUrl);
      setCopied(true); window.setTimeout(() => setCopied(false), 2000);
    } catch { /* the shopper cancelled the sheet, or the clipboard is not available */ }
  }
  function dismissPromo() { setPromo(false); try { localStorage.setItem(PROMO_KEY, "dismissed"); } catch { /* private mode */ } }

  if (!storeSlug) return <div className="max-w-[640px] rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-canvas)] px-4 py-3 text-sm leading-6 text-[var(--codiq-text-secondary)]" dir="rtl">اختر متجراً عبر مبدّل المتاجر لعرض رئيسيته.</div>;
  if (error && !home) return <div role="alert" className="rounded-2xl border border-[var(--codiq-danger-border)] bg-[var(--codiq-danger-soft)] p-4 text-sm text-[var(--codiq-danger)]" dir="rtl">{error} <Button type="button" variant="outline" size="sm" className="mr-2" onClick={() => void load()}>إعادة المحاولة</Button></div>;
  if (!home) return <div className="flex items-center gap-2 text-sm text-[var(--codiq-text-muted)]" dir="rtl"><LoaderCircle className="h-4 w-4 animate-spin" />جارٍ تحميل رئيسية المتجر…</div>;

  const { store, today, yesterday } = home;
  const newToday = home.recentOrders.filter((order) => order.status === "new" && order.createdAt.slice(0, 10) === today.day).length;
  const awaitingTransfer = home.recentOrders.filter((order) => order.paymentStatus === "awaiting_transfer").length;
  const hourMax = Math.max(1, ...home.byHour.map((row) => row.count));

  return (
    <div className="space-y-5" dir="rtl" data-testid="merchant-home">
      {!store.verifiedAt ? (
        <div data-testid="home-verify-banner" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-warning-soft)] px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-[var(--codiq-warning)]"><BadgeCheck className="h-5 w-5" /><span className="font-bold">وثّق متجرك</span><span className="text-[var(--codiq-text-secondary)]">أكمل بيانات التواصل والعنوان في واجهة المتجر؛ يمنح فريق Codiq شارة التوثيق بعد مراجعتها.</span></div>
          <Button type="button" size="sm" className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" onClick={() => navigate(dashboard("/settings/storefront"))}>أكمل البيانات</Button>
        </div>
      ) : null}
      {promo ? (
        <div data-testid="home-promo" className="relative overflow-hidden rounded-[24px] border border-[var(--codiq-accent-soft)] bg-[linear-gradient(120deg,var(--codiq-accent-soft),var(--codiq-surface))] p-5">
          <button type="button" aria-label="إخفاء إعلان واجهة المتجر" onClick={dismissPromo} className="absolute left-3 top-3 rounded-full p-1 text-[var(--codiq-text-muted)] hover:bg-white/70"><X className="h-4 w-4" /></button>
          <p className="inline-flex items-center gap-1.5 rounded-full bg-[var(--codiq-surface)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent)]"><Sparkles className="h-3.5 w-3.5" />وصل للتو</p>
          <h2 className="mt-3 text-lg font-black text-[var(--codiq-text)]">واجهة متجرك… بنسخة جديدة</h2>
          <p className="mt-1 max-w-2xl text-sm leading-7 text-[var(--codiq-text-secondary)]">ارفع صورك الكبيرة، اكتب إعلانك، رتّب أقسام الرئيسية، أضف تواصلك وسياساتك — وكل تعديل يظهر في متجرك فوراً.</p>
          <Button type="button" className="mt-4 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" onClick={() => navigate(dashboard("/settings/storefront"))}><LayoutTemplate className="ml-2 h-4 w-4" />خلّينا نجرّب</Button>
        </div>
      ) : null}

      <section data-testid="home-identity" className="flex flex-wrap items-center justify-between gap-4 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">{store.hasLogo ? <img src={`/api/store/${encodeURIComponent(store.slug)}/logo`} alt="" className="h-12 w-12 rounded-2xl object-cover" /> : <ShoppingBag className="h-5 w-5" />}</span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-lg font-black text-[var(--codiq-text)]">{store.name}{store.verifiedAt ? <BadgeCheck className="h-4 w-4 text-[var(--codiq-accent)]" aria-label="موثّق" /> : null}</p>
            <p className="truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">{store.customDomain ?? storeUrl.replace(/^https?:\/\//, "")}</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {home.wallet ? <div><p className="text-[11px] font-bold text-[var(--codiq-text-muted)]">الرصيد (دينار عراقي)</p><p className="text-lg font-black tabular-nums text-[var(--codiq-text)]">{money(home.wallet.pendingNetIqd)}</p></div> : null}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => void share()} data-testid="home-share">{copied ? <Check className="ml-1.5 h-4 w-4" /> : <Share2 className="ml-1.5 h-4 w-4" />}{copied ? "نُسخ الرابط" : "مشاركة"}</Button>
            <a href={storeUrl} target="_blank" rel="noreferrer" data-testid="home-open-store" className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--codiq-accent)] px-3 text-sm font-bold text-white hover:bg-[var(--codiq-accent-hover)]"><ExternalLink className="h-4 w-4" />الانتقال إلى المتجر</a>
          </div>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi testId="kpi-sales" label="المبيعات" value={money(today.salesIqd)} icon={Banknote}><Delta today={today.salesIqd} yesterday={yesterday.salesIqd} /></Kpi>
        <Kpi testId="kpi-orders" label="الطلبات" value={number.format(today.ordersCount)} icon={ShoppingBag}><Delta today={today.ordersCount} yesterday={yesterday.ordersCount} /></Kpi>
        <Kpi testId="kpi-visitors" label="الزوار" value={number.format(today.visitors)} icon={Users}><Delta today={today.visitors} yesterday={yesterday.visitors} /><p className="mt-1 text-[10px] text-[var(--codiq-text-muted)]">زوار فريدون تقريبياً؛ {number.format(today.visits)} زيارة اليوم.</p></Kpi>
        <Kpi testId="kpi-conversion" label="معدل التحويل" value={today.conversionPct === null ? "—" : `${number.format(today.conversionPct)}٪`} icon={BarChart3}>{today.conversionPct === null ? <span className="text-[11px] font-semibold text-[var(--codiq-text-muted)]">لا زوار بعد لحساب النسبة</span> : <Delta today={today.conversionPct} yesterday={yesterday.conversionPct ?? 0} />}</Kpi>
      </div>

      <section data-testid="home-today" className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-black text-[var(--codiq-text)]">ماذا يحدث اليوم؟</h2>
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--codiq-text-muted)]"><CalendarDays className="h-4 w-4" />{todayLabel}{store.city ? <><span>·</span><MapPin className="h-3.5 w-3.5" />{store.city}</> : null}</p>
        </div>
        <ul className="mt-4 flex flex-wrap gap-2 text-xs font-bold">
          <li><button type="button" onClick={() => navigate(dashboard("/orders/action-needed"))} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--codiq-accent-soft)] px-3 py-1.5 text-[var(--codiq-accent-on-soft)] hover:bg-[var(--codiq-accent)] hover:text-white"><ShoppingBag className="h-3.5 w-3.5" />{number.format(newToday)} طلب جديد اليوم</button></li>
          {awaitingTransfer ? <li><button type="button" onClick={() => navigate(dashboard("/orders"))} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--codiq-warning-soft)] px-3 py-1.5 text-[var(--codiq-warning)]"><Wallet className="h-3.5 w-3.5" />{number.format(awaitingTransfer)} طلب بانتظار التحويل</button></li> : null}
          <li><button type="button" onClick={() => navigate(dashboard("/products/inventory"))} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 ${home.lowStock.count ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`}><Boxes className="h-3.5 w-3.5" />{home.lowStock.count ? `${number.format(home.lowStock.count)} منتج مخزونه منخفض` : "المخزون بخير"}</button></li>
          <li><span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1.5 text-[var(--codiq-text-secondary)]"><Users className="h-3.5 w-3.5" />{store.guestCheckoutEnabled ? "الشراء كضيف مفعّل" : "الشراء يتطلب حساباً"}</span></li>
        </ul>
        <div className="mt-4"><MerchantOnboarding storeSlug={storeSlug} navigate={navigate} /></div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          <section data-testid="home-indicators" className="rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div><h2 className="text-base font-black text-[var(--codiq-text)]">مؤشرات رئيسية</h2><p className="text-[11px] text-[var(--codiq-text-muted)]">{loading ? "جارٍ التحديث…" : "طلبات المتجر الإلكترونية في المدى المختار — لا الكاشير."}</p></div>
              <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={(event) => { event.preventDefault(); void load(); }} aria-label="نطاق التاريخ">
                <label className="flex items-center gap-1.5 font-bold text-[var(--codiq-text-secondary)]">من<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className="h-9 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-canvas)] px-2 font-semibold" /></label>
                <label className="flex items-center gap-1.5 font-bold text-[var(--codiq-text-secondary)]">إلى<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className="h-9 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-canvas)] px-2 font-semibold" /></label>
              </form>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Panel title="الطلبات حسب الحالة" hint="عدد الطلبات وقيمتها في هذه الفترة." testId="home-by-status"><Bars rows={home.byStatus.map((row) => ({ label: STATUS_LABEL[row.status] ?? row.status, count: row.count, hint: money(row.totalIqd) }))} empty="لا طلبات في هذه الفترة." /></Panel>
              <Panel title="الطلبات حسب طريقة الدفع" hint="الطلبات الحقيقية فقط — بلا الملغى والمرفوض." testId="home-by-payment"><Bars rows={home.byPaymentMethod.map((row) => ({ label: PAYMENT_LABEL[row.code] ?? row.code, count: row.count, hint: money(row.totalIqd) }))} empty="لا بيانات لهذه الفترة." /></Panel>
              <Panel title="الطلبات حسب الساعة" hint="كل عمود = ساعة من اليوم بتوقيت بغداد." testId="home-by-hour">
                <div>
                    <div className="flex h-28 items-end gap-[3px]" role="img" aria-label="الطلبات حسب الساعة">{home.byHour.map((row) => <div key={row.hour} title={`${String(row.hour).padStart(2, "0")}:00 · ${number.format(row.count)}`} className="flex-1 rounded-t bg-[var(--codiq-accent)]" style={{ height: `${Math.max(row.count ? 8 : 2, (row.count / hourMax) * 100)}%`, opacity: row.count ? 1 : 0.25 }} />)}</div>
                    <div className="mt-1 flex justify-between text-[10px] text-[var(--codiq-text-muted)]" dir="ltr"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
                  </div>
              </Panel>
              <Panel title="الأكثر مبيعاً" hint="الوحدات المباعة في هذه الفترة." testId="home-top-products">
                {home.topProducts.length ? <ol className="space-y-2 text-xs">{home.topProducts.map((row, index) => <li key={row.productId ?? index} className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--codiq-neutral-soft)] text-[10px] font-black text-[var(--codiq-text-secondary)]">{index + 1}</span><span className="font-semibold text-[var(--codiq-text)]">{row.name}</span></span><span className="tabular-nums text-[var(--codiq-text-muted)]">{number.format(row.units)} قطعة · {money(row.revenueIqd)}</span></li>)}</ol> : <div className="text-xs text-[var(--codiq-text-muted)]">لا مبيعات في هذه الفترة. <button type="button" onClick={() => navigate(dashboard("/products/add"))} className="font-bold text-[var(--codiq-accent)] hover:underline">أضف منتجك الأول</button></div>}
              </Panel>
              <Panel title="الأكثر زيارة" hint="صفحات المنتجات الأكثر فتحاً في هذه الفترة." testId="home-most-viewed">
                {home.mostViewed.length ? <ol className="space-y-2 text-xs">{home.mostViewed.map((row, index) => <li key={row.productId} className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><Eye className="h-3.5 w-3.5 text-[var(--codiq-text-muted)]" /><span className="font-semibold text-[var(--codiq-text)]">{row.name}</span></span><span className="tabular-nums text-[var(--codiq-text-muted)]">{number.format(row.views)} زيارة</span></li>)}</ol> : <p className="text-xs text-[var(--codiq-text-muted)]">لا زيارات مسجّلة بعد — تُعدّ منذ اليوم.</p>}
              </Panel>
              <Panel title="مخزون منخفض" hint="منتجات بلغت حد التنبيه الذي حددته — عدّ دقيق." testId="home-low-stock">
                {home.lowStock.count ? <ul className="space-y-2 text-xs">{home.lowStock.products.map((row) => <li key={row.id} className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5 text-[var(--codiq-danger)]" /><span className="font-semibold text-[var(--codiq-text)]">{row.name}</span></span><span className="tabular-nums text-[var(--codiq-text-muted)]">{number.format(row.stockQuantity)} / حد {number.format(row.lowStockThreshold)}</span></li>)}{home.lowStock.count > home.lowStock.products.length ? <li><button type="button" onClick={() => navigate(dashboard("/products/inventory"))} className="font-bold text-[var(--codiq-accent)] hover:underline">و{number.format(home.lowStock.count - home.lowStock.products.length)} غيرها — افتح المخزون</button></li> : null}</ul> : <p className="text-xs text-[var(--codiq-text-muted)]">لا منتج تحت حدّه.</p>}
              </Panel>
            </div>
          </section>

          <section data-testid="home-orders" className="rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
            <Tabs defaultValue="orders">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabsList className="rounded-xl bg-[var(--codiq-neutral-soft)]"><TabsTrigger value="orders" className="rounded-lg">الطلبات</TabsTrigger><TabsTrigger value="sales" className="rounded-lg">المبيعات</TabsTrigger></TabsList>
                <button type="button" onClick={() => navigate(dashboard("/orders"))} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)] hover:underline">قائمة إدارة الطلبات<ArrowLeft className="h-3.5 w-3.5" /></button>
              </div>
              <TabsContent value="orders" className="mt-4">
                {home.recentOrders.length ? (
                  <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-right text-[11px] font-bold text-[var(--codiq-text-muted)]"><th className="py-2">الطلب</th><th>الزبون</th><th>الحالة</th><th>الدفع</th><th>الإجمالي</th><th>الوقت</th></tr></thead><tbody>
                    {home.recentOrders.map((order) => <tr key={order.id} className="border-t border-[var(--codiq-border)]"><td className="py-2.5"><button type="button" onClick={() => navigate(dashboard(`/orders/${order.id}`))} className="font-bold text-[var(--codiq-accent)] hover:underline" dir="ltr">{order.orderNumber}</button></td><td className="font-semibold text-[var(--codiq-text)]">{order.customerName}</td><td><span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 font-bold text-[var(--codiq-text-secondary)]">{STATUS_LABEL[order.status] ?? order.status}</span></td><td className="text-[var(--codiq-text-secondary)]">{PAYMENT_LABEL[order.paymentMethodCode] ?? order.paymentMethodCode}{order.paymentStatus === "awaiting_transfer" || order.paymentStatus === "awaiting_payment" ? <span className="mr-1 rounded-full bg-[var(--codiq-warning-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--codiq-warning)]">{PAYMENT_STATUS_LABEL[order.paymentStatus]}</span> : null}</td><td className="font-black tabular-nums text-[var(--codiq-text)]">{money(order.totalIqd)}</td><td className="text-[var(--codiq-text-muted)]"><Clock3 className="ml-1 inline h-3 w-3" />{new Intl.DateTimeFormat("ar-IQ", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Baghdad" }).format(new Date(order.createdAt))}</td></tr>)}
                  </tbody></table></div>
                ) : <p className="text-xs text-[var(--codiq-text-muted)]">لا طلبات بعد. أضف منتجات وشارك رابط متجرك لتحصل على أول طلب.</p>}
              </TabsContent>
              <TabsContent value="sales" className="mt-4">
                <div className="grid gap-3 sm:grid-cols-3 text-xs">
                  {home.byStatus.filter((row) => ["completed", "new", "processing", "preparation", "out_for_delivery"].includes(row.status)).map((row) => <div key={row.status} className="rounded-2xl bg-[var(--codiq-canvas)] p-3"><p className="font-bold text-[var(--codiq-text-muted)]">{STATUS_LABEL[row.status]}</p><p className="mt-1 text-base font-black tabular-nums text-[var(--codiq-text)]">{money(row.totalIqd)}</p><p className="text-[10px] text-[var(--codiq-text-muted)]">{number.format(row.count)} طلب</p></div>)}
                  {!home.byStatus.length ? <p className="text-[var(--codiq-text-muted)]">لا مبيعات في هذه الفترة.</p> : null}
                </div>
              </TabsContent>
            </Tabs>
          </section>
        </div>

        <aside className="space-y-4">
          {home.wallet ? ((wallet) => (
          <section data-testid="home-balance" className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
            <p className="flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]"><Wallet className="h-4 w-4 text-[var(--codiq-accent)]" />الرصيد المتاح</p>
            <p className="mt-2 text-2xl font-black tabular-nums text-[var(--codiq-text)]">{money(wallet.pendingNetIqd)}</p>
            <p className="mt-1 text-[11px] text-[var(--codiq-text-muted)]">{wallet.pendingOrders ? `صافي ${number.format(wallet.pendingOrders)} طلب مكتمل لم يُسوَّ بعد.` : "لا مبالغ بانتظار التسوية."}{wallet.lastSettlement ? ` آخر تسوية: ${money(wallet.lastSettlement.netPayoutIqd)}.` : ""}</p>
            <Button type="button" variant="outline" size="sm" className="mt-3 w-full rounded-xl" onClick={() => navigate(dashboard("/orders/settlements"))}>مراجعة التسويات</Button>
          </section>
          ))(home.wallet) : null}
          <section data-testid="home-address" className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
            <p className="flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]"><MapPin className="h-4 w-4 text-[var(--codiq-accent)]" />عنوان المتجر</p>
            {store.addressLine || store.city ? <p className="mt-2 text-sm leading-6 text-[var(--codiq-text)]">{[store.addressLine, store.city].filter(Boolean).join("، ")}</p> : <p className="mt-2 text-xs leading-6 text-[var(--codiq-text-muted)]">لم تكتب عنوان متجرك بعد — يظهر لزبائنك في تذييل المتجر.</p>}
            {store.supportPhone ? <p className="mt-1 text-xs text-[var(--codiq-text-muted)]" dir="ltr">{store.supportPhone}</p> : null}
            <button type="button" onClick={() => navigate(dashboard("/settings/storefront"))} className="mt-3 text-xs font-bold text-[var(--codiq-accent)] hover:underline">{store.addressLine ? "تعديل" : "أضف العنوان"}</button>
          </section>
          <section data-testid="home-settings" className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
            <p className="flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]"><Settings2 className="h-4 w-4 text-[var(--codiq-accent)]" />الإعدادات</p>
            <ul className="mt-3 space-y-1 text-sm">
              {[["/settings/storefront", "واجهة المتجر", LayoutTemplate], ["/settings/payments", "وسائل الدفع", Banknote], ["/settings/shipping", "التوصيل", Truck], ["/settings/integrations", "التكاملات والبكسلات", Copy]].map(([path, label, Icon]) => <li key={path as string}><button type="button" onClick={() => navigate(dashboard(path as string))} className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-right font-semibold text-[var(--codiq-text)] hover:bg-[var(--codiq-canvas)]"><span className="flex items-center gap-2">{(() => { const I = Icon as LucideIcon; return <I className="h-4 w-4 text-[var(--codiq-text-muted)]" />; })()}{label as string}</span><ArrowLeft className="h-3.5 w-3.5 text-[var(--codiq-text-muted)]" /></button></li>)}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

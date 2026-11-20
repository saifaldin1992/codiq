/**
 * codiq phase 20B-2 — merchant analytics «التقارير» (D-09).
 * Read-only aggregates from the analytics endpoints (orders.view), rendered
 * with hand-rolled SVG charts only — no chart library before phase 21
 * (approved decision §8.13) and no caching (§8.14). The same component serves
 * «الطلبات ← التقارير» and «التسويق ← التقارير»; the marketing variant adds the
 * coupons-usage tab whose counts follow the status-filtered consuming
 * definition of coupon.service.ts.
 */
import { BarChart3, ClipboardList, LoaderCircle, PackageSearch, RefreshCw, ShieldAlert, Store, TicketPercent, TrendingUp, UserPlus, UsersRound, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type Summary = {
  period: { from: string; to: string };
  revenue: { revenueIqd: number; subtotalIqd: number; deliveryFeeIqd: number; commissionIqd: number; completedOrders: number; reversedOrders: number };
  ordersCount: number;
  averageOrderValueIqd: number;
  newCustomers: number;
  // ق-135: isolated from `revenue` by design — that block is platform-carried
  // money, this one is cash already in the drawer. Optional so an older server
  // (production trails main behind the release branch) renders without it.
  pos?: { completedSales: number; returnedSales: number; takingsIqd: number; countsTowardPlanQuota: boolean };
};
type SeriesBucket = { bucketStart: string; ordersCount: number; totalIqd: number };
type TopProduct = { productId: string | null; variantId: string | null; productName: string; variantName: string | null; sku: string | null; units: number; revenueIqd: number };
type FunnelRow = { status: string; count: number };
type CustomersSummary = { totalCustomers: number; newCustomers: number; activeCustomers: number; prospectCustomers: number };
type CouponUsage = { id: string; code: string; kind: string; isActive: boolean; maxUsesTotal: number | null; consumingUses: number; redemptionsTotal: number; discountIqd: number; waivedDeliveryFeeIqd: number };

type Interval = "day" | "week" | "month";
type TopSort = "revenue" | "units";

const number = new Intl.NumberFormat("ar-IQ");
const RANGE_PRESETS = [{ days: 7, label: "٧ أيام" }, { days: 30, label: "٣٠ يوماً" }, { days: 90, label: "٩٠ يوماً" }] as const;
const INTERVAL_LABELS: Record<Interval, string> = { day: "يومي", week: "أسبوعي", month: "شهري" };
const STATUS_LABELS: Record<string, string> = {
  new: "جديد", processing: "قيد المعالجة", preparation: "قيد التجهيز", out_for_delivery: "قيد التوصيل",
  completed: "مكتمل", cancelled: "ملغى", rejected: "مرفوض", returned: "مرتجع",
};
const KIND_LABELS: Record<string, string> = { percent: "نسبة مئوية", fixed: "مبلغ ثابت", free_shipping: "شحن مجاني" };

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
    (error as Error & { code?: string }).code = body?.error?.code;
    throw error;
  }
  return body as T;
}

function bucketLabel(iso: string, interval: Interval): string {
  const date = new Date(iso);
  if (interval === "month") return date.toLocaleDateString("ar-IQ", { month: "short", year: "2-digit" });
  return date.toLocaleDateString("ar-IQ", { day: "numeric", month: "numeric" });
}

/** Hand-rolled SVG bars (revenue) + polyline (orders) — decision §8.13. */
function SalesSeriesChart({ series, interval }: { series: SeriesBucket[]; interval: Interval }) {
  const width = 720;
  const height = 240;
  const padX = 14;
  const padTop = 18;
  const padBottom = 34;
  const chartHeight = height - padTop - padBottom;
  const maxTotal = Math.max(...series.map((bucket) => bucket.totalIqd), 1);
  const maxOrders = Math.max(...series.map((bucket) => bucket.ordersCount), 1);
  const slot = (width - padX * 2) / Math.max(series.length, 1);
  const barWidth = Math.min(Math.max(slot * 0.55, 6), 46);
  const x = (index: number) => padX + slot * index + slot / 2;
  const points = series.map((bucket, index) => `${x(index)},${padTop + chartHeight - (bucket.ordersCount / maxOrders) * chartHeight}`).join(" ");
  if (!series.length) return <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)]">لا مبيعات ضمن المدة المحددة بعد.</p>;
  return (
    <div dir="ltr" className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="سلسلة المبيعات" className="min-w-[520px] w-full">
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line key={fraction} x1={padX} x2={width - padX} y1={padTop + chartHeight - chartHeight * fraction} y2={padTop + chartHeight - chartHeight * fraction} stroke="#EDF2F9" strokeWidth={1} />
        ))}
        {series.map((bucket, index) => {
          const barHeight = (bucket.totalIqd / maxTotal) * chartHeight;
          return (
            <g key={bucket.bucketStart}>
              <rect x={x(index) - barWidth / 2} y={padTop + chartHeight - barHeight} width={barWidth} height={Math.max(barHeight, bucket.totalIqd > 0 ? 3 : 0)} rx={5} fill="var(--codiq-accent)" opacity={0.85}>
                <title>{`${bucketLabel(bucket.bucketStart, interval)} — ${number.format(bucket.totalIqd)} د.ع · ${number.format(bucket.ordersCount)} طلب`}</title>
              </rect>
              <text x={x(index)} y={height - 12} textAnchor="middle" fontSize={11} fill="#8994A8">{bucketLabel(bucket.bucketStart, interval)}</text>
            </g>
          );
        })}
        <polyline points={points} fill="none" stroke="#6F6AFF" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {series.map((bucket, index) => (
          <circle key={`o-${bucket.bucketStart}`} cx={x(index)} cy={padTop + chartHeight - (bucket.ordersCount / maxOrders) * chartHeight} r={3.5} fill="#6F6AFF">
            <title>{`${number.format(bucket.ordersCount)} طلب`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function FunnelBars({ funnel }: { funnel: FunnelRow[] }) {
  const max = Math.max(...funnel.map((row) => row.count), 1);
  return (
    <div className="space-y-2.5">
      {funnel.map((row) => (
        <div key={row.status} className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-xs font-bold text-[var(--codiq-text-secondary)]">{STATUS_LABELS[row.status] ?? row.status}</span>
          <div className="h-6 flex-1 overflow-hidden rounded-full bg-[var(--codiq-neutral-soft)]" dir="ltr">
            <div className="h-full rounded-full bg-[var(--codiq-accent)]/80 transition-all" style={{ width: `${Math.max((row.count / max) * 100, row.count > 0 ? 3 : 0)}%`, marginLeft: "auto" }} />
          </div>
          <span className="w-14 shrink-0 text-left text-sm font-bold text-[#15233E]" dir="ltr">{number.format(row.count)}</span>
        </div>
      ))}
    </div>
  );
}

function StatCard({ testId, label, value, hint, icon: Icon }: { testId: string; label: string; value: string; hint: string; icon: typeof Wallet }) {
  return (
    <div data-testid={`analytics-stat-${testId}`} className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-[#60708A]">{label}</p>
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#F0F5FF] text-[var(--codiq-accent)]"><Icon className="h-4.5 w-4.5" strokeWidth={1.9} /></div>
      </div>
      <p className="mt-3 text-2xl font-bold tracking-[-0.02em] text-[#15233E]">{value}</p>
      <p className="mt-2 text-[11px] leading-5 text-[#8994A8]">{hint}</p>
    </div>
  );
}

export function MerchantAnalytics({ storeSlug, showCoupons = false }: { storeSlug?: string; showCoupons?: boolean }) {
  const [days, setDays] = useState<number>(30);
  const [interval, setIntervalValue] = useState<Interval>("day");
  const [topSort, setTopSort] = useState<TopSort>("revenue");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [series, setSeries] = useState<SeriesBucket[] | null>(null);
  const [top, setTop] = useState<TopProduct[] | null>(null);
  const [funnel, setFunnel] = useState<FunnelRow[] | null>(null);
  const [customers, setCustomers] = useState<CustomersSummary | null>(null);
  const [coupons, setCoupons] = useState<CouponUsage[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/marketing/analytics` : null;
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.valueOf() - days * 24 * 60 * 60 * 1000);
    return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  }, [days]);

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    try {
      const [summaryResult, seriesResult, topResult, funnelResult, customersResult, couponsResult] = await Promise.all([
        api<{ summary: Summary }>(`${base}/summary?${range}`),
        api<{ series: SeriesBucket[] }>(`${base}/sales-series?${range}&interval=${interval}`),
        api<{ products: TopProduct[] }>(`${base}/top-products?${range}&by=${topSort}`),
        api<{ funnel: FunnelRow[] }>(`${base}/status-funnel?${range}`),
        api<{ customers: CustomersSummary }>(`${base}/customers`),
        showCoupons ? api<{ coupons: CouponUsage[] }>(`${base}/coupons`) : Promise.resolve(null),
      ]);
      setSummary(summaryResult.summary);
      setSeries(seriesResult.series);
      setTop(topResult.products);
      setFunnel(funnelResult.funnel);
      setCustomers(customersResult.customers);
      setCoupons(couponsResult ? couponsResult.coupons : null);
      setFailure(null);
    } catch (error) {
      setFailure((error as Error & { code?: string }).code === "STAFF_PERMISSION_DENIED" ? "هذه الجلسة لا تملك صلاحية عرض الطلبات (orders.view) المطلوبة للتقارير." : error instanceof Error ? error.message : "تعذر تحميل التقارير.");
    } finally {
      setLoading(false);
    }
  }, [base, range, interval, topSort, showCoupons]);

  useEffect(() => { void load(); }, [load]);

  if (!storeSlug) {
    return <div className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]" dir="rtl"><ShieldAlert className="mb-3 h-6 w-6" />اختر متجراً عبر مبدّل المتاجر قبل عرض التقارير.</div>;
  }

  return (
    <div className="max-w-[1030px] space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><BarChart3 className="h-4 w-4" /> أرقام دقيقة من قاعدة البيانات مباشرة — الإيراد المحقق من الدفتر المالي (يخصم المرتجعات)</p>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl bg-[var(--codiq-neutral-soft)] p-1">
            {RANGE_PRESETS.map((preset) => (
              <button key={preset.days} type="button" data-testid={`analytics-range-${preset.days}`} onClick={() => setDays(preset.days)} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${days === preset.days ? "bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm" : "text-[#65748B]"}`}>{preset.label}</button>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} className="rounded-xl"><RefreshCw className="ml-1 h-3.5 w-3.5" />تحديث</Button>
        </div>
      </div>

      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><ShieldAlert className="h-4 w-4" /> {failure}</p> : null}
      {loading && !summary ? <div className="flex items-center gap-3 rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[#61708A]"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" />جارٍ تجميع أرقام المتجر…</div> : null}

      {summary ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard testId="revenue" label="الإيراد المحقق" value={`${number.format(summary.revenue.revenueIqd)} د.ع`} hint={`صافي الدفتر: ${number.format(summary.revenue.completedOrders)} إتمام − ${number.format(summary.revenue.reversedOrders)} عكس إرجاع.`} icon={Wallet} />
          <StatCard testId="orders" label="عدد الطلبات" value={number.format(summary.ordersCount)} hint="كل الطلبات المنشأة ضمن المدة، بكل الحالات." icon={ClipboardList} />
          <StatCard testId="aov" label="متوسط قيمة الطلب" value={`${number.format(summary.averageOrderValueIqd)} د.ع`} hint="الإيراد المحقق ÷ صافي الطلبات المكتملة." icon={TrendingUp} />
          <StatCard testId="new-customers" label="عملاء جدد" value={number.format(summary.newCustomers)} hint="حسابات زبائن سُجلت ضمن المدة المحددة." icon={UserPlus} />
          {/* ق-135: مالٌ في الدرج لا مالٌ يُنتظَر من المنصّة — لذلك بطاقة
              منفصلة لا رقم يُدمج في «الإيراد المحقق»، ولا يمسّ حصّة الخطة. */}
          {summary.pos && (summary.pos.completedSales > 0 || summary.pos.returnedSales > 0) && (
            <StatCard testId="pos-takings" label="مبيعات المحل (كاشير)" value={`${number.format(summary.pos.takingsIqd)} د.ع`} hint={`${number.format(summary.pos.completedSales)} بيعة نقدية${summary.pos.returnedSales > 0 ? ` − ${number.format(summary.pos.returnedSales)} إرجاع` : ""} · بلا عمولة، ولا تُحسب من حصة الخطة.`} icon={Store} />
          )}
        </div>
      ) : null}

      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-[#273753]">سلسلة المبيعات</h2>
            <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">الأعمدة: قيمة الطلبات (د.ع) · الخط: عدد الطلبات — بلا الطلبات الملغاة والمرفوضة.</p>
          </div>
          <div className="flex rounded-xl bg-[var(--codiq-neutral-soft)] p-1">
            {(Object.keys(INTERVAL_LABELS) as Interval[]).map((key) => (
              <button key={key} type="button" data-testid={`analytics-interval-${key}`} onClick={() => setIntervalValue(key)} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${interval === key ? "bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm" : "text-[#65748B]"}`}>{INTERVAL_LABELS[key]}</button>
            ))}
          </div>
        </div>
        {series ? <SalesSeriesChart series={series} interval={interval} /> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-bold text-[#273753]"><PackageSearch className="h-4.5 w-4.5 text-[var(--codiq-accent)]" /> الأكثر مبيعاً (حسب المتغير)</h2>
            <div className="flex rounded-xl bg-[var(--codiq-neutral-soft)] p-1">
              <button type="button" data-testid="analytics-top-revenue" onClick={() => setTopSort("revenue")} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${topSort === "revenue" ? "bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm" : "text-[#65748B]"}`}>بالإيراد</button>
              <button type="button" data-testid="analytics-top-units" onClick={() => setTopSort("units")} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${topSort === "units" ? "bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm" : "text-[#65748B]"}`}>بالوحدات</button>
            </div>
          </div>
          {top && top.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] text-right text-sm">
                <thead><tr className="text-[11px] font-bold text-[#8994A8]"><th className="pb-2 pl-3">المنتج</th><th className="pb-2 pl-3">SKU</th><th className="pb-2 pl-3">الوحدات</th><th className="pb-2">الإيراد</th></tr></thead>
                <tbody>
                  {top.map((product) => (
                    <tr key={`${product.productId}-${product.variantId}`} className="border-t border-[var(--codiq-neutral-soft)]">
                      <td className="py-2.5 pl-3 font-semibold text-[#273753]">{product.productName}{product.variantName && product.variantName !== product.productName ? <span className="mr-1.5 rounded-full bg-[#F0F5FF] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-accent)]">{product.variantName}</span> : null}</td>
                      <td className="py-2.5 pl-3 text-xs text-[var(--codiq-text-muted)]" dir="ltr">{product.sku ?? "—"}</td>
                      <td className="py-2.5 pl-3 font-bold text-[#15233E]">{number.format(product.units)}</td>
                      <td className="py-2.5 font-bold text-[#15233E]">{number.format(product.revenueIqd)} د.ع</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)]">لا مبيعات منتجات ضمن المدة بعد.</p>}
        </div>

        <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8">
          <h2 className="mb-4 font-bold text-[#273753]">قمع حالات الطلبات (ضمن المدة)</h2>
          {funnel ? <FunnelBars funnel={funnel.filter((row) => STATUS_LABELS[row.status])} /> : null}
          {customers ? (
            <div className="mt-5 grid grid-cols-2 gap-2 border-t border-[var(--codiq-neutral-soft)] pt-4 sm:grid-cols-4">
              {[
                { label: "إجمالي العملاء", value: customers.totalCustomers },
                { label: "جدد (٣٠ يوماً)", value: customers.newCustomers },
                { label: "نشطون", value: customers.activeCustomers },
                { label: "محتملون", value: customers.prospectCustomers },
              ].map((entry) => (
                <div key={entry.label} className="rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2.5 text-center">
                  <p className="text-[11px] font-semibold text-[#8994A8]"><UsersRound className="ml-1 inline h-3 w-3" />{entry.label}</p>
                  <p className="mt-1 text-lg font-bold text-[#15233E]">{number.format(entry.value)}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {showCoupons ? (
        <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8">
          <h2 className="mb-1 flex items-center gap-2 font-bold text-[#273753]"><TicketPercent className="h-4.5 w-4.5 text-[var(--codiq-accent)]" /> استخدامات الكوبونات</h2>
          <p className="mb-4 text-xs text-[var(--codiq-text-muted)]">«الاستخدامات المحتسبة» تستثني الطلبات الملغاة والمرفوضة — التعريف المعتمد نفسه في محرك الكوبونات؛ «كل التسجيلات» يعرض السجل الكامل غير القابل للحذف.</p>
          {coupons && coupons.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-right text-sm">
                <thead><tr className="text-[11px] font-bold text-[#8994A8]"><th className="pb-2 pl-3">الكوبون</th><th className="pb-2 pl-3">النوع</th><th className="pb-2 pl-3">الاستخدامات المحتسبة</th><th className="pb-2 pl-3">كل التسجيلات</th><th className="pb-2 pl-3">إجمالي الخصم</th><th className="pb-2">شحن مُعفى</th></tr></thead>
                <tbody>
                  {coupons.map((coupon) => (
                    <tr key={coupon.id} className="border-t border-[var(--codiq-neutral-soft)]" data-testid={`coupon-usage-${coupon.code}`}>
                      <td className="py-2.5 pl-3"><span className="font-black text-[#273753]" dir="ltr">{coupon.code}</span><span className={`mr-2 rounded-full px-2 py-0.5 text-[10px] font-bold ${coupon.isActive ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-danger-soft)] text-[#B44B40]"}`}>{coupon.isActive ? "فعّال" : "موقوف"}</span></td>
                      <td className="py-2.5 pl-3 text-xs font-semibold text-[var(--codiq-text-secondary)]">{KIND_LABELS[coupon.kind] ?? coupon.kind}</td>
                      <td className="py-2.5 pl-3 font-bold text-[#15233E]">{number.format(coupon.consumingUses)}{coupon.maxUsesTotal ? <span className="text-xs font-semibold text-[#8994A8]"> / {number.format(coupon.maxUsesTotal)}</span> : null}</td>
                      <td className="py-2.5 pl-3 text-[var(--codiq-text-secondary)]">{number.format(coupon.redemptionsTotal)}</td>
                      <td className="py-2.5 pl-3 font-bold text-[#15233E]">{number.format(coupon.discountIqd)} د.ع</td>
                      <td className="py-2.5 font-bold text-[#15233E]">{number.format(coupon.waivedDeliveryFeeIqd)} د.ع</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)]">لا كوبونات في المتجر بعد — أنشئها من صفحة «الكوبونات».</p>}
        </div>
      ) : null}
    </div>
  );
}

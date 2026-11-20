/**
 * MD-7 «شهرك في CODIQ» — a month of the merchant's shop, laid out to be printed
 * or shown to someone.
 *
 * Every headline carries last month beside it, because «بعت 40 طلباً» says
 * nothing on its own and «40 مقابل 31» is the sentence he repeats. Where last
 * month was empty there is no percentage — an increase from zero has no ratio,
 * and «+100٪» would be a number the data does not contain.
 *
 * Direction of change is never carried by colour alone: the arrow and the sign
 * say it too, so the page survives being printed in black and white — which is
 * the whole point of a printable page.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Printer, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Change = { value: number; previous: number; changePercent: number | null };
type Report = {
  store: { slug: string; name: string };
  month: { key: string; from: string; to: string };
  previous: { key: string };
  headline: { revenueIqd: Change; completedOrders: Change; averageOrderValueIqd: Change; newCustomers: Change };
  bestDay: { date: string; orders: number; revenueIqd: number } | null;
  topProducts: { productId: string | null; productName: string; variantName: string | null; units: number; revenueIqd: number }[];
  achievements: { code: string; text: string }[];
  empty: boolean;
};

const money = new Intl.NumberFormat("ar-IQ");
const monthName = (key: string) => new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "long" }).format(new Date(`${key}-01T00:00:00Z`));
const dayName = (value: string) => new Intl.DateTimeFormat("ar-IQ", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${value}T00:00:00Z`));
const thisMonthKey = () => { const now = new Date(); return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; };

function Headline({ label, change, money: asMoney }: { label: string; change: Change; money?: boolean }) {
  const shown = asMoney ? `${money.format(change.value)} د.ع` : money.format(change.value);
  const previous = asMoney ? `${money.format(change.previous)} د.ع` : money.format(change.previous);
  const up = change.changePercent !== null && change.changePercent > 0;
  const down = change.changePercent !== null && change.changePercent < 0;
  return (
    <div className="break-inside-avoid rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3.5">
      <p className="text-[11px] font-semibold text-[var(--codiq-text-secondary)]">{label}</p>
      <p className="mt-1 text-2xl font-black tabular-nums text-[var(--codiq-text)]">{shown}</p>
      <p className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--codiq-text-secondary)]">
        {change.changePercent === null ? (
          // No previous month to compare against — said plainly rather than
          // dressed up as growth.
          <span>الشهر الماضي: {previous}</span>
        ) : (
          <>
            {up ? <TrendingUp className="h-3.5 w-3.5 text-[var(--codiq-success)]" aria-hidden="true" /> : down ? <TrendingDown className="h-3.5 w-3.5 text-[var(--codiq-negative-icon)]" aria-hidden="true" /> : null}
            <span className={up ? "text-[var(--codiq-success)]" : down ? "text-[var(--codiq-negative)]" : ""}>
              {change.changePercent > 0 ? "+" : ""}{money.format(change.changePercent)}٪
            </span>
            <span>مقابل {previous}</span>
          </>
        )}
      </p>
    </div>
  );
}

export function MerchantMonthlyReport({ storeSlug }: { storeSlug: string }) {
  const [month, setMonth] = useState(thisMonthKey);
  const [report, setReport] = useState<Report | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/reports/monthly?month=${encodeURIComponent(month)}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل التقرير.");
      setReport(body.report);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, [storeSlug, month]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-[900px] space-y-4" dir="rtl">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><Sparkles className="h-4 w-4" /> شهرك في Codiq</p>
        <div className="flex items-end gap-2">
          <label className="block space-y-1 text-[11px] font-semibold text-[var(--codiq-text-secondary)]">
            <span>الشهر</span>
            <Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="h-9" dir="ltr" />
          </label>
          <Button size="sm" onClick={() => window.print()} disabled={!report} className="rounded-xl"><Printer className="ml-1 h-4 w-4" /> طباعة</Button>
        </div>
      </div>

      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {!report && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}

      {report ? (
        <article className="space-y-4 rounded-3xl bg-[var(--codiq-surface)] p-5 shadow-sm print:rounded-none print:p-0 print:shadow-none">
          <header className="border-b border-[var(--codiq-border)] pb-3">
            <p className="text-lg font-black text-[var(--codiq-text)]">{report.store.name}</p>
            <p className="text-sm font-semibold text-[var(--codiq-text-secondary)]">{monthName(report.month.key)}</p>
          </header>

          {report.empty ? (
            <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-6 text-center text-sm text-[var(--codiq-text-secondary)]">
              لا توجد حركة مسجّلة في هذا الشهر. لا شيء نقوله بعد — والصفحة لن تخترع لك أرقاماً.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Headline label="إيراداتك" change={report.headline.revenueIqd} money />
                <Headline label="طلبات مكتملة" change={report.headline.completedOrders} />
                <Headline label="متوسط قيمة الطلب" change={report.headline.averageOrderValueIqd} money />
                <Headline label="زبائن جدد" change={report.headline.newCustomers} />
              </div>

              {report.achievements.length ? (
                <section className="break-inside-avoid rounded-2xl bg-[var(--codiq-accent-soft)] px-4 py-3.5">
                  <p className="text-xs font-bold text-[var(--codiq-accent-hover)]">إنجازات هذا الشهر</p>
                  <ul className="mt-2 space-y-1.5">
                    {report.achievements.map((item) => (
                      <li key={item.code} className="flex items-start gap-2 text-[13px] font-semibold text-[var(--codiq-text)]"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--codiq-accent)]" aria-hidden="true" />{item.text}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {report.bestDay ? (
                <p className="break-inside-avoid rounded-2xl border border-[var(--codiq-border)] px-4 py-3 text-[13px] font-semibold text-[var(--codiq-text)]">
                  أفضل يوم: <b className="font-black">{dayName(report.bestDay.date)}</b> — {money.format(report.bestDay.orders)} طلب بقيمة {money.format(report.bestDay.revenueIqd)} د.ع
                </p>
              ) : null}

              {report.topProducts.length ? (
                <section className="break-inside-avoid">
                  <p className="mb-2 text-xs font-bold text-[var(--codiq-text-secondary)]">الأكثر مبيعاً</p>
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="border-y border-[var(--codiq-border)] text-[11px] text-[var(--codiq-text-secondary)]">
                        <th className="py-1.5 text-start font-semibold">المنتج</th>
                        <th className="py-1.5 text-center font-semibold">القطع</th>
                        <th className="py-1.5 text-end font-semibold">الإيراد</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.topProducts.map((product, index) => (
                        <tr key={`${product.productId ?? "gone"}-${index}`} className="border-b border-[var(--codiq-border)]">
                          <td className="py-1.5 text-start font-semibold">{product.productName}{product.variantName ? <span className="text-[var(--codiq-text-secondary)]"> — {product.variantName}</span> : null}</td>
                          <td className="py-1.5 text-center tabular-nums">{money.format(product.units)}</td>
                          <td className="py-1.5 text-end font-bold tabular-nums">{money.format(product.revenueIqd)} د.ع</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}
            </>
          )}

          <footer className="border-t border-[var(--codiq-border)] pt-2.5 text-[11px] text-[var(--codiq-text-muted)]">
            الأرقام محسوبة من سجل متجرك على Codiq للفترة {report.month.key} — نفس المصدر الذي تقرأ منه شاشة التحليلات.
          </footer>
        </article>
      ) : null}
    </div>
  );
}

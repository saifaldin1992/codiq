/**
 * codiq phase 17 — merchant finance view: period totals from the append-only
 * ledger, recent entries, and the settlements the platform recorded.
 */
import { useCallback, useEffect, useState } from "react";
import { Banknote, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MerchantWalletCard } from "@/components/MerchantWalletCard";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type Totals = { completedOrders: number; reversedOrders: number; subtotalIqd: number; deliveryFeeIqd: number; commissionIqd: number };
type Entry = { id: string; entryType: string; subtotalIqd: number; deliveryFeeIqd: number; commissionIqd: number; planCode: string; createdAt: string; store: { slug: string; name: string }; order: { orderNumber: string } };
type Settlement = { id: string; periodFrom: string; periodTo: string; ordersCount: number; commissionIqd: number; netPayoutIqd: number | null; note: string | null; createdAt: string };

const money = new Intl.NumberFormat("ar-IQ");
const dateOnly = (value: string | Date) => new Date(value).toISOString().slice(0, 10);
const ENTRY_LABELS: Record<string, { label: string; className: string }> = {
  order_completed: { label: "إتمام", className: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  order_returned: { label: "إرجاع", className: "bg-[var(--codiq-danger-soft)] text-[#B52D46]" },
  manual_adjustment: { label: "تسوية يدوية", className: "bg-[#F6F1EE] text-[#825541]" },
};

export function MerchantFinancePanel() {
  const now = new Date();
  const [from, setFrom] = useState(dateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))));
  const [to, setTo] = useState(dateOnly(now));
  const [report, setReport] = useState<{ totals: Totals; entries: Entry[]; nextCursor?: string | null } | null>(null);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [settlements, setSettlements] = useState<Settlement[] | null>(null);
  // 20-2: settlements were capped at 100 with no page 2, so a merchant in his
  // third year could not reach his first year's payouts — on the screen that
  // exists to prove what he was paid.
  const [settlementsCursor, setSettlementsCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [reportResponse, settlementsResponse] = await Promise.all([
        fetch(`/api/merchant/finance/report?from=${from}T00:00:00Z&to=${to}T23:59:59Z`, { credentials: "same-origin" }),
        fetch("/api/merchant/finance/settlements?limit=50", { credentials: "same-origin" }),
      ]);
      const reportBody = await reportResponse.json().catch(() => null);
      const settlementsBody = await settlementsResponse.json().catch(() => null);
      if (!reportResponse.ok) throw new Error(reportBody?.error?.message ?? "تعذر تحميل التقرير.");
      if (!settlementsResponse.ok) throw new Error(settlementsBody?.error?.message ?? "تعذر تحميل التسويات.");
      setReport(reportBody);
      setSettlements(settlementsBody.settlements);
      setSettlementsCursor(settlementsBody.nextCursor ?? null);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  async function loadMoreEntries(cursor: string) {
    setLoadingEntries(true);
    try {
      const response = await fetch(`/api/merchant/finance/report?from=${from}T00:00:00Z&to=${to}T23:59:59Z&cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل المزيد من القيود.");
      setReport((current) => (current ? { ...current, entries: [...current.entries, ...body.entries], nextCursor: body.nextCursor ?? null } : body));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setLoadingEntries(false);
    }
  }

  async function loadMoreSettlements(cursor: string) {
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/merchant/finance/settlements?limit=50&cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل التسويات.");
      setSettlements((current) => [...(current ?? []), ...body.settlements]);
      setSettlementsCursor(body.nextCursor ?? null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="max-w-[1030px] space-y-5">
      <MerchantWalletCard />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><Banknote className="h-4 w-4" /> مستحقاتك المالية — من السجل المحمي غير القابل للتعديل</p>
        <div className="flex items-end gap-2">
          <label className="block space-y-1 text-[11px] font-semibold text-[#44526A]"><span>من</span><Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-9" dir="ltr" /></label>
          <label className="block space-y-1 text-[11px] font-semibold text-[#44526A]"><span>إلى</span><Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-9" dir="ltr" /></label>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {report === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: "طلبات مكتملة (صافي)", value: money.format(report.totals.completedOrders - report.totals.reversedOrders) },
              { label: "مبيعاتك", value: `${money.format(report.totals.subtotalIqd)} د.ع` },
              { label: "التوصيل", value: `${money.format(report.totals.deliveryFeeIqd)} د.ع` },
              { label: "عمولة المنصة المستحقة", value: `${money.format(report.totals.commissionIqd)} د.ع` },
            ].map((card) => (
              <div key={card.label} className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-3.5 shadow-sm">
                <p className="text-[11px] font-semibold text-[#8A96A9]">{card.label}</p>
                <p className="mt-1 text-lg font-bold text-[#243855]">{card.value}</p>
              </div>
            ))}
          </div>
          <div className="rounded-[24px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-5 shadow-sm">
            <p className="mb-3 text-sm font-bold text-[#30435F]">آخر القيود</p>
            {report.entries.length === 0 ? <p data-testid="merchant-finance-empty" className="text-sm text-[var(--codiq-text-muted)]">لا توجد قيود في هذه الفترة — تُنشأ تلقائياً عند اكتمال الطلبات.</p> : null}
            <div className="space-y-1.5">
              {report.entries.map((entry) => {
                const kind = ENTRY_LABELS[entry.entryType] ?? { label: entry.entryType, className: "bg-[var(--codiq-neutral-soft)] text-[#65748B]" };
                return (
                  <div key={entry.id} data-testid="merchant-finance-entry" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface)] px-3 py-2.5 text-xs">
                    <span className="font-bold text-[#263650]" dir="ltr">{entry.order.orderNumber}</span>
                    <span className="text-[var(--codiq-text-muted)]">{entry.store.name}</span>
                    <span className="text-[#44526A]">مبيعات {money.format(entry.subtotalIqd)} · عمولة {money.format(entry.commissionIqd)} د.ع ({entry.planCode})</span>
                    <span className={`rounded-full px-2 py-0.5 font-bold ${kind.className}`}>{kind.label}</span>
                  </div>
                );
              })}
            </div>
            {report.nextCursor ? (
              <button type="button" data-testid="merchant-finance-more" disabled={loadingEntries} onClick={() => void loadMoreEntries(report.nextCursor!)} className="mt-3 rounded-xl px-3 py-1.5 text-xs font-bold text-[var(--codiq-accent)] hover:underline disabled:opacity-60">
                {loadingEntries ? "جارٍ التحميل…" : "عرض قيود أقدم"}
              </button>
            ) : null}
          </div>
          <div className="rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-5">
            <p className="mb-3 text-sm font-bold text-[#30435F]">التسويات المسجلة</p>
            {settlements?.length === 0 ? <p className="text-xs text-[var(--codiq-text-muted)]">لا توجد تسويات بعد؛ تسجلها إدارة المنصة عند تحويل المستحقات.</p> : null}
            <div className="space-y-1.5">
              {settlements?.map((settlement) => (
                <p key={settlement.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--codiq-surface)] px-3 py-2 text-xs text-[#44526A] shadow-sm">
                  <span dir="ltr">{dateOnly(settlement.periodFrom)} → {dateOnly(settlement.periodTo)}</span>
                  {/* Audit 17-ب: the money he RECEIVED leads the row — it used to print only the commission he lost. */}
                  <span><b data-testid="merchant-settlement-net" className="text-[var(--codiq-text)]">استلمت: {money.format(settlement.netPayoutIqd ?? 0)} د.ع</b> · طلبات: {settlement.ordersCount} · عمولة: {money.format(settlement.commissionIqd)} د.ع{settlement.note ? ` · ${settlement.note}` : ""}</span>
                </p>
              ))}
            </div>
            <LoadMoreButton cursor={settlementsCursor} busy={loadingMore} onLoad={(cursor) => void loadMoreSettlements(cursor)} testId="merchant-settlements-more" />
          </div>
        </>
      ) : null}
    </div>
  );
}

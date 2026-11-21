/**
 * Marketplace M13a — «الدفع». Where a card order goes after checkout: the
 * gateway's page. With the TEST provider this page plays the gateway (pay or
 * refuse); with a real one the shopper pays there and returns here. Either
 * way the status shown is the server's, which only the gateway's signed
 * notification changes — so it checks again while waiting.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { CircleAlert, CircleCheck, CreditCard, LoaderCircle, TimerOff } from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { iqd } from "../market-products";
import { MarketSignIn } from "./MarketAccountPages";

type Payment = { id: string; method: string; status: string; statusLabel: string; amountIqd: number; expiresAt: string; testProvider: boolean; order: { id: string; orderNumber: string; status: string; storeName: string } | null };

export function MarketPayPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { status, shopper } = useShopper();
  const [payment, setPayment] = useState<Payment | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setPayment((await accountCall<{ payment: Payment }>(`/api/market/payments/${encodeURIComponent(id)}`)).payment); } catch (error) { setFailure((error as Error).message); }
  }, [id]);
  useEffect(() => { if (shopper) void load(); }, [shopper, load]);
  useEffect(() => {
    if (!payment || (payment.status !== "pending" && payment.status !== "failed")) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [payment, load]);

  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  async function answer(outcome: "approve" | "decline") {
    setBusy(true); setFailure(null);
    try { setPayment((await accountCall<{ payment: Payment }>(`/api/market/payments/${encodeURIComponent(id)}/test-provider`, { method: "POST", body: JSON.stringify({ outcome }) })).payment); } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  if (!payment) return failure ? <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--codiq-danger)]">{failure}</p> : <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  const open = payment.status === "pending" || payment.status === "failed";
  return (
    <div className="space-y-4" data-testid="market-pay">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">الدفع الإلكترونيّ</h1>
      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--codiq-text)]"><CreditCard className="h-5 w-5 text-[var(--codiq-accent)]" /> {payment.order ? `طلب ${payment.order.orderNumber} من ${payment.order.storeName}` : "طلب"}</p>
        <p className="text-2xl font-black text-[var(--codiq-text)]" data-testid="market-pay-amount">{iqd(payment.amountIqd)}</p>
        <p className="text-xs font-bold" data-testid="market-pay-status">
          {payment.status === "paid" ? <span className="text-[var(--codiq-success)]"><CircleCheck className="ml-1 inline h-4 w-4" />{payment.statusLabel}</span>
            : payment.status === "expired" ? <span className="text-[var(--codiq-danger)]"><TimerOff className="ml-1 inline h-4 w-4" />{payment.statusLabel} — أُلغي الطلب ولم يُحتسب أيّ مبلغ.</span>
              : payment.status === "failed" ? <span className="text-[var(--codiq-danger)]"><CircleAlert className="ml-1 inline h-4 w-4" />{payment.statusLabel} — يمكنك المحاولة مرّة أخرى قبل {new Date(payment.expiresAt).toLocaleTimeString("ar-IQ", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Baghdad" })}.</span>
                : <span className="text-[var(--codiq-text-secondary)]">{payment.statusLabel}</span>}
        </p>
      </section>
      {open && payment.testProvider ? (
        <section className="space-y-3 rounded-[24px] border-2 border-dashed border-[var(--codiq-warning)] bg-[var(--codiq-warning-soft)] p-4" data-testid="market-pay-test-gateway">
          <p className="text-xs font-bold text-[var(--codiq-warning)]">بوابة دفع تجريبيّة — لا تُسحب أيّ أموال. في الإنتاج تظهر هنا صفحة البنك.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={() => void answer("approve")} className="rounded-full bg-[var(--codiq-accent)] py-2.5 text-sm font-black text-[var(--codiq-surface)]" data-testid="market-pay-approve">ادفع {iqd(payment.amountIqd)}</button>
            <button type="button" disabled={busy} onClick={() => void answer("decline")} className="rounded-full border border-[var(--codiq-danger)] py-2.5 text-sm font-bold text-[var(--codiq-danger)]" data-testid="market-pay-decline">رفض البطاقة</button>
          </div>
        </section>
      ) : null}
      {failure ? <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
      {payment.order ? <Link href={`/orders/${payment.order.id}`} className="block rounded-full border border-[var(--codiq-accent)] py-2.5 text-center text-sm font-bold text-[var(--codiq-accent)]" data-testid="market-pay-order">عرض الطلب</Link> : null}
    </div>
  );
}

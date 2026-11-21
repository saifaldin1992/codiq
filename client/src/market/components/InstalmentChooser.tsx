/**
 * Marketplace M13a (F9) — «أقساط» at checkout: each lender's answer for this
 * order (an account, enough capacity, the fewest months), the terms with their
 * monthly amount, then a code the lender sends to confirm. The plan covers the
 * goods; the delivery fee is paid in cash at the door.
 */
import { useState } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { accountCall } from "../market-shopper";
import { iqd } from "../market-products";

export type InstalmentOffer = {
  goodsIqd: number;
  cashPrice: boolean;
  deliveryPaidInCash: boolean;
  lenders: { id: string; name: string; available: boolean; reason: string | null; capacityIqd: number | null; minMonths: number; terms: { months: number; monthlyIqd: number; feeIqd: number; totalIqd: number }[] }[];
};
export type InstalmentPlan = { paymentId: string; lender: string; months: number; monthlyIqd: number; feeIqd: number; totalIqd: number; sentTo: string };

type Props = {
  slug: string;
  offer: InstalmentOffer;
  request: { addressId: string | null; fulfilment: "delivery" | "pickup"; couponCode: string | null; platformCouponWalletId: string | null };
  plan: InstalmentPlan | null;
  onPlan: (plan: InstalmentPlan | null) => void;
  code: string;
  onCode: (code: string) => void;
};

export function InstalmentChooser({ slug, offer, request, plan, onPlan, code, onCode }: Props) {
  const [lenderId, setLenderId] = useState<string | null>(offer.lenders.find((entry) => entry.available)?.id ?? null);
  const [months, setMonths] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const chosen = offer.lenders.find((entry) => entry.id === lenderId) ?? null;

  async function sendCode() {
    if (!chosen || !months) return;
    setSending(true); setFailure(null);
    try {
      onPlan(await accountCall<InstalmentPlan>(`/api/market/checkout/${encodeURIComponent(slug)}/instalments`, { method: "POST", body: JSON.stringify({ lender: chosen.id, months, ...request }) }));
      onCode("");
    } catch (error) { setFailure((error as Error).message); onPlan(null); } finally { setSending(false); }
  }

  return (
    <div className="space-y-3 rounded-2xl bg-[var(--codiq-surface-sunken)] p-3" data-testid="market-instalments">
      <p className="text-xs text-[var(--codiq-text-secondary)]">يُقسَّط ثمن المنتجات {iqd(offer.goodsIqd)}{offer.cashPrice ? " — بسعر الكاش بلا رسوم" : ""}. رسوم التوصيل تُدفع نقداً عند الاستلام.</p>
      <div className="space-y-2">
        {offer.lenders.map((entry) => (
          <label key={entry.id} className={`block rounded-2xl border p-3 ${lenderId === entry.id ? "border-[var(--codiq-accent)] bg-[var(--codiq-surface)]" : "border-[var(--codiq-border)]"} ${entry.available ? "" : "opacity-60"}`} data-testid={`market-instalments-lender-${entry.id}`}>
            <span className="flex items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
              <input type="radio" name="lender" disabled={!entry.available} checked={lenderId === entry.id} onChange={() => { setLenderId(entry.id); setMonths(null); onPlan(null); }} />
              {entry.name}
            </span>
            {entry.available ? <span className="text-[11px] text-[var(--codiq-text-muted)]">السعة المتاحة {iqd(entry.capacityIqd ?? 0)} · أقلّ مدّة {entry.minMonths.toLocaleString("ar-IQ")} أشهر</span> : <span className="text-[11px] text-[var(--codiq-danger)]" data-testid="market-instalments-reason">{entry.reason}</span>}
          </label>
        ))}
      </div>
      {chosen?.available ? (
        <div className="grid grid-cols-2 gap-2" data-testid="market-instalments-terms">
          {chosen.terms.map((term) => (
            <button key={term.months} type="button" aria-pressed={months === term.months} onClick={() => { setMonths(term.months); onPlan(null); }} className={`rounded-2xl border p-2 text-right ${months === term.months ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)]" : "border-[var(--codiq-border)] bg-[var(--codiq-surface)]"}`} data-testid={`market-instalments-term-${term.months}`}>
              <span className="block text-xs font-bold text-[var(--codiq-text)]">{term.months.toLocaleString("ar-IQ")} أشهر</span>
              <span className="block text-sm font-black text-[var(--codiq-accent)]">{iqd(term.monthlyIqd)} / شهر</span>
              <span className="text-[10px] text-[var(--codiq-text-muted)]">{term.feeIqd ? `رسوم ${iqd(term.feeIqd)} · الإجماليّ ${iqd(term.totalIqd)}` : "بلا رسوم"}</span>
            </button>
          ))}
        </div>
      ) : null}
      {chosen?.available && months && !plan ? (
        <button type="button" onClick={() => void sendCode()} disabled={sending} className="w-full rounded-full border border-[var(--codiq-accent)] py-2 text-xs font-bold text-[var(--codiq-accent)]" data-testid="market-instalments-send">
          {sending ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} أرسل رمز التأكيد من {chosen.name}
        </button>
      ) : null}
      {plan ? (
        <div className="space-y-2" data-testid="market-instalments-plan">
          <p className="text-xs font-semibold text-[var(--codiq-text)]">{plan.months.toLocaleString("ar-IQ")} أشهر × {iqd(plan.monthlyIqd)} — أرسلنا الرمز إلى <span dir="ltr">{plan.sentTo}</span></p>
          <input value={code} onChange={(event) => onCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="رمز من ٦ أرقام" dir="ltr" className="w-full rounded-2xl border border-[var(--codiq-border)] px-3 py-2 text-center text-lg tracking-[0.4em]" data-testid="market-instalments-code" />
        </div>
      ) : null}
      {failure ? <p className="flex items-center gap-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-instalments-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
    </div>
  );
}

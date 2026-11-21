/**
 * MD-5 «محفظتي» (ق-70) — the one number a merchant opens this page for: what he
 * is owed right now, and when it will be paid.
 *
 * The window is printed on the card, never implied. «مستحقاتك» without a period
 * is a figure that will be misread — a merchant settled last week and a merchant
 * never settled would otherwise read the same sentence and mean different money.
 *
 * Nothing here is a promise about payment dates: `Settlement` carries no status
 * column, so this screen says what was recorded and stops. An invented «قيد
 * التحويل» would be a claim about money that nothing in the database backs (ق-10).
 */
import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Wallet } from "lucide-react";

type Wallet = {
  period: { from: string | null; to: string };
  lastSettlement: { id: string; periodTo: string; netPayoutIqd: number; createdAt: string } | null;
  pending: {
    completedOrders: number;
    reversedOrders: number;
    subtotalIqd: number;
    deliveryFeeIqd: number;
    loyaltyDiscountIqd: number;
    commissionIqd: number;
    netPayoutIqd: number;
  };
  lifetime: { settledCount: number; settledNetIqd: number };
};

const money = new Intl.NumberFormat("ar-IQ");
const day = (value: string) =>
  new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "long", day: "numeric" }).format(
    new Date(value)
  );

export function MerchantWalletCard() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch("/api/merchant/finance/wallet", {
          credentials: "same-origin",
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل المحفظة.");
        if (alive) {
          setWallet(body.wallet);
          setFailure(null);
        }
      } catch (error) {
        if (alive) setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (failure)
    return (
      <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
        <CircleAlert className="h-4 w-4" /> {failure}
      </p>
    );
  if (!wallet)
    return (
      <p className="text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ تحميل محفظتك…
      </p>
    );

  const { pending, lastSettlement, lifetime } = wallet;
  // A negative balance is possible and must read as itself: returns recorded
  // after a settlement are carried into the NEXT one rather than rewriting a
  // period that was already paid.
  const owed = pending.netPayoutIqd;

  return (
    <section className="rounded-3xl bg-gradient-to-l from-[var(--codiq-accent-strong)] to-[var(--codiq-accent)] px-5 py-5 text-white shadow-sm sm:px-6 sm:py-6">
      <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-white/80">
        <Wallet className="h-4 w-4" /> محفظتي
      </p>
      <p className="mt-2 text-3xl font-black tabular-nums sm:text-4xl">
        {money.format(owed)} <span className="text-lg font-bold">د.ع</span>
      </p>
      <p className="mt-1 text-[13px] font-semibold text-white/85">
        {owed < 0
          ? "رصيد سالب: إرجاعات بعد آخر تسوية ستُخصم من التسوية القادمة."
          : "مستحقاتك غير المسوّاة حتى الآن — هذا ما ستتضمنه تسويتك القادمة."}
      </p>
      <p className="mt-0.5 text-xs text-white/70">
        {wallet.period.from
          ? `عن الفترة منذ ${day(wallet.period.from)} حتى اليوم`
          : "منذ بداية نشاطك على المنصة — لم تُسجَّل لك تسوية بعد"}
      </p>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        {[
          { label: "مبيعات الفترة", value: `${money.format(pending.subtotalIqd)} د.ع` },
          { label: "أجور التوصيل", value: `${money.format(pending.deliveryFeeIqd)} د.ع` },
          // 19-د: shown only when it exists, because a merchant without a points
          // programme must not read a line that is always zero — but when it
          // does exist the parts have to add up to the headline, or the card is
          // arithmetic the merchant cannot follow.
          ...(pending.loyaltyDiscountIqd
            ? [{ label: "خصم النقاط", value: `− ${money.format(pending.loyaltyDiscountIqd)} د.ع` }]
            : []),
          { label: "عمولة المنصة", value: `− ${money.format(pending.commissionIqd)} د.ع` },
        ].map((part) => (
          <div key={part.label} className="rounded-2xl bg-white/10 px-3.5 py-2.5">
            <p className="text-[11px] font-semibold text-white/70">{part.label}</p>
            <p className="mt-0.5 text-sm font-bold tabular-nums">{part.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-white/15 pt-3 text-xs text-white/80">
        <span>
          طلبات مكتملة في الفترة:{" "}
          <b className="font-bold tabular-nums">{money.format(pending.completedOrders)}</b>
          {pending.reversedOrders > 0 ? (
            <>
              {" "}
              · مُرجَعة:{" "}
              <b className="font-bold tabular-nums">{money.format(pending.reversedOrders)}</b>
            </>
          ) : null}
        </span>
        {lastSettlement ? (
          <span>
            آخر تسوية:{" "}
            <b className="font-bold tabular-nums">
              {money.format(lastSettlement.netPayoutIqd)} د.ع
            </b>{" "}
            بتاريخ {day(lastSettlement.createdAt)}
          </span>
        ) : null}
        {lifetime.settledCount > 0 ? (
          <span>
            إجمالي ما استُلم:{" "}
            <b className="font-bold tabular-nums">{money.format(lifetime.settledNetIqd)} د.ع</b> عبر{" "}
            {money.format(lifetime.settledCount)} تسوية
          </span>
        ) : null}
      </div>
    </section>
  );
}

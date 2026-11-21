/**
 * CD-5 — redeeming points at checkout.
 *
 * The control is ABSENT when the programme is off or the balance is zero: an
 * empty points box on a checkout page is a question the shopper cannot answer
 * and a reminder that he has nothing.
 *
 * The balance is shown in MONEY beside the points, because «300 نقطة» is not a
 * quantity anyone can reason about until it is «3000 دينار». And the input is
 * capped at his balance, so the common mistake — asking to spend more than he
 * has — is prevented rather than refused after he presses.
 *
 * LOY-1 — THE MONEY IS EXACT, NOT AN ESTIMATE.
 *
 * A point now carries the value it was EARNED at, so there is no single rate to
 * multiply by: a shopper who earned before a rate cut holds points worth more
 * than the ones he earned after it, and both are his. `quote` below walks his
 * lots oldest-first — the same queue, in the same order, under the same cap the
 * server walks in `previewLoyaltyRedemption` — so the figure on this panel is
 * the discount the checkout will actually apply. A number here that the till
 * then contradicts is worse than no number at all.
 */
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { storefrontApi } from "@/lib/storefront-api";

const money = new Intl.NumberFormat("ar-IQ");

type Lot = { points: number; pointValueIqd: number };

/**
 * The value of the first `points` points in the queue, bounded by what is left
 * to pay for goods. Mirrors the server walk exactly, STOP included: the queue
 * halts at a lot the order can no longer afford instead of skipping to a cheaper
 * one, so his oldest points are never stranded behind a single expensive one.
 */
function quote(
  lots: readonly Lot[],
  points: number,
  payableForGoodsIqd: number
): { points: number; discountIqd: number } {
  let payableLeft = Math.max(0, payableForGoodsIqd);
  let taken = 0;
  let discountIqd = 0;
  for (const lot of lots) {
    if (taken >= points) break;
    const affordable = Math.floor(payableLeft / lot.pointValueIqd);
    if (affordable <= 0) break;
    const take = Math.min(lot.points, points - taken, affordable);
    taken += take;
    discountIqd += take * lot.pointValueIqd;
    payableLeft -= take * lot.pointValueIqd;
  }
  return { points: taken, discountIqd };
}

export function LoyaltyRedeem({
  slug,
  payableForGoodsIqd,
  onChange,
  onDiscount,
}: {
  slug: string;
  payableForGoodsIqd: number;
  onChange: (points: number) => void;
  onDiscount: (discountIqd: number) => void;
}) {
  const [state, setState] = useState<{
    balance: number;
    balanceValueIqd: number;
    lots: Lot[];
  } | null>(null);
  const [points, setPoints] = useState(0);

  useEffect(() => {
    let alive = true;
    void storefrontApi
      .loyalty(slug)
      .then((data) => {
        if (!alive || !data.enabled || data.balance <= 0) return;
        setState({ balance: data.balance, balanceValueIqd: data.balanceValueIqd, lots: data.lots });
      })
      // A points panel that fails to load must never block a checkout.
      .catch(() => {
        /* stays hidden */
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  // The cap moves as the cart and the coupon move, so the quote is recomputed
  // from the same inputs the server will see rather than remembered from the
  // moment he typed.
  const applied = state
    ? quote(state.lots, points, payableForGoodsIqd)
    : { points: 0, discountIqd: 0 };
  useEffect(() => {
    onDiscount(applied.discountIqd);
  }, [applied.discountIqd, onDiscount]);

  if (!state) return null;

  function apply(next: number) {
    const bounded = Math.max(0, Math.min(Math.floor(next) || 0, state!.balance));
    setPoints(bounded);
    onChange(bounded);
  }

  return (
    <section className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-3.5">
      <p className="flex items-center gap-2 text-sm font-bold text-[var(--storefront-text)]">
        <Sparkles className="h-4 w-4 text-[var(--storefront-accent)]" aria-hidden="true" /> نقاطك
      </p>
      <p className="mt-0.5 text-[13px] text-[var(--storefront-muted)]">
        لديك <b className="font-bold">{money.format(state.balance)}</b> نقطة، تساوي{" "}
        <b className="font-bold">{money.format(state.balanceValueIqd)}</b> دينار.
      </p>
      <label className="mt-2 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-[var(--storefront-text)]">
        <span>اصرف</span>
        <input
          type="number"
          min={0}
          max={state.balance}
          step={1}
          value={points}
          onChange={(event) => apply(Number(event.target.value))}
          className="w-28 rounded-xl border border-[var(--storefront-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-sm tabular-nums outline-none focus:border-[var(--storefront-accent)]"
          aria-label={`النقاط المصروفة، بحد أقصى ${state.balance}`}
        />
        <span>نقطة</span>
        <button
          type="button"
          onClick={() => apply(state.balance)}
          className="rounded-xl px-2 py-1 text-[12px] font-bold text-[var(--storefront-accent)] hover:underline"
        >
          اصرفها كلها
        </button>
      </label>
      {applied.discountIqd > 0 ? (
        <p className="mt-1.5 text-[13px] font-bold text-[var(--codiq-success)]">
          خصم {money.format(applied.discountIqd)} دينار على قيمة المنتجات
          {/* Said plainly, because it is the question every shopper asks next. */}
          <span className="font-normal text-[var(--storefront-muted)]">
            {" "}
            — أجور التوصيل تُدفع نقداً كالمعتاد
          </span>
        </p>
      ) : null}
      {points > applied.points ? (
        // He asked for more than this order can absorb. Said out loud, because
        // the alternative is a number that quietly disagrees with the total.
        <p className="mt-1.5 text-[13px] text-[var(--storefront-muted)]">
          هذا الطلب يستوعب {money.format(applied.points)} نقطة فقط، والباقي يبقى في رصيدك.
        </p>
      ) : null}
    </section>
  );
}

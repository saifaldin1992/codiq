/**
 * Marketplace M8b — «الكوبونات» (the market's coupons and «كوبوناتي»), one
 * coupon's page with the stores it works in, and «نقاطي» with the tier and
 * coupons to buy with points.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { CircleAlert, Copy, Crown, Gift, LoaderCircle, Ticket } from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { marketGet } from "../market-api";
import { iqd } from "../market-products";
import type { MarketStoreCard } from "../market-types";
import { useMarketList } from "../use-market-list";
import { StoreListRow } from "../components/StoreCards";
import { MarketEmptyState } from "../MarketEmptyState";
import { MarketSignIn } from "./MarketAccountPages";

type Coupon = { id: string; code: string; title: string; description: string | null; kind: "percent" | "fixed"; percentOff: number | null; amountOffIqd: number | null; maxDiscountIqd: number | null; minSubtotalIqd: number; startsAt: string; endsAt: string; pointsCost: number; allStores: boolean; remaining: number | null };
type Held = { walletId: string; source: string; usedAt: string | null; usedOrderId: string | null; heldSince: string; coupon: Coupon };

const tab = (on: boolean) => `rounded-full px-3 py-1.5 text-xs font-bold ${on ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`;
const worth = (coupon: Coupon) => (coupon.kind === "percent" ? `خصم ${coupon.percentOff?.toLocaleString("ar-IQ")}%${coupon.maxDiscountIqd ? ` حتّى ${iqd(coupon.maxDiscountIqd)}` : ""}` : `خصم ${iqd(coupon.amountOffIqd ?? 0)}`);
const until = (iso: string) => new Date(iso).toLocaleDateString("ar-IQ", { day: "numeric", month: "long" });

function CouponCard({ coupon, action, faded }: { coupon: Coupon; action?: React.ReactNode; faded?: boolean }) {
  return (
    <div className={`flex items-stretch overflow-hidden rounded-[22px] bg-[var(--codiq-surface)] shadow-sm ${faded ? "opacity-60" : ""}`} data-testid={`market-coupon-${coupon.code}`}>
      <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-1 bg-[var(--codiq-accent-soft)] p-2 text-center text-[var(--codiq-accent)]"><Ticket className="h-6 w-6" /><span className="text-xs font-black">{coupon.kind === "percent" ? `${coupon.percentOff?.toLocaleString("ar-IQ")}%` : iqd(coupon.amountOffIqd ?? 0)}</span></div>
      <div className="min-w-0 flex-1 space-y-1 p-3">
        <Link href={`/coupons/${encodeURIComponent(coupon.code)}`} className="block text-sm font-black text-[var(--codiq-text)]">{coupon.title}</Link>
        <p className="text-[11px] text-[var(--codiq-text-secondary)]">{worth(coupon)}{coupon.minSubtotalIqd ? ` — لطلب من ${iqd(coupon.minSubtotalIqd)}` : ""}{coupon.allStores ? "" : " — في متاجر محدّدة"}</p>
        <p className="text-[10px] text-[var(--codiq-text-muted)]">صالح حتّى {until(coupon.endsAt)}{coupon.remaining !== null ? ` — بقي ${coupon.remaining.toLocaleString("ar-IQ")}` : ""}</p>
        {action}
      </div>
    </div>
  );
}

export function MarketCouponsPage() {
  const { shopper } = useShopper();
  const which = new URLSearchParams(useSearch()).get("tab") ?? "offers";
  const [, navigate] = useLocation();
  const [offers, setOffers] = useState<{ free: (Coupon & { claimed: boolean })[]; forPoints: Coupon[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(() => marketGet<{ free: (Coupon & { claimed: boolean })[]; forPoints: Coupon[] }>("/api/market/coupons").then(setOffers).catch((error: Error) => setFailure(error.message)), []);
  useEffect(() => { void load(); }, [load, shopper]);
  const walletTab = which === "used" || which === "expired" ? which : "active";
  const held = useMarketList<Held>(shopper && which !== "offers" ? `/api/market/me/coupons?tab=${walletTab}` : null, "coupons");
  async function claim(code: string) {
    if (!shopper) { navigate("/account"); return; }
    try { await accountCall(`/api/market/coupons/${encodeURIComponent(code)}/claim`, { method: "POST" }); setFailure(null); await load(); } catch (error) { setFailure((error as Error).message); }
  }
  return (
    <div className="space-y-4" data-testid="market-coupons">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">الكوبونات</h1>
      <div className="flex flex-wrap gap-2">
        {[["offers", "المتاحة"], ["active", "كوبوناتي"], ["used", "المستخدمة"], ["expired", "المنتهية"]].map(([value, label]) => <button key={value} type="button" aria-pressed={which === value || (value === "active" && which === "active")} onClick={() => navigate(value === "offers" ? "/coupons" : `/coupons?tab=${value}`)} className={tab(which === value)} data-testid={`market-coupons-tab-${value}`}>{label}</button>)}
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-coupons-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {which === "offers" ? (
        !offers ? <p className="text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : (
          <>
            {offers.free.length === 0 && offers.forPoints.length === 0 ? <MarketEmptyState icon={Ticket} title="لا كوبونات الآن" body="تابعنا، تُضاف كوبونات جديدة في المواسم والحملات." /> : null}
            <div className="space-y-3">
              {offers.free.map((coupon) => <CouponCard key={coupon.id} coupon={coupon} action={coupon.claimed ? <p className="text-[11px] font-bold text-[var(--codiq-success)]">في كوبوناتك</p> : <button type="button" onClick={() => void claim(coupon.code)} className="rounded-full bg-[var(--codiq-accent)] px-4 py-1.5 text-xs font-bold text-[var(--codiq-surface)]" data-testid={`market-coupon-claim-${coupon.code}`}>احصل عليه</button>} />)}
            </div>
            {offers.forPoints.length ? <><h2 className="text-base font-black text-[var(--codiq-text)]">استبدل نقاطك</h2><div className="space-y-3">{offers.forPoints.map((coupon) => <CouponCard key={coupon.id} coupon={coupon} action={<Link href="/points" className="text-[11px] font-bold text-[var(--codiq-accent)]">{coupon.pointsCost.toLocaleString("ar-IQ")} نقطة — من «نقاطي»</Link>} />)}</div></> : null}
          </>
        )
      ) : !shopper ? <MarketSignIn /> : (
        <>
          {!held.items ? <p className="text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
          {held.items?.length === 0 ? <MarketEmptyState icon={Gift} title="لا كوبونات هنا" body="احصل على كوبونات من «المتاحة» أو استبدل نقاطك." /> : null}
          <div className="space-y-3">{held.items?.map((entry) => <CouponCard key={entry.walletId} coupon={entry.coupon} faded={walletTab !== "active"} action={entry.usedOrderId ? <Link href={`/orders/${entry.usedOrderId}`} className="text-[11px] font-bold text-[var(--codiq-accent)]">استُخدم في طلب</Link> : walletTab === "active" ? <p className="text-[11px] text-[var(--codiq-text-muted)]">اختره عند إتمام الطلب</p> : null} />)}</div>
          {held.nextCursor ? <button type="button" onClick={() => void held.loadMore()} className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]">عرض المزيد</button> : null}
        </>
      )}
    </div>
  );
}

export function MarketCouponPage() {
  const { code = "" } = useParams<{ code: string }>();
  const { shopper } = useShopper();
  const [, navigate] = useLocation();
  const [page, setPage] = useState<{ coupon: Coupon & { claimed: boolean; running: boolean }; stores: MarketStoreCard[] | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => marketGet<typeof page & object>(`/api/market/coupons/${encodeURIComponent(code)}`).then(setPage).catch((error: Error) => setFailure(error.message)), [code]);
  useEffect(() => { void load(); }, [load, shopper]);
  if (failure && !page) return <MarketEmptyState icon={Ticket} title="الكوبون غير متاح" body={failure} />;
  if (!page) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  const { coupon } = page;
  async function claim() {
    if (!shopper) { navigate("/account"); return; }
    try { await accountCall(`/api/market/coupons/${encodeURIComponent(coupon.code)}/claim`, { method: "POST" }); await load(); } catch (error) { setFailure((error as Error).message); }
  }
  return (
    <div className="space-y-4" data-testid="market-coupon-page">
      <section className="space-y-2 rounded-[26px] bg-[var(--codiq-accent)] p-5 text-center text-[var(--codiq-surface)] shadow-sm">
        <Ticket className="mx-auto h-8 w-8" />
        <h1 className="text-xl font-black">{coupon.title}</h1>
        <p className="text-sm">{worth(coupon)}{coupon.minSubtotalIqd ? ` — لطلب من ${iqd(coupon.minSubtotalIqd)}` : ""}</p>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(coupon.code).then(() => setCopied(true)); }} className="mx-auto inline-flex items-center gap-1 rounded-full bg-[var(--codiq-surface)] px-4 py-1.5 font-mono text-sm font-black text-[var(--codiq-accent)]" dir="ltr"><Copy className="h-4 w-4" /> {coupon.code}</button>
        {copied ? <p className="text-[11px]">نُسخ الرمز</p> : null}
        <p className="text-xs opacity-90">صالح حتّى {until(coupon.endsAt)}</p>
      </section>
      {coupon.description ? <p className="rounded-[20px] bg-[var(--codiq-surface)] p-4 text-xs leading-6 text-[var(--codiq-text-secondary)]">{coupon.description}</p> : null}
      {coupon.pointsCost > 0 ? <Link href="/points" className="block rounded-full bg-[var(--codiq-accent)] py-3 text-center text-sm font-bold text-[var(--codiq-surface)]">استبدله بـ {coupon.pointsCost.toLocaleString("ar-IQ")} نقطة</Link>
        : coupon.claimed ? <p className="rounded-full bg-[var(--codiq-success-soft)] py-3 text-center text-sm font-bold text-[var(--codiq-success)]">في كوبوناتك — اختره عند إتمام الطلب</p>
        : <button type="button" onClick={() => void claim()} className="w-full rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-bold text-[var(--codiq-surface)]" data-testid="market-coupon-page-claim">احصل عليه</button>}
      {failure ? <p className="text-center text-xs text-[var(--codiq-danger)]">{failure}</p> : null}
      <section className="space-y-2">
        <h2 className="text-base font-black text-[var(--codiq-text)]">{page.stores ? "يعمل في هذه المتاجر" : "يعمل في كلّ متاجر السوق"}</h2>
        {page.stores ? <div className="space-y-3" data-testid="market-coupon-stores">{page.stores.map((store) => <StoreListRow key={store.slug} store={store} />)}</div> : null}
      </section>
    </div>
  );
}

type Points = {
  balance: number; owed: number; yearPoints: number;
  tier: { code: string; label: string; multiplierPct: number };
  next: { code: string; label: string; minPoints: number; toNext: number } | null;
  tiers: { code: string; label: string; minPoints: number; multiplierPct: number }[];
  earnRule: { iqdPerPoint: number };
  history: { id: string; delta: number; label: string; orderId: string | null; createdAt: string }[];
  nextCursor: string | null;
};

export function MarketPointsPage() {
  const { status, shopper } = useShopper();
  const [points, setPoints] = useState<Points | null>(null);
  const [shop, setShop] = useState<Coupon[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setPoints(await accountCall<Points>("/api/market/me/points"));
      setShop((await marketGet<{ forPoints: Coupon[] }>("/api/market/coupons")).forPoints);
    } catch (error) { setFailure((error as Error).message); }
  }, []);
  useEffect(() => { if (shopper) void load(); }, [shopper, load]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  if (!points) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  async function redeem(coupon: Coupon) {
    try {
      await accountCall("/api/market/points/redeem", { method: "POST", body: JSON.stringify({ couponId: coupon.id }) });
      setNotice(`أُضيف «${coupon.title}» إلى كوبوناتك.`); setFailure(null); await load();
    } catch (error) { setFailure((error as Error).message); setNotice(null); }
  }
  const progress = points.next ? Math.min(100, Math.round(((points.yearPoints - (points.tiers.find((tier) => tier.code === points.tier.code)?.minPoints ?? 0)) / (points.next.minPoints - (points.tiers.find((tier) => tier.code === points.tier.code)?.minPoints ?? 0))) * 100)) : 100;
  return (
    <div className="space-y-4" data-testid="market-points">
      <section className="space-y-2 rounded-[26px] bg-[var(--codiq-accent)] p-5 text-[var(--codiq-surface)] shadow-sm">
        <p className="inline-flex items-center gap-1 text-xs font-bold opacity-90"><Crown className="h-4 w-4" /> مستوى {points.tier.label}{points.tier.multiplierPct > 100 ? ` — نقاطك ×${(points.tier.multiplierPct / 100).toLocaleString("ar-IQ")}` : ""}</p>
        <p className="text-3xl font-black" data-testid="market-points-balance">{points.balance.toLocaleString("ar-IQ")} <span className="text-sm font-bold">نقطة</span></p>
        {points.owed ? <p className="text-xs">عليك {points.owed.toLocaleString("ar-IQ")} نقطة من طلب مُرجع، تُخصم من نقاطك القادمة.</p> : null}
        {points.next ? (
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-[var(--codiq-surface)]/30"><div className="h-2 rounded-full bg-[var(--codiq-surface)]" style={{ width: `${progress}%` }} /></div>
            <p className="text-[11px] opacity-90">{points.next.toNext.toLocaleString("ar-IQ")} نقطة إلى مستوى {points.next.label}</p>
          </div>
        ) : <p className="text-[11px] opacity-90">أعلى مستوى — شكراً لك.</p>}
      </section>
      <p className="rounded-[20px] bg-[var(--codiq-surface)] p-3 text-xs text-[var(--codiq-text-secondary)]">تكسب نقطة عن كلّ {points.earnRule.iqdPerPoint.toLocaleString("ar-IQ")} دينار تدفعها ثمناً للمنتجات، عند استلام الطلب، ومضاعفة حسب مستواك.</p>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-points-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="rounded-2xl bg-[var(--codiq-success-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-success)]" data-testid="market-points-notice">{notice}</p> : null}
      {shop.length ? (
        <section className="space-y-2">
          <h2 className="text-base font-black text-[var(--codiq-text)]">استبدل نقاطك</h2>
          {shop.map((coupon) => <CouponCard key={coupon.id} coupon={coupon} action={<button type="button" disabled={points.balance < coupon.pointsCost} onClick={() => void redeem(coupon)} className="rounded-full bg-[var(--codiq-accent)] px-4 py-1.5 text-xs font-bold text-[var(--codiq-surface)] disabled:opacity-50" data-testid={`market-points-redeem-${coupon.code}`}>استبدل بـ {coupon.pointsCost.toLocaleString("ar-IQ")} نقطة</button>} />)}
        </section>
      ) : null}
      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <h2 className="text-sm font-black text-[var(--codiq-text)]">المستويات</h2>
        <ul className="grid grid-cols-2 gap-2">{points.tiers.map((tier) => <li key={tier.code} className={`rounded-2xl p-2 text-xs ${tier.code === points.tier.code ? "bg-[var(--codiq-accent-soft)] font-bold text-[var(--codiq-accent)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}>{tier.label} — من {tier.minPoints.toLocaleString("ar-IQ")} نقطة{tier.multiplierPct > 100 ? ` (×${(tier.multiplierPct / 100).toLocaleString("ar-IQ")})` : ""}</li>)}</ul>
      </section>
      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-points-history">
        <h2 className="text-sm font-black text-[var(--codiq-text)]">سجلّ النقاط</h2>
        {points.history.length === 0 ? <p className="text-xs text-[var(--codiq-text-muted)]">لا حركة بعد.</p> : (
          <ul className="divide-y divide-[var(--codiq-border)]">{points.history.map((row) => <li key={row.id} className="flex justify-between gap-2 py-2 text-xs"><span><span className="block text-[var(--codiq-text)]">{row.label}</span><span className="text-[10px] text-[var(--codiq-text-muted)]">{new Date(row.createdAt).toLocaleDateString("ar-IQ")}</span></span><span className={`font-black ${row.delta > 0 ? "text-[var(--codiq-success)]" : "text-[var(--codiq-danger)]"}`}>{row.delta > 0 ? "+" : ""}{row.delta.toLocaleString("ar-IQ")}</span></li>)}</ul>
        )}
      </section>
    </div>
  );
}

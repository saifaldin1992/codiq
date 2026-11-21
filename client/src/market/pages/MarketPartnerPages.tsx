/**
 * Marketplace M13b — the partner app on the market's side.
 *
 *   /partner?token=…&next=/…   the partner opens the market here; the signed
 *                              token is exchanged for a session, then on to `next`.
 *   PartnerLinkCard            «مربوط بـ… · آخر مزامنة» on the account page.
 *   PartnerPayButton           at checkout: a payment link, opened in the
 *                              partner app, and the order once it is paid.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { CircleAlert, ExternalLink, Link2, LoaderCircle, Wallet } from "lucide-react";
import { accountCall, setShopper } from "../market-shopper";
import { refreshCart } from "../market-cart";
import { iqd } from "../market-products";
import type { Shopper } from "../market-shopper";

export type PartnerLink = { name: string; linked: boolean; linkedAt: string | null; lastSyncedAt: string | null } | null;

/** Only a path inside the market — never another site. */
const safeNext = (raw: string | null) => (raw && /^\/[a-z0-9/_-]*$/i.test(raw) && !raw.startsWith("//") ? raw : "/");

export function MarketPartnerEnterPage() {
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const [failure, setFailure] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get("token");
    if (!token) { setFailure("رابط الدخول ناقص — افتح السوق من التطبيق مجدداً."); return; }
    // The token leaves the address bar before anything else happens.
    window.history.replaceState(null, "", window.location.pathname);
    void accountCall<{ shopper: Shopper }>("/api/market/partner/enter", { method: "POST", body: JSON.stringify({ token }) })
      .then((body) => { setShopper(body.shopper); navigate(safeNext(params.get("next")), { replace: true }); })
      .catch((error: Error) => setFailure(error.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-3 py-10 text-center" data-testid="market-partner-enter">
      {failure ? <p className="flex items-center justify-center gap-2 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="market-partner-enter-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> ندخلك إلى السوق…</p>}
    </div>
  );
}

export function PartnerLinkCard() {
  const [link, setLink] = useState<PartnerLink | undefined>(undefined);
  useEffect(() => { void accountCall<{ partner: PartnerLink }>("/api/market/me/partner").then((body) => setLink(body.partner)).catch(() => setLink(null)); }, []);
  if (!link) return null;
  async function unlink() {
    try { setLink((await accountCall<{ partner: PartnerLink }>("/api/market/me/partner", { method: "DELETE" })).partner); } catch { /* the card stays as it was */ }
  }
  return (
    <section className="flex items-center justify-between gap-3 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-partner-card">
      <span className="flex items-center gap-2 text-sm">
        <Link2 className="h-5 w-5 text-[var(--codiq-accent)]" />
        {link.linked ? <span><span className="block font-bold text-[var(--codiq-text)]">مربوط بـ{link.name}</span><span className="text-[11px] text-[var(--codiq-text-muted)]" data-testid="market-partner-synced">آخر مزامنة {link.lastSyncedAt ? new Date(link.lastSyncedAt).toLocaleString("ar-IQ", { timeZone: "Asia/Baghdad" }) : "—"}</span></span>
          : <span className="text-[var(--codiq-text-secondary)]">افتح السوق من داخل {link.name} لربط حسابك.</span>}
      </span>
      {link.linked ? <button type="button" onClick={() => void unlink()} className="text-xs font-bold text-[var(--codiq-danger)]" data-testid="market-partner-unlink">فكّ الربط</button> : null}
    </section>
  );
}

type Link = { linkId: string; partner: string; amountIqd: number; expiresAt: string; deepLink: string };
type LinkStatus = { status: string; refusal: string | null; orderId: string | null };
const REFUSALS: Record<string, string> = { CART_CHANGED: "تغيّرت سلّتك بعد إنشاء الرابط — أنشئ رابطاً جديداً.", OUT_OF_STOCK: "نفد أحد المنتجات — راجع سلّتك.", AMOUNT_MISMATCH: "المبلغ المدفوع لا يطابق الطلب — سيعيده التطبيق.", ACCOUNT_MISMATCH: "دُفع الرابط من حساب آخر — سيعيد التطبيق المبلغ.", LINK_EXPIRED: "انتهت صلاحيّة الرابط — أنشئ رابطاً جديداً." };

export function PartnerPayButton({ slug, addressId, fulfilment, partnerName }: { slug: string; addressId: string | null; fulfilment: "delivery" | "pickup"; partnerName: string }) {
  const [, navigate] = useLocation();
  const [link, setLink] = useState<Link | null>(null);
  const [state, setState] = useState<LinkStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!link) return;
    const timer = window.setInterval(() => {
      void accountCall<{ link: LinkStatus }>(`/api/market/partner-links/${link.linkId}`).then(async (body) => {
        setState(body.link);
        if (body.link.status === "used" && body.link.orderId) { window.clearInterval(timer); await refreshCart(); navigate(`/orders/${body.link.orderId}?placed=1`); }
        if (["refused", "expired", "replaced"].includes(body.link.status)) window.clearInterval(timer);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [link, navigate]);
  async function create() {
    if (!addressId) return;
    setBusy(true); setFailure(null); setState(null);
    try { setLink(await accountCall<Link>(`/api/market/checkout/${encodeURIComponent(slug)}/partner-link`, { method: "POST", body: JSON.stringify({ addressId, fulfilment }) })); } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  const closed = state && ["refused", "expired", "replaced"].includes(state.status);
  return (
    <div className="space-y-2 rounded-2xl bg-[var(--codiq-surface-sunken)] p-3" data-testid="market-partner-pay">
      {!link || closed ? (
        <button type="button" onClick={() => void create()} disabled={busy || !addressId} className="w-full rounded-full bg-[var(--codiq-accent)] py-2.5 text-sm font-black text-[var(--codiq-surface)] disabled:opacity-50" data-testid="market-partner-pay-create">
          {busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : <Wallet className="ml-1 inline h-4 w-4" />} ادفع عبر {partnerName}
        </button>
      ) : (
        <>
          <a href={link.deepLink} className="flex items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-2.5 text-sm font-black text-[var(--codiq-surface)]" data-testid="market-partner-pay-open"><ExternalLink className="h-4 w-4" /> افتح {link.partner} وادفع {iqd(link.amountIqd)}</a>
          <p className="text-center text-[11px] text-[var(--codiq-text-muted)]" data-testid="market-partner-pay-waiting"><LoaderCircle className="ml-1 inline h-3 w-3 animate-spin" /> ننتظر تأكيد الدفع من التطبيق — الرابط صالح مرّة واحدة حتى {new Date(link.expiresAt).toLocaleTimeString("ar-IQ", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Baghdad" })}.</p>
        </>
      )}
      {closed ? <p className="text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-partner-pay-refused">{(state?.refusal && REFUSALS[state.refusal]) ?? "لم يكتمل الدفع عبر التطبيق."}</p> : null}
      {failure ? <p className="text-xs font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
    </div>
  );
}

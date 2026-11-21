/** طلباتي — every order across every store, and one order's story. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { CheckCircle2, LoaderCircle, MessageCircle, Package, Store, XCircle } from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { iqd } from "../market-products";
import { useMarketList } from "../use-market-list";
import { MarketSignIn } from "./MarketAccountPages";
import { MarketEmptyState } from "../MarketEmptyState";
import { OrderRatingForm, PendingRatingsStrip, type OrderRating, type RatingTag } from "./MarketRatingPages";

type OrderCard = { id: string; orderNumber: string; status: string; statusLabel: string; fulfilment: string; totalIqd: number; createdAt: string; store: { slug: string; name: string }; itemCount: number; preview: string[] };
const TABS = [{ value: "", label: "الكل" }, { value: "active", label: "الجارية" }, { value: "done", label: "المنتهية" }];
const TONE: Record<string, string> = {
  completed: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]",
  cancelled: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]",
  rejected: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]",
  returned: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]",
};

export function MarketOrdersPage() {
  const { status, shopper } = useShopper();
  const [tab, setTab] = useState("");
  const url = useMemo(() => (shopper ? `/api/market/orders?limit=20${tab ? `&status=${tab}` : ""}` : null), [shopper, tab]);
  const list = useMarketList<OrderCard>(url, "orders");
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  return (
    <div className="space-y-4" data-testid="market-orders">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">طلباتي</h1>
      <PendingRatingsStrip />
      <div className="flex gap-2">{TABS.map((entry) => <button key={entry.value} type="button" aria-pressed={tab === entry.value} onClick={() => setTab(entry.value)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${tab === entry.value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`}>{entry.label}</button>)}</div>
      {!list.items ? <p className="text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {list.items?.length === 0 ? <MarketEmptyState icon={Package} title="لا توجد طلبات هنا" body="جرّب تبويباً آخر أو ابدأ التسوّق من الرئيسيّة." /> : null}
      <ul className="space-y-3">
        {list.items?.map((order) => (
          <li key={order.id}>
            <Link href={`/orders/${order.id}`} className="block space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid={`market-order-${order.id}`}>
              <div className="flex items-center justify-between"><span className="flex items-center gap-1 text-sm font-black text-[var(--codiq-text)]"><Store className="h-4 w-4 text-[var(--codiq-accent)]" /> {order.store.name}</span><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE[order.status] ?? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"}`}>{order.statusLabel}</span></div>
              <p className="truncate text-xs text-[var(--codiq-text-secondary)]">{order.preview.join("، ")}{order.itemCount > order.preview.length ? ` و${(order.itemCount - order.preview.length).toLocaleString("ar-IQ")} منتج آخر` : ""}</p>
              <div className="flex justify-between text-xs text-[var(--codiq-text-muted)]"><span>طلب #{order.orderNumber} — {new Date(order.createdAt).toLocaleDateString("ar-IQ")}</span><span className="font-bold text-[var(--codiq-text)]">{iqd(order.totalIqd)}</span></div>
            </Link>
          </li>
        ))}
      </ul>
      {list.nextCursor ? <button type="button" onClick={() => void list.loadMore()} className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]">عرض المزيد</button> : null}
    </div>
  );
}

type OrderDetail = {
  id: string; orderNumber: string; status: string; statusLabel: string; fulfilment: string; createdAt: string;
  subtotalIqd: number; deliveryFeeIqd: number; discountIqd: number; loyaltyDiscountIqd: number; totalIqd: number; couponCode: string | null; paymentMethodCode: string;
  customerName: string; recipientPhone: string | null; governorateName: string | null; shippingAddressLine1: string | null; customerNote: string | null;
  store: { slug: string; name: string; supportWhatsapp: string | null; addressLine: string | null; latitude: number | null; longitude: number | null };
  items: { id: string; productId: string | null; productName: string; variantName: string | null; quantity: number; unitPriceIqd: number; lineTotalIqd: number; addons: { name: string; priceIqd: number }[] }[];
  timeline: { status: string; label: string; at: string }[];
  cancellable: boolean;
  rateable: boolean;
  rating: OrderRating | null;
};
type CancelReason = { code: string; label: string };
const STEPS = [{ key: "new", label: "الطلب" }, { key: "processing", label: "القبول" }, { key: "out_for_delivery", label: "التوصيل" }, { key: "completed", label: "التسليم" }];
const RANK: Record<string, number> = { new: 0, processing: 1, preparation: 1, out_for_delivery: 2, completed: 3 };

export function MarketOrderPage() {
  const { id = "" } = useParams<{ id: string }>();
  const placed = new URLSearchParams(useSearch()).get("placed") === "1";
  const { status, shopper } = useShopper();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [reasons, setReasons] = useState<CancelReason[]>([]);
  const [ratingTags, setRatingTags] = useState<RatingTag[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const load = useCallback(() => accountCall<{ order: OrderDetail; cancelReasons: CancelReason[]; ratingTags: RatingTag[] }>(`/api/market/orders/${encodeURIComponent(id)}`).then((body) => { setOrder(body.order); setReasons(body.cancelReasons ?? []); setRatingTags(body.ratingTags ?? []); }).catch((error: Error) => setFailure(error.message)), [id]);
  useEffect(() => { if (shopper) void load(); }, [shopper, load]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  if (failure) return <MarketEmptyState icon={Package} title="الطلب غير موجود" body={failure} action={<Link href="/orders" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">طلباتي</Link>} />;
  if (!order) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  const rank = RANK[order.status] ?? -1;
  const whatsapp = order.store.supportWhatsapp ? `https://wa.me/${order.store.supportWhatsapp.replace(/[^\d]/g, "")}?text=${encodeURIComponent(`مرحباً، بخصوص الطلب رقم ${order.orderNumber}`)}` : null;
  return (
    <div className="space-y-4" data-testid="market-order-page">
      {placed ? <div className="flex items-start gap-2 rounded-[22px] bg-[var(--codiq-success-soft)] p-4 text-[var(--codiq-success)]" data-testid="market-order-placed"><CheckCircle2 className="h-6 w-6 shrink-0" /><div><p className="text-sm font-black">تم استلام طلبك</p><p className="text-xs">سيتواصل معك المتجر لتأكيد التفاصيل.</p></div></div> : null}
      <Link href="/orders" className="text-xs font-bold text-[var(--codiq-accent)]">← طلباتي</Link>
      <section className="space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <div className="flex items-center justify-between"><p className="text-sm font-black text-[var(--codiq-text)]">طلب #{order.orderNumber}</p><span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-accent)]" data-testid="market-order-status">{order.statusLabel}</span></div>
        {rank >= 0 ? (
          <ol className="grid grid-cols-4 gap-1" data-testid="market-order-steps">
            {STEPS.map((step, at) => <li key={step.key} className="space-y-1 text-center"><span className={`block h-1.5 rounded-full ${at <= rank ? "bg-[var(--codiq-accent)]" : "bg-[var(--codiq-border)]"}`} /><span className={`text-[10px] ${at <= rank ? "font-bold text-[var(--codiq-text)]" : "text-[var(--codiq-text-muted)]"}`}>{step.label}</span></li>)}
          </ol>
        ) : null}
        <p className="text-xs text-[var(--codiq-text-muted)]">تاريخ الطلب: {new Date(order.createdAt).toLocaleString("ar-IQ")}</p>
      </section>
      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <Link href={`/s/${encodeURIComponent(order.store.slug)}`} className="flex items-center gap-1 text-sm font-black text-[var(--codiq-text)]"><Store className="h-4 w-4 text-[var(--codiq-accent)]" /> {order.store.name}</Link>
        <ul className="divide-y divide-[var(--codiq-border)]">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-2 py-2 text-xs">
              <span className="text-[var(--codiq-text)]">{item.productName}{item.variantName ? ` · ${item.variantName}` : ""} × {item.quantity.toLocaleString("ar-IQ")}{item.addons.length ? <span className="block text-[11px] text-[var(--codiq-text-muted)]">+ {item.addons.map((addon) => addon.name).join("، ")}</span> : null}</span>
              <span className="font-bold text-[var(--codiq-text)]">{iqd(item.lineTotalIqd)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-1.5 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-sm shadow-sm" data-testid="market-order-totals">
        <Line label="المجموع الفرعيّ" value={iqd(order.subtotalIqd)} />
        {order.discountIqd ? <Line label={`خصم الكوبون${order.couponCode ? ` (${order.couponCode})` : ""}`} value={`− ${iqd(order.discountIqd)}`} /> : null}
        {order.loyaltyDiscountIqd ? <Line label="خصم النقاط" value={`− ${iqd(order.loyaltyDiscountIqd)}`} /> : null}
        <Line label={order.fulfilment === "pickup" ? "الاستلام من المتجر" : "رسوم التوصيل"} value={order.deliveryFeeIqd ? iqd(order.deliveryFeeIqd) : "مجاناً"} />
        <div className="flex justify-between border-t border-[var(--codiq-border)] pt-2 text-base font-black text-[var(--codiq-text)]"><span>الإجماليّ</span><span>{iqd(order.totalIqd)}</span></div>
      </section>
      <section className="space-y-1 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-xs text-[var(--codiq-text-secondary)] shadow-sm">
        <p className="text-sm font-black text-[var(--codiq-text)]">{order.fulfilment === "pickup" ? "الاستلام من المتجر" : "التوصيل إلى"}</p>
        {order.fulfilment === "pickup"
          ? <p>{order.store.addressLine ?? "سيتواصل معك المتجر بموعد الاستلام."}{order.store.latitude !== null ? <> — <a href={`https://www.openstreetmap.org/?mlat=${order.store.latitude}&mlon=${order.store.longitude}#map=17/${order.store.latitude}/${order.store.longitude}`} target="_blank" rel="noopener noreferrer" className="font-bold text-[var(--codiq-accent)]">الاتجاهات</a></> : null}</p>
          : <p>{order.customerName} · {order.governorateName} — {order.shippingAddressLine1}</p>}
      </section>
      {order.rateable ? <OrderRatingForm key={order.id} orderId={order.id} items={order.items} fulfilment={order.fulfilment} tags={ratingTags} rating={order.rating} onSaved={(rating) => setOrder((current) => (current ? { ...current, rating } : current))} /> : null}
      {order.cancellable && reasons.length ? (
        cancelling
          ? <CancelOrderSheet orderId={order.id} reasons={reasons} onClose={() => setCancelling(false)} onCancelled={() => { setCancelling(false); void load(); }} />
          : <button type="button" onClick={() => setCancelling(true)} className="flex w-full items-center justify-center gap-2 rounded-full border border-[var(--codiq-danger)] bg-[var(--codiq-surface)] py-3 text-sm font-bold text-[var(--codiq-danger)]" data-testid="market-order-cancel"><XCircle className="h-4 w-4" /> إلغاء الطلب</button>
      ) : null}
      {whatsapp ? <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-3 text-sm font-bold text-[var(--codiq-text)]"><MessageCircle className="h-4 w-4" /> تواصل مع التاجر</a> : null}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-[var(--codiq-text-secondary)]"><span>{label}</span><span className="font-bold text-[var(--codiq-text)]">{value}</span></div>;
}

/** «إلغاء الطلب»: one reason from the list; «سبب آخر» asks for a few words. The store reads both on the order. */
function CancelOrderSheet({ orderId, reasons, onClose, onCancelled }: { orderId: string; reasons: CancelReason[]; onClose: () => void; onCancelled: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const needsNote = code === "other";
  const submit = async () => {
    if (!code || (needsNote && !note.trim())) return;
    setBusy(true); setProblem(null);
    try {
      await accountCall(`/api/market/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", body: JSON.stringify({ reasonCode: code, note: note.trim() || null }) });
      onCancelled();
    } catch (error) {
      setProblem((error as Error).message);
      // The store accepted it meanwhile: the page reloads to show where the order is now.
      if ((error as { code?: string }).code === "ORDER_NOT_CANCELLABLE") onCancelled();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-order-cancel-sheet">
      <p className="text-sm font-black text-[var(--codiq-text)]">لماذا تريد إلغاء الطلب؟</p>
      <div className="space-y-2" role="radiogroup" aria-label="سبب الإلغاء">
        {reasons.map((reason) => (
          <button key={reason.code} type="button" role="radio" aria-checked={code === reason.code} onClick={() => setCode(reason.code)} className={`block w-full rounded-2xl border px-3 py-2.5 text-start text-sm ${code === reason.code ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] font-bold text-[var(--codiq-accent)]" : "border-[var(--codiq-border)] text-[var(--codiq-text)]"}`} data-testid={`market-cancel-reason-${reason.code}`}>{reason.label}</button>
        ))}
      </div>
      <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={400} rows={2} placeholder={needsNote ? "اكتب سبب الإلغاء" : "ملاحظة للمتجر (اختياري)"} className="w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm" data-testid="market-cancel-note" />
      {problem ? <p className="text-xs text-[var(--codiq-danger)]">{problem}</p> : null}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onClose} className="rounded-full border border-[var(--codiq-border)] py-2.5 text-sm font-bold text-[var(--codiq-text)]">تراجع</button>
        <button type="button" disabled={!code || (needsNote && !note.trim()) || busy} onClick={() => void submit()} className="rounded-full bg-[var(--codiq-danger)] py-2.5 text-sm font-bold text-[var(--codiq-surface)] disabled:opacity-50" data-testid="market-cancel-confirm">{busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} تأكيد الإلغاء</button>
      </div>
    </section>
  );
}

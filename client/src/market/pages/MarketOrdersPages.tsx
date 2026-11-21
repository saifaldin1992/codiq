/** طلباتي — every order across every store, and one order's story. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import {
  CheckCircle2,
  LoaderCircle,
  MessageCircle,
  Package,
  Star,
  Store,
  Truck,
} from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { iqd } from "../market-products";
import { useMarketList } from "../use-market-list";
import { MarketSignIn } from "./MarketAccountPages";
import { MarketEmptyState } from "../MarketEmptyState";
import { OrderTicketLink } from "./MarketTicketsPages";
import {
  CancelOrder,
  HandoverCode,
  RateOrder,
  ReturnOrder,
  Stars,
  type AfterSales,
} from "../components/OrderAfterSales";

type OrderCard = {
  id: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  fulfilment: string;
  totalIqd: number;
  createdAt: string;
  store: { slug: string; name: string };
  itemCount: number;
  preview: string[];
};
const TABS = [
  { value: "", label: "الكل" },
  { value: "active", label: "الجارية" },
  { value: "done", label: "المنتهية" },
];
const TONE: Record<string, string> = {
  completed: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]",
  cancelled: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]",
  rejected: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]",
  returned: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]",
};

export function MarketOrdersPage() {
  const { status, shopper } = useShopper();
  const [tab, setTab] = useState("");
  const url = useMemo(
    () => (shopper ? `/api/market/orders?limit=20${tab ? `&status=${tab}` : ""}` : null),
    [shopper, tab]
  );
  const list = useMarketList<OrderCard>(url, "orders");
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  return (
    <div className="space-y-4" data-testid="market-orders">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">طلباتي</h1>
      <div className="flex gap-2">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-pressed={tab === entry.value}
            onClick={() => setTab(entry.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${tab === entry.value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {!list.items ? (
        <p className="text-center text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {list.items?.length === 0 ? (
        <MarketEmptyState
          icon={Package}
          title="لا توجد طلبات هنا"
          body="جرّب تبويباً آخر أو ابدأ التسوّق من الرئيسيّة."
        />
      ) : null}
      <ul className="space-y-3">
        {list.items?.map((order) => (
          <li key={order.id}>
            <Link
              href={`/orders/${order.id}`}
              className="block space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm"
              data-testid={`market-order-${order.id}`}
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-sm font-black text-[var(--codiq-text)]">
                  <Store className="h-4 w-4 text-[var(--codiq-accent)]" /> {order.store.name}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE[order.status] ?? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"}`}
                >
                  {order.statusLabel}
                </span>
              </div>
              <p className="truncate text-xs text-[var(--codiq-text-secondary)]">
                {order.preview.join("، ")}
                {order.itemCount > order.preview.length
                  ? ` و${(order.itemCount - order.preview.length).toLocaleString("ar-IQ")} منتج آخر`
                  : ""}
              </p>
              <div className="flex justify-between text-xs text-[var(--codiq-text-muted)]">
                <span>
                  طلب #{order.orderNumber} — {new Date(order.createdAt).toLocaleDateString("ar-IQ")}
                </span>
                <span className="font-bold text-[var(--codiq-text)]">{iqd(order.totalIqd)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {list.nextCursor ? (
        <button
          type="button"
          onClick={() => void list.loadMore()}
          className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]"
        >
          عرض المزيد
        </button>
      ) : null}
    </div>
  );
}

type OrderDetail = {
  id: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  fulfilment: string;
  createdAt: string;
  subtotalIqd: number;
  deliveryFeeIqd: number;
  discountIqd: number;
  loyaltyDiscountIqd: number;
  totalIqd: number;
  couponCode: string | null;
  paymentMethodCode: string;
  /** Marketplace M13a: the card payment or the instalment plan, when the order is paid online. */
  onlinePayment: {
    id: string;
    method: string;
    status: string;
    amountIqd: number;
    months: number | null;
    monthlyIqd: number | null;
    refundedIqd: number;
  } | null;
  customerName: string;
  recipientPhone: string | null;
  governorateName: string | null;
  shippingAddressLine1: string | null;
  customerNote: string | null;
  store: {
    slug: string;
    name: string;
    supportWhatsapp: string | null;
    addressLine: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  items: {
    id: string;
    productId: string | null;
    productName: string;
    variantName: string | null;
    quantity: number;
    unitPriceIqd: number;
    lineTotalIqd: number;
    addons: { name: string; priceIqd: number }[];
  }[];
  timeline: { status: string; label: string; at: string }[];
};
const STEPS = [
  { key: "new", label: "الطلب" },
  { key: "processing", label: "القبول" },
  { key: "out_for_delivery", label: "التوصيل" },
  { key: "completed", label: "التسليم" },
];
const RANK: Record<string, number> = {
  new: 0,
  processing: 1,
  preparation: 1,
  out_for_delivery: 2,
  completed: 3,
};

export function MarketOrderPage() {
  const { id = "" } = useParams<{ id: string }>();
  const placed = new URLSearchParams(useSearch()).get("placed") === "1";
  const { status, shopper } = useShopper();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [afterSales, setAfterSales] = useState<AfterSales | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(
    () =>
      accountCall<{ order: OrderDetail; afterSales: AfterSales }>(
        `/api/market/orders/${encodeURIComponent(id)}`
      )
        .then((body) => {
          setOrder(body.order);
          setAfterSales(body.afterSales);
        })
        .catch((error: Error) => setFailure(error.message)),
    [id]
  );
  useEffect(() => {
    if (shopper) void load();
  }, [shopper, load]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  if (failure)
    return (
      <MarketEmptyState
        icon={Package}
        title="الطلب غير موجود"
        body={failure}
        action={
          <Link
            href="/orders"
            className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]"
          >
            طلباتي
          </Link>
        }
      />
    );
  if (!order || !afterSales)
    return (
      <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );
  const rank = RANK[order.status] ?? -1;
  const whatsapp = order.store.supportWhatsapp
    ? `https://wa.me/${order.store.supportWhatsapp.replace(/[^\d]/g, "")}?text=${encodeURIComponent(`مرحباً، بخصوص الطلب رقم ${order.orderNumber}`)}`
    : null;
  return (
    <div className="space-y-4" data-testid="market-order-page">
      {placed ? (
        <div
          className="flex items-start gap-2 rounded-[22px] bg-[var(--codiq-success-soft)] p-4 text-[var(--codiq-success)]"
          data-testid="market-order-placed"
        >
          <CheckCircle2 className="h-6 w-6 shrink-0" />
          <div>
            <p className="text-sm font-black">تم استلام طلبك</p>
            <p className="text-xs">سيتواصل معك المتجر لتأكيد التفاصيل.</p>
          </div>
        </div>
      ) : null}
      <Link href="/orders" className="text-xs font-bold text-[var(--codiq-accent)]">
        ← طلباتي
      </Link>
      <section className="space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm font-black text-[var(--codiq-text)]">طلب #{order.orderNumber}</p>
          <span
            className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-accent)]"
            data-testid="market-order-status"
          >
            {order.statusLabel}
          </span>
        </div>
        {rank >= 0 ? (
          <ol className="grid grid-cols-4 gap-1" data-testid="market-order-steps">
            {STEPS.map((step, at) => (
              <li key={step.key} className="space-y-1 text-center">
                <span
                  className={`block h-1.5 rounded-full ${at <= rank ? "bg-[var(--codiq-accent)]" : "bg-[var(--codiq-border)]"}`}
                />
                <span
                  className={`text-[10px] ${at <= rank ? "font-bold text-[var(--codiq-text)]" : "text-[var(--codiq-text-muted)]"}`}
                >
                  {step.label}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {afterSales.deliveryStage ? (
          <p
            className="flex items-center gap-1.5 rounded-2xl bg-[var(--codiq-accent-soft)] px-3 py-2 text-xs font-bold text-[var(--codiq-accent)]"
            data-testid="market-order-stage"
          >
            <Truck className="h-4 w-4" /> {afterSales.deliveryStage.label}
          </p>
        ) : null}
        {afterSales.cancelReason ? (
          <p
            className="text-xs text-[var(--codiq-text-secondary)]"
            data-testid="market-order-cancel-reason"
          >
            سبب الإلغاء: {afterSales.cancelReason}
          </p>
        ) : null}
        <p className="text-xs text-[var(--codiq-text-muted)]">
          تاريخ الطلب: {new Date(order.createdAt).toLocaleString("ar-IQ")}
        </p>
      </section>
      {afterSales.handoverCode ? (
        <HandoverCode code={afterSales.handoverCode} pickup={order.fulfilment === "pickup"} />
      ) : null}
      <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <Link
          href={`/s/${encodeURIComponent(order.store.slug)}`}
          className="flex items-center gap-1 text-sm font-black text-[var(--codiq-text)]"
        >
          <Store className="h-4 w-4 text-[var(--codiq-accent)]" /> {order.store.name}
        </Link>
        <ul className="divide-y divide-[var(--codiq-border)]">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-2 py-2 text-xs">
              <span className="text-[var(--codiq-text)]">
                {item.productName}
                {item.variantName ? ` · ${item.variantName}` : ""} ×{" "}
                {item.quantity.toLocaleString("ar-IQ")}
                {item.addons.length ? (
                  <span className="block text-[11px] text-[var(--codiq-text-muted)]">
                    + {item.addons.map((addon) => addon.name).join("، ")}
                  </span>
                ) : null}
              </span>
              <span className="font-bold text-[var(--codiq-text)]">{iqd(item.lineTotalIqd)}</span>
            </li>
          ))}
        </ul>
      </section>
      {order.onlinePayment ? (
        <OnlinePaymentCard payment={order.onlinePayment} deliveryFeeIqd={order.deliveryFeeIqd} />
      ) : null}
      <section
        className="space-y-1.5 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-sm shadow-sm"
        data-testid="market-order-totals"
      >
        <Line label="المجموع الفرعيّ" value={iqd(order.subtotalIqd)} />
        {order.discountIqd ? (
          <Line
            label={`خصم الكوبون${order.couponCode ? ` (${order.couponCode})` : ""}`}
            value={`− ${iqd(order.discountIqd)}`}
          />
        ) : null}
        {order.loyaltyDiscountIqd ? (
          <Line label="خصم النقاط" value={`− ${iqd(order.loyaltyDiscountIqd)}`} />
        ) : null}
        <Line
          label={order.fulfilment === "pickup" ? "الاستلام من المتجر" : "رسوم التوصيل"}
          value={order.deliveryFeeIqd ? iqd(order.deliveryFeeIqd) : "مجاناً"}
        />
        <div className="flex justify-between border-t border-[var(--codiq-border)] pt-2 text-base font-black text-[var(--codiq-text)]">
          <span>الإجماليّ</span>
          <span>{iqd(order.totalIqd)}</span>
        </div>
      </section>
      <section className="space-y-1 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-xs text-[var(--codiq-text-secondary)] shadow-sm">
        <p className="text-sm font-black text-[var(--codiq-text)]">
          {order.fulfilment === "pickup" ? "الاستلام من المتجر" : "التوصيل إلى"}
        </p>
        {order.fulfilment === "pickup" ? (
          <p>
            {order.store.addressLine ?? "سيتواصل معك المتجر بموعد الاستلام."}
            {order.store.latitude !== null ? (
              <>
                {" "}
                —{" "}
                <a
                  href={`https://www.openstreetmap.org/?mlat=${order.store.latitude}&mlon=${order.store.longitude}#map=17/${order.store.latitude}/${order.store.longitude}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold text-[var(--codiq-accent)]"
                >
                  الاتجاهات
                </a>
              </>
            ) : null}
          </p>
        ) : (
          <p>
            {order.customerName} · {order.governorateName} — {order.shippingAddressLine1}
          </p>
        )}
      </section>
      {afterSales.canRate || afterSales.rating ? (
        afterSales.canRate ? (
          <RateOrder
            key={afterSales.rating ? "edit" : "new"}
            orderId={order.id}
            items={order.items}
            pickup={order.fulfilment === "pickup"}
            current={afterSales.rating}
            rateBy={afterSales.rateBy}
            onDone={() => void load()}
          />
        ) : (
          <section className="space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm">
            <p className="text-sm font-black text-[var(--codiq-text)]">تقييمك</p>
            <Stars value={afterSales.rating?.storeStars ?? 0} label="تقييم المتجر" />
          </section>
        )
      ) : null}
      <ReturnOrder orderId={order.id} state={afterSales} onDone={() => void load()} />
      {order.status === "completed" ? <OrderTicketLink orderId={order.id} /> : null}
      {afterSales.canCancel ? <CancelOrder orderId={order.id} onDone={() => void load()} /> : null}
      {whatsapp ? (
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-3 text-sm font-bold text-[var(--codiq-text)]"
        >
          <MessageCircle className="h-4 w-4" /> تواصل مع التاجر
        </a>
      ) : null}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-[var(--codiq-text-secondary)]">
      <span>{label}</span>
      <span className="font-bold text-[var(--codiq-text)]">{value}</span>
    </div>
  );
}

// ── تقييماتي ─────────────────────────────────────────────────────────────────

type PendingRating = {
  id: string;
  orderNumber: string;
  deliveredAt: string;
  rateBy: string;
  store: { slug: string; name: string };
  preview: string[];
};
type MyRating = {
  id: string;
  storeStars: number;
  deliveryStars: number | null;
  tagLabels: string[];
  note: string | null;
  createdAt: string;
  order: { id: string; orderNumber: string; store: { slug: string; name: string } };
};

export function MarketRatingsPage() {
  const { status, shopper } = useShopper();
  const [tab, setTab] = useState<"pending" | "mine">("pending");
  const pending = useMarketList<PendingRating>(
    shopper && tab === "pending" ? "/api/market/ratings/pending?limit=20" : null,
    "orders"
  );
  const mine = useMarketList<MyRating>(
    shopper && tab === "mine" ? "/api/market/ratings?limit=20" : null,
    "ratings"
  );
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  const list = tab === "pending" ? pending : mine;
  return (
    <div className="space-y-4" data-testid="market-ratings">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">تقييماتي</h1>
      <div className="flex gap-2">
        {(
          [
            ["pending", "بانتظار تقييمك"],
            ["mine", "قيّمتها"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${tab === value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`}
            data-testid={`market-ratings-tab-${value}`}
          >
            {label}
          </button>
        ))}
      </div>
      {!list.items ? (
        <p className="text-center text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {list.items?.length === 0 ? (
        <MarketEmptyState
          icon={Star}
          title={tab === "pending" ? "لا طلبات بانتظار تقييمك" : "لم تقيّم أيّ طلب بعد"}
          body="بعد استلام طلبك يظهر هنا لتقيّم المتجر والمنتجات."
        />
      ) : null}
      <ul className="space-y-3">
        {tab === "pending"
          ? pending.items?.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/orders/${row.id}`}
                  className="block space-y-1.5 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm"
                  data-testid={`market-pending-${row.id}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-black text-[var(--codiq-text)]">
                      {row.store.name}
                    </span>
                    <span className="rounded-full bg-[var(--codiq-accent)] px-3 py-1 text-[11px] font-bold text-[var(--codiq-surface)]">
                      قيّم الآن
                    </span>
                  </div>
                  <p className="truncate text-xs text-[var(--codiq-text-secondary)]">
                    {row.preview.join("، ")}
                  </p>
                  <p className="text-[11px] text-[var(--codiq-text-muted)]">
                    طلب #{row.orderNumber} — التقييم متاح حتّى{" "}
                    {new Date(row.rateBy).toLocaleDateString("ar-IQ")}
                  </p>
                </Link>
              </li>
            ))
          : mine.items?.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/orders/${row.order.id}`}
                  className="block space-y-1.5 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm"
                  data-testid={`market-rated-${row.order.id}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-black text-[var(--codiq-text)]">
                      {row.order.store.name}
                    </span>
                    <Stars value={row.storeStars} label="تقييم المتجر" />
                  </div>
                  {row.tagLabels.length ? (
                    <p className="text-xs text-[var(--codiq-text-secondary)]">
                      {row.tagLabels.join("، ")}
                    </p>
                  ) : null}
                  {row.note ? <p className="text-xs text-[var(--codiq-text)]">{row.note}</p> : null}
                  <p className="text-[11px] text-[var(--codiq-text-muted)]">
                    طلب #{row.order.orderNumber} —{" "}
                    {new Date(row.createdAt).toLocaleDateString("ar-IQ")}
                  </p>
                </Link>
              </li>
            ))}
      </ul>
      {list.nextCursor ? (
        <button
          type="button"
          onClick={() => void list.loadMore()}
          className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]"
        >
          عرض المزيد
        </button>
      ) : null}
    </div>
  );
}

const ONLINE_STATUS: Record<string, string> = {
  pending: "بانتظار الدفع",
  failed: "لم يكتمل الدفع",
  paid: "مدفوع إلكترونيّاً",
  expired: "انتهت مهلة الدفع",
  cancelled: "أُلغي",
  refunded: "أُعيد المبلغ",
  approved: "خطّة التقسيط معتمدة",
  adjusted: "عُدّلت خطّة التقسيط بعد الإرجاع",
};

/** Marketplace M13a: how this order is paid online — and the door back to the gateway while it waits. */
function OnlinePaymentCard({
  payment,
  deliveryFeeIqd,
}: {
  payment: NonNullable<OrderDetail["onlinePayment"]>;
  deliveryFeeIqd: number;
}) {
  return (
    <section
      className="space-y-1.5 rounded-[24px] bg-[var(--codiq-surface)] p-4 text-sm shadow-sm"
      data-testid="market-order-online-payment"
    >
      <p className="font-black text-[var(--codiq-text)]">
        {payment.method === "card"
          ? "الدفع بالبطاقة"
          : payment.method === "partner"
            ? "الدفع عبر التطبيق الشريك"
            : "الدفع بالأقساط"}
      </p>
      <p
        className="text-xs font-bold text-[var(--codiq-accent)]"
        data-testid="market-order-online-status"
      >
        {ONLINE_STATUS[payment.status] ?? payment.status}
      </p>
      {payment.method === "instalments" && payment.months && payment.monthlyIqd ? (
        <p className="text-xs text-[var(--codiq-text-secondary)]">
          {payment.months.toLocaleString("ar-IQ")} أشهر × {iqd(payment.monthlyIqd)} — ورسوم التوصيل{" "}
          {iqd(deliveryFeeIqd)} نقداً عند الاستلام.
        </p>
      ) : null}
      {payment.refundedIqd ? (
        <p className="text-xs text-[var(--codiq-success)]">
          {payment.method === "instalments"
            ? "لم تعد الخطّة تغطّي شيئاً من هذا الطلب"
            : `يُعاد ${iqd(payment.refundedIqd)}`}
        </p>
      ) : null}
      {payment.method === "card" &&
      (payment.status === "pending" || payment.status === "failed") ? (
        <Link
          href={`/pay/${payment.id}`}
          className="inline-block rounded-full bg-[var(--codiq-accent)] px-4 py-1.5 text-xs font-bold text-[var(--codiq-surface)]"
          data-testid="market-order-pay-now"
        >
          أكمل الدفع
        </Link>
      ) : null}
    </section>
  );
}

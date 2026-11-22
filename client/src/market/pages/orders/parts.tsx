/**
 * The shopper's orders — parts. Split verbatim from MarketOrdersPages.tsx (review batch 2, ت-١١);
 * MarketOrdersPages.tsx re-exports what it always exported.
 */
import { Link } from "wouter";
import { iqd } from "../../market-products";
import type { OrderDetail } from "./detail";

/** What the order cost, term by term — every term of the total, so the page adds up. */
export function OrderTotals({ order }: { order: OrderDetail }) {
  return (
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
      <div
        className={
          "flex justify-between border-t border-[var(--codiq-border)] pt-2 " +
          "text-base font-black text-[var(--codiq-text)]"
        }
      >
        <span>الإجماليّ</span>
        <span>{iqd(order.totalIqd)}</span>
      </div>
    </section>
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
export function OnlinePaymentCard({
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

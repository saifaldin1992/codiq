/**
 * Market payments — after-order. Split verbatim from payments.service.ts (review batch 2, ت-٨);
 * payments.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";
import { lender } from "../providers.js";
import { event } from "./events.js";
import { refundCard } from "./card.js";

// ── after the order changes ─────────────────────────────────────────────────

/** Subscribed to order.status_changed: money follows the order. */
export async function onOrderStatusChanged(payload: { orderId: string; to: string }) {
  if (!["cancelled", "rejected", "returned"].includes(payload.to)) return;
  const payment = await prisma.marketPayment.findUnique({ where: { orderId: payload.orderId } });
  if (!payment) return;
  if (payment.method === "partner") {
    // M13b: the partner holds the money; it is told to give it back (its refund API lands with the contract).
    if (payment.status !== "paid") return;
    await prisma.marketPayment.update({
      where: { id: payment.id },
      data: { status: "refunded", refundedIqd: payment.amountIqd },
    });
    await event(payment.id, "refund_requested", {
      amountIqd: payment.amountIqd,
      detail: { reason: payload.to },
    });
    await prisma.storeOrder.update({
      where: { id: payload.orderId },
      data: { paymentStatus: "refunded" },
    });
    return;
  }
  if (payment.method === "card") {
    if (payment.status === "paid")
      await refundCard(payment.id, payload.to === "returned" ? "أُرجع الطلب." : "أُلغي الطلب.");
    else if (payment.status === "pending" || payment.status === "failed")
      await prisma.marketPayment.update({
        where: { id: payment.id },
        data: { status: "cancelled" },
      });
    return;
  }
  const provider = lender(payment.provider);
  if (!provider || !payment.providerRef || payment.status !== "approved") return;
  if (payload.to === "returned") {
    // G8: the goods came back, so the plan covers nothing now.
    await provider.adjustPlan({ planRef: payment.providerRef, amountIqd: 0 });
    await prisma.marketPayment.update({
      where: { id: payment.id },
      data: { status: "adjusted", refundedIqd: payment.amountIqd },
    });
    await event(payment.id, "plan_adjusted", { amountIqd: 0 });
    await prisma.storeOrder.update({
      where: { id: payload.orderId },
      data: { paymentStatus: "refunded" },
    });
  } else {
    await provider.cancelPlan({ planRef: payment.providerRef });
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
    await event(payment.id, "plan_cancelled");
  }
}

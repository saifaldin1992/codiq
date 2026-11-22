/**
 * Market payments — card. Split verbatim from payments.service.ts (review batch 2, ت-٨);
 * payments.service.ts re-exports what it always exported.
 */
import { randomUUID } from "node:crypto";
import { cardGateway } from "../providers.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { prisma } from "../../../db/prisma.js";
import { logger } from "../../../logging/logger.js";
import { transitionOrderStatus } from "../../../services/order-lifecycle.service.js";
import { event } from "./events.js";

export const CARD_WINDOW_MS = 30 * 60 * 1000;

// ── card ─────────────────────────────────────────────────────────────────────

/** Right after a card order is placed: a session with the gateway. A gateway that refuses cancels the order. */
export async function openCardSession(
  order: { id: string; storeId: string; totalIqd: number; orderNumber: string; version: number },
  shopperId: string
) {
  const gateway = cardGateway();
  if (!gateway)
    throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "الدفع الإلكترونيّ غير متاح الآن.");
  const existing = await prisma.marketPayment.findUnique({
    where: { orderId: order.id },
    select: { id: true, status: true },
  });
  if (existing) return { paymentId: existing.id, redirectUrl: `/market/pay/${existing.id}` };
  const id = randomUUID();
  try {
    const session = await gateway.createSession({
      paymentId: id,
      amountIqd: order.totalIqd,
      description: `طلب ${order.orderNumber}`,
    });
    await prisma.marketPayment.create({
      data: {
        id,
        shopperId,
        storeId: order.storeId,
        orderId: order.id,
        method: "card",
        provider: gateway.id,
        providerRef: session.providerRef,
        status: "pending",
        amountIqd: order.totalIqd,
        expiresAt: new Date(Date.now() + CARD_WINDOW_MS),
      },
    });
    await event(id, "session_opened", { amountIqd: order.totalIqd });
    return { paymentId: id, redirectUrl: session.redirectUrl };
  } catch (error) {
    logger.warn("payments.session_failed", { orderId: order.id, reason: (error as Error).message });
    await transitionOrderStatus(order.storeId, { kind: "system", id: order.id }, order.id, {
      toStatus: "cancelled",
      expectedVersion: order.version,
      note: "تعذّر فتح جلسة الدفع الإلكترونيّ.",
    }).catch(() => undefined);
    throw new HttpError(
      502,
      "PAYMENT_PROVIDER_UNAVAILABLE",
      "تعذّر الوصول إلى بوابة الدفع — لم يُحتسب أيّ مبلغ وأُلغي الطلب. جرّب مرّة أخرى أو ادفع نقداً."
    );
  }
}

/**
 * The gateway's notification. Verified by its signature, applied once per
 * notification id, and only if it matches the session's amount.
 */
export async function handleCardNotification(rawBody: Buffer, signature: string | undefined) {
  const gateway = cardGateway();
  if (!gateway) throw new HttpError(404, "PAYMENTS_OFF", "الدفع الإلكترونيّ غير مفعّل.");
  const note = gateway.verifyNotification(rawBody, signature);
  if (!note) {
    logger.warn("security.refused", { reason: "payment_notification_signature" });
    throw new HttpError(401, "PAYMENT_SIGNATURE_INVALID", "توقيع الإشعار غير صحيح.");
  }
  const payment = await prisma.marketPayment.findUnique({
    where: { provider_providerRef: { provider: gateway.id, providerRef: note.providerRef } },
    include: { order: { select: { id: true, storeId: true, version: true, status: true } } },
  });
  if (!payment || !payment.order)
    throw new HttpError(404, "PAYMENT_NOT_FOUND", "لا توجد جلسة دفع بهذا المرجع.");
  const seen = await prisma.marketPaymentEvent.findUnique({
    where: { paymentId_providerEventId: { paymentId: payment.id, providerEventId: note.eventId } },
    select: { id: true },
  });
  if (seen) return { ok: true, duplicate: true, status: payment.status };
  if (note.type === "payment.succeeded" && note.amountIqd !== payment.amountIqd) {
    await event(payment.id, "amount_mismatch", {
      providerEventId: note.eventId,
      amountIqd: note.amountIqd,
    });
    logger.warn("security.refused", { reason: "payment_amount_mismatch", paymentId: payment.id });
    throw new HttpError(422, "PAYMENT_AMOUNT_MISMATCH", "المبلغ في الإشعار لا يطابق الطلب.");
  }
  if (note.type === "payment.failed") {
    await event(payment.id, "provider_failed", { providerEventId: note.eventId });
    if (payment.status === "pending")
      await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "failed" } });
    return { ok: true, status: "failed" };
  }
  // Succeeded. Late — after the window closed, or after the order was cancelled while he was
  // paying — the money still arrived: take it, then give it back. (Review 2026-11-21: «expired»
  // and «cancelled» were not claimable, so a late payment was neither recorded nor refunded.)
  const claimed = await prisma.marketPayment.updateMany({
    where: { id: payment.id, status: { in: ["pending", "failed", "expired", "cancelled"] } },
    data: { status: "paid", paidAt: new Date() },
  });
  await event(payment.id, "provider_paid", {
    providerEventId: note.eventId,
    amountIqd: note.amountIqd,
  });
  if (claimed.count === 1) {
    const order = await prisma.storeOrder.findUniqueOrThrow({
      where: { id: payment.order.id },
      select: { status: true },
    });
    if (
      order.status === "cancelled" ||
      order.status === "rejected" ||
      payment.status === "expired" ||
      payment.status === "cancelled"
    ) {
      await refundCard(payment.id, "وصل الدفع بعد إلغاء الطلب.");
      return { ok: true, status: "refunded" };
    }
    await prisma.storeOrder.updateMany({
      where: { id: payment.order.id, paymentStatus: "awaiting_payment" },
      data: { paymentStatus: "paid" },
    });
  }
  return { ok: true, status: "paid" };
}

export async function refundCard(paymentId: string, reason: string) {
  const payment = await prisma.marketPayment.findUniqueOrThrow({ where: { id: paymentId } });
  if (payment.status !== "paid" || !payment.providerRef) return;
  const gateway = cardGateway();
  if (!gateway) return;
  const remaining = payment.amountIqd - payment.refundedIqd;
  const { refundRef } = await gateway.refund({
    providerRef: payment.providerRef,
    amountIqd: remaining,
  });
  await prisma.marketPayment.update({
    where: { id: payment.id },
    data: { status: "refunded", refundedIqd: payment.amountIqd },
  });
  await event(payment.id, "refunded", { amountIqd: remaining, detail: { refundRef, reason } });
  if (payment.orderId)
    await prisma.storeOrder.update({
      where: { id: payment.orderId },
      data: { paymentStatus: "refunded" },
    });
}

/** Card sessions past their window: the order is cancelled (its stock returns) and the session expired. */
export async function expireStalePayments(now = new Date()) {
  const stale = await prisma.marketPayment.findMany({
    where: { method: "card", status: { in: ["pending", "failed"] }, expiresAt: { lt: now } },
    take: 100,
    include: { order: { select: { id: true, storeId: true, version: true, status: true } } },
  });
  for (const payment of stale) {
    const claimed = await prisma.marketPayment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: { status: "expired" },
    });
    if (claimed.count !== 1) continue;
    await event(payment.id, "expired");
    if (payment.order && payment.order.status === "new") {
      await transitionOrderStatus(
        payment.order.storeId,
        { kind: "system", id: payment.id },
        payment.order.id,
        {
          toStatus: "cancelled",
          expectedVersion: payment.order.version,
          note: "لم يكتمل الدفع الإلكترونيّ خلال ٣٠ دقيقة.",
        }
      ).catch((error: Error) =>
        logger.warn("payments.expire_cancel_failed", {
          paymentId: payment.id,
          reason: error.message,
        })
      );
    }
  }
  // Plans whose code was never entered simply lapse.
  await prisma.marketPayment.updateMany({
    where: { method: "instalments", status: "code_sent", expiresAt: { lt: now } },
    data: { status: "expired" },
  });
  return stale.length;
}

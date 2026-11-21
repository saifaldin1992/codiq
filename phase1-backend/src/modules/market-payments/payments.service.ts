/**
 * Marketplace M13a — paying a market order online.
 *
 * CARD. The order is placed first («بانتظار الدفع»: its stock is held and the
 * store cannot accept it yet), a session is opened with the gateway, and the
 * shopper pays on the gateway's page. Only the gateway's SIGNED notification
 * marks it paid — never the shopper's browser coming back. Not paid within
 * 30 minutes: the order is cancelled and its stock returns.
 *
 * INSTALMENTS. The shopper picks a lender and a term on the checkout page; the
 * lender checks his account and capacity and sends him a code; the code
 * approves the plan and only then is the order placed. The plan covers the
 * goods; the delivery fee is paid in cash at the door.
 *
 * AFTERWARDS. Cancelled or rejected: a paid card is refunded, a plan cancelled.
 * Returned: the card is refunded, the plan brought to 0 (G8). Every step is a
 * row in market_payment_events.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { logger } from "../../logging/logger.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { transitionOrderStatus } from "../../services/order-lifecycle.service.js";
import { cardGateway, lender, lenders, monthlyFor, paymentsMode, type InstalmentLender } from "./providers.js";

export const CARD_WINDOW_MS = 30 * 60 * 1000;
const PLAN_WINDOW_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

type Shopper = { id: string; phoneNormalized: string };

async function event(paymentId: string, kind: string, extra: { providerEventId?: string; amountIqd?: number; detail?: Record<string, unknown> } = {}) {
  await prisma.marketPaymentEvent.create({ data: { paymentId, kind, providerEventId: extra.providerEventId ?? null, amountIqd: extra.amountIqd ?? null, detail: (extra.detail ?? {}) as object } });
}

// ── what the checkout may offer ─────────────────────────────────────────────

/**
 * Review 2026-11-21: the expiry sweep ran only when a payment page was opened, so with no
 * scheduler an unpaid order could hold its stock for hours. Every checkout page now nudges it —
 * at most once a minute per process, off the request — besides `pnpm market:payments:expire`.
 */
let lastSweep = 0;
export function sweepSoon(now = Date.now()) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  setImmediate(() => { void expireStalePayments().catch((error: Error) => logger.warn("payments.sweep_failed", { reason: error.message })); });
}

/** Which online methods this order could use, and — for instalments — each lender's answer. */
export async function onlineOptions(shopper: Shopper, storeId: string, goodsIqd: number) {
  if (paymentsMode() === "off") return { card: null, instalments: null };
  sweepSoon();
  const card = cardGateway();
  const lines = await prisma.marketCartItem.findMany({ where: { cart: { shopperId: shopper.id }, storeId }, select: { productId: true } });
  const products = await prisma.product.findMany({ where: { id: { in: lines.map((line) => line.productId) }, storeId, deletedAt: null }, select: { instalmentsEligible: true, instalmentsCashPrice: true } });
  const eligible = products.length > 0 && products.every((row) => row.instalmentsEligible);
  const cashPrice = products.length > 0 && products.every((row) => row.instalmentsCashPrice);
  const offers = await Promise.all(lenders().map(async (entry) => {
    const account = await entry.account(shopper.phoneNormalized);
    const minMonths = entry.minMonths(goodsIqd);
    const terms = entry.terms.filter((term) => term.months >= minMonths).map((term) => monthlyFor(goodsIqd, term, cashPrice));
    const reason = !eligible ? "بعض منتجات هذا الطلب غير متاحة بالتقسيط."
      : goodsIqd < entry.minimumIqd ? `أقلّ مبلغ للتقسيط لدى هذه الجهة ${entry.minimumIqd.toLocaleString("ar-IQ")} د.ع.`
        : !account.hasAccount ? account.reason
          : goodsIqd > account.capacityIqd ? `سعتك المتاحة ${account.capacityIqd.toLocaleString("ar-IQ")} د.ع — أقلّ من قيمة الطلب.`
            : null;
    return { id: entry.id, name: entry.name, available: reason === null, reason, capacityIqd: account.hasAccount ? account.capacityIqd : null, minMonths, terms };
  }));
  return {
    card: card ? { id: card.id, name: card.name } : null,
    instalments: { goodsIqd, cashPrice, deliveryPaidInCash: true, lenders: offers },
  };
}

// ── card ─────────────────────────────────────────────────────────────────────

/** Right after a card order is placed: a session with the gateway. A gateway that refuses cancels the order. */
export async function openCardSession(order: { id: string; storeId: string; totalIqd: number; orderNumber: string; version: number }, shopperId: string) {
  const gateway = cardGateway();
  if (!gateway) throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "الدفع الإلكترونيّ غير متاح الآن.");
  const existing = await prisma.marketPayment.findUnique({ where: { orderId: order.id }, select: { id: true, status: true } });
  if (existing) return { paymentId: existing.id, redirectUrl: `/market/pay/${existing.id}` };
  const id = randomUUID();
  try {
    const session = await gateway.createSession({ paymentId: id, amountIqd: order.totalIqd, description: `طلب ${order.orderNumber}` });
    await prisma.marketPayment.create({ data: { id, shopperId, storeId: order.storeId, orderId: order.id, method: "card", provider: gateway.id, providerRef: session.providerRef, status: "pending", amountIqd: order.totalIqd, expiresAt: new Date(Date.now() + CARD_WINDOW_MS) } });
    await event(id, "session_opened", { amountIqd: order.totalIqd });
    return { paymentId: id, redirectUrl: session.redirectUrl };
  } catch (error) {
    logger.warn("payments.session_failed", { orderId: order.id, reason: (error as Error).message });
    await transitionOrderStatus(order.storeId, { kind: "system", id: order.id }, order.id, { toStatus: "cancelled", expectedVersion: order.version, note: "تعذّر فتح جلسة الدفع الإلكترونيّ." }).catch(() => undefined);
    throw new HttpError(502, "PAYMENT_PROVIDER_UNAVAILABLE", "تعذّر الوصول إلى بوابة الدفع — لم يُحتسب أيّ مبلغ وأُلغي الطلب. جرّب مرّة أخرى أو ادفع نقداً.");
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
  const payment = await prisma.marketPayment.findUnique({ where: { provider_providerRef: { provider: gateway.id, providerRef: note.providerRef } }, include: { order: { select: { id: true, storeId: true, version: true, status: true } } } });
  if (!payment || !payment.order) throw new HttpError(404, "PAYMENT_NOT_FOUND", "لا توجد جلسة دفع بهذا المرجع.");
  const seen = await prisma.marketPaymentEvent.findUnique({ where: { paymentId_providerEventId: { paymentId: payment.id, providerEventId: note.eventId } }, select: { id: true } });
  if (seen) return { ok: true, duplicate: true, status: payment.status };
  if (note.type === "payment.succeeded" && note.amountIqd !== payment.amountIqd) {
    await event(payment.id, "amount_mismatch", { providerEventId: note.eventId, amountIqd: note.amountIqd });
    logger.warn("security.refused", { reason: "payment_amount_mismatch", paymentId: payment.id });
    throw new HttpError(422, "PAYMENT_AMOUNT_MISMATCH", "المبلغ في الإشعار لا يطابق الطلب.");
  }
  if (note.type === "payment.failed") {
    await event(payment.id, "provider_failed", { providerEventId: note.eventId });
    if (payment.status === "pending") await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "failed" } });
    return { ok: true, status: "failed" };
  }
  // Succeeded. Late — after the window closed, or after the order was cancelled while he was
  // paying — the money still arrived: take it, then give it back. (Review 2026-11-21: «expired»
  // and «cancelled» were not claimable, so a late payment was neither recorded nor refunded.)
  const claimed = await prisma.marketPayment.updateMany({ where: { id: payment.id, status: { in: ["pending", "failed", "expired", "cancelled"] } }, data: { status: "paid", paidAt: new Date() } });
  await event(payment.id, "provider_paid", { providerEventId: note.eventId, amountIqd: note.amountIqd });
  if (claimed.count === 1) {
    const order = await prisma.storeOrder.findUniqueOrThrow({ where: { id: payment.order.id }, select: { status: true } });
    if (order.status === "cancelled" || order.status === "rejected" || payment.status === "expired" || payment.status === "cancelled") {
      await refundCard(payment.id, "وصل الدفع بعد إلغاء الطلب.");
      return { ok: true, status: "refunded" };
    }
    await prisma.storeOrder.updateMany({ where: { id: payment.order.id, paymentStatus: "awaiting_payment" }, data: { paymentStatus: "paid" } });
  }
  return { ok: true, status: "paid" };
}

async function refundCard(paymentId: string, reason: string) {
  const payment = await prisma.marketPayment.findUniqueOrThrow({ where: { id: paymentId } });
  if (payment.status !== "paid" || !payment.providerRef) return;
  const gateway = cardGateway();
  if (!gateway) return;
  const remaining = payment.amountIqd - payment.refundedIqd;
  const { refundRef } = await gateway.refund({ providerRef: payment.providerRef, amountIqd: remaining });
  await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "refunded", refundedIqd: payment.amountIqd } });
  await event(payment.id, "refunded", { amountIqd: remaining, detail: { refundRef, reason } });
  if (payment.orderId) await prisma.storeOrder.update({ where: { id: payment.orderId }, data: { paymentStatus: "refunded" } });
}

/** Card sessions past their window: the order is cancelled (its stock returns) and the session expired. */
export async function expireStalePayments(now = new Date()) {
  const stale = await prisma.marketPayment.findMany({ where: { method: "card", status: { in: ["pending", "failed"] }, expiresAt: { lt: now } }, take: 100, include: { order: { select: { id: true, storeId: true, version: true, status: true } } } });
  for (const payment of stale) {
    const claimed = await prisma.marketPayment.updateMany({ where: { id: payment.id, status: payment.status }, data: { status: "expired" } });
    if (claimed.count !== 1) continue;
    await event(payment.id, "expired");
    if (payment.order && payment.order.status === "new") {
      await transitionOrderStatus(payment.order.storeId, { kind: "system", id: payment.id }, payment.order.id, { toStatus: "cancelled", expectedVersion: payment.order.version, note: "لم يكتمل الدفع الإلكترونيّ خلال ٣٠ دقيقة." })
        .catch((error: Error) => logger.warn("payments.expire_cancel_failed", { paymentId: payment.id, reason: error.message }));
    }
  }
  // Plans whose code was never entered simply lapse.
  await prisma.marketPayment.updateMany({ where: { method: "instalments", status: "code_sent", expiresAt: { lt: now } }, data: { status: "expired" } });
  return stale.length;
}

// ── instalments ──────────────────────────────────────────────────────────────

/** The shopper picked a lender and a term: open the plan and have the code sent. */
export async function startInstalmentPlan(shopper: Shopper, storeId: string, goodsIqd: number, input: { lender: string; months: number }) {
  const options = await onlineOptions(shopper, storeId, goodsIqd);
  const offer = options.instalments?.lenders.find((entry) => entry.id === input.lender);
  if (!offer) throw new HttpError(422, "INSTALMENT_LENDER_UNKNOWN", "جهة التقسيط غير متاحة.");
  if (!offer.available) throw new HttpError(422, "INSTALMENT_NOT_ELIGIBLE", offer.reason ?? "التقسيط غير متاح لهذا الطلب.");
  const term = offer.terms.find((entry) => entry.months === input.months);
  if (!term) throw new HttpError(422, "INSTALMENT_TERM_INVALID", `اختر مدّة من ${offer.minMonths} أشهر أو أكثر من المدد المعروضة.`);
  const provider = lender(input.lender) as InstalmentLender;
  // One open plan per shopper and store: a new choice replaces the old one.
  await prisma.marketPayment.updateMany({ where: { shopperId: shopper.id, storeId, method: "instalments", status: "code_sent" }, data: { status: "cancelled" } });
  const id = randomUUID();
  const { planRef } = await provider.startPlan({ phoneE164: shopper.phoneNormalized, amountIqd: goodsIqd, months: term.months, reference: id });
  await prisma.marketPayment.create({ data: { id, shopperId: shopper.id, storeId, method: "instalments", provider: provider.id, providerRef: planRef, status: "code_sent", amountIqd: goodsIqd, months: term.months, monthlyIqd: term.monthlyIqd, feeIqd: term.feeIqd, expiresAt: new Date(Date.now() + PLAN_WINDOW_MS) } });
  await event(id, "plan_started", { amountIqd: goodsIqd, detail: { months: term.months, monthlyIqd: term.monthlyIqd } });
  return { paymentId: id, lender: provider.name, months: term.months, monthlyIqd: term.monthlyIqd, feeIqd: term.feeIqd, totalIqd: term.totalIqd, sentTo: `•••${shopper.phoneNormalized.slice(-4)}`, expiresAt: new Date(Date.now() + PLAN_WINDOW_MS) };
}

/** Before the order: the code approves the plan. Five wrong codes close it. */
export async function confirmInstalmentPlan(shopper: Shopper, storeId: string, paymentId: unknown, code: unknown, goodsIqd: number) {
  if (typeof paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(paymentId)) throw new HttpError(422, "INSTALMENT_PLAN_REQUIRED", "اختر جهة التقسيط والمدّة أوّلاً.");
  const payment = await prisma.marketPayment.findFirst({ where: { id: paymentId, shopperId: shopper.id, storeId, method: "instalments" } });
  if (!payment || payment.status !== "code_sent") throw new HttpError(422, "INSTALMENT_PLAN_REQUIRED", "اختر جهة التقسيط والمدّة من جديد.");
  if (payment.expiresAt < new Date()) {
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "expired" } });
    throw new HttpError(422, "INSTALMENT_PLAN_EXPIRED", "انتهت مهلة الرمز — اطلبه من جديد.");
  }
  if (payment.amountIqd !== goodsIqd) {
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
    throw new HttpError(422, "INSTALMENT_AMOUNT_CHANGED", "تغيّر مبلغ الطلب منذ اخترت التقسيط — اختر المدّة من جديد.");
  }
  const provider = lender(payment.provider);
  if (!provider || !payment.providerRef) throw new HttpError(422, "PAYMENT_METHOD_NOT_SUPPORTED", "جهة التقسيط غير متاحة الآن.");
  const attempts = await prisma.marketPayment.update({ where: { id: payment.id }, data: { codeAttempts: { increment: 1 } }, select: { codeAttempts: true } });
  if (attempts.codeAttempts > MAX_CODE_ATTEMPTS) {
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
    await provider.cancelPlan({ planRef: payment.providerRef });
    throw new HttpError(429, "INSTALMENT_CODE_LOCKED", "محاولات كثيرة — اطلب رمزاً جديداً.");
  }
  if (typeof code !== "string" || !(await provider.confirmPlan({ planRef: payment.providerRef, code: code.trim() }))) {
    await event(payment.id, "code_wrong");
    throw new HttpError(422, "INSTALMENT_CODE_WRONG", "الرمز غير صحيح.");
  }
  return payment;
}

/** After the order exists: the approved plan belongs to it. */
export async function attachInstalmentPlan(paymentId: string, orderId: string) {
  await prisma.marketPayment.update({ where: { id: paymentId }, data: { orderId, status: "approved", paidAt: new Date() } });
  await event(paymentId, "plan_approved", { detail: { orderId } });
}

/** The order could not be placed after the code: the lender forgets the plan. */
export async function abandonInstalmentPlan(paymentId: string) {
  const payment = await prisma.marketPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.orderId) return;
  await prisma.marketPayment.update({ where: { id: paymentId }, data: { status: "cancelled" } });
  if (payment.providerRef) await lender(payment.provider)?.cancelPlan({ planRef: payment.providerRef }).catch(() => undefined);
  await event(paymentId, "plan_abandoned");
}

// ── after the order changes ─────────────────────────────────────────────────

/** Subscribed to order.status_changed: money follows the order. */
export async function onOrderStatusChanged(payload: { orderId: string; to: string }) {
  if (!["cancelled", "rejected", "returned"].includes(payload.to)) return;
  const payment = await prisma.marketPayment.findUnique({ where: { orderId: payload.orderId } });
  if (!payment) return;
  if (payment.method === "partner") {
    // M13b: the partner holds the money; it is told to give it back (its refund API lands with the contract).
    if (payment.status !== "paid") return;
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "refunded", refundedIqd: payment.amountIqd } });
    await event(payment.id, "refund_requested", { amountIqd: payment.amountIqd, detail: { reason: payload.to } });
    await prisma.storeOrder.update({ where: { id: payload.orderId }, data: { paymentStatus: "refunded" } });
    return;
  }
  if (payment.method === "card") {
    if (payment.status === "paid") await refundCard(payment.id, payload.to === "returned" ? "أُرجع الطلب." : "أُلغي الطلب.");
    else if (payment.status === "pending" || payment.status === "failed") await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
    return;
  }
  const provider = lender(payment.provider);
  if (!provider || !payment.providerRef || payment.status !== "approved") return;
  if (payload.to === "returned") {
    // G8: the goods came back, so the plan covers nothing now.
    await provider.adjustPlan({ planRef: payment.providerRef, amountIqd: 0 });
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "adjusted", refundedIqd: payment.amountIqd } });
    await event(payment.id, "plan_adjusted", { amountIqd: 0 });
    await prisma.storeOrder.update({ where: { id: payload.orderId }, data: { paymentStatus: "refunded" } });
  } else {
    await provider.cancelPlan({ planRef: payment.providerRef });
    await prisma.marketPayment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
    await event(payment.id, "plan_cancelled");
  }
}

// ── screens ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = { pending: "بانتظار الدفع", code_sent: "بانتظار الرمز", paid: "مدفوع", approved: "تقسيط معتمد", failed: "فشل الدفع", expired: "انتهت المهلة", cancelled: "ملغي", refunded: "مُسترد", adjusted: "عُدّل بعد الإرجاع" };

/** The shopper's own payment, for the gateway page and the order page. */
export async function shopperPayment(shopperId: string, paymentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) throw new HttpError(404, "PAYMENT_NOT_FOUND", "عملية الدفع غير موجودة.");
  await expireStalePayments();
  const payment = await prisma.marketPayment.findFirst({ where: { id: paymentId, shopperId }, include: { order: { select: { id: true, orderNumber: true, status: true, store: { select: { name: true } } } } } });
  if (!payment) throw new HttpError(404, "PAYMENT_NOT_FOUND", "عملية الدفع غير موجودة.");
  return {
    payment: {
      id: payment.id, method: payment.method, provider: payment.provider, status: payment.status, statusLabel: STATUS_LABELS[payment.status] ?? payment.status,
      amountIqd: payment.amountIqd, months: payment.months, monthlyIqd: payment.monthlyIqd, feeIqd: payment.feeIqd, refundedIqd: payment.refundedIqd,
      expiresAt: payment.expiresAt, paidAt: payment.paidAt,
      order: payment.order ? { id: payment.order.id, orderNumber: payment.order.orderNumber, status: payment.order.status, storeName: payment.order.store.name } : null,
      testProvider: payment.provider.startsWith("fake-"),
    },
  };
}

const OWNER_KIND = "market-payments";
/** The owner's ledger of online payments, newest first. */
export async function paymentsForOwner(input: { status?: string; cursor?: unknown; limit?: unknown }) {
  await expireStalePayments();
  const limit = parseListLimit(input.limit, 100, 30);
  const cursor = decodeListCursor(OWNER_KIND, input.cursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.marketPayment.findMany({
    where: { ...(input.status ? { status: input.status } : {}), ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { store: { select: { name: true, slug: true } }, order: { select: { orderNumber: true, status: true } }, shopper: { select: { phoneNormalized: true } } },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(OWNER_KIND, last.createdAt, last.id));
  return {
    mode: paymentsMode(),
    payments: page.map((row) => ({ id: row.id, method: row.method, provider: row.provider, status: row.status, statusLabel: STATUS_LABELS[row.status] ?? row.status, amountIqd: row.amountIqd, refundedIqd: row.refundedIqd, months: row.months, monthlyIqd: row.monthlyIqd, createdAt: row.createdAt, paidAt: row.paidAt, store: row.store, order: row.order, shopperPhone: `•••${row.shopper.phoneNormalized.slice(-4)}` })),
    nextCursor,
  };
}

/** E6: «أو من X د.ع شهرياً» beside a product's price, from the lenders' terms. */
export function instalmentTeaser(priceIqd: number, product: { instalmentsEligible: boolean; instalmentsCashPrice: boolean }) {
  if (!product.instalmentsEligible || paymentsMode() === "off") return null;
  const candidates = lenders().filter((entry) => priceIqd >= entry.minimumIqd).flatMap((entry) => entry.terms.filter((term) => term.months >= entry.minMonths(priceIqd)).map((term) => monthlyFor(priceIqd, term, product.instalmentsCashPrice)));
  if (!candidates.length) return null;
  const lowest = candidates.reduce((best, entry) => (entry.monthlyIqd < best.monthlyIqd ? entry : best));
  return { fromMonthlyIqd: lowest.monthlyIqd, months: lowest.months, maxMonths: Math.max(...candidates.map((entry) => entry.months)), cashPrice: product.instalmentsCashPrice };
}

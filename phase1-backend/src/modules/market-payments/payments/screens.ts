/**
 * Market payments — screens. Split verbatim from payments.service.ts (review batch 2, ت-٨);
 * payments.service.ts re-exports what it always exported.
 */
import { HttpError } from "../../../auth/auth.errors.js";
import { prisma } from "../../../db/prisma.js";
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";
import { paymentsMode, lenders, monthlyFor } from "../providers.js";
import { expireStalePayments } from "./card.js";

// ── screens ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: "بانتظار الدفع",
  code_sent: "بانتظار الرمز",
  paid: "مدفوع",
  approved: "تقسيط معتمد",
  failed: "فشل الدفع",
  expired: "انتهت المهلة",
  cancelled: "ملغي",
  refunded: "مُسترد",
  adjusted: "عُدّل بعد الإرجاع",
};

/** The shopper's own payment, for the gateway page and the order page. */
export async function shopperPayment(shopperId: string, paymentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId))
    throw new HttpError(404, "PAYMENT_NOT_FOUND", "عملية الدفع غير موجودة.");
  await expireStalePayments();
  const payment = await prisma.marketPayment.findFirst({
    where: { id: paymentId, shopperId },
    include: {
      order: {
        select: { id: true, orderNumber: true, status: true, store: { select: { name: true } } },
      },
    },
  });
  if (!payment) throw new HttpError(404, "PAYMENT_NOT_FOUND", "عملية الدفع غير موجودة.");
  return {
    payment: {
      id: payment.id,
      method: payment.method,
      provider: payment.provider,
      status: payment.status,
      statusLabel: STATUS_LABELS[payment.status] ?? payment.status,
      amountIqd: payment.amountIqd,
      months: payment.months,
      monthlyIqd: payment.monthlyIqd,
      feeIqd: payment.feeIqd,
      refundedIqd: payment.refundedIqd,
      expiresAt: payment.expiresAt,
      paidAt: payment.paidAt,
      order: payment.order
        ? {
            id: payment.order.id,
            orderNumber: payment.order.orderNumber,
            status: payment.order.status,
            storeName: payment.order.store.name,
          }
        : null,
      testProvider: payment.provider.startsWith("fake-"),
    },
  };
}

const OWNER_KIND = "market-payments";

/** The owner's ledger of online payments, newest first. */
export async function paymentsForOwner(input: {
  status?: string;
  cursor?: unknown;
  limit?: unknown;
}) {
  await expireStalePayments();
  const limit = parseListLimit(input.limit, 100, 30);
  const cursor = decodeListCursor(OWNER_KIND, input.cursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.marketPayment.findMany({
    where: {
      ...(input.status ? { status: input.status } : {}),
      ...(cursor && at
        ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      store: { select: { name: true, slug: true } },
      order: { select: { orderNumber: true, status: true } },
      shopper: { select: { phoneNormalized: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(OWNER_KIND, last.createdAt, last.id)
  );
  return {
    mode: paymentsMode(),
    payments: page.map((row) => ({
      id: row.id,
      method: row.method,
      provider: row.provider,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] ?? row.status,
      amountIqd: row.amountIqd,
      refundedIqd: row.refundedIqd,
      months: row.months,
      monthlyIqd: row.monthlyIqd,
      createdAt: row.createdAt,
      paidAt: row.paidAt,
      store: row.store,
      order: row.order,
      shopperPhone: `•••${row.shopper.phoneNormalized.slice(-4)}`,
    })),
    nextCursor,
  };
}

/** E6: «أو من X د.ع شهرياً» beside a product's price, from the lenders' terms. */
export function instalmentTeaser(
  priceIqd: number,
  product: { instalmentsEligible: boolean; instalmentsCashPrice: boolean }
) {
  if (!product.instalmentsEligible || paymentsMode() === "off") return null;
  const candidates = lenders()
    .filter((entry) => priceIqd >= entry.minimumIqd)
    .flatMap((entry) =>
      entry.terms
        .filter((term) => term.months >= entry.minMonths(priceIqd))
        .map((term) => monthlyFor(priceIqd, term, product.instalmentsCashPrice))
    );
  if (!candidates.length) return null;
  const lowest = candidates.reduce((best, entry) =>
    entry.monthlyIqd < best.monthlyIqd ? entry : best
  );
  return {
    fromMonthlyIqd: lowest.monthlyIqd,
    months: lowest.months,
    maxMonths: Math.max(...candidates.map((entry) => entry.months)),
    cashPrice: product.instalmentsCashPrice,
  };
}

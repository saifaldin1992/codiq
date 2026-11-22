/**
 * Market checkout — orders. Split verbatim from checkout.service.ts (review batch 2, ت-١٢);
 * checkout.service.ts re-exports what it always exported.
 */
import { ORDER_STATUS_LABELS_AR } from "../../../services/order-status-labels.js";
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { afterSalesState } from "../../market-orders/after-sales.service.js";
import { governorateLabel } from "../../../services/governorates.js";

// ── طلباتي ───────────────────────────────────────────────────────────────────

const ORDERS_KIND = "market-shopper-orders";

/** Every order the shopper placed, across every store, newest first. */
export async function shopperOrders(
  shopperId: string,
  rawCursor: unknown,
  rawLimit: unknown,
  statusGroup: unknown
) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(ORDERS_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const group =
    statusGroup === "active"
      ? { status: { in: ["new", "processing", "preparation", "out_for_delivery"] } }
      : statusGroup === "done"
        ? { status: { in: ["completed", "cancelled", "rejected", "returned"] } }
        : {};
  const rows = await prisma.storeOrder.findMany({
    where: {
      customer: { shopperId },
      ...group,
      ...(cursor && at
        ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      fulfilment: true,
      totalIqd: true,
      createdAt: true,
      store: { select: { slug: true, name: true } },
      items: { select: { productName: true, quantity: true }, take: 3 },
      _count: { select: { items: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(ORDERS_KIND, last.createdAt, last.id)
  );
  return {
    orders: page.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      statusLabel: ORDER_STATUS_LABELS_AR[row.status] ?? row.status,
      fulfilment: row.fulfilment,
      totalIqd: row.totalIqd,
      createdAt: row.createdAt,
      store: row.store,
      itemCount: row._count.items,
      preview: row.items.map((item) => item.productName),
    })),
    nextCursor,
  };
}

export async function shopperOrder(shopperId: string, orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId))
    throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, customer: { shopperId } },
    select: {
      id: true,
      storeId: true,
      orderNumber: true,
      status: true,
      statusUpdatedAt: true,
      fulfilment: true,
      deliveryStage: true,
      cancelReasonCode: true,
      createdAt: true,
      subtotalIqd: true,
      deliveryFeeIqd: true,
      discountIqd: true,
      loyaltyDiscountIqd: true,
      platformDiscountIqd: true,
      totalIqd: true,
      couponCode: true,
      paymentMethodCode: true,
      customerName: true,
      recipientPhone: true,
      shippingGovernorate: true,
      shippingAddressLine1: true,
      customerNote: true,
      store: {
        select: {
          slug: true,
          name: true,
          supportWhatsapp: true,
          addressLine: true,
          latitude: true,
          longitude: true,
        },
      },
      items: {
        select: {
          id: true,
          productId: true,
          productName: true,
          variantName: true,
          quantity: true,
          unitPriceIqd: true,
          lineTotalIqd: true,
          addons: true,
        },
      },
      statusEvents: { select: { toStatus: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const { storeId: _storeId, deliveryStage: _stage, cancelReasonCode: _reason, ...shown } = order;
  return {
    afterSales: await afterSalesState(order),
    order: {
      ...shown,
      statusLabel: ORDER_STATUS_LABELS_AR[order.status] ?? order.status,
      governorateName: order.shippingGovernorate
        ? governorateLabel(order.shippingGovernorate)
        : null,
      timeline: order.statusEvents.map((event) => ({
        status: event.toStatus,
        label: ORDER_STATUS_LABELS_AR[event.toStatus] ?? event.toStatus,
        at: event.createdAt,
      })),
      // Marketplace M13a: how it is paid online, if it is.
      onlinePayment: await prisma.marketPayment.findUnique({
        where: { orderId: order.id },
        select: {
          id: true,
          method: true,
          status: true,
          amountIqd: true,
          months: true,
          monthlyIqd: true,
          refundedIqd: true,
        },
      }),
    },
  };
}

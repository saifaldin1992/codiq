/**
 * After-sales — shopper. Split verbatim from after-sales.service.ts
 * (review batch 6, ت-٤); after-sales.service.ts re-exports what it always exported.
 */
import { HttpError } from "../../../auth/auth.errors.js";
import { prisma } from "../../../db/prisma.js";
import {
  type CancelReasonCode,
  labelOf,
  CANCEL_REASONS,
  type ReturnReasonCode,
  RETURN_REASONS,
  type RatingTagCode,
  RATING_TAGS,
} from "../reasons.js";
import { cancelOwnOrder } from "../../../services/order-self-cancel.service.js";
import { requestReturn, withdrawReturnRequest } from "../../../services/return-request.service.js";
import { upsertProductReview } from "../../../services/product-review.service.js";
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";

/** How long after delivery an order may still be rated. */
export const RATING_WINDOW_DAYS = 30;

/** Wrong codes the store may type before the code stops working. */
export const HANDOVER_MAX_FAILURES = 5;

export const DAY_MS = 86_400_000;

export const CODE_VISIBLE_STATUSES = new Set(["processing", "preparation", "out_for_delivery"]);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shopper's own order, from whichever store. A miss is a 404, never a 403. */
async function ownedOrder(shopperId: string, orderId: string) {
  if (!UUID.test(orderId)) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, customer: { shopperId } },
    select: {
      id: true,
      storeId: true,
      customerId: true,
      status: true,
      statusUpdatedAt: true,
      fulfilment: true,
    },
  });
  if (!order || !order.customerId) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  return { ...order, customerId: order.customerId };
}

function withDetails(label: string, details: string | undefined) {
  return details ? `${label} — ${details}` : label;
}

// ── الإلغاء ─────────────────────────────────────────────────────────────────

export async function cancelMarketOrder(
  shopperId: string,
  orderId: string,
  input: { reasonCode: CancelReasonCode; details?: string }
) {
  const order = await ownedOrder(shopperId, orderId);
  const label = labelOf(CANCEL_REASONS, input.reasonCode) ?? "سبب آخر";
  try {
    const result = await cancelOwnOrder(order.storeId, order.customerId, order.id, {
      reason: withDetails(label, input.details),
    });
    await prisma.storeOrder.update({
      where: { id: order.id },
      data: { cancelReasonCode: input.reasonCode },
    });
    return result;
  } catch (error) {
    if (error instanceof HttpError && error.code === "ORDER_NOT_CANCELLABLE") {
      throw new HttpError(
        409,
        "ORDER_NOT_CANCELLABLE",
        "بدأ المتجر بتجهيز طلبك، فلم يعد إلغاؤه من هنا ممكناً. تواصل مع المتجر."
      );
    }
    throw error;
  }
}

// ── الإرجاع ─────────────────────────────────────────────────────────────────

export async function requestMarketReturn(
  shopperId: string,
  orderId: string,
  input: { reasonCode: ReturnReasonCode; details?: string }
) {
  const order = await ownedOrder(shopperId, orderId);
  const label = labelOf(RETURN_REASONS, input.reasonCode) ?? "سبب آخر";
  const request = await requestReturn(order.storeId, order.customerId, order.id, {
    reason: withDetails(label, input.details),
  });
  return { returnRequest: request };
}

export async function withdrawMarketReturn(shopperId: string, orderId: string) {
  const order = await ownedOrder(shopperId, orderId);
  const open = await prisma.returnRequest.findFirst({
    where: { storeId: order.storeId, orderId: order.id, status: "requested" },
    select: { id: true },
  });
  if (!open) throw new HttpError(404, "RETURN_NOT_FOUND", "لا يوجد طلب إرجاع مفتوح لهذا الطلب.");
  return { returnRequest: await withdrawReturnRequest(order.storeId, order.customerId, open.id) };
}

// ── التقييم ─────────────────────────────────────────────────────────────────

export function ratingOpen(status: string, statusUpdatedAt: Date, now: Date) {
  return (
    status === "completed" &&
    now.valueOf() - statusUpdatedAt.valueOf() <= RATING_WINDOW_DAYS * DAY_MS
  );
}

export async function rateMarketOrder(
  shopperId: string,
  orderId: string,
  input: {
    storeStars: number;
    deliveryStars?: number | null;
    tags: RatingTagCode[];
    note?: string;
    products: { productId: string; stars: number; body?: string }[];
  },
  now = new Date()
) {
  const order = await ownedOrder(shopperId, orderId);
  if (order.status !== "completed")
    throw new HttpError(422, "ORDER_NOT_RATABLE", "التقييم متاح بعد استلام الطلب.");
  if (!ratingOpen(order.status, order.statusUpdatedAt, now)) {
    throw new HttpError(
      422,
      "RATING_WINDOW_CLOSED",
      `مضى أكثر من ${RATING_WINDOW_DAYS} يوماً على استلام الطلب، فلم يعد تقييمه ممكناً.`
    );
  }
  // Only products that are on THIS order. The review service checks purchase too;
  // this keeps a request from rating something bought in another order through this one.
  const items = await prisma.orderItem.findMany({
    where: { orderId: order.id },
    select: { productId: true },
  });
  const onOrder = new Set(
    items.map((item) => item.productId).filter((id): id is string => Boolean(id))
  );
  const unknown = input.products.find((product) => !onOrder.has(product.productId));
  if (unknown)
    throw new HttpError(422, "PRODUCT_NOT_ON_ORDER", "أحد المنتجات المُقيَّمة ليس في هذا الطلب.");
  // Delivery stars mean nothing for a counter pick-up.
  const deliveryStars = order.fulfilment === "pickup" ? null : (input.deliveryStars ?? null);
  const note = input.note?.trim() || null;

  const rating = await prisma.orderRating.upsert({
    where: { orderId: order.id },
    create: {
      orderId: order.id,
      storeId: order.storeId,
      shopperId,
      storeStars: input.storeStars,
      deliveryStars,
      tags: input.tags,
      note,
    },
    update: { storeStars: input.storeStars, deliveryStars, tags: input.tags, note },
    select: {
      id: true,
      storeStars: true,
      deliveryStars: true,
      tags: true,
      note: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  for (const product of input.products) {
    await upsertProductReview(order.storeId, order.customerId, product.productId, {
      rating: product.stars,
      body: product.body,
    });
  }
  return { rating: presentRating(rating) };
}

export function presentRating(rating: {
  storeStars: number;
  deliveryStars: number | null;
  tags: string[];
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  id: string;
}) {
  return { ...rating, tagLabels: rating.tags.map((tag) => labelOf(RATING_TAGS, tag) ?? tag) };
}

const PENDING_KIND = "market-pending-ratings";

const MINE_KIND = "market-my-ratings";

/** Delivered orders still waiting for the shopper's stars, newest delivery first. */
export async function pendingRatings(
  shopperId: string,
  rawCursor: unknown,
  rawLimit: unknown,
  now = new Date()
) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(PENDING_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.storeOrder.findMany({
    where: {
      customer: { shopperId },
      status: "completed",
      rating: { is: null },
      statusUpdatedAt: { gte: new Date(now.valueOf() - RATING_WINDOW_DAYS * DAY_MS) },
      ...(cursor && at
        ? { OR: [{ statusUpdatedAt: { lt: at } }, { statusUpdatedAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ statusUpdatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      orderNumber: true,
      statusUpdatedAt: true,
      store: { select: { slug: true, name: true } },
      items: { select: { productName: true }, take: 3 },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(PENDING_KIND, last.statusUpdatedAt, last.id)
  );
  return {
    orders: page.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      deliveredAt: row.statusUpdatedAt,
      store: row.store,
      preview: row.items.map((item) => item.productName),
      rateBy: new Date(row.statusUpdatedAt.valueOf() + RATING_WINDOW_DAYS * DAY_MS),
    })),
    nextCursor,
  };
}

/** The shopper's own ratings, newest first. */
export async function myRatings(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(MINE_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.orderRating.findMany({
    where: {
      shopperId,
      ...(cursor && at
        ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      storeStars: true,
      deliveryStars: true,
      tags: true,
      note: true,
      createdAt: true,
      updatedAt: true,
      order: {
        select: { id: true, orderNumber: true, store: { select: { slug: true, name: true } } },
      },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(MINE_KIND, last.createdAt, last.id)
  );
  return {
    ratings: page.map(({ order, ...rating }) => ({ ...presentRating(rating), order })),
    nextCursor,
  };
}

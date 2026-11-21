/**
 * After the order (Marketplace M6): what a shopper may do with an order once
 * it is placed — call it off with a reason, rate it, confirm a pick-up.
 *
 * Every write here goes through the store's OWN order machinery (the same
 * state machine, stock release, status events and notifications the merchant
 * dashboard and the storefront use). The market adds the shopper's door to it,
 * never a second path to an order's state.
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { cancelOwnOrder } from "../../services/order-self-cancel.service.js";
import { REVIEW_BODY_MAX, REVIEW_RATING_MAX, REVIEW_RATING_MIN } from "../../services/product-review.service.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";

/** Why a shopper calls an order off. The code is stable; the label is what both he and the merchant read. */
export const CANCEL_REASONS = [
  { code: "changed_mind", label: "غيّرت رأيي" },
  { code: "ordered_by_mistake", label: "طلبت بالخطأ" },
  { code: "found_better_price", label: "وجدت سعراً أفضل" },
  { code: "delivery_too_long", label: "مدّة التوصيل طويلة" },
  { code: "change_details", label: "أريد تغيير العنوان أو تفاصيل الطلب" },
  { code: "other", label: "سبب آخر" },
] as const;
export type CancelReasonCode = (typeof CANCEL_REASONS)[number]["code"];
export const CANCEL_REASON_CODES = CANCEL_REASONS.map((reason) => reason.code) as [CancelReasonCode, ...CancelReasonCode[]];

/** The one order status a shopper may cancel from — the store's own rule (PG-1): past it, the store has committed work. */
export const SHOPPER_CANCELLABLE_STATUS = "new";

async function shopperOrderRef(shopperId: string, orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({ where: { id: orderId, customer: { shopperId } }, select: { id: true, storeId: true, customerId: true, status: true } });
  // Another shopper's order is indistinguishable from none.
  if (!order || !order.customerId) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  return { ...order, customerId: order.customerId };
}

/**
 * «إلغاء الطلب» — a reason from the list, and a note («سبب آخر» needs one).
 * The reason travels as the status event's note, so the merchant reads it on
 * the order beside every other move, and the cancellation is the store's own
 * PG-1 transition: reservations released, event written, merchant notified.
 */
export async function cancelShopperOrder(shopperId: string, orderId: string, input: { reasonCode: CancelReasonCode; note?: string | null }) {
  const order = await shopperOrderRef(shopperId, orderId);
  const reason = CANCEL_REASONS.find((row) => row.code === input.reasonCode);
  if (!reason) throw new HttpError(422, "INVALID_CANCELLATION_REASON", "اختر سبب الإلغاء.");
  const note = input.note?.trim() || null;
  if (reason.code === "other" && !note) throw new HttpError(422, "CANCELLATION_NOTE_REQUIRED", "اكتب سبب الإلغاء.");
  if (order.status !== SHOPPER_CANCELLABLE_STATUS) {
    throw new HttpError(409, "ORDER_NOT_CANCELLABLE", "قَبِل المتجر طلبك وبدأ العمل عليه، فلا يمكن إلغاؤه من هنا. تواصل مع المتجر.");
  }
  try {
    const result = await cancelOwnOrder(order.storeId, order.customerId, order.id, { reason: `سبب الإلغاء: ${reason.label}${note ? ` — ${note}` : ""}` });
    return { order: { id: result.order.id, status: result.order.status } };
  } catch (error) {
    if (error instanceof HttpError && error.code === "ORDER_NOT_CANCELLABLE") {
      throw new HttpError(409, "ORDER_NOT_CANCELLABLE", "قَبِل المتجر طلبك وبدأ العمل عليه، فلا يمكن إلغاؤه من هنا. تواصل مع المتجر.");
    }
    throw error;
  }
}

// ── «قيّم طلبك» (G6) ───────────────────────────────────────────────────────

/** The tags a rating may carry. Mirrored by the order_ratings_known_tags CHECK in migration 20261121160000. */
export const ORDER_RATING_TAGS = [
  { code: "late_delivery", label: "تأخّر التوصيل", tone: "negative" },
  { code: "damaged", label: "وصل تالفاً", tone: "negative" },
  { code: "not_as_described", label: "لا يطابق الوصف", tone: "negative" },
  { code: "poor_service", label: "خدمة سيّئة", tone: "negative" },
  { code: "poor_packaging", label: "التغليف سيّئ", tone: "negative" },
  { code: "average_quality", label: "جودة متوسّطة", tone: "negative" },
  { code: "slow_response", label: "بطء في الردّ", tone: "negative" },
  { code: "overpriced", label: "السعر مرتفع", tone: "negative" },
  { code: "excellent_quality", label: "جودة ممتازة", tone: "positive" },
  { code: "fast_delivery", label: "توصيل سريع", tone: "positive" },
  { code: "as_described", label: "مطابق للوصف", tone: "positive" },
  { code: "great_service", label: "خدمة رائعة", tone: "positive" },
] as const;
export type OrderRatingTag = (typeof ORDER_RATING_TAGS)[number]["code"];
export const ORDER_RATING_TAG_CODES = ORDER_RATING_TAGS.map((tag) => tag.code) as [OrderRatingTag, ...OrderRatingTag[]];
export { REVIEW_RATING_MIN as RATING_MIN, REVIEW_RATING_MAX as RATING_MAX, REVIEW_BODY_MAX as RATING_COMMENT_MAX };

/** How long after completion an order waits in «بانتظار تقييمك». It can still be rated from its page after. */
const PENDING_WINDOW_DAYS = 60;

export type OrderRatingInput = {
  products: { productId: string; rating: number; comment?: string | null }[];
  deliveryRating?: number | null;
  tags: OrderRatingTag[];
  note?: string | null;
};

const tagView = (codes: readonly string[]) => codes.map((code) => ORDER_RATING_TAGS.find((tag) => tag.code === code)).filter((tag): tag is (typeof ORDER_RATING_TAGS)[number] => Boolean(tag));

/** The shopper's rating of one order as he sees it: the order part and his stars on its products. */
export async function orderRatingView(storeId: string, customerId: string, orderId: string) {
  const [rating, items] = await Promise.all([
    prisma.orderRating.findUnique({ where: { orderId }, select: { deliveryRating: true, tags: true, note: true, createdAt: true, updatedAt: true } }),
    prisma.orderItem.findMany({ where: { orderId, productId: { not: null } }, select: { productId: true }, distinct: ["productId"] }),
  ]);
  const productIds = items.map((item) => item.productId).filter((id): id is string => Boolean(id));
  const reviews = productIds.length
    ? await prisma.productReview.findMany({ where: { storeId, customerId, productId: { in: productIds }, withdrawnAt: null }, select: { productId: true, rating: true, body: true } })
    : [];
  if (!rating && reviews.length === 0) return null;
  return {
    deliveryRating: rating?.deliveryRating ?? null,
    tags: tagView(rating?.tags ?? []),
    note: rating?.note ?? null,
    products: reviews.map((review) => ({ productId: review.productId, rating: review.rating, comment: review.body })),
    ratedAt: rating?.updatedAt ?? null,
  };
}

/**
 * Rate a completed order, or revise the rating. One transaction:
 *   · product stars go to product_reviews — the store's verified-buyer reviews,
 *     so they count in the product's and the store's rating. A product he had
 *     already reviewed keeps its one review, updated; a merchant's hide of its
 *     words stays (the product-review rule: editing does not lift moderation);
 *   · delivery stars (never for a pick-up), tags and a note go to order_ratings.
 */
export async function rateShopperOrder(shopperId: string, orderId: string, input: OrderRatingInput) {
  const order = await shopperOrderRef(shopperId, orderId);
  if (order.status !== "completed") throw new HttpError(409, "ORDER_NOT_RATEABLE", "يمكنك تقييم الطلب بعد استلامه.");
  const full = await prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id }, select: { fulfilment: true, items: { select: { productId: true } } } });
  const inOrder = new Set(full.items.map((item) => item.productId).filter((id): id is string => Boolean(id)));
  const seen = new Set<string>();
  for (const line of input.products) {
    if (!inOrder.has(line.productId)) throw new HttpError(422, "PRODUCT_NOT_IN_ORDER", "أحد المنتجات المقيّمة ليس في هذا الطلب.");
    if (seen.has(line.productId)) throw new HttpError(422, "DUPLICATE_PRODUCT_RATING", "قيّمت المنتج نفسه مرّتين.");
    seen.add(line.productId);
  }
  if (input.products.length === 0 && (input.deliveryRating ?? null) === null && input.tags.length === 0 && !input.note?.trim()) {
    throw new HttpError(422, "EMPTY_RATING", "اختر نجوماً لمنتج أو للتوصيل، أو وسماً واحداً على الأقلّ.");
  }
  if (full.fulfilment === "pickup" && input.deliveryRating != null) throw new HttpError(422, "NO_DELIVERY_TO_RATE", "هذا الطلب استُلم من المتجر، فلا توصيل لتقييمه.");
  const tags = Array.from(new Set(input.tags));
  const note = input.note?.trim() || null;

  await prisma.$transaction(async (tx) => {
    await tx.orderRating.upsert({
      where: { orderId: order.id },
      update: { deliveryRating: input.deliveryRating ?? null, tags, note },
      create: { orderId: order.id, storeId: order.storeId, customerId: order.customerId, deliveryRating: input.deliveryRating ?? null, tags, note },
    });
    for (const line of input.products) {
      const comment = line.comment?.trim() || null;
      const existing = await tx.productReview.findFirst({ where: { storeId: order.storeId, productId: line.productId, customerId: order.customerId, withdrawnAt: null }, select: { id: true } });
      if (existing) {
        await tx.productReview.update({ where: { id: existing.id }, data: { rating: line.rating, ...(comment !== null ? { body: comment } : {}) } });
      } else {
        await tx.productReview.create({ data: { storeId: order.storeId, productId: line.productId, customerId: order.customerId, orderId: order.id, rating: line.rating, body: comment } });
      }
    }
  });
  return { rating: await orderRatingView(order.storeId, order.customerId, order.id) };
}

const orderCard = {
  id: true, orderNumber: true, createdAt: true, totalIqd: true, fulfilment: true,
  store: { select: { slug: true, name: true } },
  items: { select: { productName: true }, take: 3 },
} as const;

/** «طلبات بانتظار تقييمك» — completed in the last sixty days and not rated yet. A shelf: twenty at most. */
export async function ordersAwaitingRating(shopperId: string) {
  const since = new Date(Date.now() - PENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.storeOrder.findMany({
    where: { customer: { shopperId }, status: "completed", statusUpdatedAt: { gte: since }, orderRatings: { none: {} } },
    orderBy: [{ statusUpdatedAt: "desc" }, { id: "desc" }],
    take: 20,
    select: orderCard,
  });
  return { orders: rows.map((row) => ({ id: row.id, orderNumber: row.orderNumber, createdAt: row.createdAt, totalIqd: row.totalIqd, fulfilment: row.fulfilment, store: row.store, preview: row.items.map((item) => item.productName) })) };
}

const RATINGS_KIND = "market-shopper-ratings";

/** «تقييماتي» — the shopper's order ratings, newest first, paged. */
export async function myOrderRatings(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(RATINGS_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.orderRating.findMany({
    where: { order: { customer: { shopperId } }, ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, createdAt: true, deliveryRating: true, tags: true, note: true, order: { select: orderCard } },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(RATINGS_KIND, last.createdAt, last.id));
  return {
    ratings: page.map((row) => ({
      id: row.id, ratedAt: row.createdAt, deliveryRating: row.deliveryRating, tags: tagView(row.tags), note: row.note,
      order: { id: row.order.id, orderNumber: row.order.orderNumber, store: row.order.store, preview: row.order.items.map((item) => item.productName) },
    })),
    nextCursor,
  };
}

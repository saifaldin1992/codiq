/**
 * Marketplace M6 — what the shopper can do once an order is placed: cancel it
 * with a reason, hand over the receipt code, rate it, ask to return it.
 *
 * Nothing here moves an order by itself. Cancelling goes through PG-1's
 * `cancelOwnOrder`, a return through CD-3's `requestReturn`, product stars
 * through `upsertProductReview`, and the store's code check through
 * `transitionOrderStatus` — each the one path that keeps stock, money and
 * notifications consistent. This file only finds the order from the SHOPPER's
 * side (any store he bought from) and records what the market adds: the reason
 * code, the hand-over code, the order rating.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import type { StoreActor } from "../../auth/staff-permissions.js";
import { cancelOwnOrder } from "../../services/order-self-cancel.service.js";
import { requestReturn, withdrawReturnRequest } from "../../services/return-request.service.js";
import { upsertProductReview } from "../../services/product-review.service.js";
import { transitionOrderStatus } from "../../services/order-lifecycle.service.js";
import { RETURN_REVERSAL_WINDOW_DAYS } from "../../services/finance.service.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { CANCEL_REASONS, DELIVERY_STAGES, RATING_TAGS, RETURN_REASONS, labelOf, type CancelReasonCode, type DeliveryStageCode, type RatingTagCode, type ReturnReasonCode } from "./reasons.js";

/** How long after delivery an order may still be rated. */
export const RATING_WINDOW_DAYS = 30;
/** Wrong codes the store may type before the code stops working. */
export const HANDOVER_MAX_FAILURES = 5;
const DAY_MS = 86_400_000;
const CODE_VISIBLE_STATUSES = new Set(["processing", "preparation", "out_for_delivery"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shopper's own order, from whichever store. A miss is a 404, never a 403. */
async function ownedOrder(shopperId: string, orderId: string) {
  if (!UUID.test(orderId)) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, customer: { shopperId } },
    select: { id: true, storeId: true, customerId: true, status: true, statusUpdatedAt: true, fulfilment: true },
  });
  if (!order || !order.customerId) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  return { ...order, customerId: order.customerId };
}

function withDetails(label: string, details: string | undefined) {
  return details ? `${label} — ${details}` : label;
}

// ── الإلغاء ─────────────────────────────────────────────────────────────────

export async function cancelMarketOrder(shopperId: string, orderId: string, input: { reasonCode: CancelReasonCode; details?: string }) {
  const order = await ownedOrder(shopperId, orderId);
  const label = labelOf(CANCEL_REASONS, input.reasonCode) ?? "سبب آخر";
  try {
    const result = await cancelOwnOrder(order.storeId, order.customerId, order.id, { reason: withDetails(label, input.details) });
    await prisma.storeOrder.update({ where: { id: order.id }, data: { cancelReasonCode: input.reasonCode } });
    return result;
  } catch (error) {
    if (error instanceof HttpError && error.code === "ORDER_NOT_CANCELLABLE") {
      throw new HttpError(409, "ORDER_NOT_CANCELLABLE", "بدأ المتجر بتجهيز طلبك، فلم يعد إلغاؤه من هنا ممكناً. تواصل مع المتجر.");
    }
    throw error;
  }
}

// ── الإرجاع ─────────────────────────────────────────────────────────────────

export async function requestMarketReturn(shopperId: string, orderId: string, input: { reasonCode: ReturnReasonCode; details?: string }) {
  const order = await ownedOrder(shopperId, orderId);
  const label = labelOf(RETURN_REASONS, input.reasonCode) ?? "سبب آخر";
  const request = await requestReturn(order.storeId, order.customerId, order.id, { reason: withDetails(label, input.details) });
  return { returnRequest: request };
}

export async function withdrawMarketReturn(shopperId: string, orderId: string) {
  const order = await ownedOrder(shopperId, orderId);
  const open = await prisma.returnRequest.findFirst({ where: { storeId: order.storeId, orderId: order.id, status: "requested" }, select: { id: true } });
  if (!open) throw new HttpError(404, "RETURN_NOT_FOUND", "لا يوجد طلب إرجاع مفتوح لهذا الطلب.");
  return { returnRequest: await withdrawReturnRequest(order.storeId, order.customerId, open.id) };
}

// ── التقييم ─────────────────────────────────────────────────────────────────

function ratingOpen(status: string, statusUpdatedAt: Date, now: Date) {
  return status === "completed" && now.valueOf() - statusUpdatedAt.valueOf() <= RATING_WINDOW_DAYS * DAY_MS;
}

export async function rateMarketOrder(
  shopperId: string,
  orderId: string,
  input: { storeStars: number; deliveryStars?: number | null; tags: RatingTagCode[]; note?: string; products: { productId: string; stars: number; body?: string }[] },
  now = new Date(),
) {
  const order = await ownedOrder(shopperId, orderId);
  if (order.status !== "completed") throw new HttpError(422, "ORDER_NOT_RATABLE", "التقييم متاح بعد استلام الطلب.");
  if (!ratingOpen(order.status, order.statusUpdatedAt, now)) {
    throw new HttpError(422, "RATING_WINDOW_CLOSED", `مضى أكثر من ${RATING_WINDOW_DAYS} يوماً على استلام الطلب، فلم يعد تقييمه ممكناً.`);
  }
  // Only products that are on THIS order. The review service checks purchase too;
  // this keeps a request from rating something bought in another order through this one.
  const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, select: { productId: true } });
  const onOrder = new Set(items.map((item) => item.productId).filter((id): id is string => Boolean(id)));
  const unknown = input.products.find((product) => !onOrder.has(product.productId));
  if (unknown) throw new HttpError(422, "PRODUCT_NOT_ON_ORDER", "أحد المنتجات المُقيَّمة ليس في هذا الطلب.");
  // Delivery stars mean nothing for a counter pick-up.
  const deliveryStars = order.fulfilment === "pickup" ? null : input.deliveryStars ?? null;
  const note = input.note?.trim() || null;

  const rating = await prisma.orderRating.upsert({
    where: { orderId: order.id },
    create: { orderId: order.id, storeId: order.storeId, shopperId, storeStars: input.storeStars, deliveryStars, tags: input.tags, note },
    update: { storeStars: input.storeStars, deliveryStars, tags: input.tags, note },
    select: { id: true, storeStars: true, deliveryStars: true, tags: true, note: true, createdAt: true, updatedAt: true },
  });
  for (const product of input.products) {
    await upsertProductReview(order.storeId, order.customerId, product.productId, { rating: product.stars, body: product.body });
  }
  return { rating: presentRating(rating) };
}

function presentRating(rating: { storeStars: number; deliveryStars: number | null; tags: string[]; note: string | null; createdAt: Date; updatedAt: Date; id: string }) {
  return { ...rating, tagLabels: rating.tags.map((tag) => labelOf(RATING_TAGS, tag) ?? tag) };
}

const PENDING_KIND = "market-pending-ratings";
const MINE_KIND = "market-my-ratings";

/** Delivered orders still waiting for the shopper's stars, newest delivery first. */
export async function pendingRatings(shopperId: string, rawCursor: unknown, rawLimit: unknown, now = new Date()) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(PENDING_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.storeOrder.findMany({
    where: {
      customer: { shopperId }, status: "completed", rating: { is: null },
      statusUpdatedAt: { gte: new Date(now.valueOf() - RATING_WINDOW_DAYS * DAY_MS) },
      ...(cursor && at ? { OR: [{ statusUpdatedAt: { lt: at } }, { statusUpdatedAt: at, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ statusUpdatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, orderNumber: true, statusUpdatedAt: true, store: { select: { slug: true, name: true } }, items: { select: { productName: true }, take: 3 } },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(PENDING_KIND, last.statusUpdatedAt, last.id));
  return {
    orders: page.map((row) => ({ id: row.id, orderNumber: row.orderNumber, deliveredAt: row.statusUpdatedAt, store: row.store, preview: row.items.map((item) => item.productName), rateBy: new Date(row.statusUpdatedAt.valueOf() + RATING_WINDOW_DAYS * DAY_MS) })),
    nextCursor,
  };
}

/** The shopper's own ratings, newest first. */
export async function myRatings(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(MINE_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.orderRating.findMany({
    where: { shopperId, ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, storeStars: true, deliveryStars: true, tags: true, note: true, createdAt: true, updatedAt: true, order: { select: { id: true, orderNumber: true, store: { select: { slug: true, name: true } } } } },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(MINE_KIND, last.createdAt, last.id));
  return { ratings: page.map(({ order, ...rating }) => ({ ...presentRating(rating), order })), nextCursor };
}

// ── رمز الاستلام ────────────────────────────────────────────────────────────

function freshCode() {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

/** Issued once per market order; idempotent, so a checkout replay or a second view changes nothing. */
export async function ensureHandoverCode(orderId: string, storeId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  await db.orderHandoverCode.createMany({ data: [{ orderId, storeId, code: freshCode() }], skipDuplicates: true });
}

/**
 * Everything the shopper's order page needs to offer the after-sales actions.
 * Read by `shopperOrder` so the page is one request.
 */
export async function afterSalesState(order: { id: string; storeId: string; status: string; statusUpdatedAt: Date; fulfilment: string; deliveryStage: string | null; cancelReasonCode: string | null }, now = new Date()) {
  const showCode = CODE_VISIBLE_STATUSES.has(order.status);
  if (showCode) await ensureHandoverCode(order.id, order.storeId);
  const [handover, rating, returnRequest, completion] = await Promise.all([
    showCode ? prisma.orderHandoverCode.findUnique({ where: { orderId: order.id }, select: { code: true, failures: true, usedAt: true } }) : null,
    prisma.orderRating.findUnique({ where: { orderId: order.id }, select: { id: true, storeStars: true, deliveryStars: true, tags: true, note: true, createdAt: true, updatedAt: true } }),
    prisma.returnRequest.findFirst({ where: { storeId: order.storeId, orderId: order.id }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, reason: true, decisionNote: true, decidedAt: true, reversalDeadline: true, createdAt: true } }),
    order.status === "completed" ? prisma.ledgerEntry.findFirst({ where: { storeId: order.storeId, orderId: order.id, entryType: "order_completed" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }) : null,
  ]);
  const returnDeadline = completion ? new Date(completion.createdAt.valueOf() + RETURN_REVERSAL_WINDOW_DAYS * DAY_MS) : null;
  const hasOpenReturn = returnRequest?.status === "requested";
  return {
    deliveryStage: order.status === "out_for_delivery" && order.deliveryStage ? { code: order.deliveryStage, label: labelOf(DELIVERY_STAGES, order.deliveryStage) } : null,
    cancelReason: order.cancelReasonCode ? labelOf(CANCEL_REASONS, order.cancelReasonCode) : null,
    handoverCode: handover && !handover.usedAt && handover.failures < HANDOVER_MAX_FAILURES ? handover.code : null,
    canCancel: order.status === "new",
    canRate: ratingOpen(order.status, order.statusUpdatedAt, now),
    rateBy: order.status === "completed" ? new Date(order.statusUpdatedAt.valueOf() + RATING_WINDOW_DAYS * DAY_MS) : null,
    rating: rating ? presentRating(rating) : null,
    canReturn: order.status === "completed" && Boolean(returnDeadline && now <= returnDeadline) && !hasOpenReturn && returnRequest?.status !== "approved",
    returnBy: returnDeadline,
    returnRequest,
  };
}

export function afterSalesOptions() {
  return { cancelReasons: CANCEL_REASONS, returnReasons: RETURN_REASONS, ratingTags: RATING_TAGS, ratingWindowDays: RATING_WINDOW_DAYS, returnWindowDays: RETURN_REVERSAL_WINDOW_DAYS };
}

// ── جهة المتجر ──────────────────────────────────────────────────────────────

async function storeOrder(storeId: string, orderId: string) {
  if (!UUID.test(orderId)) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId },
    select: { id: true, status: true, version: true, fulfilment: true, deliveryStage: true, deliveryStageAt: true, cancelReasonCode: true },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");
  return order;
}

/** The market side of one order as the STORE sees it. The code itself is never in it. */
export async function storeOrderMarketView(storeId: string, orderId: string) {
  const order = await storeOrder(storeId, orderId);
  const [handover, rating] = await Promise.all([
    prisma.orderHandoverCode.findUnique({ where: { orderId: order.id }, select: { failures: true, usedAt: true } }),
    prisma.orderRating.findUnique({ where: { orderId: order.id }, select: { id: true, storeStars: true, deliveryStars: true, tags: true, note: true, createdAt: true, updatedAt: true } }),
  ]);
  return {
    deliveryStage: order.deliveryStage,
    deliveryStageAt: order.deliveryStageAt,
    deliveryStages: DELIVERY_STAGES,
    cancelReason: labelOf(CANCEL_REASONS, order.cancelReasonCode),
    handover: handover ? { used: Boolean(handover.usedAt), attemptsLeft: Math.max(0, HANDOVER_MAX_FAILURES - handover.failures) } : null,
    rating: rating ? presentRating(rating) : null,
  };
}

export async function setDeliveryStage(storeId: string, orderId: string, stage: DeliveryStageCode | null) {
  const order = await storeOrder(storeId, orderId);
  if (stage && !["preparation", "out_for_delivery"].includes(order.status)) {
    throw new HttpError(409, "DELIVERY_STAGE_NOT_APPLICABLE", "مرحلة التوصيل تُحدَّث للطلبات قيد التجهيز أو في الطريق فقط.");
  }
  if (stage && order.fulfilment === "pickup") throw new HttpError(409, "DELIVERY_STAGE_NOT_APPLICABLE", "هذا الطلب استلام من المتجر، بلا توصيل.");
  await prisma.storeOrder.update({ where: { id: order.id }, data: { deliveryStage: stage, deliveryStageAt: stage ? new Date() : null } });
  return storeOrderMarketView(storeId, orderId);
}

function sameCode(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The store types the shopper's code; a match marks the order delivered through
 * the ordinary state machine. A pick-up may be handed over straight from
 * «قيد التجهيز» — it passes through «في الطريق» on the way, because that is the
 * only edge into «مكتمل» and the state machine is not bent for it.
 */
export async function confirmHandover(storeId: string, actor: StoreActor, orderId: string, code: string) {
  const order = await storeOrder(storeId, orderId);
  const handover = await prisma.orderHandoverCode.findUnique({ where: { orderId: order.id }, select: { code: true, failures: true, usedAt: true } });
  if (!handover) throw new HttpError(409, "HANDOVER_NOT_AVAILABLE", "هذا الطلب بلا رمز استلام. أكمله من قائمة الحالات.");
  if (handover.usedAt) throw new HttpError(409, "HANDOVER_ALREADY_USED", "استُخدم رمز الاستلام لهذا الطلب.");
  if (handover.failures >= HANDOVER_MAX_FAILURES) throw new HttpError(429, "HANDOVER_LOCKED", "أُدخل رمز خاطئ مرّات كثيرة. أكمل الطلب من قائمة الحالات.");
  const allowed = order.status === "out_for_delivery" || (order.fulfilment === "pickup" && order.status === "preparation");
  if (!allowed) throw new HttpError(409, "HANDOVER_NOT_APPLICABLE", order.fulfilment === "pickup" ? "الطلب ليس جاهزاً للاستلام بعد." : "حدّث الطلب إلى «في الطريق» قبل تسليمه.");

  // EVERY attempt is counted before the code is compared, by a guarded write
  // that refuses once the limit is reached. Read-then-increment let parallel
  // guesses all read «4 failures» and all be compared — a 4-digit code with
  // five tries is only safe if the five are really five.
  const slot = await prisma.orderHandoverCode.updateMany({ where: { orderId: order.id, usedAt: null, failures: { lt: HANDOVER_MAX_FAILURES } }, data: { failures: { increment: 1 } } });
  if (slot.count !== 1) throw new HttpError(429, "HANDOVER_LOCKED", "أُدخل رمز خاطئ مرّات كثيرة. أكمل الطلب من قائمة الحالات.");
  if (!sameCode(handover.code, code)) {
    const after = await prisma.orderHandoverCode.findUniqueOrThrow({ where: { orderId: order.id }, select: { failures: true } });
    throw new HttpError(422, "HANDOVER_CODE_WRONG", `الرمز غير صحيح. تبقّت ${Math.max(0, HANDOVER_MAX_FAILURES - after.failures)} محاولات.`);
  }
  // The right code: the attempt it took is not a failure.
  await prisma.orderHandoverCode.update({ where: { orderId: order.id }, data: { failures: { decrement: 1 } } });

  let version = order.version;
  if (order.status === "preparation") {
    const moved = await transitionOrderStatus(storeId, { kind: actor.kind, id: actor.id }, order.id, { toStatus: "out_for_delivery", expectedVersion: version, note: "استلام من المتجر" });
    version = moved.version;
  }
  const done = await transitionOrderStatus(storeId, { kind: actor.kind, id: actor.id }, order.id, { toStatus: "completed", expectedVersion: version, note: "سُلِّم برمز الاستلام" });
  await prisma.orderHandoverCode.update({ where: { orderId: order.id }, data: { usedAt: new Date() } });
  await prisma.storeOrder.update({ where: { id: order.id }, data: { deliveryStage: null, deliveryStageAt: null } });
  return { order: { id: done.id, status: done.status, version: done.version } };
}

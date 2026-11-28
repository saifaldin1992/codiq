/**
 * After-sales — store. Split verbatim from after-sales.service.ts
 * (review batch 6, ت-٤); after-sales.service.ts re-exports what it always exported.
 */
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../../../auth/auth.errors.js";
import { prisma } from "../../../db/prisma.js";
import { DELIVERY_STAGES, labelOf, CANCEL_REASONS, type DeliveryStageCode } from "../reasons.js";
import type { StoreActor } from "../../../auth/staff-permissions.js";
import { transitionOrderStatus } from "../../../services/order-lifecycle.service.js";
import { UUID, HANDOVER_MAX_FAILURES, presentRating } from "./shopper.js";

// ── جهة المتجر ──────────────────────────────────────────────────────────────

async function storeOrder(storeId: string, orderId: string) {
  if (!UUID.test(orderId)) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId },
    select: {
      id: true,
      status: true,
      version: true,
      fulfilment: true,
      deliveryStage: true,
      deliveryStageAt: true,
      cancelReasonCode: true,
    },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");
  return order;
}

/** The market side of one order as the STORE sees it. The code itself is never in it. */
export async function storeOrderMarketView(storeId: string, orderId: string) {
  const order = await storeOrder(storeId, orderId);
  const [handover, rating] = await Promise.all([
    prisma.orderHandoverCode.findUnique({
      where: { orderId: order.id },
      select: { failures: true, usedAt: true },
    }),
    prisma.orderRating.findUnique({
      where: { orderId: order.id },
      select: {
        id: true,
        storeStars: true,
        deliveryStars: true,
        tags: true,
        note: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);
  return {
    deliveryStage: order.deliveryStage,
    deliveryStageAt: order.deliveryStageAt,
    deliveryStages: DELIVERY_STAGES,
    cancelReason: labelOf(CANCEL_REASONS, order.cancelReasonCode),
    handover: handover
      ? {
          used: Boolean(handover.usedAt),
          attemptsLeft: Math.max(0, HANDOVER_MAX_FAILURES - handover.failures),
        }
      : null,
    rating: rating ? presentRating(rating) : null,
  };
}

export async function setDeliveryStage(
  storeId: string,
  orderId: string,
  stage: DeliveryStageCode | null
) {
  const order = await storeOrder(storeId, orderId);
  if (stage && !["preparation", "out_for_delivery"].includes(order.status)) {
    throw new HttpError(
      409,
      "DELIVERY_STAGE_NOT_APPLICABLE",
      "مرحلة التوصيل تُحدَّث للطلبات قيد التجهيز أو في الطريق فقط."
    );
  }
  if (stage && order.fulfilment === "pickup")
    throw new HttpError(
      409,
      "DELIVERY_STAGE_NOT_APPLICABLE",
      "هذا الطلب استلام من المتجر، بلا توصيل."
    );
  await prisma.storeOrder.update({
    where: { id: order.id },
    data: { deliveryStage: stage, deliveryStageAt: stage ? new Date() : null },
  });
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
export async function confirmHandover(
  storeId: string,
  actor: StoreActor,
  orderId: string,
  code: string
) {
  const order = await storeOrder(storeId, orderId);
  const handover = await prisma.orderHandoverCode.findUnique({
    where: { orderId: order.id },
    select: { code: true, failures: true, usedAt: true },
  });
  if (!handover)
    throw new HttpError(
      409,
      "HANDOVER_NOT_AVAILABLE",
      "هذا الطلب بلا رمز استلام. أكمله من قائمة الحالات."
    );
  if (handover.usedAt)
    throw new HttpError(409, "HANDOVER_ALREADY_USED", "استُخدم رمز الاستلام لهذا الطلب.");
  if (handover.failures >= HANDOVER_MAX_FAILURES)
    throw new HttpError(
      429,
      "HANDOVER_LOCKED",
      "أُدخل رمز خاطئ مرّات كثيرة. أكمل الطلب من قائمة الحالات."
    );
  const allowed =
    order.status === "out_for_delivery" ||
    (order.fulfilment === "pickup" && order.status === "preparation");
  if (!allowed)
    throw new HttpError(
      409,
      "HANDOVER_NOT_APPLICABLE",
      order.fulfilment === "pickup"
        ? "الطلب ليس جاهزاً للاستلام بعد."
        : "حدّث الطلب إلى «في الطريق» قبل تسليمه."
    );

  if (!sameCode(handover.code, code)) {
    const updated = await prisma.orderHandoverCode.update({
      where: { orderId: order.id },
      data: { failures: { increment: 1 } },
      select: { failures: true },
    });
    throw new HttpError(
      422,
      "HANDOVER_CODE_WRONG",
      `الرمز غير صحيح. تبقّت ${Math.max(0, HANDOVER_MAX_FAILURES - updated.failures)} محاولات.`
    );
  }

  let version = order.version;
  if (order.status === "preparation") {
    const moved = await transitionOrderStatus(
      storeId,
      { kind: actor.kind, id: actor.id },
      order.id,
      { toStatus: "out_for_delivery", expectedVersion: version, note: "استلام من المتجر" }
    );
    version = moved.version;
  }
  const done = await transitionOrderStatus(storeId, { kind: actor.kind, id: actor.id }, order.id, {
    toStatus: "completed",
    expectedVersion: version,
    note: "سُلِّم برمز الاستلام",
  });
  await prisma.orderHandoverCode.update({
    where: { orderId: order.id },
    data: { usedAt: new Date() },
  });
  await prisma.storeOrder.update({
    where: { id: order.id },
    data: { deliveryStage: null, deliveryStageAt: null },
  });
  return { order: { id: done.id, status: done.status, version: done.version } };
}

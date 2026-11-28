/**
 * After-sales — state. Split verbatim from after-sales.service.ts
 * (review batch 6, ت-٤); after-sales.service.ts re-exports what it always exported.
 */
import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../db/prisma.js";
import { RETURN_REVERSAL_WINDOW_DAYS } from "../../../services/finance.service.js";
import {
  labelOf,
  DELIVERY_STAGES,
  CANCEL_REASONS,
  RETURN_REASONS,
  RATING_TAGS,
} from "../reasons.js";
import {
  CODE_VISIBLE_STATUSES,
  DAY_MS,
  HANDOVER_MAX_FAILURES,
  ratingOpen,
  RATING_WINDOW_DAYS,
  presentRating,
} from "./shopper.js";

// ── رمز الاستلام ────────────────────────────────────────────────────────────

function freshCode() {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

/** Issued once per market order; idempotent, so a checkout replay or a second view changes nothing. */
export async function ensureHandoverCode(
  orderId: string,
  storeId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  await db.orderHandoverCode.createMany({
    data: [{ orderId, storeId, code: freshCode() }],
    skipDuplicates: true,
  });
}

/**
 * Everything the shopper's order page needs to offer the after-sales actions.
 * Read by `shopperOrder` so the page is one request.
 */
export async function afterSalesState(
  order: {
    id: string;
    storeId: string;
    status: string;
    statusUpdatedAt: Date;
    fulfilment: string;
    deliveryStage: string | null;
    cancelReasonCode: string | null;
  },
  now = new Date()
) {
  const showCode = CODE_VISIBLE_STATUSES.has(order.status);
  if (showCode) await ensureHandoverCode(order.id, order.storeId);
  const [handover, rating, returnRequest, completion] = await Promise.all([
    showCode
      ? prisma.orderHandoverCode.findUnique({
          where: { orderId: order.id },
          select: { code: true, failures: true, usedAt: true },
        })
      : null,
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
    prisma.returnRequest.findFirst({
      where: { storeId: order.storeId, orderId: order.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        reason: true,
        decisionNote: true,
        decidedAt: true,
        reversalDeadline: true,
        createdAt: true,
      },
    }),
    order.status === "completed"
      ? prisma.ledgerEntry.findFirst({
          where: { storeId: order.storeId, orderId: order.id, entryType: "order_completed" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        })
      : null,
  ]);
  const returnDeadline = completion
    ? new Date(completion.createdAt.valueOf() + RETURN_REVERSAL_WINDOW_DAYS * DAY_MS)
    : null;
  const hasOpenReturn = returnRequest?.status === "requested";
  return {
    deliveryStage:
      order.status === "out_for_delivery" && order.deliveryStage
        ? { code: order.deliveryStage, label: labelOf(DELIVERY_STAGES, order.deliveryStage) }
        : null,
    cancelReason: order.cancelReasonCode ? labelOf(CANCEL_REASONS, order.cancelReasonCode) : null,
    handoverCode:
      handover && !handover.usedAt && handover.failures < HANDOVER_MAX_FAILURES
        ? handover.code
        : null,
    canCancel: order.status === "new",
    canRate: ratingOpen(order.status, order.statusUpdatedAt, now),
    rateBy:
      order.status === "completed"
        ? new Date(order.statusUpdatedAt.valueOf() + RATING_WINDOW_DAYS * DAY_MS)
        : null,
    rating: rating ? presentRating(rating) : null,
    canReturn:
      order.status === "completed" &&
      Boolean(returnDeadline && now <= returnDeadline) &&
      !hasOpenReturn &&
      returnRequest?.status !== "approved",
    returnBy: returnDeadline,
    returnRequest,
  };
}

export function afterSalesOptions() {
  return {
    cancelReasons: CANCEL_REASONS,
    returnReasons: RETURN_REASONS,
    ratingTags: RATING_TAGS,
    ratingWindowDays: RATING_WINDOW_DAYS,
    returnWindowDays: RETURN_REVERSAL_WINDOW_DAYS,
  };
}

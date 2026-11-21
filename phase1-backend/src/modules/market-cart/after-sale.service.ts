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

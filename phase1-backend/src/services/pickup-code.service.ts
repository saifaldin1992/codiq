/**
 * «رمز الاستلام» (Marketplace M6, G5): proof at the counter that the person
 * collecting a pick-up order is the one who placed it.
 *
 * The code is DERIVED, not stored: six digits from an HMAC of the order id
 * under the `otp` purpose key (domain-separated by the «pickup:» prefix). So
 * there is no column to leak and nothing to rotate per order; a leaked order
 * id is not a code, and rotating the session secret keeps old codes valid
 * through the verifying keys for as long as old sessions are.
 *
 * The shopper sees it (and a QR that opens the merchant's order page with it
 * filled in) once the order is ready for collection. The merchant confirms it
 * and the order completes through the store's own state machine — the same
 * transition, event and notification as the status button. Guessing is capped
 * per order.
 */
import crypto from "node:crypto";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import { buildKeys } from "../auth/keys.js";
import { config } from "../config.js";
import { transitionOrderStatus, type OrderTransitionActor } from "./order-lifecycle.service.js";
import { consumeStorefrontRateLimit } from "./storefront.service.js";

/** A pick-up order is ready for collection at this status (the delivery flow's «قيد التوصيل»). */
export const PICKUP_READY_STATUS = "out_for_delivery";
const KEYS = buildKeys(config.sessionJwtSecret, config.sessionJwtSecretPrevious).otp;

function codeUnder(key: Buffer, orderId: string) {
  const mac = crypto.createHmac("sha256", key).update(`pickup:${orderId}`).digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** The code for this order, as the shopper is shown it. */
export function pickupCode(orderId: string): string {
  return codeUnder(KEYS.signing, orderId);
}

function matches(orderId: string, candidate: string) {
  const given = Buffer.from(candidate.padEnd(6, " ").slice(0, 6));
  return KEYS.verifying.some((key) => crypto.timingSafeEqual(Buffer.from(codeUnder(key, orderId)), given));
}

/** The merchant confirms a pick-up with the shopper's code: the order completes. */
export async function confirmPickup(storeId: string, actor: OrderTransitionActor, orderId: string, rawCode: unknown) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(code)) throw new HttpError(422, "INVALID_PICKUP_CODE", "رمز الاستلام ستّة أرقام.");
  const order = await prisma.storeOrder.findFirst({ where: { id: orderId, storeId }, select: { id: true, fulfilment: true, status: true, version: true } });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");
  if (order.fulfilment !== "pickup") throw new HttpError(409, "NOT_A_PICKUP_ORDER", "هذا الطلب للتوصيل، لا للاستلام من المتجر.");
  if (order.status !== PICKUP_READY_STATUS) throw new HttpError(409, "PICKUP_NOT_READY", "علّم الطلب «جاهز للاستلام» أوّلاً، ثم أكّد الاستلام بالرمز.");
  // Five tries per order per quarter hour: six digits are not a secret against a patient guesser.
  await consumeStorefrontRateLimit({ scope: "pickup_code", rawKey: order.id, limit: 5, windowMs: 15 * 60 * 1000 });
  if (!matches(order.id, code)) throw new HttpError(422, "WRONG_PICKUP_CODE", "رمز الاستلام غير صحيح. اطلبه من الزبون من صفحة طلبه.");
  return transitionOrderStatus(storeId, actor, order.id, { toStatus: "completed", expectedVersion: order.version, note: "سُلّم للزبون في المتجر — تأكّد برمز الاستلام." });
}

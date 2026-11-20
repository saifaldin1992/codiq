/**
 * MD-1 «إجراءات جماعية على الطلبات».
 *
 * THE STATE MACHINE IS NOT BYPASSED. This service owns no SQL of its own: it is
 * a thin sequencer that calls the existing `transitionOrderStatus` once per
 * order, each call in its OWN transaction with its OWN freshly-read
 * `expectedVersion`. That means every bulk item still goes through:
 *   - the allowed-edge table (`INVALID_ORDER_TRANSITION`),
 *   - the optimistic-concurrency guard (`ORDER_VERSION_CONFLICT`),
 *   - the 20B-1 prescription gate (`PRESCRIPTION_NOT_APPROVED`),
 *   - reservation settlement, the notification outbox row, and the finance
 *     ledger entry — identical to a single-order transition.
 * There is deliberately NO multi-order UPDATE, NO shared transaction, and NO
 * status write anywhere in this file.
 *
 * Failures are per-order and never abort the batch: each item resolves to
 * `{ orderId, ok, code }` so the UI can report "نُقل N، تعذّر M" with reasons.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { ORDER_STATUSES, orderTransitionNote, transitionOrderStatus, type OrderTransitionActor } from "./order-lifecycle.service.js";

export const BULK_ORDER_LIMIT = 50;

export interface BulkOrderResult {
  orderId: string;
  ok: boolean;
  code: string;
  status?: string;
  orderNumber?: string;
  message?: string;
}

/**
 * ق-219 — every item may carry the version the CLIENT saw.
 *
 * The single-order path is a textbook If-Match: the screen sends `order.version`
 * and `transitionOrderStatus` compare-and-swaps on it. This path used to re-read
 * the version on the server immediately before each transition — which is a
 * real guard against a race in the microseconds between the read and the write,
 * and NO guard at all against the case the guard exists for: a merchant whose
 * order board has been open and stale for ten minutes while a staff member on
 * her phone moved the same orders. Bulk is where the Iraqi order board is
 * actually worked — forty orders cleared at the end of the day, on the same
 * screen as two staff over a mobile connection — so it was the one path where
 * optimistic concurrency was switched off exactly where it mattered most.
 *
 * The row already carries `version` all the way to the browser; the only thing
 * missing was one field in the request body. A bare `{ orderId }` (or a bare
 * string) keeps the old freshly-read behaviour, so nothing that already calls
 * this route breaks.
 */
function requestedOrders(value: unknown): Array<{ orderId: string; expectedVersion: number | null }> {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(422, "INVALID_BULK_SELECTION", "اختر طلباً واحداً على الأقل.");
  const items: Array<{ orderId: string; expectedVersion: number | null }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = typeof entry === "object" && entry !== null ? (entry as { orderId?: unknown; expectedVersion?: unknown }) : null;
    const orderId = typeof entry === "string" ? entry : record?.orderId;
    if (typeof orderId !== "string" || !orderId) throw new HttpError(422, "INVALID_BULK_SELECTION", "كل عنصر يجب أن يحمل orderId نصياً.");
    const rawVersion = record?.expectedVersion;
    if (rawVersion !== undefined && rawVersion !== null && (!Number.isInteger(rawVersion) || (rawVersion as number) < 1)) {
      throw new HttpError(422, "INVALID_BULK_SELECTION", "expectedVersion يجب أن يكون رقماً صحيحاً موجباً.");
    }
    if (seen.has(orderId)) continue;
    seen.add(orderId);
    items.push({ orderId, expectedVersion: typeof rawVersion === "number" ? rawVersion : null });
  }
  // The cap is enforced on the RAW list length too, so a 60-item payload of
  // duplicates is refused rather than silently shrunk to one.
  if (value.length > BULK_ORDER_LIMIT || items.length > BULK_ORDER_LIMIT) {
    throw new HttpError(422, "BULK_LIMIT_EXCEEDED", `الحد الأقصى ${BULK_ORDER_LIMIT} طلباً في العملية الواحدة.`);
  }
  return items;
}

export async function bulkTransitionOrderStatus(storeId: string, actor: OrderTransitionActor, body: Record<string, unknown>) {
  const requested = requestedOrders(body.orders);
  const orderIds = requested.map((item) => item.orderId);
  const toStatus = body.toStatus;
  // Validated once up-front: an unsupported target is a request error, not 50
  // identical per-order failures. Per-order edge legality still lives entirely
  // inside transitionOrderStatus.
  if (typeof toStatus !== "string" || !(ORDER_STATUSES as readonly string[]).includes(toStatus)) {
    throw new HttpError(422, "INVALID_ORDER_STATUS", "الحالة المطلوبة غير مدعومة.");
  }
  // The note is shared by the whole batch, so it is validated ONCE up-front with
  // the state machine's own validator — exactly like `toStatus` above. Passing a
  // malformed note through used to make `transitionOrderStatus` reject it fifty
  // separate times: fifty database round trips answering HTTP 200 with
  // succeeded=0/failed=50, when the truth is a single malformed request.
  const note = orderTransitionNote(body.note) ?? undefined;

  const results: BulkOrderResult[] = [];
  for (const { orderId, expectedVersion } of requested) {
    // The order number is read for the summary line; the version is read only
    // when the caller did not send one (ق-219). When it did, the compare-and-swap
    // inside `transitionOrderStatus` is against what the merchant SAW, which is
    // the whole point of an If-Match — fifty of them, one per order.
    const current = await prisma.storeOrder.findFirst({ where: { id: orderId, storeId }, select: { version: true, orderNumber: true } });
    if (!current) {
      results.push({ orderId, ok: false, code: "RESOURCE_NOT_FOUND", message: "الطلب غير موجود ضمن هذا المتجر." });
      continue;
    }
    try {
      const order = await transitionOrderStatus(storeId, actor, orderId, { toStatus, expectedVersion: expectedVersion ?? current.version, note });
      results.push({ orderId, ok: true, code: "OK", status: order.status, orderNumber: order.orderNumber });
    } catch (error) {
      const failure = error instanceof HttpError ? error : null;
      if (!failure) throw error;
      results.push({ orderId, ok: false, code: failure.code, orderNumber: current.orderNumber, message: failure.message });
    }
  }
  return { toStatus, requested: orderIds.length, succeeded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, results };
}

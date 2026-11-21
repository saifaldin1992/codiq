/**
 * CD-3 «بوابة إرجاع ذاتية» — the shopper asks, the merchant answers.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: approving a return does not return an
 * order. It calls `transitionOrderStatus(..., "returned")` — inside the SAME
 * transaction that records the decision — the same path a
 * merchant uses from his orders screen, which fires `recordOrderReturn` and the
 * ledger reversal. Nothing here writes a ledger entry, and nothing here sets
 * `storeOrder.status` directly.
 *
 * That is not tidiness. A second route to `returned` would be a second place the
 * 15-day window is checked, a second place the already-reversed guard is
 * repeated, and a second place the status machine's edges are enforced. Three
 * chances to drift, on the code path that moves money.
 *
 * THE WINDOW IS THE FINANCE WINDOW. A request may be opened only while the order
 * can still be reversed automatically. A separate, longer «returns window» would
 * produce requests that are valid and approvals that quietly cannot reverse —
 * `recordOrderReturn` answers "outside_window" and carries on, leaving the
 * merchant paying commission on a sale he refunded until the platform owner
 * adjusts it by hand. The deadline is stored on the request and reported to the
 * merchant, so approving late is a visible cost rather than a silent one.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import type { StoreActor } from "../auth/staff-permissions.js";
import { RETURN_REVERSAL_WINDOW_DAYS } from "./finance.service.js";
import { announceOrderTransition, transitionOrderStatus } from "./order-lifecycle.service.js";
import { recordAuditEvent } from "./soft-delete/audit-log.service.js";

const PAGE_SIZE = 20;

/**
 * When automatic reversal stops being possible. Measured from the COMPLETION
 * LEDGER ENTRY, because that is what `recordOrderReturn` measures from — a
 * deadline derived from anything else (the order's createdAt, its
 * statusUpdatedAt) would tell the merchant one date while the reversal used
 * another.
 */
async function reversalDeadlineFor(storeId: string, orderId: string): Promise<Date | null> {
  const completion = await prisma.ledgerEntry.findFirst({
    where: { storeId, orderId, entryType: "order_completed" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!completion) return null;
  return new Date(completion.createdAt.valueOf() + RETURN_REVERSAL_WINDOW_DAYS * 86_400_000);
}

function parseReason(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpError(422, "RETURN_REASON_REQUIRED", "اكتب سبب الإرجاع — التاجر يحتاجه ليقرر.");
  }
  const reason = raw.trim();
  if (reason.length > 1000) throw new HttpError(422, "INVALID_RETURN_REASON", "السبب يتجاوز 1000 حرف.");
  return reason;
}

export async function requestReturn(
  storeId: string,
  customerId: string,
  orderId: string,
  input: { reason: unknown },
  now = new Date(),
) {
  const reason = parseReason(input.reason);

  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId, customerId },
    select: { id: true, status: true, orderNumber: true },
  });
  // 404 for someone else's order too: whether an order exists is not something
  // this endpoint should confirm to a shopper who does not own it.
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود.");

  if (order.status !== "completed") {
    // You cannot return what you have not received. An order still in flight is
    // cancelled (PG-1) or refused at the door — not returned.
    throw new HttpError(422, "ORDER_NOT_RETURNABLE", "الإرجاع متاح للطلبات المستلمة فقط. إن لم يصلك الطلب بعد، تواصل مع المتجر.");
  }

  const deadline = await reversalDeadlineFor(storeId, order.id);
  if (!deadline) throw new HttpError(422, "ORDER_NOT_RETURNABLE", "لا يوجد قيد إتمام لهذا الطلب.");
  if (now > deadline) {
    throw new HttpError(422, "RETURN_WINDOW_CLOSED", `مهلة الإرجاع (${RETURN_REVERSAL_WINDOW_DAYS} يوماً) انتهت لهذا الطلب. تواصل مع المتجر مباشرة.`);
  }

  const open = await prisma.returnRequest.findFirst({ where: { storeId, orderId: order.id, status: "requested" }, select: { id: true } });
  if (open) throw new HttpError(409, "RETURN_ALREADY_REQUESTED", "لديك طلب إرجاع مفتوح لهذا الطلب.");

  return prisma.returnRequest.create({
    data: { storeId, orderId: order.id, customerId, reason, reversalDeadline: deadline },
    select: { id: true, status: true, reason: true, reversalDeadline: true, createdAt: true },
  });
}

/** The shopper may withdraw while it is still open — never after an answer. */
export async function withdrawReturnRequest(storeId: string, customerId: string, requestId: string) {
  const request = await prisma.returnRequest.findFirst({
    where: { id: requestId, storeId, customerId },
    select: { id: true, status: true },
  });
  if (!request) throw new HttpError(404, "RESOURCE_NOT_FOUND", "طلب الإرجاع غير موجود.");
  if (request.status !== "requested") {
    throw new HttpError(409, "RETURN_ALREADY_DECIDED", "لا يمكن سحب طلب أُجيب عليه.");
  }
  // The status test sits in the WHERE, as in decideReturnRequest. Read-then-
  // update let a withdrawal that read «requested» overwrite an approval that
  // committed in between — a request saying «withdrawn» beside an order that
  // was returned and reversed.
  const withdrawn = await prisma.returnRequest.updateMany({ where: { id: request.id, storeId, status: "requested" }, data: { status: "withdrawn" } });
  if (withdrawn.count !== 1) throw new HttpError(409, "RETURN_ALREADY_DECIDED", "لا يمكن سحب طلب أُجيب عليه.");
  return { id: request.id, status: "withdrawn" };
}

/** The cursor's list kinds. One per list, so a cursor cannot cross lists. */
const CUSTOMER_RETURNS_KIND = "storefront.account.returns";
const STORE_RETURNS_KIND = "merchant.returns";

export async function listCustomerReturnRequests(storeId: string, customerId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit, 100, PAGE_SIZE);
  const cursor = await readListCursor(CUSTOMER_RETURNS_KIND, rawCursor);
  const rows = await prisma.returnRequest.findMany({
    where: { storeId, customerId, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, status: true, reason: true, decisionNote: true, decidedAt: true,
      reversalDeadline: true, createdAt: true,
      order: { select: { id: true, orderNumber: true, totalIqd: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(CUSTOMER_RETURNS_KIND, last.createdAt, last.id));
  return { requests: page, nextCursor };
}

export async function listStoreReturnRequests(storeId: string, query: Record<string, unknown>) {
  const status = typeof query.status === "string" && query.status ? query.status : undefined;
  const limit = parseListLimit(query.limit, 100, PAGE_SIZE);
  const cursor = await readListCursor(STORE_RETURNS_KIND, query.cursor);
  const rows = await prisma.returnRequest.findMany({
    where: { storeId, ...(status ? { status } : {}), ...keysetWhere("createdAt", "asc", cursor) },
    // OLDEST FIRST — the shopper who has been waiting longest is the one this
    // queue exists for. The leading `status: "asc"` this sort used to carry was
    // claimed to put open requests first and never did: the four statuses are
    // `approved`, `rejected`, `requested`, `withdrawn`, and alphabetically
    // `requested` is THIRD. It sorted decided requests above open ones, which
    // is the opposite of what its own comment promised. Dropping it also makes
    // the order a two-column keyset the cursor can page; `?status=requested`
    // remains the way to see only the open queue.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true, status: true, reason: true, decisionNote: true, decidedAt: true,
      reversalDeadline: true, createdAt: true,
      order: { select: { id: true, orderNumber: true, totalIqd: true, status: true } },
      customer: { select: { fullName: true, phone: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(STORE_RETURNS_KIND, last.createdAt, last.id));
  return { requests: page, nextCursor };
}

/**
 * The merchant's answer.
 *
 * APPROVING GOES THROUGH THE STATE MACHINE. `transitionOrderStatus` needs the
 * order's current version, so it is read here and passed straight in — and if
 * something else moved the order in between, that call raises the ordinary
 * version conflict rather than this code forcing a stale decision through.
 */
/**
 * 19-ج: the HTTP edge parses this body through `decideReturnRequestSchema`, so
 * an `approve` that is not a boolean answers 422 VALIDATION_FAILED naming the
 * field. The two guards below stay — the note rule because it is a business
 * refusal with its own code and its own sentence, and the `approve` check
 * because this function is exported and reachable from anywhere.
 */
export async function decideReturnRequest(
  storeId: string,
  actor: StoreActor,
  requestId: string,
  input: { approve: unknown; note?: unknown },
) {
  if (typeof input.approve !== "boolean") throw new HttpError(422, "INVALID_INPUT", "approve يجب أن يكون true أو false.");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : null;
  if (!input.approve && !note) {
    throw new HttpError(422, "RETURN_REJECTION_NOTE_REQUIRED", "رفض طلب الإرجاع يحتاج سبباً — يراه الزبون.");
  }

  const request = await prisma.returnRequest.findFirst({
    where: { id: requestId, storeId },
    select: { id: true, status: true, orderId: true, order: { select: { orderNumber: true, status: true, version: true } } },
  });
  if (!request) throw new HttpError(404, "RESOURCE_NOT_FOUND", "طلب الإرجاع غير موجود.");
  if (request.status !== "requested") throw new HttpError(409, "RETURN_ALREADY_DECIDED", "أُجيب على هذا الطلب مسبقاً.");

  // ONE transaction for the decision and the order it moves. They used to be
  // two: the order went to `returned` (ledger reversal, points, stock queue)
  // and THEN the request was marked — so a failure between them left a returned
  // order beside a request still «open», which no later click could clear
  // (`returned → returned` is not an edge). Now both commit or neither does.
  const actorRef = { kind: actor.kind, id: actor.id };
  const { updated, transition } = await prisma.$transaction(async (tx) => {
    // The guarded flip is the first write, so two decisions racing on the same
    // request resolve to one: the loser matches nothing and is refused before
    // it can touch the order.
    const flipped = await tx.returnRequest.updateMany({
      where: { id: request.id, storeId, status: "requested" },
      data: {
        status: input.approve ? "approved" : "rejected",
        decisionNote: note,
        decidedAt: new Date(),
        decidedByKind: actor.kind,
        decidedById: actor.id,
      },
    });
    if (flipped.count !== 1) throw new HttpError(409, "RETURN_ALREADY_DECIDED", "أُجيب على هذا الطلب مسبقاً.");
    // The one path to the money. If the order has already been moved elsewhere,
    // this raises the state machine's own error and the flip above rolls back,
    // so the request stays open — the merchant sees why, rather than a request
    // marked approved beside an order that never returned.
    const transition = input.approve
      ? await transitionOrderStatus(storeId, actorRef, request.orderId, {
          toStatus: "returned",
          expectedVersion: request.order.version,
          note: `إرجاع بموافقة على طلب الزبون (${request.id})`,
        }, tx)
      : null;
    const updated = await tx.returnRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: { id: true, status: true, decisionNote: true, decidedAt: true },
    });
    await recordAuditEvent(tx, {
      storeId,
      entityType: "return_request",
      entityId: request.id,
      entityLabel: request.order.orderNumber,
      action: input.approve ? "return.approved" : "return.rejected",
      actor,
      metadata: note ? { note } : {},
    });
    return { updated, transition };
  });
  // The version check inside the transition guarantees the order was still in
  // the status read above, so that is the edge it left.
  if (transition) announceOrderTransition(storeId, actorRef, transition, request.order.status);
  return updated;
}

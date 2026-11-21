/**
 * Marketplace M7b — support tickets.
 *
 * Opened by the shopper FROM a delivered order, within a day of delivery: a
 * complaint about something he has in his hands. The store that sold it answers
 * (it knows the order); the platform owner can step in, answer and close.
 *
 *   open → in_progress → awaiting_customer ⇄ in_progress → resolved → closed
 *
 * The shopper writes the first message (the description) and may reply only
 * after the support side has answered — so a ticket cannot become a chat with
 * nobody on the other end — and never once it is closed. On a resolved ticket
 * he answers «هل حُلّت مشكلتك؟»: yes closes it, «ليس بعد» sends it back.
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import {
  decodeListCursor,
  encodeListCursor,
  pageOf,
  parseListLimit,
} from "../../services/list-page.js";
import {
  deleteMarketImageObjects,
  getStoreLogoBytes,
  putMarketImage,
} from "../../services/product-image-storage.service.js";

export const TICKET_TYPES = [
  { code: "damaged", label: "منتج تالف" },
  { code: "missing_item", label: "منتج ناقص من الطلب" },
  { code: "wrong_item", label: "منتج غير الذي طلبته" },
  { code: "not_as_described", label: "لا يطابق الوصف" },
  { code: "late_delivery", label: "مشكلة في التوصيل" },
  { code: "payment", label: "مشكلة في الدفع أو المبلغ" },
  { code: "other", label: "مشكلة أخرى" },
] as const;
export type TicketType = (typeof TICKET_TYPES)[number]["code"];
export type TicketStatus = "open" | "in_progress" | "awaiting_customer" | "resolved" | "closed";
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "فُتحت",
  in_progress: "قيد المعالجة",
  awaiting_customer: "بانتظار ردّك",
  resolved: "حُلّت",
  closed: "مغلقة",
};

/** How long after delivery a ticket may still be opened. */
export const TICKET_WINDOW_HOURS = 24;
/** Pictures per side of one ticket. */
export const TICKET_ATTACHMENTS_PER_SIDE = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SupportActor = { kind: "merchant" | "staff" | "platform"; id: string };
type Scope = { shopperId: string } | { storeId: string } | { platform: true };

function scopeWhere(scope: Scope) {
  return "shopperId" in scope
    ? { shopperId: scope.shopperId }
    : "storeId" in scope
      ? { storeId: scope.storeId }
      : {};
}

async function ticketIn(scope: Scope, ticketId: string) {
  if (!UUID.test(ticketId)) throw new HttpError(404, "TICKET_NOT_FOUND", "التذكرة غير موجودة.");
  const ticket = await prisma.supportTicket.findFirst({
    where: { id: ticketId, ...scopeWhere(scope) },
  });
  if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "التذكرة غير موجودة.");
  return ticket;
}

const typeLabel = (code: string) =>
  TICKET_TYPES.find((entry) => entry.code === code)?.label ?? code;

function cardOf(row: {
  id: string;
  number: number;
  type: string;
  subject: string | null;
  status: string;
  escalatedAt: Date | null;
  lastSupportAt: Date | null;
  shopperReadAt: Date;
  createdAt: Date;
  updatedAt: Date;
  order: { id: string; orderNumber: string };
  store: { slug: string; name: string };
}) {
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    typeLabel: typeLabel(row.type),
    subject: row.subject,
    status: row.status,
    statusLabel: TICKET_STATUS_LABELS[row.status as TicketStatus] ?? row.status,
    escalated: Boolean(row.escalatedAt),
    newReplies: Boolean(row.lastSupportAt && row.lastSupportAt > row.shopperReadAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    order: row.order,
    store: row.store,
  };
}
const CARD_SELECT = {
  id: true,
  number: true,
  type: true,
  subject: true,
  status: true,
  escalatedAt: true,
  lastSupportAt: true,
  shopperReadAt: true,
  createdAt: true,
  updatedAt: true,
  order: { select: { id: true, orderNumber: true } },
  store: { select: { slug: true, name: true } },
} as const;

// ── the shopper ────────────────────────────────────────────────────────────

/** Which of his orders a ticket may be opened on right now, and why not for the rest. */
export async function ticketEligibility(shopperId: string, orderId: string, now = new Date()) {
  if (!UUID.test(orderId)) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, customer: { shopperId } },
    select: { id: true, storeId: true, status: true, statusUpdatedAt: true },
  });
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود.");
  const live = await prisma.supportTicket.findFirst({
    where: { orderId: order.id, status: { not: "closed" } },
    select: { id: true },
  });
  if (live)
    return {
      order,
      allowed: false as const,
      reason: "لديك تذكرة مفتوحة لهذا الطلب.",
      ticketId: live.id,
      until: null,
    };
  if (order.status !== "completed")
    return {
      order,
      allowed: false as const,
      reason: "لا يمكن فتح تذكرة على طلب لم يصلك بعد.",
      ticketId: null,
      until: null,
    };
  const until = new Date(order.statusUpdatedAt.valueOf() + TICKET_WINDOW_HOURS * 3_600_000);
  if (now > until)
    return {
      order,
      allowed: false as const,
      reason: `تُفتح التذكرة خلال ${TICKET_WINDOW_HOURS} ساعة من التسليم، وقد انتهت المدّة. تواصل معنا من «المساعدة».`,
      ticketId: null,
      until,
    };
  return { order, allowed: true as const, reason: null, ticketId: null, until };
}

export async function openTicket(
  shopperId: string,
  input: { orderId: string; type: TicketType; subject?: string; description: string },
  now = new Date()
) {
  const eligibility = await ticketEligibility(shopperId, input.orderId, now);
  if (!eligibility.allowed) {
    throw new HttpError(
      eligibility.ticketId ? 409 : 422,
      eligibility.ticketId ? "TICKET_ALREADY_OPEN" : "TICKET_NOT_ALLOWED",
      eligibility.reason,
      eligibility.ticketId ? { ticketId: eligibility.ticketId } : undefined
    );
  }
  await consumeStorefrontRateLimit({
    scope: "market_ticket_shopper",
    rawKey: shopperId,
    limit: 5,
    windowMs: 86_400_000,
  });
  try {
    const ticket = await prisma.supportTicket.create({
      data: {
        shopperId,
        storeId: eligibility.order.storeId,
        orderId: eligibility.order.id,
        type: input.type,
        subject: input.subject?.trim() || null,
        description: input.description.trim(),
      },
      select: CARD_SELECT,
    });
    return { ticket: cardOf(ticket) };
  } catch (error) {
    // Two taps at once: the partial unique index keeps one live ticket per order.
    if ((error as { code?: string }).code === "P2002")
      throw new HttpError(409, "TICKET_ALREADY_OPEN", "لديك تذكرة مفتوحة لهذا الطلب.");
    throw error;
  }
}

const LIST_KIND = "market-support-tickets";
const OPEN_STATUSES = ["open", "in_progress", "awaiting_customer", "resolved"];

async function ticketPage(where: object, rawCursor: unknown, rawLimit: unknown, kind: string) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(kind, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.supportTicket.findMany({
    where: {
      ...where,
      ...(cursor && at
        ? { OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: CARD_SELECT,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(kind, last.updatedAt, last.id)
  );
  return { tickets: page.map(cardOf), nextCursor };
}

export async function shopperTickets(
  shopperId: string,
  tab: unknown,
  rawCursor: unknown,
  rawLimit: unknown
) {
  const statuses = tab === "closed" ? ["closed"] : OPEN_STATUSES;
  const [page, summary] = await Promise.all([
    ticketPage(
      { shopperId, status: { in: statuses } },
      rawCursor,
      rawLimit,
      `${LIST_KIND}.shopper.${tab === "closed" ? "closed" : "open"}`
    ),
    prisma.supportTicket.groupBy({ by: ["status"], where: { shopperId }, _count: { _all: true } }),
  ]);
  const count = (status: string) => summary.find((row) => row.status === status)?._count._all ?? 0;
  return {
    ...page,
    summary: {
      open: OPEN_STATUSES.reduce((sum, status) => sum + count(status), 0),
      awaitingYou: count("awaiting_customer"),
      closed: count("closed"),
    },
  };
}

async function detail(ticketId: string) {
  const ticket = await prisma.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
    select: {
      ...CARD_SELECT,
      description: true,
      resolvedAt: true,
      closedAt: true,
      comments: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 200,
        select: { id: true, authorKind: true, body: true, createdAt: true },
      },
      attachments: {
        orderBy: { createdAt: "asc" },
        take: 2 * TICKET_ATTACHMENTS_PER_SIDE,
        select: { id: true, authorKind: true, contentType: true, byteSize: true, createdAt: true },
      },
    },
  });
  return {
    ...cardOf(ticket),
    description: ticket.description,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    comments: ticket.comments.map((comment) => ({
      ...comment,
      side: comment.authorKind === "shopper" ? "shopper" : "support",
    })),
    attachments: ticket.attachments,
  };
}

function shopperMayReply(ticket: { status: string; lastSupportAt: Date | null }) {
  return (
    ticket.status !== "closed" && ticket.status !== "resolved" && Boolean(ticket.lastSupportAt)
  );
}

export async function shopperTicket(shopperId: string, ticketId: string) {
  const ticket = await ticketIn({ shopperId }, ticketId);
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { shopperReadAt: new Date(), updatedAt: ticket.updatedAt },
  });
  const shopperAttachments = await prisma.supportTicketAttachment.count({
    where: { ticketId: ticket.id, authorKind: "shopper" },
  });
  return {
    ticket: await detail(ticket.id),
    canReply: shopperMayReply(ticket),
    replyHint:
      ticket.status === "closed"
        ? "التذكرة مغلقة."
        : !ticket.lastSupportAt
          ? "سيصلك ردّ فريق الدعم قريباً، وبعدها يمكنك الردّ."
          : null,
    askResolved: ticket.status === "resolved",
    canAttach: ticket.status !== "closed" && shopperAttachments < TICKET_ATTACHMENTS_PER_SIDE,
  };
}

export async function shopperReply(shopperId: string, ticketId: string, body: string) {
  const ticket = await ticketIn({ shopperId }, ticketId);
  if (ticket.status === "closed")
    throw new HttpError(409, "TICKET_CLOSED", "التذكرة مغلقة، لا يمكن الردّ عليها.");
  if (!ticket.lastSupportAt)
    throw new HttpError(409, "TICKET_AWAITING_SUPPORT", "انتظر ردّ فريق الدعم أوّلاً.");
  if (ticket.status === "resolved")
    throw new HttpError(409, "TICKET_RESOLVED", "أخبرنا أوّلاً: هل حُلّت مشكلتك؟");
  await prisma.$transaction([
    prisma.supportTicketComment.create({
      data: { ticketId: ticket.id, authorKind: "shopper", authorId: shopperId, body: body.trim() },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: "in_progress", shopperReadAt: new Date() },
    }),
  ]);
  return shopperTicket(shopperId, ticket.id);
}

/** «هل حُلّت مشكلتك؟» */
export async function shopperConfirm(shopperId: string, ticketId: string, resolved: boolean) {
  const ticket = await ticketIn({ shopperId }, ticketId);
  if (ticket.status !== "resolved")
    throw new HttpError(409, "TICKET_NOT_RESOLVED", "لم تُعلَّم التذكرة كمحلولة بعد.");
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: resolved
      ? { status: "closed", closedAt: new Date() }
      : { status: "in_progress", resolvedAt: null },
  });
  return shopperTicket(shopperId, ticket.id);
}

// ── attachments ────────────────────────────────────────────────────────────

export async function attachToTicket(
  scope: Scope,
  authorKind: "shopper" | "merchant" | "staff" | "platform",
  ticketId: string,
  file: Express.Multer.File | undefined
) {
  if (!file) throw new HttpError(422, "IMAGE_REQUIRED", "اختر صورة.");
  const ticket = await ticketIn(scope, ticketId);
  if (ticket.status === "closed") throw new HttpError(409, "TICKET_CLOSED", "التذكرة مغلقة.");
  const side = authorKind === "shopper" ? ["shopper"] : ["merchant", "staff", "platform"];
  if (
    (await prisma.supportTicketAttachment.count({
      where: { ticketId: ticket.id, authorKind: { in: side } },
    })) >= TICKET_ATTACHMENTS_PER_SIDE
  ) {
    throw new HttpError(
      409,
      "TICKET_ATTACHMENTS_FULL",
      `حتّى ${TICKET_ATTACHMENTS_PER_SIDE} صور لكلّ طرف.`
    );
  }
  const stored = await putMarketImage("tickets", file);
  try {
    const attachment = await prisma.supportTicketAttachment.create({
      data: {
        ticketId: ticket.id,
        authorKind,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
      },
      select: { id: true, authorKind: true, contentType: true, byteSize: true, createdAt: true },
    });
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { updatedAt: new Date() },
    });
    return { attachment };
  } catch (error) {
    await deleteMarketImageObjects([stored.objectKey]).catch(() => undefined);
    throw error;
  }
}

export async function attachmentBytes(scope: Scope, ticketId: string, attachmentId: string) {
  const ticket = await ticketIn(scope, ticketId);
  if (!UUID.test(attachmentId)) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المرفق غير موجود.");
  const row = await prisma.supportTicketAttachment.findFirst({
    where: { id: attachmentId, ticketId: ticket.id },
    select: { objectKey: true, contentType: true },
  });
  if (!row) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المرفق غير موجود.");
  return { contentType: row.contentType, bytes: await getStoreLogoBytes(row.objectKey) };
}

// ── the support side: the store and the owner ─────────────────────────────

export async function supportTickets(
  scope: { storeId: string } | { platform: true },
  query: { status?: string; escalated?: boolean },
  rawCursor: unknown,
  rawLimit: unknown
) {
  const where = {
    ...scopeWhere(scope),
    ...(query.status === "active"
      ? { status: { in: ["open", "in_progress"] } }
      : query.status
        ? { status: query.status }
        : {}),
    ...(query.escalated ? { escalatedAt: { not: null } } : {}),
  };
  const kind = `${LIST_KIND}.${"storeId" in scope ? "store" : "platform"}.${query.status ?? "all"}.${query.escalated ? "e" : "a"}`;
  return ticketPage(where, rawCursor, rawLimit, kind);
}

export async function supportTicket(
  scope: { storeId: string } | { platform: true },
  ticketId: string
) {
  const ticket = await ticketIn(scope, ticketId);
  const order = await prisma.storeOrder.findUniqueOrThrow({
    where: { id: ticket.orderId },
    select: {
      orderNumber: true,
      totalIqd: true,
      customerName: true,
      recipientPhone: true,
      status: true,
      items: { select: { productName: true, quantity: true }, take: 50 },
    },
  });
  return {
    ticket: { ...(await detail(ticket.id)), description: ticket.description },
    order,
    canReply: ticket.status !== "closed",
  };
}

export async function supportReply(
  scope: { storeId: string } | { platform: true },
  actor: SupportActor,
  ticketId: string,
  input: { body: string; resolve?: boolean }
) {
  const ticket = await ticketIn(scope, ticketId);
  if (ticket.status === "closed") throw new HttpError(409, "TICKET_CLOSED", "التذكرة مغلقة.");
  const now = new Date();
  await prisma.$transaction([
    prisma.supportTicketComment.create({
      data: {
        ticketId: ticket.id,
        authorKind: actor.kind,
        authorId: actor.id,
        body: input.body.trim(),
      },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: input.resolve ? "resolved" : "awaiting_customer",
        lastSupportAt: now,
        ...(input.resolve ? { resolvedAt: now } : {}),
      },
    }),
  ]);
  return supportTicket(scope, ticket.id);
}

/** «قيد المعالجة» or «حُلّت» without writing a reply. */
export async function setTicketStatus(
  scope: { storeId: string } | { platform: true },
  ticketId: string,
  status: "in_progress" | "resolved"
) {
  const ticket = await ticketIn(scope, ticketId);
  if (ticket.status === "closed") throw new HttpError(409, "TICKET_CLOSED", "التذكرة مغلقة.");
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      status,
      ...(status === "resolved"
        ? { resolvedAt: new Date(), lastSupportAt: ticket.lastSupportAt ?? new Date() }
        : {}),
    },
  });
  return supportTicket(scope, ticket.id);
}

/** The owner takes a ticket over, and only the owner closes without the shopper. */
export async function escalateTicket(ticketId: string) {
  const ticket = await ticketIn({ platform: true }, ticketId);
  if (ticket.status === "closed") throw new HttpError(409, "TICKET_CLOSED", "التذكرة مغلقة.");
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { escalatedAt: ticket.escalatedAt ?? new Date() },
  });
  return supportTicket({ platform: true }, ticket.id);
}

export async function closeTicket(ticketId: string) {
  const ticket = await ticketIn({ platform: true }, ticketId);
  if (ticket.status === "closed")
    throw new HttpError(409, "TICKET_CLOSED", "التذكرة مغلقة مسبقاً.");
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status: "closed", closedAt: new Date() },
  });
  return supportTicket({ platform: true }, ticket.id);
}

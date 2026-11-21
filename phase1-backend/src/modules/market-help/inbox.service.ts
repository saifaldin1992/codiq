/**
 * Marketplace M7 «الإشعارات» — the shopper's inbox.
 *
 * DERIVED, NOT STORED. Every notice is a fact the system already keeps durably:
 * a step in an order's status history, a store's answer to a return. The inbox
 * reads them directly, so a notice cannot be lost between a commit and an event
 * handler, and the money path is not edited to write one. Only the read marks
 * are stored: a «read everything up to here» instant, and the items opened
 * one by one after it.
 *
 * His own actions (cancelling his order) are not notices to himself.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";

type Row = { item_id: string; source: "o" | "r"; at: Date; status: string; order_id: string; order_number: string; fulfilment: string; store_name: string; note: string | null; read: boolean };

const KIND = "market-inbox";
const KEY = /^([or]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function itemsSql(shopperId: string) {
  return Prisma.sql`
    SELECT e.id AS item_id, 'o' AS source, e.created_at AS at, e.to_status AS status, o.id AS order_id, o.order_number, o.fulfilment, st.name AS store_name, NULL::text AS note
      FROM order_status_events e
      JOIN store_orders o ON o.id = e.order_id AND o.store_id = e.store_id
      JOIN customers c ON c.id = o.customer_id AND c.store_id = o.store_id
      JOIN stores st ON st.id = o.store_id
     WHERE c.shopper_id = ${shopperId}::uuid AND e.actor_kind <> 'customer' AND e.from_status IS NOT NULL
    UNION ALL
    SELECT r.id, 'r', r.decided_at, r.status, o.id, o.order_number, o.fulfilment, st.name, r.decision_note
      FROM return_requests r
      JOIN store_orders o ON o.id = r.order_id AND o.store_id = r.store_id
      JOIN customers c ON c.id = o.customer_id AND c.store_id = o.store_id
      JOIN stores st ON st.id = o.store_id
     WHERE c.shopper_id = ${shopperId}::uuid AND r.status IN ('approved', 'rejected') AND r.decided_at IS NOT NULL`;
}

function readAllAtSql(shopperId: string) {
  return Prisma.sql`COALESCE((SELECT read_all_at FROM shopper_inbox_state WHERE shopper_id = ${shopperId}::uuid), '-infinity'::timestamptz)`;
}

const ORDER_TEXT: Record<string, (row: Row) => { title: string; body: string }> = {
  processing: (row) => ({ title: "قبل المتجر طلبك", body: `${row.store_name} قبل الطلب رقم ${row.order_number} وسيبدأ بتجهيزه.` }),
  preparation: (row) => ({ title: "طلبك قيد التجهيز", body: `${row.store_name} يجهّز الطلب رقم ${row.order_number}.` }),
  out_for_delivery: (row) => row.fulfilment === "pickup"
    ? { title: "طلبك جاهز للاستلام", body: `الطلب رقم ${row.order_number} جاهز في ${row.store_name}. اعرض رمز الاستلام عند وصولك.` }
    : { title: "طلبك في الطريق إليك", body: `الطلب رقم ${row.order_number} خرج للتوصيل. جهّز رمز الاستلام للمندوب.` },
  completed: (row) => ({ title: "تمّ تسليم طلبك", body: `استلمت الطلب رقم ${row.order_number}. شاركنا تقييمك لـ${row.store_name}.` }),
  cancelled: (row) => ({ title: "أُلغي طلبك", body: `ألغى ${row.store_name} الطلب رقم ${row.order_number}.` }),
  rejected: (row) => ({ title: "اعتذر المتجر عن طلبك", body: `لم يتمكّن ${row.store_name} من تنفيذ الطلب رقم ${row.order_number}.` }),
  returned: (row) => ({ title: "سُجّل إرجاع طلبك", body: `الطلب رقم ${row.order_number} سُجّل مُرجعاً لدى ${row.store_name}.` }),
};

function present(row: Row) {
  const text = row.source === "r"
    ? row.status === "approved"
      ? { title: "وافق المتجر على الإرجاع", body: `${row.store_name} وافق على إرجاع الطلب رقم ${row.order_number}.${row.note ? ` ${row.note}` : ""}` }
      : { title: "رفض المتجر طلب الإرجاع", body: `${row.store_name}: ${row.note ?? "لم يقبل طلب الإرجاع."}` }
    : (ORDER_TEXT[row.status] ?? ((r: Row) => ({ title: "تحديث على طلبك", body: `الطلب رقم ${r.order_number}` })))(row);
  return { key: `${row.source}:${row.item_id}`, kind: row.source === "r" ? "return" : "order", at: row.at, read: row.read, ...text, orderId: row.order_id, link: `/orders/${row.order_id}` };
}

export async function inboxPage(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(KIND, rawCursor);
  const after = cursor ? Prisma.sql`WHERE (i.at, i.item_id) < (${new Date(cursor.value)}::timestamptz, ${cursor.id}::uuid)` : Prisma.empty;
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT i.*, (i.at <= ${readAllAtSql(shopperId)} OR rd.item_key IS NOT NULL) AS read
      FROM (${itemsSql(shopperId)}) i
      LEFT JOIN shopper_inbox_reads rd ON rd.shopper_id = ${shopperId}::uuid AND rd.item_key = i.source || ':' || i.item_id
      ${after}
     ORDER BY i.at DESC, i.item_id DESC
     LIMIT ${limit + 1}`;
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(KIND, last.at, last.item_id));
  return { items: page.map(present), nextCursor };
}

/** The badge. Counted in the database; capped so a long history costs nothing extra. */
export async function unreadCount(shopperId: string) {
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM (${itemsSql(shopperId)}) i
       WHERE i.at > ${readAllAtSql(shopperId)}
         AND NOT EXISTS (SELECT 1 FROM shopper_inbox_reads rd WHERE rd.shopper_id = ${shopperId}::uuid AND rd.item_key = i.source || ':' || i.item_id)
       LIMIT 100) capped`;
  return { unread: row?.n ?? 0 };
}

export async function markRead(shopperId: string, key: string) {
  if (!KEY.test(key)) throw new HttpError(422, "INVALID_INBOX_KEY", "إشعار غير معروف.");
  await prisma.shopperInboxRead.createMany({ data: [{ shopperId, itemKey: key.toLowerCase() }], skipDuplicates: true });
  return unreadCount(shopperId);
}

/** «تحديد الكلّ كمقروء»: one instant replaces every per-item mark before it. */
export async function markAllRead(shopperId: string) {
  const now = new Date();
  await prisma.$transaction([
    prisma.shopperInboxState.upsert({ where: { shopperId }, create: { shopperId, readAllAt: now }, update: { readAllAt: now } }),
    prisma.shopperInboxRead.deleteMany({ where: { shopperId, readAt: { lte: now } } }),
  ]);
  return { unread: 0 };
}

/**
 * MD-1 «ملاحظات ووسوم داخلية على الطلب».
 *
 * INTERNAL-ONLY contract — the load-bearing property of this feature:
 *  - `order_notes` is read by exactly TWO endpoints, both under
 *    `/merchant/stores/:storeSlug/orders/:orderId/notes` behind
 *    `requireStoreActor` (orders.view to read, orders.update to write). No
 *    storefront, customer, or public route selects this table at all.
 *  - `order_tags` is a CHILD TABLE, not a `store_orders` column, precisely so the
 *    same holds for tags. The customer order read in storefront.service.ts uses a
 *    top-level `include`, which returns every scalar column of store_orders — a
 *    scalar `internal_tags` would therefore have shipped straight into the
 *    customer's own payload. A relation is only ever returned when a query names
 *    it, and no storefront/customer query names this one.
 * Both surfaces stay merchant-side by construction, not by filtering.
 *
 * Every read and write is anchored on the guard-resolved storeId, so a
 * cross-store orderId is a 404 (IDOR-safe) rather than a leak.
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";

export const ORDER_NOTE_MAX_LENGTH = 2000;
export const ORDER_TAGS_MAX_COUNT = 8;
export const ORDER_TAG_MAX_LENGTH = 24;

async function scopedOrderId(storeId: string, orderId: string) {
  // findFirst on the (id, storeId) pair: a foreign order is indistinguishable
  // from a missing one.
  const order = await prisma.storeOrder.findFirst({ where: { id: orderId, storeId }, select: { id: true } });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found in this store.");
  return order.id;
}

function notePayload(note: { id: string; authorKind: string; authorId: string; body: string; createdAt: Date }, authorName: string | null = null) {
  return { id: note.id, authorKind: note.authorKind, authorId: note.authorId, authorName, body: note.body, createdAt: note.createdAt };
}

/**
 * An internal thread is useless if nobody can tell who wrote a line. The stored
 * `authorId` is a uuid, so the names are resolved here in ONE batched read per
 * kind (merchant business name / staff display name) and attached as
 * `authorName`; a deleted author simply falls back to null and the UI keeps
 * showing the generic role label.
 */
async function withAuthorNames(notes: Array<{ id: string; authorKind: string; authorId: string; body: string; createdAt: Date }>) {
  const merchantIds = Array.from(new Set(notes.filter((note) => note.authorKind === "merchant").map((note) => note.authorId)));
  const staffIds = Array.from(new Set(notes.filter((note) => note.authorKind === "staff").map((note) => note.authorId)));
  const [merchants, staff] = await Promise.all([
    merchantIds.length ? prisma.merchant.findMany({ where: { id: { in: merchantIds } }, select: { id: true, businessName: true } }) : Promise.resolve([]),
    staffIds.length ? prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
  ]);
  const names = new Map<string, string>();
  for (const merchant of merchants) names.set(merchant.id, merchant.businessName);
  for (const member of staff) names.set(member.id, member.displayName);
  return notes.map((note) => notePayload(note, names.get(note.authorId) ?? null));
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const ORDER_NOTES_KIND = "merchant.order.notes";

/**
 * D-18: nothing caps how many notes a store writes on one order, and this
 * returned all of them. A long-running dispute is exactly the order that
 * accumulates them, and exactly the one a packer opens.
 */
export async function listOrderNotes(storeId: string, orderId: string, rawLimit?: unknown, rawCursor?: unknown) {
  await scopedOrderId(storeId, orderId);
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(ORDER_NOTES_KIND, rawCursor);
  const rows = await prisma.orderNote.findMany({
    where: { storeId, orderId, ...keysetWhere("createdAt", "asc", cursor) },
    select: { id: true, authorKind: true, authorId: true, body: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(ORDER_NOTES_KIND, last.createdAt, last.id));
  return { notes: await withAuthorNames(page), nextCursor };
}

export async function createOrderNote(storeId: string, author: { kind: "merchant" | "staff"; id: string }, orderId: string, body: Record<string, unknown>) {
  await scopedOrderId(storeId, orderId);
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) throw new HttpError(422, "INVALID_ORDER_NOTE", "نص الملاحظة مطلوب.");
  if (text.length > ORDER_NOTE_MAX_LENGTH) throw new HttpError(422, "INVALID_ORDER_NOTE", `الملاحظة الداخلية يجب ألا تتجاوز ${ORDER_NOTE_MAX_LENGTH} حرفاً.`);
  const note = await prisma.orderNote.create({
    data: { storeId, orderId, authorKind: author.kind, authorId: author.id, body: text },
    select: { id: true, authorKind: true, authorId: true, body: true, createdAt: true },
  });
  return (await withAuthorNames([note]))[0];
}

/**
 * Normalizes a raw tag list: trims, collapses inner whitespace, drops empties,
 * de-duplicates case-insensitively (keeping the first spelling), and enforces
 * the count/length caps. The DB CHECK mirrors these caps.
 */
export function normalizeOrderTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(422, "INVALID_ORDER_TAGS", "الوسوم يجب أن تكون قائمة نصية.");
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new HttpError(422, "INVALID_ORDER_TAGS", "كل وسم يجب أن يكون نصاً.");
    const tag = entry.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > ORDER_TAG_MAX_LENGTH) throw new HttpError(422, "INVALID_ORDER_TAGS", `طول الوسم يجب ألا يتجاوز ${ORDER_TAG_MAX_LENGTH} حرفاً.`);
    const key = normalizeTagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  if (normalized.length > ORDER_TAGS_MAX_COUNT) throw new HttpError(422, "INVALID_ORDER_TAGS", `الحد الأقصى ${ORDER_TAGS_MAX_COUNT} وسوم لكل طلب.`);
  return normalized;
}

/** Case/whitespace-insensitive key, shared by the dedupe and the DB UNIQUE. */
export function normalizeTagKey(tag: string) {
  return tag.trim().replace(/\s+/g, " ").toLocaleLowerCase("ar-IQ");
}

export async function listOrderTags(storeId: string, orderId: string) {
  await scopedOrderId(storeId, orderId);
  const tags = await prisma.orderTag.findMany({ where: { storeId, orderId }, select: { tag: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  return { orderId, tags: tags.map((row) => row.tag) };
}

/**
 * Replaces the internal tag set. Deliberately does NOT touch `version` or
 * `status`: tags are metadata, not a lifecycle change, so they never interact
 * with the order state machine or its optimistic-concurrency guard.
 *
 * CONCURRENCY — why the row lock is load-bearing. delete-then-insert inside a
 * READ COMMITTED transaction is NOT safe on its own: two transactions that each
 * delete the (possibly empty) current set never conflict with one another, so
 * both proceed to insert. Measured before this lock existed, twenty concurrent
 * pairs produced 409s on the UNIQUE(order_id, tag_normalized) for identical
 * sets and 500s plus SIXTEEN stored tags for disjoint 8-tag sets — the count
 * trigger cannot close that window either, because under READ COMMITTED it only
 * counts rows the other transaction has already committed.
 *
 * Taking `store_orders` FOR UPDATE at the head of the transaction makes the
 * whole replace serialize per order: the second writer waits, then sees the
 * first writer's committed rows. The SELECT doubles as the store-scope check,
 * so a foreign orderId is still a 404. It locks the order row without touching
 * it — no column is written, `version` is untouched, and the order state
 * machine is not involved.
 */
export async function replaceOrderTags(storeId: string, orderId: string, body: Record<string, unknown>) {
  await scopedOrderId(storeId, orderId);
  const tags = normalizeOrderTags(body.tags);
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM store_orders
      WHERE id = ${orderId}::uuid AND store_id = ${storeId}::uuid
      FOR UPDATE
    `);
    if (!locked[0]) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found in this store.");
    await tx.orderTag.deleteMany({ where: { storeId, orderId } });
    if (tags.length) {
      await tx.orderTag.createMany({ data: tags.map((tag, position) => ({ storeId, orderId, tag, tagNormalized: normalizeTagKey(tag), position })) });
    }
  });
  return { orderId, tags };
}

/**
 * codiq menus pass A — store-scoped customer directory.
 * Serves the merchant AND staff «العملاء» pages through one guard-protected
 * read (requireStoreActor with "customers.view" at the route). Segments follow
 * the owner-approved definitions: new = registered within the last 30 days,
 * active = has at least one order, prospect = registered with zero orders.
 */
import { HttpError } from "../auth/auth.errors.js";
import type { StoreActor } from "../auth/staff-permissions.js";
import { recordAuditEvent } from "./soft-delete/audit-log.service.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { phoneNeedle } from "./merchant-search.service.js";
import { mergeSearchPages, searchEngine } from "./search/index.js";

const SEGMENTS = ["new", "active", "prospect"] as const;
export type CustomerSegment = (typeof SEGMENTS)[number];

export type CustomerDirectoryRow = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  createdAt: Date;
  ordersCount: number;
};

function parseSegment(value: unknown): CustomerSegment | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !SEGMENTS.includes(value as CustomerSegment)) {
    throw new HttpError(422, "INVALID_CUSTOMER_SEGMENT", "segment يجب أن يكون new أو active أو prospect.");
  }
  return value as CustomerSegment;
}

/**
 * PG-6 (ق-74): how many ranked matches a `q` narrows the directory to before
 * the page's own keyset takes over. Same reasoning, same number, as the order
 * list — the engine may not mint a cursor, so `q` is an `id IN (…)` narrowing
 * and the existing `createdAt DESC, id DESC` cursor pages through it unchanged.
 */
const SEARCH_ID_CAP = 200;

/**
 * PG-6 fixes three things about this search at once.
 *
 *  1. The three-column `OR` is split into three single-column statements. The
 *     planner refuses a BitmapOr across different columns and falls straight
 *     back to a sequential scan — measured in this repo at 39.4 ms versus
 *     1.0 ms for the split query (migration 20260827190000, header lines 33-40).
 *  2. It searches `phone_normalized`, NOT the raw `phone`. The palette always
 *     searched the normalized column, so the palette's own `?q=<phone>` deep
 *     link used to land on a directory page that found nothing.
 *  3. It carries `phoneNeedle`'s 4-digit, phone-shaped gate, which this file
 *     never had: `phone: { contains: q }` on ANY string is exactly the bug the
 *     gate was written for — `AB-0001` surfacing the customer whose number
 *     merely contains `0001` (owner decision 2, on every surface).
 */
async function customerSearchIds(storeId: string, q: string): Promise<string[]> {
  const phone = phoneNeedle(q);
  const base = { storeId, needle: q, limit: SEARCH_ID_CAP };
  const pages = await Promise.all([
    searchEngine.search("customers.fullName", base),
    searchEngine.search("customers.email", base),
    ...(phone ? [searchEngine.search("customers.phone", { ...base, needle: phone })] : []),
  ]);
  return mergeSearchPages(pages, SEARCH_ID_CAP).hits.map((hit) => hit.id);
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const LIST_KIND = "merchant.customers";

export async function listStoreCustomers(storeId: string, query: Record<string, unknown>): Promise<{ customers: CustomerDirectoryRow[]; nextCursor: string | null }> {
  const limit = parseListLimit(query.limit);
  // 20-2: the cursor is opaque and carries its own `(createdAt, id)`, so the
  // page is a KEYSET predicate and Prisma never resolves an anchor row by id
  // alone. `legacy:` is the one-time ramp for a bare uuid this route minted
  // before this branch — resolved store-scoped, exactly as it always was.
  const cursor = await readListCursor(LIST_KIND, query.cursor, {
    legacy: async (id) => {
      const row = await prisma.customer.findFirst({ where: { id, storeId }, select: { createdAt: true } });
      return row ? { value: row.createdAt } : null;
    },
  });
  const segment = parseSegment(query.segment);
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const where = {
    storeId,
    ...(segment === "new" ? { createdAt: { gte: thirtyDaysAgo } } : {}),
    ...(segment === "active" ? { orders: { some: {} } } : {}),
    ...(segment === "prospect" ? { orders: { none: {} } } : {}),
    ...(q ? { id: { in: await customerSearchIds(storeId, q) } } : {}),
    ...keysetWhere("createdAt", "desc", cursor),
  };
  const rows = await prisma.customer.findMany({
    where,
    // ق-201: `isGuest` lets the directory say «ضيف» — a shopper who bought
    // without choosing a password, and whom the merchant cannot expect to sign in.
    select: { id: true, fullName: true, phone: true, email: true, isActive: true, isGuest: true, createdAt: true, _count: { select: { orders: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(LIST_KIND, last.createdAt, last.id));
  return {
    customers: page.map((row) => ({ id: row.id, fullName: row.fullName, phone: row.phone, email: row.email, isActive: row.isActive, createdAt: row.createdAt, ordersCount: row._count.orders })),
    nextCursor,
  };
}

/**
 * ق-179 — the switch behind `Customer.isActive`.
 *
 * The column has been enforced at the door since phase 9 — a blocked shopper
 * cannot sign in, and an open session is refused on its next request — and
 * nothing in the platform could set it. The cash-on-delivery loss this exists
 * for is the shopper who orders and does not open the door; the merchant
 * needed the switch, not a new wall.
 *
 * It is POLICY, so it is an audit event with the reason on it, and it rides
 * `settings.manage` rather than the day-to-day `customers.view`. The shopper
 * is told nothing beyond what a wrong password would tell him (19-د).
 */
export async function setCustomerActive(
  storeId: string,
  customerId: string,
  actor: StoreActor,
  input: { isActive: boolean; reason?: string },
): Promise<{ id: string; isActive: boolean }> {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: customerId, storeId }, select: { id: true, fullName: true, phone: true, isActive: true } });
    if (!customer) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الزبون غير موجود في هذا المتجر.");
    if (customer.isActive !== input.isActive) {
      await tx.customer.update({ where: { id: customer.id }, data: { isActive: input.isActive } });
      await recordAuditEvent(tx, {
        storeId,
        entityType: "customer",
        entityId: customer.id,
        entityLabel: customer.fullName,
        entitySecondary: customer.phone,
        action: input.isActive ? "customer.unblocked" : "customer.blocked",
        actor,
        metadata: input.reason ? { reason: input.reason } : undefined,
      });
    }
    return { id: customer.id, isActive: input.isActive };
  });
}

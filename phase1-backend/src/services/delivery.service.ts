/**
 * ق-246 — التوصيل ونقدُ الاستلام.
 *
 * THE MARKET FACT THIS SERVES. CODIQ is cash-on-delivery by construction: the
 * parcel goes to a courier company, the courier collects the cash from the
 * shopper, and pays the merchant back later — days later, in a lump, across
 * many orders. Until this module the platform knew every order and nothing
 * about what happens to it after it leaves the shelf: not who took it, not its
 * waybill number, not when it left, not whether its cash ever came back. The
 * merchant reconciled with the courier out of a paper notebook.
 *
 * Three things, and only three:
 *
 *   · HANDOVER — who took the parcel, its tracking number, and when. Recorded
 *     at the «قيد التوصيل» transition (the moment it actually happens) or
 *     corrected afterwards.
 *   · THE MANIFEST — the day's handed-over parcels as a CSV the courier's own
 *     system ingests, one row per parcel with the cash to collect.
 *   · RECONCILIATION — per courier, per window: what the courier collected
 *     (delivered orders), what the merchant has marked as received, and the
 *     difference. Marking is the merchant's act; the number he checks it
 *     against is the platform's.
 *
 * WHAT THIS IS NOT. It is not D-04 («تسوية نقد COD الآلية مع الناقلين») —
 * automated settlement through courier APIs is phase 25أ and an owner
 * decision. This is the manual precursor that makes that later phase a
 * replacement of the data source, not a redesign: the columns and the screen
 * are the ones an integration would fill.
 *
 * The expected cash for a delivered order is `totalIqd` — what the shopper
 * paid the courier. Courier fees, delivery-fee splits and shortfalls are the
 * merchant's arrangement with the courier and are deliberately NOT modelled in
 * v1: a wrong number the platform asserts is worse than a number the merchant
 * reconciles himself against the total he can see.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { keysetWhere } from "./list-page.js";
import { CSV_UTF8_BOM, csvGuardedLine, csvLine } from "./csv.js";
import { CASH_AT_DOOR_CODES, collectsCashOnDelivery } from "./payment-methods.service.js";
import type { Prisma } from "@prisma/client";

export const COURIER_NAME_MAX_LENGTH = 120;
export const TRACKING_NUMBER_MAX_LENGTH = 120;
/** A reconciliation or manifest window may span at most this many days — a report, not a list. */
export const DELIVERY_WINDOW_MAX_DAYS = 62;
/** Suggested courier names come from the store's own recent handovers. */
export const COURIER_SUGGESTION_DAYS = 90;
const MANIFEST_PAGE_SIZE = 200;
const COD_COLLECT_BATCH_LIMIT = 200;

export type DeliveryActor = { kind: "merchant" | "staff"; id: string };

/** Optional text, trimmed; empty means «clear it». */
function optionalDeliveryText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "INVALID_DELIVERY_FIELD", `${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new HttpError(422, "INVALID_DELIVERY_FIELD", `${field} must contain at most ${max} characters.`);
  return trimmed;
}

/**
 * The delivery fields a transition or a correction may carry. Parsed once,
 * here, so the transition and the PATCH refuse the same things the same way.
 */
export function parseDeliveryFields(body: Record<string, unknown>): { courierName?: string | null; trackingNumber?: string | null } {
  return {
    courierName: optionalDeliveryText(body.courierName, "courierName", COURIER_NAME_MAX_LENGTH),
    trackingNumber: optionalDeliveryText(body.trackingNumber, "trackingNumber", TRACKING_NUMBER_MAX_LENGTH),
  };
}

/** The column subset every reader of the handover facts uses. */
export const deliverySelect = { courierName: true, trackingNumber: true, handedOverAt: true, codCollectedAt: true } as const;

/**
 * Correct or set the handover facts on an order that has left, or is leaving,
 * the shelf. `expectedVersion` rides along for the same reason it rides every
 * order write: two tabs must not silently overwrite each other's courier.
 *
 * Statuses: from `preparation` onward. Before that the parcel is not in a
 * courier's hands and a courier name would be a plan, not a fact; the field
 * exists to record facts.
 */
export async function updateOrderDelivery(storeId: string, orderId: string, body: Record<string, unknown>) {
  const fields = parseDeliveryFields(body);
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new HttpError(400, "INVALID_ORDER_VERSION", "expectedVersion must be a positive integer.");
  if (fields.courierName === undefined && fields.trackingNumber === undefined) {
    throw new HttpError(422, "INVALID_DELIVERY_FIELD", "Nothing to update: send courierName or trackingNumber.");
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.storeOrder.findFirst({ where: { id: orderId, storeId }, select: { id: true, status: true, version: true, handedOverAt: true } });
    if (!current) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found in this store.");
    if (current.version !== expectedVersion) throw new HttpError(409, "ORDER_VERSION_CONFLICT", "The order was changed by another request.");
    if (["new", "processing", "cancelled", "rejected"].includes(current.status)) {
      throw new HttpError(422, "DELIVERY_NOT_APPLICABLE", "الطلب لم يصل مرحلة التسليم للناقل بعد.");
    }
    const data: Prisma.StoreOrderUncheckedUpdateInput = { version: { increment: 1 } };
    if (fields.courierName !== undefined) data.courierName = fields.courierName;
    if (fields.trackingNumber !== undefined) data.trackingNumber = fields.trackingNumber;
    // Naming a courier IS the handover when none was recorded: the merchant is
    // telling us who has it. A later correction of the name keeps the original
    // moment.
    if (fields.courierName && !current.handedOverAt) data.handedOverAt = new Date();
    const result = await tx.storeOrder.updateMany({ where: { id: orderId, storeId, version: expectedVersion }, data });
    if (result.count !== 1) throw new HttpError(409, "ORDER_VERSION_CONFLICT", "The order was changed by another request.");
    const updated = await tx.storeOrder.findFirstOrThrow({ where: { id: orderId, storeId }, select: { id: true, version: true, status: true, ...deliverySelect } });
    return updated;
  });
}

/**
 * The names this store has handed parcels to recently — the datalist behind
 * the courier field. A free-text field with no memory produces «الفهد»,
 * «شركة الفهد» and «الفهد للتوصيل» as three couriers on the reconciliation
 * screen; suggesting the store's own spelling back is how the list stays one.
 */
export async function listCourierNames(storeId: string): Promise<string[]> {
  const since = new Date(Date.now() - COURIER_SUGGESTION_DAYS * 86_400_000);
  const rows = await prisma.storeOrder.groupBy({
    by: ["courierName"],
    where: { storeId, courierName: { not: null }, handedOverAt: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { courierName: "desc" } },
    take: 50,
  });
  return rows.map((row) => row.courierName).filter((name): name is string => typeof name === "string" && name.length > 0);
}

function windowFrom(query: Record<string, unknown>): { from: Date; to: Date; courier: string | null } {
  const parse = (value: unknown, field: string): Date | null => {
    if (value === undefined || value === "") return null;
    if (typeof value !== "string") throw new HttpError(422, "INVALID_DELIVERY_WINDOW", `${field} must be an ISO-8601 date.`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) throw new HttpError(422, "INVALID_DELIVERY_WINDOW", `${field} must be an ISO-8601 date.`);
    return parsed;
  };
  const now = new Date();
  const to = parse(query.to, "to") ?? now;
  // Default: the day that just happened — the manifest a courier collects in
  // the morning is yesterday evening's parcels plus today's.
  const from = parse(query.from, "from") ?? new Date(to.getTime() - 86_400_000);
  if (from > to) throw new HttpError(422, "INVALID_DELIVERY_WINDOW", "from must not be after to.");
  if (to.getTime() - from.getTime() > DELIVERY_WINDOW_MAX_DAYS * 86_400_000) {
    throw new HttpError(422, "INVALID_DELIVERY_WINDOW", `The window may span at most ${DELIVERY_WINDOW_MAX_DAYS} days.`);
  }
  const courier = optionalDeliveryText(query.courier, "courier", COURIER_NAME_MAX_LENGTH) ?? null;
  return { from, to, courier };
}

export const MANIFEST_CSV_COLUMNS = [
  "order_number",
  "handed_over_at",
  "courier_name",
  "tracking_number",
  "customer_name",
  "recipient_phone",
  "shipping_governorate",
  "shipping_address_line1",
  "shipping_address_line2",
  "cod_amount_iqd",
  "status",
  "customer_note",
  "payment_method",
] as const;

/**
 * The manifest: one row per parcel handed over in the window, with the cash the
 * courier is to collect. Streamed the way `exportOrdersCsv` streams — BOM,
 * header, then pages walked on a `(handedOverAt, id)` keyset — the order the parcels
 * went out, which is how a courier reads a manifest — because a busy store hands over hundreds of parcels a day and a file
 * assembled in memory is the kind of thing that works until the day it matters.
 */
export async function courierManifestCsv(storeId: string, query: Record<string, unknown>, write: (chunk: string) => void): Promise<{ rows: number }> {
  const { from, to, courier } = windowFrom(query);
  write(CSV_UTF8_BOM);
  write(csvLine(MANIFEST_CSV_COLUMNS));
  let rows = 0;
  let cursor: { handedOverAt: Date; id: string } | undefined;
  for (;;) {
    const page = await prisma.storeOrder.findMany({
      where: {
        storeId,
        handedOverAt: { gte: from, lte: to },
        ...(courier ? { courierName: courier } : {}),
        ...keysetWhere("handedOverAt", "desc", cursor && { value: cursor.handedOverAt.toISOString(), id: cursor.id }),
      },
      orderBy: [{ handedOverAt: "desc" }, { id: "desc" }],
      take: MANIFEST_PAGE_SIZE,
      select: {
        id: true, orderNumber: true, createdAt: true, status: true, customerName: true, recipientPhone: true,
        shippingGovernorate: true, shippingAddressLine1: true, shippingAddressLine2: true, totalIqd: true, customerNote: true, paymentMethodCode: true,
        ...deliverySelect,
      },
    });
    for (const order of page) {
      rows += 1;
      write(csvGuardedLine([
        order.orderNumber,
        order.handedOverAt?.toISOString() ?? "",
        order.courierName ?? "",
        order.trackingNumber ?? "",
        order.customerName,
        order.recipientPhone ?? "",
        order.shippingGovernorate ?? "",
        order.shippingAddressLine1 ?? "",
        order.shippingAddressLine2 ?? "",
        // Cash the courier collects: the total for a cash-on-delivery order, and
        // nothing for one the shopper already paid by transfer.
        collectsCashOnDelivery(order.paymentMethodCode) ? order.totalIqd : 0,
        order.status,
        order.customerNote ?? "",
        order.paymentMethodCode,
      ]));
    }
    if (page.length < MANIFEST_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { handedOverAt: last.handedOverAt!, id: last.id };
  }
  return { rows };
}

export interface CourierReconciliationRow {
  courierName: string;
  handedOver: number;
  delivered: number;
  returned: number;
  inTransit: number;
  /** Cash the courier collected from shoppers: Σ totalIqd over delivered orders. */
  collectedIqd: number;
  /** Of that, what the merchant has marked as received from the courier. */
  receivedIqd: number;
  /** collectedIqd − receivedIqd — the number the merchant phones the courier about. */
  outstandingIqd: number;
}

/**
 * Per courier, in the window: how many parcels went out, how many came back
 * delivered / returned / still in transit, and the cash position. A report
 * over a bounded window, not a list: it walks the window in pages and folds,
 * so a store with thousands of parcels a month still gets one answer.
 */
export async function codReconciliation(storeId: string, query: Record<string, unknown>) {
  const { from, to, courier } = windowFrom(query);
  const byCourier = new Map<string, CourierReconciliationRow>();
  const outstanding: Array<{ id: string; orderNumber: string; courierName: string; trackingNumber: string | null; handedOverAt: Date; totalIqd: number; version: number }> = [];
  let cursor: { handedOverAt: Date; id: string } | undefined;
  for (;;) {
    const page = await prisma.storeOrder.findMany({
      where: {
        storeId,
        handedOverAt: { gte: from, lte: to },
        ...(courier ? { courierName: courier } : {}),
        ...keysetWhere("handedOverAt", "desc", cursor && { value: cursor.handedOverAt.toISOString(), id: cursor.id }),
      },
      orderBy: [{ handedOverAt: "desc" }, { id: "desc" }],
      take: MANIFEST_PAGE_SIZE,
      select: { id: true, orderNumber: true, createdAt: true, status: true, totalIqd: true, version: true, paymentMethodCode: true, ...deliverySelect },
    });
    for (const order of page) {
      const name = order.courierName ?? "—";
      const row = byCourier.get(name) ?? { courierName: name, handedOver: 0, delivered: 0, returned: 0, inTransit: 0, collectedIqd: 0, receivedIqd: 0, outstandingIqd: 0 };
      row.handedOver += 1;
      // A prepaid order is delivered like any other, but the courier never held
      // its money — so it is neither collected nor outstanding.
      const cashAtDoor = collectsCashOnDelivery(order.paymentMethodCode);
      if (order.status === "completed") {
        row.delivered += 1;
        if (cashAtDoor) {
          row.collectedIqd += order.totalIqd;
          if (order.codCollectedAt) row.receivedIqd += order.totalIqd;
          else outstanding.push({ id: order.id, orderNumber: order.orderNumber, courierName: name, trackingNumber: order.trackingNumber, handedOverAt: order.handedOverAt!, totalIqd: order.totalIqd, version: order.version });
        }
      } else if (order.status === "returned") {
        row.returned += 1;
      } else {
        row.inTransit += 1;
      }
      row.outstandingIqd = row.collectedIqd - row.receivedIqd;
      byCourier.set(name, row);
    }
    if (page.length < MANIFEST_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { handedOverAt: last.handedOverAt!, id: last.id };
  }
  const couriers = Array.from(byCourier.values()).sort((a, b) => b.outstandingIqd - a.outstandingIqd || a.courierName.localeCompare(b.courierName, "ar"));
  return {
    window: { from: from.toISOString(), to: to.toISOString(), courier },
    couriers,
    totals: couriers.reduce(
      (sum, row) => ({ handedOver: sum.handedOver + row.handedOver, delivered: sum.delivered + row.delivered, collectedIqd: sum.collectedIqd + row.collectedIqd, receivedIqd: sum.receivedIqd + row.receivedIqd, outstandingIqd: sum.outstandingIqd + row.outstandingIqd }),
      { handedOver: 0, delivered: 0, collectedIqd: 0, receivedIqd: 0, outstandingIqd: 0 },
    ),
    // Newest handover first; the merchant ticks these off against the courier's
    // envelope. Capped at the 200 one «استلمتُ النقد» batch accepts — mark, refresh,
    // and the next 200 surface — with the true count beside it, so the screen
    // never implies this is all there is.
    outstandingTotal: outstanding.length,
    outstanding: outstanding.sort((a, b) => b.handedOverAt.getTime() - a.handedOverAt.getTime()).slice(0, COD_COLLECT_BATCH_LIMIT),
  };
}

/**
 * «استلمتُ النقد»: the merchant's own act, on delivered orders only, once. The
 * write is idempotent and partial by design — a batch that names an order
 * already marked, or one that never completed, simply does not count it, and
 * the answer says how many it did mark so the screen can say the rest.
 */
export async function markCodCollected(storeId: string, body: Record<string, unknown>) {
  const raw = Array.isArray(body.orderIds) ? body.orderIds : null;
  if (!raw || raw.length === 0) throw new HttpError(422, "INVALID_COD_BATCH", "orderIds must be a non-empty array.");
  if (raw.length > COD_COLLECT_BATCH_LIMIT) throw new HttpError(422, "INVALID_COD_BATCH", `At most ${COD_COLLECT_BATCH_LIMIT} orders per request.`);
  const orderIds = raw.map((id) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(422, "INVALID_COD_BATCH", "Every orderId must be a uuid.");
    return id;
  });
  const result = await prisma.storeOrder.updateMany({
    // Tenant, delivered, handed over, and not yet marked — the CHECK below the
    // table says the third one too, but a predicate that names its own rule is
    // one a reader does not have to go and find.
    where: { id: { in: orderIds }, storeId, status: "completed", handedOverAt: { not: null }, codCollectedAt: null, paymentMethodCode: { in: [...CASH_AT_DOOR_CODES] } },
    data: { codCollectedAt: new Date() },
  });
  return { requested: orderIds.length, marked: result.count };
}

/**
 * Delivery and cash on delivery — reconciliation. Split verbatim from delivery.service.ts
 * (review batch 4, ت-٥); delivery.service.ts re-exports what it always exported.
 */
import { prisma } from "../../db/prisma.js";
import { keysetWhere } from "../list-page.js";
import { HttpError } from "../../auth/auth.errors.js";
import {
  windowFrom,
  MANIFEST_PAGE_SIZE,
  deliverySelect,
  COD_COLLECT_BATCH_LIMIT,
} from "./fields.js";

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

type OutstandingParcel = {
  id: string;
  orderNumber: string;
  courierName: string;
  trackingNumber: string | null;
  handedOverAt: Date;
  totalIqd: number;
  version: number;
};

/** One handed-over parcel, folded into its courier's row (and the outstanding list). */
function foldOrder(
  byCourier: Map<string, CourierReconciliationRow>,
  outstanding: OutstandingParcel[],
  order: {
    id: string;
    orderNumber: string;
    status: string;
    totalIqd: number;
    version: number;
    courierName: string | null;
    trackingNumber: string | null;
    handedOverAt: Date | null;
    codCollectedAt: Date | null;
  }
) {
  const name = order.courierName ?? "—";
  const row = byCourier.get(name) ?? {
    courierName: name,
    handedOver: 0,
    delivered: 0,
    returned: 0,
    inTransit: 0,
    collectedIqd: 0,
    receivedIqd: 0,
    outstandingIqd: 0,
  };
  row.handedOver += 1;
  if (order.status === "completed") {
    row.delivered += 1;
    row.collectedIqd += order.totalIqd;
    if (order.codCollectedAt) row.receivedIqd += order.totalIqd;
    else
      outstanding.push({
        id: order.id,
        orderNumber: order.orderNumber,
        courierName: name,
        trackingNumber: order.trackingNumber,
        handedOverAt: order.handedOverAt!,
        totalIqd: order.totalIqd,
        version: order.version,
      });
  } else if (order.status === "returned") {
    row.returned += 1;
  } else {
    row.inTransit += 1;
  }
  row.outstandingIqd = row.collectedIqd - row.receivedIqd;
  byCourier.set(name, row);
}

/** The window's totals across every courier. */
function sumCouriers(couriers: CourierReconciliationRow[]) {
  return couriers.reduce(
    (sum, row) => ({
      handedOver: sum.handedOver + row.handedOver,
      delivered: sum.delivered + row.delivered,
      collectedIqd: sum.collectedIqd + row.collectedIqd,
      receivedIqd: sum.receivedIqd + row.receivedIqd,
      outstandingIqd: sum.outstandingIqd + row.outstandingIqd,
    }),
    { handedOver: 0, delivered: 0, collectedIqd: 0, receivedIqd: 0, outstandingIqd: 0 }
  );
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
  const outstanding: OutstandingParcel[] = [];
  let cursor: { handedOverAt: Date; id: string } | undefined;
  for (;;) {
    const page = await prisma.storeOrder.findMany({
      where: {
        storeId,
        handedOverAt: { gte: from, lte: to },
        ...(courier ? { courierName: courier } : {}),
        ...keysetWhere(
          "handedOverAt",
          "desc",
          cursor && { value: cursor.handedOverAt.toISOString(), id: cursor.id }
        ),
      },
      orderBy: [{ handedOverAt: "desc" }, { id: "desc" }],
      take: MANIFEST_PAGE_SIZE,
      select: {
        id: true,
        orderNumber: true,
        createdAt: true,
        status: true,
        totalIqd: true,
        version: true,
        ...deliverySelect,
      },
    });
    for (const order of page) foldOrder(byCourier, outstanding, order);
    if (page.length < MANIFEST_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { handedOverAt: last.handedOverAt!, id: last.id };
  }
  const couriers = Array.from(byCourier.values()).sort(
    (a, b) =>
      b.outstandingIqd - a.outstandingIqd || a.courierName.localeCompare(b.courierName, "ar")
  );
  return {
    window: { from: from.toISOString(), to: to.toISOString(), courier },
    couriers,
    totals: sumCouriers(couriers),
    // Newest handover first; the merchant ticks these off against the courier's
    // envelope. Capped at the 200 one «استلمتُ النقد» batch accepts — mark, refresh,
    // and the next 200 surface — with the true count beside it, so the screen
    // never implies this is all there is.
    outstandingTotal: outstanding.length,
    outstanding: outstanding
      .sort((a, b) => b.handedOverAt.getTime() - a.handedOverAt.getTime())
      .slice(0, COD_COLLECT_BATCH_LIMIT),
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
  if (!raw || raw.length === 0)
    throw new HttpError(422, "INVALID_COD_BATCH", "orderIds must be a non-empty array.");
  if (raw.length > COD_COLLECT_BATCH_LIMIT)
    throw new HttpError(
      422,
      "INVALID_COD_BATCH",
      `At most ${COD_COLLECT_BATCH_LIMIT} orders per request.`
    );
  const orderIds = raw.map((id) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      throw new HttpError(422, "INVALID_COD_BATCH", "Every orderId must be a uuid.");
    return id;
  });
  const result = await prisma.storeOrder.updateMany({
    // Tenant, delivered, handed over, and not yet marked — the CHECK below the
    // table says the third one too, but a predicate that names its own rule is
    // one a reader does not have to go and find.
    where: {
      id: { in: orderIds },
      storeId,
      status: "completed",
      handedOverAt: { not: null },
      codCollectedAt: null,
    },
    data: { codCollectedAt: new Date() },
  });
  return { requested: orderIds.length, marked: result.count };
}

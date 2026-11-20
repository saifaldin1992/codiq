/**
 * MD-2 print sheet — the data behind a shipping label, an invoice and a picking
 * list, for one order or for a batch.
 *
 * Print is where a quiet bug becomes an expensive one: a label printed for the
 * wrong store, or a batch that silently drops an order, is discovered by a
 * courier at a door rather than by a test. So:
 *
 *  - the store is resolved from the caller's own membership and every order is
 *    matched by `(id, storeId)`, never by id alone;
 *  - a requested id that is not in this store is a REFUSAL, not an omission. A
 *    merchant who selects ten orders and receives nine labels has no way to
 *    notice; he ships nine parcels believing he shipped ten.
 *
 * The picking list aggregates across the batch — one line per product/variant
 * with the total quantity — because that is the sheet someone walks the shelves
 * with. Printing ten separate lists would defeat the point of batching.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";

/** A print run is a physical act; this bounds it before the browser does. */
export const PRINT_BATCH_LIMIT = 50;

export interface PrintLine { key: string; productName: string; variantName: string | null; sku: string | null; quantity: number }

export function parsePrintIds(raw: unknown): string[] {
  const text = typeof raw === "string" ? raw : "";
  // Duplicates are dropped rather than refused: selecting the same order twice
  // is a slip of the hand, and one label is plainly what was meant.
  const ids = Array.from(new Set(text.split(",").map((value) => value.trim()).filter((value) => value.length > 0)));
  if (ids.length === 0) throw new HttpError(400, "INVALID_PRINT_SELECTION", "Select at least one order to print.");
  if (ids.length > PRINT_BATCH_LIMIT) throw new HttpError(400, "PRINT_BATCH_TOO_LARGE", `A print run covers at most ${PRINT_BATCH_LIMIT} orders.`);
  return ids;
}

export async function orderPrintSheet(storeId: string, ids: string[]) {
  const [store, orders] = await Promise.all([
    prisma.store.findUnique({
      where: { id: storeId },
      select: { slug: true, name: true, merchant: { select: { businessName: true, phoneNormalized: true } } },
    }),
    prisma.storeOrder.findMany({
      where: { id: { in: ids }, storeId },
      select: {
        id: true, orderNumber: true, status: true, createdAt: true,
        customerName: true, recipientPhone: true,
        shippingGovernorate: true, shippingAddressLine1: true, shippingAddressLine2: true,
        subtotalIqd: true, deliveryFeeIqd: true, discountIqd: true, totalIqd: true,
        // ق-187: the courier carries this sheet, and without the loyalty line
        // its arithmetic is short by exactly what the shopper redeemed.
        loyaltyDiscountIqd: true, loyaltyPointsSpent: true,
        couponCode: true, customerNote: true, paymentStatus: true,
        // ق-246: the waybill on the sheet is the courier's own reference.
        courierName: true, trackingNumber: true, handedOverAt: true,
        items: { select: { id: true, productName: true, variantName: true, sku: true, quantity: true, unitPriceIqd: true, lineTotalIqd: true } },
      },
    }),
  ]);
  if (!store) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The store was not found.");
  if (orders.length !== ids.length) {
    const found = new Set(orders.map((order) => order.id));
    const missing = ids.filter((id) => !found.has(id)).length;
    throw new HttpError(404, "RESOURCE_NOT_FOUND", `${missing} of ${ids.length} selected orders are not in this store.`);
  }

  // The requested order is preserved: the merchant picked a sequence on his
  // screen and the paper should come out in it.
  const byId = new Map(orders.map((order) => [order.id, order]));
  const ordered = ids.map((id) => byId.get(id)!);

  const picking = new Map<string, PrintLine>();
  for (const order of ordered) {
    for (const item of order.items) {
      // SKU is the identity when a store keeps one; without it, the product and
      // variant names are what a person actually reads off a shelf.
      const key = item.sku ?? `${item.productName} ${item.variantName ?? ""}`;
      const line = picking.get(key);
      if (line) line.quantity += item.quantity;
      else picking.set(key, { key, productName: item.productName, variantName: item.variantName, sku: item.sku, quantity: item.quantity });
    }
  }

  return {
    store: { slug: store.slug, name: store.name, businessName: store.merchant.businessName, contactPhone: store.merchant.phoneNormalized },
    orders: ordered,
    picking: Array.from(picking.values()).sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName, "ar")),
    totals: {
      orders: ordered.length,
      units: ordered.reduce((sum, order) => sum + order.items.reduce((count, item) => count + item.quantity, 0), 0),
      collectIqd: ordered.reduce((sum, order) => sum + order.totalIqd, 0),
    },
  };
}

/**
 * Delivery and cash on delivery — manifest. Split verbatim from delivery.service.ts
 * (review batch 4, ت-٥); delivery.service.ts re-exports what it always exported.
 */
import { CSV_UTF8_BOM, csvLine, csvGuardedLine } from "../csv.js";
import { prisma } from "../../db/prisma.js";
import { keysetWhere } from "../list-page.js";
import { windowFrom, MANIFEST_PAGE_SIZE, deliverySelect, cashToCollectIqd } from "./fields.js";

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
] as const;

/** One parcel's manifest row — the cash column is what is still owed (review batch 4, م-٢). */
function manifestLine(order: {
  orderNumber: string;
  status: string;
  customerName: string;
  recipientPhone: string | null;
  shippingGovernorate: string | null;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  totalIqd: number;
  deliveryFeeIqd: number;
  paymentStatus: string;
  customerNote: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  handedOverAt: Date | null;
}) {
  return csvGuardedLine([
    order.orderNumber,
    order.handedOverAt?.toISOString() ?? "",
    order.courierName ?? "",
    order.trackingNumber ?? "",
    order.customerName,
    order.recipientPhone ?? "",
    order.shippingGovernorate ?? "",
    order.shippingAddressLine1 ?? "",
    order.shippingAddressLine2 ?? "",
    cashToCollectIqd(order),
    order.status,
    order.customerNote ?? "",
  ]);
}

/**
 * The manifest: one row per parcel handed over in the window, with the cash the
 * courier is to collect. Streamed the way `exportOrdersCsv` streams — BOM,
 * header, then pages walked on a `(handedOverAt, id)` keyset — the order the parcels
 * went out, which is how a courier reads a manifest — because a busy store hands
 * over hundreds of parcels a day and a file assembled in memory is the kind of
 * thing that works until the day it matters.
 */
export async function courierManifestCsv(
  storeId: string,
  query: Record<string, unknown>,
  write: (chunk: string) => void
): Promise<{ rows: number }> {
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
        customerName: true,
        recipientPhone: true,
        shippingGovernorate: true,
        shippingAddressLine1: true,
        shippingAddressLine2: true,
        totalIqd: true,
        deliveryFeeIqd: true,
        paymentStatus: true,
        customerNote: true,
        ...deliverySelect,
      },
    });
    for (const order of page) {
      rows += 1;
      write(manifestLine(order));
    }
    if (page.length < MANIFEST_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { handedOverAt: last.handedOverAt!, id: last.id };
  }
  return { rows };
}

/**
 * Delivery and cash on delivery — handover. Split verbatim from delivery.service.ts
 * (review batch 4, ت-٥); delivery.service.ts re-exports what it always exported.
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../../auth/auth.errors.js";
import { prisma } from "../../db/prisma.js";
import { parseDeliveryFields, deliverySelect, COURIER_SUGGESTION_DAYS } from "./fields.js";

/**
 * Correct or set the handover facts on an order that has left, or is leaving,
 * the shelf. `expectedVersion` rides along for the same reason it rides every
 * order write: two tabs must not silently overwrite each other's courier.
 *
 * Statuses: from `preparation` onward. Before that the parcel is not in a
 * courier's hands and a courier name would be a plan, not a fact; the field
 * exists to record facts.
 */
export async function updateOrderDelivery(
  storeId: string,
  orderId: string,
  body: Record<string, unknown>
) {
  const fields = parseDeliveryFields(body);
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw new HttpError(
      400,
      "INVALID_ORDER_VERSION",
      "expectedVersion must be a positive integer."
    );
  if (fields.courierName === undefined && fields.trackingNumber === undefined) {
    throw new HttpError(
      422,
      "INVALID_DELIVERY_FIELD",
      "Nothing to update: send courierName or trackingNumber."
    );
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.storeOrder.findFirst({
      where: { id: orderId, storeId },
      select: { id: true, status: true, version: true, handedOverAt: true },
    });
    if (!current)
      throw new HttpError(
        404,
        "RESOURCE_NOT_FOUND",
        "The requested order was not found in this store."
      );
    if (current.version !== expectedVersion)
      throw new HttpError(
        409,
        "ORDER_VERSION_CONFLICT",
        "The order was changed by another request."
      );
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
    const result = await tx.storeOrder.updateMany({
      where: { id: orderId, storeId, version: expectedVersion },
      data,
    });
    if (result.count !== 1)
      throw new HttpError(
        409,
        "ORDER_VERSION_CONFLICT",
        "The order was changed by another request."
      );
    const updated = await tx.storeOrder.findFirstOrThrow({
      where: { id: orderId, storeId },
      select: { id: true, version: true, status: true, ...deliverySelect },
    });
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
  return rows
    .map((row) => row.courierName)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

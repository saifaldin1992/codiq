/**
 * Storefront — orders. Split verbatim from storefront.service.ts (review batch 2, ت-٣);
 * storefront.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import {
  parseListLimit,
  readListCursor,
  keysetWhere,
  pageOf,
  encodeListCursor,
} from "../list-page.js";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
// ق-193: the one reason a release may still be settled at completion. Imported
// rather than re-typed so the sweep and the settlement can never disagree about
// the string — `reservation-expiry-job.ts` imports nothing from the services, so
// this direction carries no cycle.
import { RESERVATION_EXPIRY_RELEASE_REASON } from "../reservation-expiry-job.js";
import { enqueueLowStockIfCrossed } from "../../notifications/notification-outbox.service.js";

const CUSTOMER_ORDERS_KIND = "storefront.account.orders";

export async function customerOrders(
  storeId: string,
  customerId: string,
  rawLimit: unknown,
  rawCursor: unknown
) {
  const limit = parseListLimit(rawLimit);
  // 20-2: an opaque `(createdAt, id)` keyset. This was the door that needed no
  // merchant permission at all — any signed-in shopper could turn one query
  // parameter into an unhandled 500 — and with the keyset there is no anchor
  // read left to mishandle. `legacy:` still resolves a pre-20-2 bare order id
  // inside THIS shopper own orders, so it proves nothing about anyone else.
  const cursor = await readListCursor(CUSTOMER_ORDERS_KIND, rawCursor, {
    legacy: async (id) => {
      const row = await prisma.storeOrder.findFirst({
        where: { id, storeId, customerId },
        select: { createdAt: true },
      });
      return row ? { value: row.createdAt } : null;
    },
  });
  const rows = await prisma.storeOrder.findMany({
    where: { storeId, customerId, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalIqd: true,
      createdAt: true,
      statusUpdatedAt: true,
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(CUSTOMER_ORDERS_KIND, last.createdAt, last.id)
  );
  return { orders: page, nextCursor };
}

export async function customerOrder(storeId: string, customerId: string, orderId: string) {
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId, customerId },
    include: {
      items: {
        select: {
          id: true,
          productName: true,
          variantId: true,
          variantName: true,
          sku: true,
          quantity: true,
          unitPriceIqd: true,
          lineTotalIqd: true,
        },
      },
      statusEvents: {
        select: { fromStatus: true, toStatus: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found.");
  return order;
}

export async function settleStorefrontReservations(
  tx: Prisma.TransactionClient,
  storeId: string,
  order: { id: string; source: string },
  toStatus: string
) {
  if (order.source !== "storefront") return;
  const reservations = await tx.inventoryReservation.findMany({
    where: { storeId, orderId: order.id },
  });
  if (!reservations.length) return;
  const now = new Date();
  if (toStatus === "cancelled" || toStatus === "rejected") {
    await tx.inventoryReservation.updateMany({
      where: { storeId, orderId: order.id, status: "active" },
      data: { status: "released", releaseReason: toStatus, releasedAt: now },
    });
    return;
  }
  if (toStatus === "returned") {
    // ق-215 — ONLY A RESERVATION WITH SOMETHING TO INSPECT ENTERS THE QUEUE.
    //
    // The queue means «goods to physically decide about»: units still held
    // (`active`) or already taken off the shelf (`consumed`). A reservation the
    // D-46 sweep RELEASED as `expired` holds neither — the units never left
    // `stockQuantity` — and `resolveReturnInspection` refuses it by design
    // («حالة هذا الحجز لا تقبل الفحص»). Queuing it anyway produced a row the
    // merchant could see, press, and never clear: order on Thursday night,
    // confirmation on Monday, reservation expired over the weekend, refused at
    // the door — the path ق-193's own comment calls normal here. A queue a
    // merchant learns he cannot empty is a queue he stops opening, and the
    // genuinely actionable returns get buried behind the ones he cannot resolve.
    await tx.inventoryReservation.updateMany({
      where: {
        storeId,
        orderId: order.id,
        returnDisposition: "not_returned",
        status: { in: ["active", "consumed"] },
      },
      data: { returnDisposition: "pending_inspection", returnedAt: now },
    });
    return;
  }
  if (toStatus !== "completed") return;
  // Phase 20A: the decrement-only-at-completion invariant now settles against the
  // reserved VARIANT with the same atomic stock >= quantity condition.
  //
  // ق-193 — AN EXPIRED RESERVATION IS STILL A SALE, AND IT MUST STILL COST STOCK.
  //
  // D-46's sweep releases the reservations of an order that is STILL `new` after
  // 72 hours, which is right: abandoned COD orders must stop hiding stock. But
  // this loop used to read `status === "active"` alone, so an order the sweep had
  // touched completed with NO decrement at all — no movement row, no error, and
  // the `stock >= quantity` guard below never even consulted.
  //
  // That is not an exotic path in Iraq. A shopper orders on Thursday night; the
  // merchant makes the confirmation call when he is back; on Monday he walks the
  // order to `completed` and the courier collects the cash. Three days is normal
  // fulfilment here, not neglect — so the platform was quietly minting phantom
  // stock once per weekend order, compounding forever, and every availability
  // figure on the storefront, the product page and the till kept offering units
  // that had already left the shelf. The next shopper's oversell is discovered at
  // his door. `reservation-expiry-job.ts` warns in its own header against minting
  // inventory the merchant does not own; this reached the same place from the
  // other side — not by adding stock on release, but by never removing it on
  // completion.
  //
  // ONLY `expired` qualifies. A reservation released by `cancelled` or `rejected`
  // must never be consumed — and cannot be, since both are terminal statuses that
  // can never reach `completed`; the reason check makes that structural rather
  // than incidental.
  //
  // The stock guard below is deliberately NOT relaxed for these. If the units were
  // sold to someone else while the reservation was lapsed, completion fails with
  // INSUFFICIENT_AVAILABLE_STOCK — which is the honest answer: the merchant is
  // told he no longer has what he just delivered, and must correct his inventory.
  // Silently allowing a negative would hide the very oversell this exists to stop.
  const settleable = reservations.filter(
    (row) =>
      row.status === "active" ||
      (row.status === "released" && row.releaseReason === RESERVATION_EXPIRY_RELEASE_REASON)
  );
  for (const reservation of settleable) {
    const before = await tx.productVariant.findFirst({
      where: { id: reservation.variantId, storeId },
      select: {
        name: true,
        sku: true,
        stockQuantity: true,
        lowStockThreshold: true,
        product: { select: { name: true } },
      },
    });
    const changed = await tx.productVariant.updateMany({
      where: { id: reservation.variantId, storeId, stockQuantity: { gte: reservation.quantity } },
      data: { stockQuantity: { decrement: reservation.quantity } },
    });
    if (changed.count !== 1)
      throw new HttpError(
        422,
        "INSUFFICIENT_AVAILABLE_STOCK",
        "Reserved stock is no longer available for completion."
      );
    await tx.inventoryMovement.create({
      data: {
        storeId,
        productId: reservation.productId,
        variantId: reservation.variantId,
        delta: -reservation.quantity,
        reason: "storefront_cod_completed",
      },
    });
    if (before) {
      await enqueueLowStockIfCrossed(tx, {
        storeId,
        productId: reservation.productId,
        variantId: reservation.variantId,
        productName: before.product.name,
        variantName: before.name,
        sku: before.sku,
        previousQuantity: before.stockQuantity,
        stockQuantity: before.stockQuantity - reservation.quantity,
        lowStockThreshold: before.lowStockThreshold,
      });
    }
  }
  // ق-193: the same set that was decremented is the set that is consumed — by id,
  // not by re-describing the predicate. A second `where` here that drifted from
  // the filter above would decrement rows it then failed to mark, and the next
  // completion of the same order would decrement them again.
  await tx.inventoryReservation.updateMany({
    where: { storeId, orderId: order.id, id: { in: settleable.map((row) => row.id) } },
    data: { status: "consumed", consumedAt: now },
  });
}

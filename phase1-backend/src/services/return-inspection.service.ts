/**
 * RI-1 «فحص المرتجعات» — the consumer pending_inspection never had.
 *
 * A returned storefront order parks its goods as inventory_reservations rows
 * with return_disposition='pending_inspection'. Until now NOTHING consumed
 * that state: every refused COD delivery (the majority return in Iraq) bled
 * phantom inventory forever. This service lists the queue and records the
 * merchant's physical decision — restock the fine units, write off the
 * damaged — with the arithmetic enforced by the DB constraint.
 *
 * THE LOAD-BEARING FORK (the double-count trap): a pending row exists in one
 * of two STOCK states, and the branch is reservation.status, never the
 * disposition —
 *   'active'   (out_for_delivery → returned): stock was NEVER decremented.
 *              Restock = RELEASE the reservation only (no increment, no
 *              movement — the units are still inside stockQuantity, hidden
 *              behind the phantom active row). Write-off = a real guarded
 *              decrement + movement + the low-stock alert.
 *   'consumed' (completed → returned): stock was already decremented at
 *              completion. Restock = a real increment + movement (reason
 *              'storefront_returned_restored' — the exact string phase9a
 *              pins at zero for the bare transition). Write-off = nothing;
 *              the disposition columns are the record.
 * Inverting either branch silently corrupts stock for every merchant.
 *
 * Deliberately independent of money: resolution writes ZERO ledger entries
 * (the 15-day commission window in finance.service.ts is its own cleanup),
 * so ledger-sign and analytics stay untouched by construction.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { enqueueLowStockIfCrossed } from "../notifications/notification-outbox.service.js";

export const RETURN_INSPECTION_NOTE_MAX = 500;

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const RETURN_INSPECTIONS_KIND = "merchant.inventory.returns";

/**
 * D-18: the queue was capped at 200 rows with no way to reach row 201, so a
 * store that let inspections pile up simply stopped being able to see the
 * oldest ones — the very rows the queue exists to clear.
 */
const INSPECTED_RETURNS_KIND = "merchant.inventory.returns.inspected";

/**
 * ق-177 — the decisions, read back. RI-1 wrote the audit trio (who, when, the
 * note) and the only list filtered on `pending_inspection`, so a decision left
 * every screen the moment it was taken — a write-off reason is money explained,
 * and it could be written and never read. Newest decision first, keyset on
 * `(inspectedAt, id)`; every row here has `inspectedAt`, so the ordering column
 * is never null on this slice.
 */
export async function listInspectedReturns(storeId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(INSPECTED_RETURNS_KIND, rawCursor);
  const rows = await prisma.inventoryReservation.findMany({
    where: { storeId, returnDisposition: { in: ["restocked", "written_off", "split"] }, ...keysetWhere("inspectedAt", "desc", cursor) },
    orderBy: [{ inspectedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, quantity: true, restockedQuantity: true, writtenOffQuantity: true, returnDisposition: true,
      inspectedAt: true, inspectedByKind: true, inspectionNote: true,
      variant: { select: { sku: true, name: true, product: { select: { name: true } } } },
      order: { select: { id: true, orderNumber: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(INSPECTED_RETURNS_KIND, last.inspectedAt ?? new Date(0), last.id));
  return {
    returns: page.map((row) => ({
      id: row.id,
      orderId: row.order.id,
      orderNumber: row.order.orderNumber,
      productName: row.variant.product.name,
      variantName: row.variant.name,
      sku: row.variant.sku,
      quantity: row.quantity,
      restockedQuantity: row.restockedQuantity,
      writtenOffQuantity: row.writtenOffQuantity,
      disposition: row.returnDisposition as "restocked" | "written_off" | "split",
      inspectedAt: row.inspectedAt,
      inspectedByKind: row.inspectedByKind,
      inspectionNote: row.inspectionNote,
    })),
    nextCursor,
  };
}

export async function listPendingReturnInspections(storeId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(RETURN_INSPECTIONS_KIND, rawCursor);
  const rows = await prisma.inventoryReservation.findMany({
    where: { storeId, returnDisposition: "pending_inspection", ...keysetWhere("returnedAt", "desc", cursor) },
    orderBy: [{ returnedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      quantity: true,
      status: true,
      returnedAt: true,
      variant: { select: { sku: true, name: true, deletedAt: true, product: { select: { name: true } } } },
      order: { select: { id: true, orderNumber: true } },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(RETURN_INSPECTIONS_KIND, last.returnedAt ?? new Date(0), last.id));
  const returns = page.map((row) => ({
    id: row.id,
    quantity: row.quantity,
    returnedAt: row.returnedAt,
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    productName: row.variant?.product.name ?? null,
    variantName: row.variant?.name ?? null,
    sku: row.variant?.sku ?? null,
    // The client never branches on raw reservation status — the server names
    // the physical truth instead.
    stockDeducted: row.status === "consumed",
    variantTrashed: row.variant?.deletedAt != null,
  }));
  return { returns, nextCursor };
}

export async function resolveReturnInspection(
  storeId: string,
  actor: { kind: "merchant" | "staff"; id: string },
  reservationId: string,
  body: { restockQty: number; writeOffQty: number; note?: string },
) {
  const { restockQty, writeOffQty } = body;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  if (note && note.length > RETURN_INSPECTION_NOTE_MAX) {
    throw new HttpError(422, "INVALID_INPUT", `ملاحظة الفحص يجب ألا تتجاوز ${RETURN_INSPECTION_NOTE_MAX} حرف.`);
  }

  return prisma.$transaction(async (tx) => {
    // findFirst on the (id, storeId) pair: a foreign reservation is
    // indistinguishable from a missing one (the store-wall idiom).
    const reservation = await tx.inventoryReservation.findFirst({
      where: { id: reservationId, storeId },
      select: {
        id: true, quantity: true, status: true, returnDisposition: true,
        productId: true, variantId: true,
        variant: { select: { deletedAt: true, stockQuantity: true, lowStockThreshold: true, name: true, sku: true, product: { select: { name: true } } } },
      },
    });
    if (!reservation) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested return was not found in this store.");
    if (reservation.returnDisposition !== "pending_inspection") {
      throw new HttpError(409, "RETURN_ALREADY_INSPECTED", "هذا المرتجع فُحص سابقاً — القرار الأول يبقى.");
    }
    if (restockQty + writeOffQty !== reservation.quantity) {
      throw new HttpError(422, "INVALID_INSPECTION_SPLIT", `مجموع السليم والتالف يجب أن يساوي كمية المرتجع (${reservation.quantity}).`);
    }
    if (reservation.status !== "active" && reservation.status !== "consumed") {
      throw new HttpError(409, "RESERVATION_NOT_INSPECTABLE", "حالة هذا الحجز لا تقبل الفحص.");
    }

    // THE IDEMPOTENCY GATE, FIRST AND INSIDE THE TX: a guarded flip on the
    // disposition. A concurrent resolve blocks on the row lock, re-evaluates
    // the WHERE, matches nothing → 409. Every stock write below shares this
    // transaction's fate — flip and stock move as one.
    const disposition = writeOffQty === 0 ? "restocked" : restockQty === 0 ? "written_off" : "split";
    const flipped = await tx.inventoryReservation.updateMany({
      where: { id: reservation.id, storeId, returnDisposition: "pending_inspection" },
      data: {
        returnDisposition: disposition,
        restockedQuantity: restockQty,
        writtenOffQuantity: writeOffQty,
        inspectedAt: new Date(),
        inspectedByKind: actor.kind,
        inspectedById: actor.id,
        inspectionNote: note,
      },
    });
    if (flipped.count !== 1) throw new HttpError(409, "RETURN_ALREADY_INSPECTED", "هذا المرتجع فُحص سابقاً — القرار الأول يبقى.");

    if (reservation.status === "consumed") {
      // Stock already left at completion. Only a restock touches it — and only
      // onto a LIVE variant (restoring stock onto a trashed one would violate
      // *_deleted_implies_inactive; soft-delete's own service is the only
      // deletedAt writer).
      if (restockQty > 0) {
        if (reservation.variant?.deletedAt) {
          throw new HttpError(409, "VARIANT_TRASHED", "الصنف في سلة المحذوفات — استرجعه أولاً ثم أرجِع مخزونه.");
        }
        const incremented = await tx.productVariant.updateMany({
          where: { id: reservation.variantId, storeId, deletedAt: null },
          data: { stockQuantity: { increment: restockQty } },
        });
        if (incremented.count !== 1) throw new HttpError(409, "VARIANT_TRASHED", "الصنف في سلة المحذوفات — استرجعه أولاً ثم أرجِع مخزونه.");
        await tx.inventoryMovement.create({
          data: { storeId, productId: reservation.productId, variantId: reservation.variantId, delta: restockQty, reason: "storefront_returned_restored" },
        });
        // Upward move: enqueueLowStockIfCrossed is deliberately NOT called —
        // it exists for downward crossings only.
      }
      // Write-off portion of a consumed row: nothing to do — the units left
      // stockQuantity at completion; the disposition columns are the record.
    } else {
      // status === 'active': stock was never deducted. The restock portion is
      // a RELEASE only; incrementing here would double-count every refused
      // COD delivery. The write-off portion is the real, guarded loss.
      if (writeOffQty > 0) {
        const before = reservation.variant;
        const decremented = await tx.productVariant.updateMany({
          where: { id: reservation.variantId, storeId, stockQuantity: { gte: writeOffQty } },
          data: { stockQuantity: { decrement: writeOffQty } },
        });
        if (decremented.count !== 1) throw new HttpError(422, "INSUFFICIENT_AVAILABLE_STOCK", "المخزون الحالي أقل من الكمية المشطوبة — حدّث الشاشة وأعد المحاولة.");
        await tx.inventoryMovement.create({
          data: { storeId, productId: reservation.productId, variantId: reservation.variantId, delta: -writeOffQty, reason: "storefront_returned_written_off" },
        });
        if (before) {
          // The loudest stock loss the merchant has must alert exactly like a
          // sale does — downward crossing, same helper, same threshold.
          await enqueueLowStockIfCrossed(tx, {
            storeId,
            productId: reservation.productId,
            variantId: reservation.variantId,
            productName: before.product.name,
            variantName: before.name,
            sku: before.sku,
            previousQuantity: before.stockQuantity,
            stockQuantity: before.stockQuantity - writeOffQty,
            lowStockThreshold: before.lowStockThreshold,
          });
        }
      }
      // Releasing restores availability (only status='active' rows count in
      // every storefront/POS availability sum) and un-blocks soft-delete's
      // PRODUCT_HAS_ACTIVE_RESERVATION — in the SAME tx as the write-off
      // decrement, so net availability rises by exactly restockQty.
      await tx.inventoryReservation.updateMany({
        where: { id: reservation.id, storeId, status: "active" },
        data: { status: "released", releaseReason: "return_inspected", releasedAt: new Date() },
      });
    }

    return {
      id: reservation.id,
      disposition,
      restockedQuantity: restockQty,
      writtenOffQuantity: writeOffQty,
    };
  });
}

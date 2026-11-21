/**
 * ق-176 — the stock movement log, READ.
 *
 * `inventory_movements` has been written in thirteen places since phase 7 —
 * every sale, restock, return inspection and manual adjustment lands a row
 * with a delta and a reason — and PG-2 gave it snapshot columns (product name,
 * SKU, variant name) stamped by a trigger so the history stays legible after
 * the product itself is purged. The one read in the repository was a `count()`
 * that printed a number inside the delete-confirm sheet, beside a sentence
 * promising the merchant that «سجل حركة المخزون يُحفظ دائماً».
 *
 * It was. Nobody could open it. This is the door.
 *
 * House list dialect (20-2): keyset on `(createdAt, id)`, cursor minted by
 * `encodeListCursor`, page cut by `pageOf`, limit parsed once by
 * `parseListLimit`. `productId` narrows to one product's history — the
 * question a merchant actually asks («لماذا نقص هذا؟») — and the cursor stays
 * valid across the narrowing because the keyset is on time, not on position.
 */
import { prisma } from "../db/prisma.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "./list-page.js";

const INVENTORY_MOVEMENTS_KIND = "merchant.inventory.movements";

export interface InventoryMovementRow {
  id: string;
  productId: string | null;
  variantId: string | null;
  delta: number;
  reason: string;
  /** Snapshot at the time of the movement — survives the product's deletion. */
  productName: string;
  productSku: string;
  variantName: string | null;
  variantSku: string | null;
  createdAt: Date;
}

export async function listInventoryMovements(
  storeId: string,
  rawLimit: unknown,
  rawCursor: unknown,
  rawProductId: unknown
): Promise<{ movements: InventoryMovementRow[]; nextCursor: string | null }> {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(INVENTORY_MOVEMENTS_KIND, rawCursor, {});
  const productId =
    typeof rawProductId === "string" && rawProductId.trim() ? rawProductId.trim() : undefined;

  const rows = await prisma.inventoryMovement.findMany({
    where: {
      storeId,
      ...(productId ? { productId } : {}),
      ...keysetWhere("createdAt", "desc", cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      productId: true,
      variantId: true,
      delta: true,
      reason: true,
      productName: true,
      productSku: true,
      variantName: true,
      variantSku: true,
      createdAt: true,
    },
  });

  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(INVENTORY_MOVEMENTS_KIND, last.createdAt, last.id)
  );
  return { movements: page, nextCursor };
}

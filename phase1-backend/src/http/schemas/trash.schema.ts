/**
 * Phase 19-ج — the overrides a restore may carry (PG-2, plan §4).
 *
 * Restoring is the one write in the bin, and its body exists to resolve a 409 in
 * the SAME call: the SKU a live product took while this one sat in the trash,
 * the coupon code someone reused, the category that is gone. There is never a
 * silent rename — a SKU is the merchant's own key — so every field here is an
 * explicit instruction, and every one of them was checked by hand against the
 * generic `INVALID_INPUT` before this file existed.
 *
 * `entityType` is NOT modelled here. It is a PATH segment, its closed set is
 * `TRASH_ENTITY_TYPES` (note that `product_variant` is auditable but never
 * trashed on its own — plan §6.3), and `assertTrashEntityType` deliberately
 * answers 404 for a type outside it: an unknown entity type is a resource that
 * does not exist, not a body that is malformed. Turning that into a 422 would
 * change an answer the trash bin has always given.
 *
 * ⚠ `categoryId` is a UUID here, and that IS a change — stated, not smuggled.
 *   The column is `@db.Uuid`, so a non-uuid category id never reached the
 *   CATEGORY_NOT_FOUND 404: Prisma raised P2023 for a malformed uuid and
 *   `errorHandler` has no branch for P2023, so the merchant got a bare 500.
 *   Same fault, same fix, as the wishlist's variantId.
 */
import { z } from "zod";

/**
 * The house's `overrideText`: a non-empty string within its cap, stored trimmed.
 * Trimming BEFORE the length check is what the hand-rolled version did, and it
 * matters — a SKU padded with spaces is the same SKU.
 */
function overrideText(max: number) {
  return z.string().trim().min(1).max(max);
}

export const restoreTrashSchema = z.object({
  /** The product's SKU, when a live product has taken the old one. */
  sku: overrideText(80).optional(),
  /** The coupon's code, for the same reason. */
  code: overrideText(40).optional(),
  /**
   * Per-variant SKUs, keyed by variant id. The KEY stays a plain string on
   * purpose: an id that matches no variant of this product is ignored rather
   * than refused, which is what the hand-rolled version did and what a client
   * replaying a stale conflict payload depends on.
   */
  variantSkus: z.record(z.string(), overrideText(80)).optional(),
  /**
   * An explicit category for the restored product. `null` and `""` both mean
   * «no category», which is why this is a union rather than a plain uuid: the
   * empty string is what an HTML form sends for a cleared select.
   */
  categoryId: z.union([z.string().uuid(), z.literal(""), z.null()]).optional(),
});
export type RestoreTrashInput = z.infer<typeof restoreTrashSchema>;

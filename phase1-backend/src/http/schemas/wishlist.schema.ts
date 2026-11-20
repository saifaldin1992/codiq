/**
 * Phase 19-ج — schemas for the CD-2 wishlist.
 *
 * Shape only, as everywhere in this layer: whether the variant belongs to this
 * store, whether it is still on sale, and whether the shopper has already
 * hoarded two hundred of them are questions that need the database, and they
 * stay in `wishlist.service.ts` where someone looking for them will find them.
 *
 * ⚠ `variantId` is a UUID here, and that IS a change — stated, not smuggled.
 *   The column is `@db.Uuid`, so a variantId of «abc» never reached the
 *   «المنتج غير متاح» 404: it reached Postgres, where Prisma raised P2023 for a
 *   malformed uuid, and `errorHandler` has no branch for P2023 — the shopper got
 *   a 500 for a typo. Refusing the wrong SHAPE at the edge is the whole point of
 *   this layer, and it leaks nothing the 404 did not already: a malformed id and
 *   a foreign store's id are still two different questions, and only the first
 *   is answered.
 */
import { z } from "zod";

export const wishlistItemSchema = z.object({
  variantId: z.string().uuid(),
  // Saving something is not consent to be mailed about it — see the service.
  notifyOnRestock: z.boolean().optional(),
});
export type WishlistItemInput = z.infer<typeof wishlistItemSchema>;

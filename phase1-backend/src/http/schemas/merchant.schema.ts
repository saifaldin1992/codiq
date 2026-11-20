/**
 * Phase 19-ج — schemas for the merchant's own surface: store creation, the store
 * switcher, the rename, «وضع الإجازة», and the manually created customer.
 *
 * READ THIS BEFORE ADDING A CONSTRAINT BELOW. These five routes are the one
 * corner of the conversion where almost nothing moves into the schema, and that
 * is the finding, not a gap. Every refusal they can produce ALREADY has what
 * ق-49 is asking for — a stable machine code and an Arabic sentence written for
 * the merchant:
 *
 *   INVALID_STORE_NAME    «اسم المتجر يجب أن يتكون من حرفين إلى 120 حرفاً.»
 *   INVALID_STORE_SLUG    «يجب أن يكون رابط المتجر بأحرف إنجليزية صغيرة…»
 *   INVALID_VACATION_SETTINGS, DUPLICATE_STORE_SLUG, INVALID_FULL_NAME,
 *   INVALID_PHONE, INVALID_EMAIL, MERCHANT_STORE_CONTEXT_NOT_FOUND
 *
 * Re-expressing those as `z.string().min(2)` would answer the SAME bad input
 * with `VALIDATION_FAILED` and zod's English `too_small`, and phase 13 and MD-1
 * assert three of the codes by name. That is a step away from the destination,
 * not towards it.
 *
 * ⚠ The rename has a second reason, and it is an ordering one.
 *   `renameMerchantStore` calls `assertDemoWritable` BEFORE it looks at the
 *   name, so a visitor renaming the shared demo store is told `DEMO_READ_ONLY`
 *   whatever he typed. A name rule in this file would run first and answer him
 *   with a validation error about a store he was never allowed to rename.
 *
 * What the schemas below DO buy, which is the part that matters for 25أ and 22:
 * the body arrives as a declared, typed, CLOSED set of keys. `POST
 * /merchant/stores/:storeSlug/customers/manual` spread the raw body straight
 * into the service (`{ ...request.body, storeId }`); it now spreads three named
 * fields. And every one of these routes is out of the ratchet's debt list, so
 * the next hand-rolled check cannot be added here without being noticed.
 */
import { z } from "zod";

/** `merchantStoreForSwitch` answers 422 INVALID_STORE_SLUG for a missing or non-string slug, and 404 for a foreign one. */
export const switchMerchantStoreSchema = z.object({
  storeSlug: z.unknown(),
});

/** `requiredStoreName` + `normalizedStoreSlug` own both fields; the slug's uniqueness is the database's answer (409 DUPLICATE_STORE_SLUG). */
export const createMerchantStoreSchema = z.object({
  name: z.unknown(),
  slug: z.unknown(),
});

/** Rename only — the slug is a public identity and this route never touches it, so it is not a key here. */
export const renameMerchantStoreSchema = z.object({
  name: z.unknown(),
});

/**
 * The store-scoped customer created by hand. `storeId` is deliberately NOT a key:
 * it comes from the resolved store actor, and the route appends it after this
 * body — a client that sends one is now ignored at the door rather than one
 * spread away from the service.
 */
export const createManualCustomerSchema = z.object({
  fullName: z.unknown(),
  email: z.unknown(),
  phone: z.unknown(),
});

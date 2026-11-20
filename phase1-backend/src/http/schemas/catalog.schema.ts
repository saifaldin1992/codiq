/**
 * Phase 19-ج — the catalog's eight write bodies: categories, products, variants
 * and the two inventory adjustments (phases 7, 20A, PG-2).
 *
 * This file is the largest of the batch because the catalog is where the
 * hand-rolled layer was thickest: three helpers — `requiredText`,
 * `optionalText`, `nonNegativeInteger` — invoked forty-odd times, every one of
 * them answering the same `INVALID_INPUT` with an ENGLISH sentence built by
 * string concatenation («sku is required and must be within 80 characters»).
 * Forty refusals a translator cannot enumerate and a form cannot map to a box.
 *
 * THE HELPERS BELOW MIRROR THOSE THREE EXACTLY, including their leniences,
 * because this conversion changes the CODE a client reads and nothing else:
 *
 *  · `nonNegativeInteger` ran the value through `Number()`, so «5» is five and
 *    `true` is one. `z.coerce.number()` is that same call, so a client that has
 *    been posting numeric strings since phase 7 keeps working.
 *  · `optionalText` accepted `null` and `""` as «no value» and did NOT trim
 *    before storing — which is why the string branch here refines rather than
 *    transforms: a description of spaces stored `""`, and it still does.
 *  · `isActive` and `requiresPrescription` are UNCHECKED on create and strictly
 *    boolean on update. That asymmetry is pre-existing and load-bearing enough
 *    to leave alone: `body.isActive === true` on create means «anything that is
 *    not exactly true creates an inactive product», and tightening it would
 *    refuse bodies the catalog has accepted for four phases. Stated here so the
 *    next person sees it is a decision, not an oversight.
 *
 * ⚠ `categoryId` and `parentCategoryId` are UUIDs here, and that IS a change.
 *   Both were checked for `typeof === "string"` and handed to Prisma, where a
 *   non-uuid on a `@db.Uuid` column raises P2023 — a code `errorHandler` has no
 *   branch for — so «/products?categoryId=shoes» answered 500 instead of the
 *   CATEGORY_NOT_FOUND 404 the code plainly intends. Same fault as the
 *   wishlist's variantId and the trash bin's categoryId; same fix.
 *
 * WHAT STAYS IN THE SERVICE: every question that needs the database. Whether the
 * category belongs to this store (404 CATEGORY_NOT_FOUND), whether a parent
 * would make a cycle or breach the three-level budget (INVALID_CATEGORY_PARENT,
 * CATEGORY_DEPTH_EXCEEDED, both re-checked by a trigger under an advisory lock),
 * whether the SKU is free, whether the plan still has room for another product.
 */
import { z } from "zod";

/** `requiredText`: present, non-blank, and within the cap once trimmed. */
function requiredText(max: number) {
  return z.string().trim().min(1).max(max);
}

/**
 * `optionalText`: `null` and `""` both mean «no value», and the cap is measured
 * on the TRIMMED length while the value itself is passed on untouched — the
 * service's own normalization decides what is stored.
 */
function optionalText(max: number) {
  return z.union([
    z.string().refine((value) => value.trim().length <= max, `الحد الأقصى ${max} حرفاً.`),
    z.null(),
  ]).optional();
}

/** `nonNegativeInteger`: `Number(value)`, then integer and at least zero. */
/**
 * ASVS 5.0 V1.4.2: prices, stock and thresholds are 32-bit integer columns. A
 * larger value used to reach PostgreSQL and come back as a 500; it is now the
 * caller's 422 at the edge.
 */
export const INT32_MAX = 2_147_483_647;
const nonNegativeInteger = z.coerce.number().int().min(0).max(INT32_MAX, "القيمة أكبر من المسموح.");

/**
 * A category reference. `null` and `""` both mean «no category» — the empty
 * string is what a cleared <select> sends — and anything else must be a uuid,
 * because the column is one.
 */
const categoryReference = z.union([z.string().uuid(), z.literal(""), z.null()]).optional();

/** Phase 20A: free-form variant axes («اللون»: «أحمر»). An object, and a small one. */
const variantOptions = z
  .looseObject({})
  .refine((value) => JSON.stringify(value).length <= 2000, "الحد الأقصى 2000 حرف لخصائص المتغير.");

export const createCategorySchema = z.object({
  name: requiredText(120),
  parentCategoryId: categoryReference,
});

export const updateCategorySchema = z.object({
  name: requiredText(120),
  parentCategoryId: categoryReference,
});

export const createProductSchema = z.object({
  sku: requiredText(80),
  name: requiredText(240),
  description: optionalText(4000),
  priceIqd: nonNegativeInteger,
  // Absent means zero, exactly as `body.stockQuantity ?? 0` meant it.
  stockQuantity: nonNegativeInteger.default(0),
  lowStockThreshold: nonNegativeInteger.default(0),
  categoryId: categoryReference,
  // Unchecked on purpose — see the header.
  isActive: z.unknown().optional(),
  requiresPrescription: z.unknown().optional(),
  // ق-199: typed attribute groups («النوتة العطرية»: مقدمة/قلب/قاعدة) — validated in the service by the storefront schema.
  attributes: z.unknown().optional(),
});

/**
 * ق-243 — STOCK IS NOT A CATALOG FIELD, AND A PATCH THAT CARRIES IT IS REFUSED
 * OUT LOUD.
 *
 * The product editor used to resend the stock it had loaded on EVERY save, and
 * `updateProduct` wrote that number over the default variant's live stock with
 * no compare-and-swap. Stock 10 on screen; the till sells 3 an hour later; the
 * merchant fixes a typo in the description and presses «حفظ» → stock is 10
 * again, three phantom units are sellable on the storefront and at the till,
 * and the trail holds a «manual_adjustment» nobody performed. The inverse is
 * worse for money: a return-inspection restock landing in between is erased,
 * and a DELIVERED COD order then fails completion with
 * INSUFFICIENT_AVAILABLE_STOCK — cash already collected, wallet credit stuck.
 *
 * So stock moves through ONE door: the inventory endpoints, which require
 * `inventory.update` (the catalog PATCH only ever asked for
 * `catalog.products.update` — a permission hole as well as a data one), record
 * a reason, and since ق-243 lock the row and honour `expectedStockQuantity`.
 *
 * `z.never().optional()` rather than dropping the key: an object schema STRIPS
 * unknown keys silently, and a client that kept sending `stockQuantity` would
 * believe it had set the stock while nothing happened. A refusal that names the
 * right door is the only honest answer to a field that used to work.
 */
const stockNotOnCatalogPatch = z
  .never({ error: "المخزون لا يُعدَّل من بيانات المنتج — استعمل مسار الجرد مع ذكر السبب." })
  .optional();

export const updateProductSchema = z.object({
  sku: requiredText(80).optional(),
  name: requiredText(240).optional(),
  description: optionalText(4000),
  priceIqd: nonNegativeInteger.optional(),
  stockQuantity: stockNotOnCatalogPatch,
  lowStockThreshold: nonNegativeInteger.optional(),
  categoryId: categoryReference,
  isActive: z.boolean().optional(),
  requiresPrescription: z.boolean().optional(),
  attributes: z.unknown().optional(),
});

/**
 * Both inventory endpoints: the new count, and why it changed.
 *
 * ق-243: `expectedStockQuantity` is the number the caller SAW when he decided
 * on the new one. When present, the service refuses (409 STOCK_CHANGED) if the
 * row no longer holds it — a stale tab cannot overwrite a sale that landed in
 * between. Optional because a physical count is legitimately absolute: «it is
 * 12 now, whatever it was».
 */
export const inventoryAdjustmentSchema = z.object({
  stockQuantity: nonNegativeInteger,
  expectedStockQuantity: nonNegativeInteger.optional(),
  reason: requiredText(120),
});

export const createVariantSchema = z.object({
  sku: requiredText(80),
  name: requiredText(240),
  priceIqd: nonNegativeInteger,
  stockQuantity: nonNegativeInteger.default(0),
  lowStockThreshold: nonNegativeInteger.default(0),
  isActive: z.unknown().optional(),
  options: variantOptions.optional(),
});

export const updateVariantSchema = z.object({
  sku: requiredText(80).optional(),
  name: requiredText(240).optional(),
  priceIqd: nonNegativeInteger.optional(),
  // ق-243: same door, same refusal — see `stockNotOnCatalogPatch`.
  stockQuantity: stockNotOnCatalogPatch,
  lowStockThreshold: nonNegativeInteger.optional(),
  position: nonNegativeInteger.optional(),
  isActive: z.boolean().optional(),
  options: variantOptions.optional(),
});

import { Prisma } from "@prisma/client";
import type { ProductVariant } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { enqueueLowStockIfCrossed } from "../notifications/notification-outbox.service.js";
import { assertWithinPlanLimit } from "./entitlement.service.js";
import { productAttributesSchema } from "../http/schemas/storefront-config.schema.js";
import { deleteProductImageObjects, productImageObjectKeys, putProductImage, renderProductImage } from "./product-image-storage.service.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { inSearchOrder, mergeSearchPages, searchEngine } from "./search/index.js";
import type { AuditActor } from "./soft-delete/audit-log.service.js";
import { LIVE } from "./soft-delete/constants.js";
import { restore, softDelete, type RestoreOverrides } from "./soft-delete/soft-delete.service.js";

const variantOrder = [{ isDefault: "desc" as const }, { position: "asc" as const }, { createdAt: "asc" as const }];

const productInclude = {
  category: { select: { id: true, name: true } },
  images: { select: { id: true, contentType: true, byteSize: true, sortOrder: true }, orderBy: { sortOrder: "asc" as const } },
  variants: { where: { deletedAt: null }, orderBy: variantOrder },
} satisfies Prisma.ProductInclude;

/**
 * 19-ج: the eight catalog write bodies are now parsed at the HTTP edge by
 * `http/schemas/catalog.schema.ts`, whose helpers mirror these three exactly —
 * `Number()` coercion included — so a client posting «5» keeps working and a
 * shape failure answers one code naming the field. These stay because the
 * functions below are exported and reachable from the CSV importer and the
 * seeder, which do not pass through a route.
 */
function requiredText(value: unknown, field: string, maxLength = 240) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new HttpError(422, "INVALID_INPUT", `${field} is required and must be within ${maxLength} characters.`);
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength = 4000) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength) throw new HttpError(422, "INVALID_INPUT", `${field} must be within ${maxLength} characters.`);
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpError(422, "INVALID_INPUT", `${field} must be a non-negative integer.`);
  return number;
}

function optionalNonNegativeInteger(value: unknown, field: string) {
  return value === undefined ? undefined : nonNegativeInteger(value, field);
}

/** Shared with the CSV importer (phase 20B-3) — category names are matched on this normalization. */
export function normalizeName(name: string) { return name.trim().toLocaleLowerCase("ar-IQ").replace(/\s+/g, " "); }

// PG-2: `productInclude.variants` is LIVE-filtered above, so a restored product
// never shows a variant the merchant deleted separately before it.
async function scopedProduct(storeId: string, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, storeId, ...LIVE }, include: productInclude });
  if (!product) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product was not found in this store.");
  return product;
}

async function scopedCategory(storeId: string, categoryId: string) {
  const category = await prisma.productCategory.findFirst({ where: { id: categoryId, storeId, ...LIVE } });
  if (!category) throw new HttpError(404, "CATEGORY_NOT_FOUND", "The requested category was not found in this store.");
  return category;
}

async function categoryIdForStore(storeId: string, value: unknown) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "INVALID_INPUT", "categoryId is invalid.");
  await scopedCategory(storeId, value);
  return value;
}

// ---------- Approved addition (2026-08-26): nested category tree ----------

// Levels are counted inclusively: a root category is level 1, so the deepest
// allowed chain is root -> child -> grandchild.
const CATEGORY_MAX_DEPTH = 3;

/**
 * Number of nodes on the chain from the category up to its root (>= 1).
 *
 * TRASHED ROWS COUNT. `codiq_guard_category_cycle` walks the same chain in SQL
 * with no `deleted_at` filter, and the trigger is the authority — it holds the
 * per-store advisory lock. When this walk filtered them out, a move the service
 * allowed was refused by Postgres with 23514 and the merchant saw a bare 500.
 * The price of agreeing with the trigger is that a trashed branch keeps spending
 * the budget until it is purged or restored; the alternative — teaching the
 * trigger to skip them — would let a restore rebuild a live 4-level tree,
 * because `restoreCategory` clears the stamp without re-checking depth.
 */
async function categoryAncestorDepth(storeId: string, categoryId: string) {
  let depth = 1;
  let current: string | null = categoryId;
  while (current) {
    const row: { parentCategoryId: string | null } | null = await prisma.productCategory.findFirst({ where: { id: current, storeId }, select: { parentCategoryId: true } });
    if (!row?.parentCategoryId) return depth;
    depth += 1;
    current = row.parentCategoryId;
    if (depth > CATEGORY_MAX_DEPTH + 1) return depth; // defensive cap — the DB trigger forbids cycles
  }
  return depth;
}

/** All descendant ids of a category (excluding itself), walked level by level. */
async function categoryDescendantIds(storeId: string, categoryId: string) {
  const descendants: string[] = [];
  let frontier = [categoryId];
  const seen = new Set(frontier);
  while (frontier.length) {
    const children = await prisma.productCategory.findMany({ where: { storeId, parentCategoryId: { in: frontier }, ...LIVE }, select: { id: true } });
    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
    for (const id of frontier) { seen.add(id); descendants.push(id); }
  }
  return descendants;
}

/**
 * Height of the subtree rooted at the category (the category itself = 1).
 * Trashed children count here for the same reason as in `categoryAncestorDepth`:
 * the trigger's recursive CTE counts them, and the two layers must agree.
 */
async function categorySubtreeHeight(storeId: string, categoryId: string) {
  let height = 1;
  let frontier = [categoryId];
  const seen = new Set(frontier);
  while (frontier.length) {
    const children = await prisma.productCategory.findMany({ where: { storeId, parentCategoryId: { in: frontier } }, select: { id: true } });
    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
    if (frontier.length) height += 1;
    for (const id of frontier) seen.add(id);
  }
  return height;
}

/**
 * Server-resolves an optional parentCategoryId: same-store existence (404 like
 * every other cross-store reference), self/cycle (422 INVALID_CATEGORY_PARENT),
 * and the 3-level depth budget (422 CATEGORY_DEPTH_EXCEEDED). `categoryId` is
 * present on update only; `subtreeHeight` is the height of the moving subtree
 * (1 for a fresh create).
 */
async function resolveParentCategoryId(storeId: string, value: unknown, categoryId?: string) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "INVALID_CATEGORY_PARENT", "التصنيف الأب المحدد غير صالح.");
  if (categoryId && value === categoryId) throw new HttpError(422, "INVALID_CATEGORY_PARENT", "لا يمكن أن يكون التصنيف أبًا لنفسه.");
  await scopedCategory(storeId, value);
  if (categoryId) {
    const descendants = await categoryDescendantIds(storeId, categoryId);
    if (descendants.includes(value)) throw new HttpError(422, "INVALID_CATEGORY_PARENT", "لا يمكن نقل التصنيف تحت أحد تصنيفاته الفرعية.");
  }
  const parentDepth = await categoryAncestorDepth(storeId, value);
  const subtreeHeight = categoryId ? await categorySubtreeHeight(storeId, categoryId) : 1;
  if (parentDepth + subtreeHeight > CATEGORY_MAX_DEPTH) throw new HttpError(422, "CATEGORY_DEPTH_EXCEEDED", `الحد الأقصى لعمق شجرة التصنيفات هو ${CATEGORY_MAX_DEPTH} مستويات.`);
  return value;
}

export function variantPayload(variant: ProductVariant) {
  return {
    id: variant.id, productId: variant.productId, sku: variant.sku, name: variant.name, priceIqd: variant.priceIqd,
    stockQuantity: variant.stockQuantity, lowStockThreshold: variant.lowStockThreshold, isLowStock: variant.isLowStock,
    isDefault: variant.isDefault, isActive: variant.isActive, position: variant.position, options: variant.options,
  };
}

export function productPayload(product: Prisma.ProductGetPayload<{ include: typeof productInclude }>) {
  return {
    id: product.id, sku: product.sku, name: product.name, description: product.description, priceIqd: product.priceIqd,
    stockQuantity: product.stockQuantity, lowStockThreshold: product.lowStockThreshold, isLowStock: product.isLowStock,
    requiresPrescription: product.requiresPrescription,
    attributes: product.attributes,
    isActive: product.isActive, category: product.category, images: product.images,
    variants: product.variants.map(variantPayload),
  };
}

export async function listCategories(storeId: string) {
  // PG-2: the nested `_count` needs its OWN LIVE filter — without it a category
  // would advertise products that are sitting in the trash bin.
  return prisma.productCategory.findMany({ where: { storeId, ...LIVE }, select: { id: true, name: true, parentCategoryId: true, createdAt: true, _count: { select: { products: { where: { deletedAt: null } } } } }, orderBy: { name: "asc" } });
}

export async function createCategory(storeId: string, body: Record<string, unknown>) {
  const name = requiredText(body.name, "name", 120);
  const normalizedName = normalizeName(name);
  const parentCategoryId = await resolveParentCategoryId(storeId, body.parentCategoryId);
  // PG-2 LIVE: a name held by a trashed category is free to reuse, exactly as
  // the partial unique index product_categories_store_name_live_key allows.
  const existing = await prisma.productCategory.findFirst({ where: { storeId, normalizedName, ...LIVE }, select: { id: true } });
  if (existing) throw new HttpError(409, "DUPLICATE_CATEGORY", "A category with this name already exists in this store.");
  return prisma.productCategory.create({ data: { storeId, name, normalizedName, parentCategoryId: parentCategoryId ?? null }, select: { id: true, name: true, parentCategoryId: true, createdAt: true } });
}

export async function updateCategory(storeId: string, categoryId: string, body: Record<string, unknown>) {
  await scopedCategory(storeId, categoryId);
  const name = requiredText(body.name, "name", 120);
  const parentCategoryId = await resolveParentCategoryId(storeId, body.parentCategoryId, categoryId);
  return prisma.productCategory.update({ where: { id: categoryId }, data: { name, normalizedName: normalizeName(name), ...(parentCategoryId !== undefined ? { parentCategoryId } : {}) }, select: { id: true, name: true, parentCategoryId: true, updatedAt: true } });
}

/**
 * PG-2: the hard delete became a soft delete. Both guards (live children, live
 * products) and the audit event live in `soft-delete.service.ts`, which is the
 * only module allowed to write `deletedAt`. The counts there are LIVE-only:
 * counting trashed products would leave the merchant unable, for thirty days,
 * to delete a category he can see is empty.
 */
export async function deleteCategory(storeId: string, categoryId: string, actor: AuditActor) {
  return softDelete("product_category", storeId, categoryId, actor);
}

export async function restoreCategory(storeId: string, categoryId: string, actor: AuditActor) {
  return restore("product_category", storeId, categoryId, actor);
}

/**
 * PG-6 (ق-74): how many ranked matches `q` narrows the catalog to.
 *
 * This is what kills the browser-side cap at `ProductCatalogManager.tsx:72`,
 * which loaded the first 100 products and filtered THOSE — so product 101
 * onward was reported as «no results», and the command palette's own deep link
 * (`?q=<sku>`) landed on a page that filtered its own hit away. The search now
 * runs over every product in the store; the cap below is on the ANSWER, not on
 * the haystack.
 */
const SEARCH_ID_CAP = 200;

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const CATALOG_LIST_KIND = "merchant.catalog.products";

export async function listProducts(storeId: string, rawLimit: unknown, rawCursor: unknown, lowStockOnly: boolean, rawQuery?: string) {
  const limit = parseListLimit(rawLimit);
  // 20-2: an opaque `(createdAt, id)` cursor and a keyset predicate. The
  // store-scoped anchor read that used to run on EVERY page is gone with it —
  // the cursor already carries the ordering value, so there is nothing to look
  // up. `legacy:` is the one-time ramp for the bare product uuid this route
  // minted before this branch, resolved through the same `scopedProduct` the
  // old code used, so a foreign or purged id is still a 404.
  const cursor = await readListCursor(CATALOG_LIST_KIND, rawCursor, {
    legacy: async (id) => ({ value: (await scopedProduct(storeId, id)).createdAt }),
  });
  const q = typeof rawQuery === "string" && rawQuery.trim() ? rawQuery.trim() : undefined;
  // Two single-column statements, never one `name OR sku`: the planner refuses
  // a BitmapOr across columns and falls back to a sequential scan (39.4 ms vs
  // 1.0 ms, measured on 8,013 products — migration 20260827190000, lines 33-40).
  const matchedIds = q
    ? mergeSearchPages(
        await Promise.all([
          searchEngine.search("products.name", { storeId, needle: q, limit: SEARCH_ID_CAP }),
          searchEngine.search("products.sku", { storeId, needle: q, limit: SEARCH_ID_CAP }),
        ]),
        SEARCH_ID_CAP,
      ).hits.map((hit) => hit.id)
    : undefined;
  // Phase 20A: a product is low-stock when ANY of its variants is low-stock.
  const where: Prisma.ProductWhereInput = { storeId, ...LIVE, ...(lowStockOnly ? { variants: { some: { isLowStock: true, deletedAt: null } } } : {}), ...(matchedIds ? { id: { in: matchedIds } } : {}), ...keysetWhere("createdAt", "desc", cursor) };
  // The id tiebreaker is load-bearing, not cosmetic: a CSV import writes many
  // products in the same transaction, so createdAt alone leaves their relative
  // order undefined and the keyset cursor can then skip or repeat rows across
  // pages. Every other paginated list in the platform already sorts this way.
  const rows = await prisma.product.findMany({ where, include: productInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(CATALOG_LIST_KIND, last.createdAt, last.id));
  return { products: page.map(productPayload), nextCursor };
}

/**
 * PG-6 (ق-74) — the till's ONLINE product search
 * (`GET /merchant/stores/:slug/pos/products`).
 *
 * The till keeps its offline snapshot filter (`TillPage.tsx`, ق-142) so a
 * cashier with no network still sells; this is the path it takes when the
 * network is there, and it is the only one that can see past the snapshot's
 * 500-row window. The payload is deliberately the SAME shape the till already
 * caches — id, sku, name, isActive, variants — so the online answer and the
 * offline answer render through one code path.
 *
 * Ranked, not paginated: a cashier types two or three characters and taps the
 * row. `hasMore` says the cap hid matches, exactly as the palette's `truncated`
 * does, instead of implying that is all there is.
 */
export async function searchPosProducts(storeId: string, needle: string, limit: number) {
  const page = mergeSearchPages(
    await Promise.all([
      searchEngine.search("products.name", { storeId, needle, limit }),
      searchEngine.search("products.sku", { storeId, needle, limit }),
    ]),
    limit,
  );
  // PG-2 LIVE: a product sitting in the trash bin must never reach a till, or
  // the cashier sells it and mints an order_item that blocks its purge forever.
  const rows = await prisma.product.findMany({
    where: { id: { in: page.hits.map((hit) => hit.id) }, storeId, ...LIVE },
    select: { id: true, sku: true, name: true, isActive: true, variants: { where: { deletedAt: null }, orderBy: variantOrder, select: { id: true, name: true, sku: true, priceIqd: true, stockQuantity: true, isActive: true, isDefault: true } } },
  });
  return { products: inSearchOrder(page.hits, rows), hasMore: page.hasMore };
}

/**
 * ق-199 — typed attribute groups. `undefined` means «leave it»; anything else must be
 * the shape the storefront renders, or the merchant is told which row is wrong.
 */
function parseProductAttributes(raw: unknown): Prisma.InputJsonValue | undefined {
  if (raw === undefined) return undefined;
  const parsed = productAttributesSchema.safeParse(raw === null ? [] : raw);
  if (!parsed.success) throw new HttpError(422, "INVALID_PRODUCT_ATTRIBUTES", "خصائص المنتج غير صالحة: كل مجموعة تحتاج اسماً وصفاً واحداً على الأقل (مفتاح وقيمة).");
  return parsed.data as Prisma.InputJsonValue;
}

export async function createProduct(storeId: string, body: Record<string, unknown>) {
  const sku = requiredText(body.sku, "sku", 80);
  const name = requiredText(body.name, "name", 240);
  const description = optionalText(body.description, "description");
  const priceIqd = nonNegativeInteger(body.priceIqd, "priceIqd");
  const stockQuantity = nonNegativeInteger(body.stockQuantity ?? 0, "stockQuantity");
  const lowStockThreshold = nonNegativeInteger(body.lowStockThreshold ?? 0, "lowStockThreshold");
  const categoryId = await categoryIdForStore(storeId, body.categoryId);
  const isActive = body.isActive === undefined ? true : body.isActive === true;
  // Phase 20B-1: prescription-required flag (additive; defaults to false).
  const requiresPrescription = body.requiresPrescription === undefined ? false : body.requiresPrescription === true;
  const attributes = parseProductAttributes(body.attributes);
  return prisma.$transaction(async (tx) => {
    // Phase 16: product count is a plan entitlement across the merchant's stores.
    const store = await tx.store.findUnique({ where: { id: storeId }, select: { merchantId: true } });
    if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
    await assertWithinPlanLimit(tx, store.merchantId, "max_products");
    // Phase 20A: the products_create_default_variant trigger materializes the
    // implicit default variant (inheriting sku/price/stock/threshold) inside this
    // same transaction, so the product is never observable without a variant.
    const product = await tx.product.create({ data: { storeId, sku, name, description, priceIqd, stockQuantity, lowStockThreshold, categoryId, isActive, requiresPrescription, ...(attributes === undefined ? {} : { attributes }) }, include: productInclude });
    const defaultVariant = product.variants.find((variant) => variant.isDefault);
    if (stockQuantity > 0) await tx.inventoryMovement.create({ data: { storeId, productId: product.id, variantId: defaultVariant?.id ?? null, delta: stockQuantity, reason: "initial_stock" } });
    return productPayload(product);
  });
}

export async function updateProduct(storeId: string, productId: string, body: Record<string, unknown>) {
  const existing = await scopedProduct(storeId, productId);
  const data: Prisma.ProductUpdateInput = {};
  const sku = body.sku === undefined ? undefined : requiredText(body.sku, "sku", 80);
  if (sku !== undefined) data.sku = sku;
  const name = body.name === undefined ? undefined : requiredText(body.name, "name", 240);
  if (name !== undefined) data.name = name;
  if (body.description !== undefined) data.description = optionalText(body.description, "description");
  const priceIqd = body.priceIqd === undefined ? undefined : nonNegativeInteger(body.priceIqd, "priceIqd");
  if (priceIqd !== undefined) data.priceIqd = priceIqd;
  const lowStockThreshold = body.lowStockThreshold === undefined ? undefined : nonNegativeInteger(body.lowStockThreshold, "lowStockThreshold");
  if (lowStockThreshold !== undefined) data.lowStockThreshold = lowStockThreshold;
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw new HttpError(422, "INVALID_INPUT", "isActive must be boolean.");
    data.isActive = body.isActive;
  }
  if (body.requiresPrescription !== undefined) {
    if (typeof body.requiresPrescription !== "boolean") throw new HttpError(422, "INVALID_INPUT", "requiresPrescription must be boolean.");
    data.requiresPrescription = body.requiresPrescription;
  }
  const attributes = parseProductAttributes(body.attributes);
  if (attributes !== undefined) data.attributes = attributes;
  const categoryId = await categoryIdForStore(storeId, body.categoryId);
  if (categoryId !== undefined) data.category = categoryId === null ? { disconnect: true } : { connect: { id: categoryId } };
  // ق-243: stock is no longer accepted here — the schema refuses it with the
  // door to use. `existing` was read OUTSIDE this transaction, so any stock
  // number derived from it would already be stale; the inventory endpoints
  // lock the row and read the truth inside theirs.
  return prisma.$transaction(async (tx) => {
    // Phase 20A: sku/price/threshold are variant facts — the legacy product
    // fields on this endpoint keep working by targeting the implicit default
    // variant (the frozen product columns follow via the mirror trigger).
    const defaultVariant = existing.variants.find((variant) => variant.isDefault);
    if (defaultVariant) {
      const variantData: Prisma.ProductVariantUncheckedUpdateInput = {};
      if (sku !== undefined) variantData.sku = sku;
      if (name !== undefined) variantData.name = name;
      if (priceIqd !== undefined) variantData.priceIqd = priceIqd;
      if (lowStockThreshold !== undefined) variantData.lowStockThreshold = lowStockThreshold;
      if (Object.keys(variantData).length) await tx.productVariant.update({ where: { id: defaultVariant.id }, data: variantData });
    }
    const product = await tx.product.update({ where: { id: existing.id }, data, include: productInclude });
    return productPayload(product);
  });
}

/**
 * ق-243 — THE ONE DOOR STOCK MOVES THROUGH, AND WHY IT LOCKS THE ROW FIRST.
 *
 * `variant` was read by the caller OUTSIDE this transaction. Computing the
 * movement's delta from `variant.stockQuantity` — which is what this function
 * did — makes the trail lie whenever anything committed in between: a till
 * sale (`updateMany … decrement`), a COD completion, a return-inspection
 * restock. The absolute write still lands, but the delta beside it describes a
 * starting point that no longer existed, and Σ(movements) stops summing to the
 * stock — «phantom stock … undetectable until a physical count», in the words
 * of the reservation-expiry job's own header.
 *
 * So the TRUE current value is read inside the transaction with `FOR UPDATE`.
 * The lock serialises this write against every concurrent decrement (they take
 * row locks too), and the delta is computed from a number that is provably the
 * one the update overwrote. That alone makes the trail honest.
 *
 * `expectedStockQuantity` is the other half — the everyday case, with no race
 * at all: a merchant's tab opened an hour ago says 10, the till sold 3 since,
 * and he saves «12» meaning «two more than I saw». With the expectation the
 * server can tell him the screen is stale (409 STOCK_CHANGED) instead of
 * silently setting 12 over a true 7. Without it — a physical count — the write
 * is absolute by design, and the delta is still true.
 */
/**
 * A seam for the race, and nothing else. The defect this function closes lives
 * in the gap between the caller's pre-transaction read and the row lock below;
 * a test cannot land a concurrent decrement in that gap by timing, so it lands
 * one HERE. Production never sets it — the same shape as `runPass` on the outbox
 * worker and `exit` on graceful shutdown: one nullable hook, proven by a suite
 * that fails when the read below is replaced with the stale one.
 */
export const inventoryWriteHooks: { beforeLock: null | (() => Promise<void>) } = { beforeLock: null };

async function applyVariantInventory(storeId: string, productId: string, variant: ProductVariant, body: Record<string, unknown>) {
  const stockQuantity = nonNegativeInteger(body.stockQuantity, "stockQuantity");
  const reason = requiredText(body.reason, "reason", 120);
  const expectedStockQuantity = optionalNonNegativeInteger(body.expectedStockQuantity, "expectedStockQuantity");
  return prisma.$transaction(async (tx) => {
    if (inventoryWriteHooks.beforeLock) await inventoryWriteHooks.beforeLock();
    const locked = await tx.$queryRaw<Array<{ stock_quantity: number }>>`
      SELECT stock_quantity FROM product_variants
      WHERE id = ${variant.id}::uuid AND store_id = ${storeId}::uuid AND deleted_at IS NULL
      FOR UPDATE`;
    const current = locked[0]?.stock_quantity;
    if (current === undefined) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product variant was not found in this store.");
    if (expectedStockQuantity !== undefined && expectedStockQuantity !== current) {
      throw new HttpError(
        409,
        "STOCK_CHANGED",
        `تغيّر المخزون منذ فتح الشاشة: كان ${expectedStockQuantity} وصار ${current}. حدّث الشاشة ثم أعد المحاولة.`,
      );
    }
    const updated = await tx.productVariant.update({ where: { id: variant.id }, data: { stockQuantity }, include: { product: { select: { name: true } } } });
    if (stockQuantity !== current) {
      await tx.inventoryMovement.create({ data: { storeId, productId, variantId: variant.id, delta: stockQuantity - current, reason } });
      await enqueueLowStockIfCrossed(tx, { storeId, productId, variantId: variant.id, productName: updated.product.name, variantName: updated.name, sku: updated.sku, previousQuantity: current, stockQuantity: updated.stockQuantity, lowStockThreshold: updated.lowStockThreshold });
    }
    return updated;
  });
}

export async function adjustInventory(storeId: string, productId: string, body: Record<string, unknown>) {
  // Phase 20A: the legacy product-level inventory endpoint keeps working by
  // adjusting the product's implicit default variant.
  const existing = await scopedProduct(storeId, productId);
  const defaultVariant = existing.variants.find((variant) => variant.isDefault);
  if (!defaultVariant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product was not found in this store.");
  await applyVariantInventory(storeId, existing.id, defaultVariant, body);
  const product = await prisma.product.findFirst({ where: { id: existing.id, storeId, ...LIVE }, include: productInclude });
  if (!product) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product was not found in this store.");
  return productPayload(product);
}

/**
 * PG-2: the hard delete became a soft delete (owner decision «ب»).
 *
 * The old `PRODUCT_REFERENCED_BY_ORDER` pre-check is GONE on purpose: a product
 * sold two months ago is not an operation in flight, so it enters the trash bin
 * like any other and can be restored from it. Its ledger row is protected where
 * it actually matters — at PURGE time, by `order_items`' restricting foreign
 * key — after which the row stays visible in the bin with the
 * «محفوظ لسجلاتك» badge and is never hard-deleted.
 *
 * The two guards that DID survive both protect something happening right now:
 * a live customer cart and an active inventory reservation. Both live in
 * `soft-delete.service.ts` and run inside the delete transaction.
 */
export async function deleteProduct(storeId: string, productId: string, actor: AuditActor) {
  return softDelete("product", storeId, productId, actor);
}

export async function restoreProduct(storeId: string, productId: string, actor: AuditActor, overrides: RestoreOverrides) {
  return restore("product", storeId, productId, actor, overrides);
}

// ---------- Phase 20A: variant management ----------

async function scopedVariant(storeId: string, productId: string, variantId: string) {
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, productId, storeId, ...LIVE } });
  if (!variant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product variant was not found in this store.");
  return variant;
}

function variantOptions(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(422, "INVALID_INPUT", "options must be an object.");
  if (JSON.stringify(value).length > 2000) throw new HttpError(422, "INVALID_INPUT", "options must be within 2000 characters.");
  return value as Prisma.InputJsonObject;
}

async function assertVariantSkuAvailable(storeId: string, sku: string, exceptVariantId?: string) {
  // PG-2 LIVE: a SKU held by a trashed variant is free, matching the partial
  // unique index product_variants_store_sku_live_key.
  const duplicate = await prisma.productVariant.findFirst({ where: { storeId, sku, ...LIVE, ...(exceptVariantId ? { id: { not: exceptVariantId } } : {}) }, select: { id: true } });
  if (duplicate) throw new HttpError(409, "DUPLICATE_VARIANT_SKU", "A variant with this SKU already exists in this store.");
}

export async function listVariants(storeId: string, productId: string) {
  const product = await scopedProduct(storeId, productId);
  return product.variants.map(variantPayload);
}

export async function createVariant(storeId: string, productId: string, body: Record<string, unknown>) {
  const product = await scopedProduct(storeId, productId);
  const sku = requiredText(body.sku, "sku", 80);
  const name = requiredText(body.name, "name", 240);
  const priceIqd = nonNegativeInteger(body.priceIqd, "priceIqd");
  const stockQuantity = nonNegativeInteger(body.stockQuantity ?? 0, "stockQuantity");
  const lowStockThreshold = nonNegativeInteger(body.lowStockThreshold ?? 0, "lowStockThreshold");
  const isActive = body.isActive === undefined ? true : body.isActive === true;
  const options = variantOptions(body.options) ?? {};
  await assertVariantSkuAvailable(storeId, sku);
  return prisma.$transaction(async (tx) => {
    const maxPosition = await tx.productVariant.aggregate({ where: { productId: product.id, ...LIVE }, _max: { position: true } });
    const variant = await tx.productVariant.create({ data: { storeId, productId: product.id, sku, name, priceIqd, stockQuantity, lowStockThreshold, isDefault: false, isActive, position: (maxPosition._max.position ?? -1) + 1, options } });
    if (stockQuantity > 0) await tx.inventoryMovement.create({ data: { storeId, productId: product.id, variantId: variant.id, delta: stockQuantity, reason: "initial_stock" } });
    return variantPayload(variant);
  });
}

export async function updateVariant(storeId: string, productId: string, variantId: string, body: Record<string, unknown>) {
  const variant = await scopedVariant(storeId, productId, variantId);
  const data: Prisma.ProductVariantUncheckedUpdateInput = {};
  const sku = body.sku === undefined ? undefined : requiredText(body.sku, "sku", 80);
  if (sku !== undefined) data.sku = sku;
  if (body.name !== undefined) data.name = requiredText(body.name, "name", 240);
  if (body.priceIqd !== undefined) data.priceIqd = nonNegativeInteger(body.priceIqd, "priceIqd");
  if (body.lowStockThreshold !== undefined) data.lowStockThreshold = nonNegativeInteger(body.lowStockThreshold, "lowStockThreshold");
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw new HttpError(422, "INVALID_INPUT", "isActive must be boolean.");
    data.isActive = body.isActive;
  }
  if (body.position !== undefined) data.position = nonNegativeInteger(body.position, "position");
  const options = variantOptions(body.options);
  if (options !== undefined) data.options = options;
  // ق-243: stock is refused by the schema on this route — `adjustVariantInventory`
  // is the door, and it locks the row before it computes anything.
  if (sku !== undefined && sku !== variant.sku) await assertVariantSkuAvailable(storeId, sku, variant.id);
  const updated = await prisma.productVariant.update({ where: { id: variant.id }, data });
  return variantPayload(updated);
}

export async function adjustVariantInventory(storeId: string, productId: string, variantId: string, body: Record<string, unknown>) {
  const variant = await scopedVariant(storeId, productId, variantId);
  const updated = await applyVariantInventory(storeId, productId, variant, body);
  return variantPayload(updated);
}

export async function deleteVariant(storeId: string, productId: string, variantId: string) {
  const variant = await scopedVariant(storeId, productId, variantId);
  // The implicit default variant carries the product's identity — it can never be
  // deleted, which also guarantees every product keeps >= 1 variant.
  // PG-2 §6.3: a variant is NOT an entity in the approved scope — deleteVariant
  // stays a HARD delete behind its three existing guards; a variant only reaches
  // the trash bin by riding along with its parent product.
  if (variant.isDefault) throw new HttpError(409, "DEFAULT_VARIANT_PROTECTED", "The default variant of a product cannot be deleted.");
  const usedInOrders = await prisma.orderItem.count({ where: { variantId: variant.id } });
  const usedInReservations = await prisma.inventoryReservation.count({ where: { variantId: variant.id } });
  if (usedInOrders > 0 || usedInReservations > 0) throw new HttpError(409, "VARIANT_REFERENCED_BY_ORDER", "A variant referenced by an order cannot be deleted.");
  const usedInCarts = await prisma.cartItem.count({ where: { variantId: variant.id } });
  if (usedInCarts > 0) throw new HttpError(409, "VARIANT_IN_USE", "A variant present in shopping carts cannot be deleted.");
  await prisma.productVariant.delete({ where: { id: variant.id } });
}

// ---------- MD-1: «نسخ منتج بنقرة» (one-click product duplicate) ----------

const SKU_MAX_LENGTH = 80;
const COPY_SUFFIX = "-COPY";
const COPY_SUFFIX_ATTEMPTS = 200;

/** `BASE-COPY`, `BASE-COPY-2`, … truncated so the result never exceeds the 80-char SKU budget. */
function copySkuCandidate(base: string, attempt: number) {
  const suffix = attempt === 1 ? COPY_SUFFIX : `${COPY_SUFFIX}-${attempt}`;
  const room = Math.max(1, SKU_MAX_LENGTH - suffix.length);
  return `${base.slice(0, room)}${suffix}`;
}

/**
 * Allocates the first free `-COPY…` SKU inside the transaction. Both tables are
 * probed through the caller's `tx`, so SKUs minted earlier in the SAME duplicate
 * (the product's own SKU and each preceding variant) are already visible and
 * can never be handed out twice.
 */
async function allocateCopySku(tx: Prisma.TransactionClient, storeId: string, base: string, table: "product" | "variant", exceptVariantId?: string) {
  for (let attempt = 1; attempt <= COPY_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = copySkuCandidate(base, attempt);
    // PG-2 LIVE on BOTH probes: without it a `-COPY` suffix stays reserved by a
    // duplicate the merchant already threw away.
    const taken = table === "product"
      ? await tx.product.findFirst({ where: { storeId, sku: candidate, ...LIVE }, select: { id: true } })
      // `exceptVariantId` is the copy's own trigger-created default variant: it
      // already holds the product's `-COPY` SKU, so counting it as "taken" would
      // needlessly push the default variant to `-COPY-2`.
      : await tx.productVariant.findFirst({ where: { storeId, sku: candidate, ...LIVE, ...(exceptVariantId ? { id: { not: exceptVariantId } } : {}) }, select: { id: true } });
    if (!taken) return candidate;
  }
  throw new HttpError(409, "DUPLICATE_SKU_EXHAUSTED", "تعذر توليد SKU فريد للنسخة — عدّل SKU المنتج الأصلي ثم أعِد المحاولة.");
}

/**
 * Duplicates a product with its category link and ALL its variants.
 * v1 rules (surfaced verbatim in the UI):
 *   - every copied variant starts at stock 0 (a duplicate owns no inventory),
 *   - images are NOT copied,
 *   - the product and each variant get a unique `-COPY…` SKU suffix so the
 *     UNIQUE(store_id, sku) constraints on products and product_variants can
 *     never collide,
 *   - the plan's `max_products` budget is charged for the new product INSIDE the
 *     transaction, so a refusal leaves zero partial writes.
 */
export async function duplicateProduct(storeId: string, productId: string) {
  const source = await scopedProduct(storeId, productId);
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.findUnique({ where: { id: storeId }, select: { merchantId: true } });
    if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
    await assertWithinPlanLimit(tx, store.merchantId, "max_products", 1);
    const sku = await allocateCopySku(tx, storeId, source.sku, "product");
    const name = `${source.name} (نسخة)`.slice(0, 240);
    // The products_create_default_variant trigger materializes the copy's
    // default variant from these columns; stockQuantity 0 keeps it empty, and
    // no inventory movement is recorded because nothing was stocked.
    //
    // The copy ALWAYS lands as a draft (`isActive: false`), never inheriting the
    // source's published flag. Copying an active product used to publish
    // «X (نسخة)» to the storefront instantly with zero stock — a shopper-visible,
    // unbuyable duplicate produced by a single click. Publishing is a deliberate
    // act, so it stays a second, explicit step.
    const created = await tx.product.create({
      data: {
        storeId, sku, name, description: source.description, priceIqd: source.priceIqd,
        stockQuantity: 0, lowStockThreshold: source.lowStockThreshold,
        categoryId: source.categoryId, isActive: false, requiresPrescription: source.requiresPrescription,
      },
      include: productInclude,
    });
    const createdDefault = created.variants.find((variant) => variant.isDefault);
    if (!createdDefault) throw new HttpError(500, "PRODUCT_DUPLICATE_FAILED", "تعذر إنشاء نسخة المنتج.");
    // `source.variants` is ordered default-first, so the default variant claims
    // its SKU before any sibling can take the same candidate.
    for (const variant of source.variants) {
      const variantSku = await allocateCopySku(tx, storeId, variant.sku, "variant", variant.isDefault ? createdDefault.id : undefined);
      const shared = {
        sku: variantSku, name: variant.name, priceIqd: variant.priceIqd, stockQuantity: 0,
        lowStockThreshold: variant.lowStockThreshold, isActive: variant.isActive,
        position: variant.position, options: variant.options as Prisma.InputJsonValue,
      };
      if (variant.isDefault) await tx.productVariant.update({ where: { id: createdDefault.id }, data: shared });
      else await tx.productVariant.create({ data: { storeId, productId: created.id, isDefault: false, ...shared } });
    }
    const duplicated = await tx.product.findFirst({ where: { id: created.id, storeId, ...LIVE }, include: productInclude });
    if (!duplicated) throw new HttpError(500, "PRODUCT_DUPLICATE_FAILED", "تعذر إنشاء نسخة المنتج.");
    return productPayload(duplicated);
  });
}

export async function addProductImages(storeId: string, productId: string, files: Express.Multer.File[]) {
  const product = await scopedProduct(storeId, productId);
  // Phase 16: image storage is a plan entitlement; refuse before any byte is uploaded.
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { merchantId: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
  // ق-238 — RENDER FIRST, THEN ASK THE METER, THEN UPLOAD.
  //
  // The meter used to be charged `file.size`: what the merchant SENT. Since the
  // platform now re-encodes, that number is roughly twelve times what the bucket
  // will hold, so a merchant was billed against his plan for bytes that were
  // never stored — and hit a wall he had not actually reached.
  //
  // Rendering before the check keeps phase 16's invariant intact («refuse before
  // any byte is uploaded») while making the number true. Holding the renders in
  // memory costs almost nothing: eight cards are ~4 MB, against the source
  // buffers multer is already holding.
  const rendered = [];
  for (const file of files) rendered.push(await renderProductImage(file));
  const incomingMb = Math.ceil(rendered.reduce((sum, set) => sum + set.totalBytes, 0) / (1024 * 1024));
  await assertWithinPlanLimit(prisma, store.merchantId, "max_image_storage_mb", Math.max(1, incomingMb));
  const maxSort = product.images.reduce((current, image) => Math.max(current, image.sortOrder), -1);
  // D-72 — WHOLE OR NOT AT ALL.
  //
  // This was a loop of put-then-insert, one file at a time, with no transaction
  // around the rows and no cleanup around the objects. A failure on the third
  // file left the first two committed — a half gallery the merchant reconciles
  // by eye — and a failure on the INSERT after a successful put left an orphan
  // in the bucket: bytes charged to his plan that no screen shows and no delete
  // ever reaches.
  //
  // Now every set is put first, and the rows are written in ONE transaction.
  // Anything that fails after the first put deletes what was put — best effort,
  // like the trash purger, because the database is the record of truth and a
  // storage hiccup during cleanup must not turn a refused upload into a 500 that
  // hides the real reason.
  const uploaded: Awaited<ReturnType<typeof putProductImage>>[] = [];
  try {
    for (const set of rendered) uploaded.push(await putProductImage(storeId, product.id, set));
    return await prisma.$transaction(async (tx) => {
      const images = [];
      for (let index = 0; index < uploaded.length; index += 1) {
        images.push(await tx.productImage.create({ data: { storeId, productId: product.id, ...uploaded[index]!, sortOrder: maxSort + index + 1 }, select: { id: true, contentType: true, byteSize: true, sortOrder: true } }));
      }
      if (imageWriteHooks.beforeCommit) await imageWriteHooks.beforeCommit();
      return images;
    });
  } catch (error) {
    await deleteProductImageObjects(uploaded.flatMap((image) => productImageObjectKeys(image))).catch(() => { /* best effort — the error below is the one that matters */ });
    throw error;
  }
}

/**
 * The seam D-72's suite fails through: fires inside the transaction after every
 * row is written and before it commits — the worst moment for the database to
 * go away. Production never sets it; same shape as `inventoryWriteHooks`.
 */
export const imageWriteHooks: { beforeCommit: null | (() => Promise<void>) } = { beforeCommit: null };

export async function productImageForStore(storeId: string, productId: string, imageId: string) {
  // PG-2: the image itself has no deleted_at (plan §0 — the alleged "public
  // image leak" was a fabricated fact); the guard is on the PARENT product, so a
  // trashed product's images stop being served the instant it is deleted.
  const image = await prisma.productImage.findFirst({ where: { id: imageId, storeId, productId, product: { deletedAt: null } }, select: { objectKey: true, contentType: true, variantSet: true } });
  if (!image) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product image was not found in this store.");
  return image;
}

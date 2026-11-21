/**
 * codiq phase 20B-3 — catalog CSV import/export + orders export (D-25).
 *
 * Approved decisions (§8.8/§8.9):
 * - hand-rolled RFC-4180-subset parser (csv.ts) — no new dependency;
 * - import is CREATE-ONLY in v1: an existing SKU is a row error, never an update;
 * - hard cap of 2000 data rows (CSV_TOO_LARGE);
 * - mandatory preview: ?dryRun=true validates every row and writes NOTHING;
 * - commit is ONE transaction — all-or-nothing, a single bad row rejects the file;
 * - plan limit charges the NEW-PRODUCTS count (assertWithinPlanLimit once,
 *   before any insert, inside the same transaction);
 * - UTF-8 only for import (broken encodings get a clear Arabic 422) and a
 *   UTF-8 BOM opens every export so Excel renders Arabic correctly.
 *
 * Format: one row per VARIANT, grouped by product_sku. The FIRST row of a group
 * creates the product exactly like createProduct does (the DB trigger
 * materializes the implicit default variant in the same transaction, then the
 * row's variant fields update that default variant); every subsequent row of
 * the group creates an additional variant. category_path ("أب > فرع > ورقة")
 * resolves against the store's nested category tree, creating missing nodes on
 * commit, and respects the 3-level depth budget.
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { CSV_UTF8_BOM, csvGuardedLine, csvLine, csvUnguardField, parseCsv } from "./csv.js";
import { assertWithinPlanLimit } from "./entitlement.service.js";
import { normalizeName } from "./product-catalog.service.js";
import { ORDER_STATUSES } from "./order-lifecycle.service.js";
import { LIVE } from "./soft-delete/constants.js";
import { keysetWhere } from "./list-page.js";

export const CSV_MAX_ROWS = 2000;
const CATEGORY_MAX_DEPTH = 3;

export const PRODUCT_CSV_COLUMNS = [
  "product_sku",
  "product_name",
  "description",
  "category_path",
  "requires_prescription",
  "variant_sku",
  "variant_name",
  "price_iqd",
  "stock_quantity",
  "low_stock_threshold",
  "is_active",
  "options_json",
] as const;
const REQUIRED_COLUMNS = ["product_sku", "variant_sku", "price_iqd"] as const;

export interface CsvRowError { row: number; column: string; code: string; message: string }

interface ImportRow {
  row: number;
  productSku: string;
  productName: string;
  description: string | null;
  categorySegments: string[] | null;
  requiresPrescription: boolean;
  variantSku: string;
  variantName: string;
  priceIqd: number;
  stockQuantity: number;
  lowStockThreshold: number;
  isActive: boolean;
  options: Record<string, unknown>;
}

interface ImportGroup { productSku: string; rows: ImportRow[] }

/** A category the commit must create: keyed by normalized name (unique per store). */
interface CategoryPlanNode { key: string; name: string; parentKey: string | null }

export interface ImportValidation {
  totalRows: number;
  newProducts: number;
  newVariants: number;
  errors: CsvRowError[];
  groups: ImportGroup[];
  categoryPlan: CategoryPlanNode[];
  /** normalized name -> existing category id (pre-existing nodes only). */
  existingCategoryIds: Map<string, string>;
}

function rowError(errors: CsvRowError[], row: number, column: string, code: string, message: string) {
  errors.push({ row, column, code, message });
}

function parseBooleanCell(value: string, fallback: boolean): boolean | null {
  const cell = value.trim().toLowerCase();
  if (cell === "") return fallback;
  if (cell === "true" || cell === "1") return true;
  if (cell === "false" || cell === "0") return false;
  return null;
}

function parseIntegerCell(value: string, fallback: number | null): number | null | undefined {
  const cell = value.trim();
  if (cell === "") return fallback; // null fallback = required
  if (!/^[0-9]+$/.test(cell)) return undefined;
  const parsed = Number(cell);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function decodeUtf8Strict(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new HttpError(422, "CSV_INVALID_ENCODING", "الملف ليس بترميز UTF-8 صالح. احفظ الملف بترميز UTF-8 (مع أو دون BOM) ثم أعِد المحاولة.");
  }
}

/**
 * Read-only validation shared by dry-run and commit: it parses, validates every
 * row, resolves category paths against the live tree (planning — not creating —
 * missing nodes), and checks every SKU against the store and the file itself.
 */
export async function validateProductsCsv(storeId: string, buffer: Buffer): Promise<ImportValidation> {
  const text = decodeUtf8Strict(buffer);
  let rawRows: string[][];
  try {
    // csvUnguardField reverses the export-side formula-injection guard so
    // export → import round-trips are lossless.
    rawRows = parseCsv(text).map((cells) => cells.map(csvUnguardField));
  } catch {
    throw new HttpError(422, "CSV_PARSE_ERROR", "تعذر قراءة الملف: حقل مقتبس غير مُغلق. راجِع علامات الاقتباس ثم أعِد المحاولة.");
  }
  if (!rawRows.length) throw new HttpError(422, "CSV_EMPTY", "الملف فارغ — لا صف عناوين ولا بيانات.");
  const header = rawRows[0]!.map((cell) => cell.trim());
  const errors: CsvRowError[] = [];
  const columnIndex = new Map<string, number>();
  header.forEach((name, index) => {
    if (!(PRODUCT_CSV_COLUMNS as readonly string[]).includes(name)) rowError(errors, 1, name || `#${index + 1}`, "CSV_UNKNOWN_COLUMN", `عمود غير معروف: «${name || index + 1}». الأعمدة المدعومة: ${PRODUCT_CSV_COLUMNS.join("، ")}.`);
    else if (columnIndex.has(name)) rowError(errors, 1, name, "CSV_DUPLICATE_COLUMN", `العمود «${name}» مكرر في صف العناوين.`);
    else columnIndex.set(name, index);
  });
  for (const required of REQUIRED_COLUMNS) {
    if (!columnIndex.has(required)) rowError(errors, 1, required, "CSV_COLUMN_MISSING", `العمود المطلوب «${required}» غير موجود في صف العناوين.`);
  }
  const dataRows = rawRows.slice(1);
  if (dataRows.length > CSV_MAX_ROWS) throw new HttpError(422, "CSV_TOO_LARGE", `الحد الأقصى ${CSV_MAX_ROWS} صف بيانات لكل ملف؛ قسّمي الملف ثم أعِد المحاولة.`);
  if (!dataRows.length) throw new HttpError(422, "CSV_EMPTY", "لا توجد صفوف بيانات بعد صف العناوين.");
  if (errors.length) return { totalRows: dataRows.length, newProducts: 0, newVariants: 0, errors, groups: [], categoryPlan: [], existingCategoryIds: new Map() };

  const cell = (row: string[], column: string) => {
    const index = columnIndex.get(column);
    return index === undefined ? "" : (row[index] ?? "");
  };

  // ---------- per-row validation + grouping by product_sku ----------
  const groups = new Map<string, ImportGroup>();
  dataRows.forEach((raw, dataIndex) => {
    const row = dataIndex + 2; // header is row 1
    const productSku = cell(raw, "product_sku").trim();
    if (!productSku || productSku.length > 80) { rowError(errors, row, "product_sku", "MISSING_VALUE", "product_sku مطلوب في كل صف (حتى 80 حرفاً)."); return; }
    const isFirstOfGroup = !groups.has(productSku);
    const productName = cell(raw, "product_name").trim();
    if (isFirstOfGroup && (!productName || productName.length > 240)) { rowError(errors, row, "product_name", "MISSING_VALUE", "product_name مطلوب في أول صف لكل منتج (حتى 240 حرفاً)."); return; }
    const description = cell(raw, "description").trim();
    if (description.length > 4000) { rowError(errors, row, "description", "TEXT_TOO_LONG", "description حتى 4000 حرف."); return; }
    let variantSku = cell(raw, "variant_sku").trim();
    if (!variantSku && isFirstOfGroup) variantSku = productSku; // the default variant inherits the product SKU
    if (!variantSku || variantSku.length > 80) { rowError(errors, row, "variant_sku", "MISSING_VALUE", "variant_sku مطلوب لكل متغير إضافي (حتى 80 حرفاً)."); return; }
    let variantName = cell(raw, "variant_name").trim();
    if (!variantName && isFirstOfGroup) variantName = productName;
    if (!variantName || variantName.length > 240) { rowError(errors, row, "variant_name", "MISSING_VALUE", "variant_name مطلوب لكل متغير إضافي (حتى 240 حرفاً)."); return; }
    const priceIqd = parseIntegerCell(cell(raw, "price_iqd"), null);
    if (priceIqd === null || priceIqd === undefined) { rowError(errors, row, "price_iqd", "INVALID_NUMBER", "price_iqd مطلوب ويجب أن يكون عدداً صحيحاً غير سالب."); return; }
    const stockQuantity = parseIntegerCell(cell(raw, "stock_quantity"), 0);
    if (stockQuantity === undefined || stockQuantity === null) { rowError(errors, row, "stock_quantity", "INVALID_NUMBER", "stock_quantity يجب أن يكون عدداً صحيحاً غير سالب."); return; }
    const lowStockThreshold = parseIntegerCell(cell(raw, "low_stock_threshold"), 0);
    if (lowStockThreshold === undefined || lowStockThreshold === null) { rowError(errors, row, "low_stock_threshold", "INVALID_NUMBER", "low_stock_threshold يجب أن يكون عدداً صحيحاً غير سالب."); return; }
    const requiresPrescription = parseBooleanCell(cell(raw, "requires_prescription"), false);
    if (requiresPrescription === null) { rowError(errors, row, "requires_prescription", "INVALID_BOOLEAN", "requires_prescription يقبل true أو false فقط."); return; }
    const isActive = parseBooleanCell(cell(raw, "is_active"), true);
    if (isActive === null) { rowError(errors, row, "is_active", "INVALID_BOOLEAN", "is_active يقبل true أو false فقط."); return; }
    let options: Record<string, unknown> = {};
    const optionsCell = cell(raw, "options_json").trim();
    if (optionsCell) {
      try {
        const parsed = JSON.parse(optionsCell);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        if (JSON.stringify(parsed).length > 2000) throw new Error("too long");
        options = parsed as Record<string, unknown>;
      } catch {
        rowError(errors, row, "options_json", "INVALID_OPTIONS", "options_json يجب أن يكون كائن JSON صالحاً (حتى 2000 حرف).");
        return;
      }
    }
    let categorySegments: string[] | null = null;
    const categoryCell = cell(raw, "category_path").trim();
    if (categoryCell && isFirstOfGroup) {
      const segments = categoryCell.split(">").map((segment) => segment.trim());
      if (segments.some((segment) => !segment || segment.length > 120)) { rowError(errors, row, "category_path", "INVALID_CATEGORY_PATH", "category_path بصيغة «أب > فرع > ورقة» وبأسماء غير فارغة (حتى 120 حرفاً)."); return; }
      if (segments.length > CATEGORY_MAX_DEPTH) { rowError(errors, row, "category_path", "CATEGORY_DEPTH_EXCEEDED", `الحد الأقصى لعمق شجرة التصنيفات هو ${CATEGORY_MAX_DEPTH} مستويات.`); return; }
      categorySegments = segments;
    }
    const record: ImportRow = { row, productSku, productName, description: description || null, categorySegments, requiresPrescription, variantSku, variantName, priceIqd, stockQuantity, lowStockThreshold, isActive, options };
    const group = groups.get(productSku);
    if (group) group.rows.push(record);
    else groups.set(productSku, { productSku, rows: [record] });
  });

  const groupList = Array.from(groups.values());

  // ---------- SKU uniqueness: within the file, then against the store ----------
  // The default variant is first inserted by the trigger with the PRODUCT sku
  // and only then renamed to the row's variant_sku, so a product_sku must be
  // free in the variants namespace too (transient collision otherwise).
  const claimed = new Map<string, number>();
  for (const group of groupList) {
    const first = group.rows[0]!;
    const priorClaim = claimed.get(group.productSku);
    if (priorClaim !== undefined) rowError(errors, first.row, "product_sku", "DUPLICATE_SKU_IN_FILE", `SKU «${group.productSku}» مكرر داخل الملف (ظهر أول مرة في الصف ${priorClaim}).`);
    else claimed.set(group.productSku, first.row);
    for (const record of group.rows) {
      if (record === first && record.variantSku === group.productSku) continue; // same entity as the product claim
      const variantClaim = claimed.get(record.variantSku);
      if (variantClaim !== undefined) rowError(errors, record.row, "variant_sku", "DUPLICATE_SKU_IN_FILE", `SKU «${record.variantSku}» مكرر داخل الملف (ظهر أول مرة في الصف ${variantClaim}).`);
      else claimed.set(record.variantSku, record.row);
    }
  }
  const fileSkus = Array.from(claimed.keys());
  // PG-2 — CRITICAL: LIVE only. Without it the importer refuses a perfectly
  // legitimate row with SKU_EXISTS because of a code held by a product sitting
  // in the trash bin, and the merchant cannot see the offending product on ANY
  // screen. The import is create-only (v1), so this is the whole risk surface.
  const [existingProducts, existingVariants] = await Promise.all([
    prisma.product.findMany({ where: { storeId, sku: { in: fileSkus }, ...LIVE }, select: { sku: true } }),
    prisma.productVariant.findMany({ where: { storeId, sku: { in: fileSkus }, ...LIVE }, select: { sku: true } }),
  ]);
  const taken = new Set([...existingProducts.map((product) => product.sku), ...existingVariants.map((variant) => variant.sku)]);
  for (const group of groupList) {
    const first = group.rows[0]!;
    if (taken.has(group.productSku)) rowError(errors, first.row, "product_sku", "SKU_EXISTS", `SKU «${group.productSku}» موجود بالفعل في المتجر — الاستيراد إنشاء فقط (v1) ولا يُحدّث الموجود.`);
    for (const record of group.rows) {
      if (record.variantSku !== group.productSku && taken.has(record.variantSku)) rowError(errors, record.row, "variant_sku", "SKU_EXISTS", `SKU «${record.variantSku}» موجود بالفعل في المتجر — الاستيراد إنشاء فقط (v1).`);
    }
  }

  // ---------- category paths: resolve existing nodes, plan the missing ones ----------
  // normalized_name is UNIQUE per store, so a path segment that already exists
  // under a DIFFERENT parent cannot be created again — that is a row conflict.
  // PG-2 LIVE: a trashed category must not be reused by an import; the row gets a
  // fresh live category with the same name, which the partial unique index allows.
  const existingCategories = await prisma.productCategory.findMany({ where: { storeId, ...LIVE }, select: { id: true, normalizedName: true, parentCategoryId: true } });
  const existingByNorm = new Map(existingCategories.map((category) => [category.normalizedName, category]));
  const existingCategoryIds = new Map(existingCategories.map((category) => [category.normalizedName, category.id]));
  const plannedByNorm = new Map<string, CategoryPlanNode>();
  const categoryPlan: CategoryPlanNode[] = [];
  for (const group of groupList) {
    const first = group.rows[0]!;
    if (!first.categorySegments) continue;
    let parentKey: string | null = null; // normalized name of the parent (existing or planned)
    let valid = true;
    for (const segment of first.categorySegments) {
      const key = normalizeName(segment);
      const existing = existingByNorm.get(key);
      if (existing) {
        const existingParentKey = existing.parentCategoryId ? existingCategories.find((category) => category.id === existing.parentCategoryId)?.normalizedName ?? null : null;
        if (existingParentKey !== parentKey) {
          rowError(errors, first.row, "category_path", "CATEGORY_PATH_CONFLICT", `التصنيف «${segment}» موجود بالفعل تحت أب مختلف — أسماء التصنيفات فريدة داخل المتجر.`);
          valid = false;
          break;
        }
      } else if (!plannedByNorm.has(key)) {
        const node: CategoryPlanNode = { key, name: segment, parentKey };
        plannedByNorm.set(key, node);
        categoryPlan.push(node);
      } else if (plannedByNorm.get(key)!.parentKey !== parentKey) {
        rowError(errors, first.row, "category_path", "CATEGORY_PATH_CONFLICT", `التصنيف «${segment}» يظهر في الملف تحت أبوين مختلفين.`);
        valid = false;
        break;
      }
      parentKey = key;
    }
    if (!valid) first.categorySegments = null;
  }

  return {
    totalRows: dataRows.length,
    newProducts: groupList.length,
    newVariants: groupList.reduce((sum, group) => sum + group.rows.length - 1, 0),
    errors,
    groups: groupList,
    categoryPlan,
    existingCategoryIds,
  };
}

/**
 * Commit path: ONE transaction, all-or-nothing. The caller must have verified
 * `validation.errors` is empty. The plan limit is asserted ONCE with the
 * new-products increment (decision §8.9) before any insert.
 */
export async function commitProductsImport(storeId: string, validation: ImportValidation) {
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.findUnique({ where: { id: storeId }, select: { merchantId: true } });
    if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
    await assertWithinPlanLimit(tx, store.merchantId, "max_products", validation.newProducts);
    const categoryIds = new Map(validation.existingCategoryIds);
    for (const node of validation.categoryPlan) {
      const created = await tx.productCategory.create({
        data: { storeId, name: node.name, normalizedName: node.key, parentCategoryId: node.parentKey ? categoryIds.get(node.parentKey)! : null },
        select: { id: true },
      });
      categoryIds.set(node.key, created.id);
    }
    let createdProducts = 0;
    let createdVariants = 0;
    for (const group of validation.groups) {
      const first = group.rows[0]!;
      const leafKey = first.categorySegments ? normalizeName(first.categorySegments[first.categorySegments.length - 1]!) : null;
      // Exactly the createProduct shape: the products_create_default_variant
      // trigger materializes the implicit default variant inside this
      // transaction; the first row's variant fields then update that variant
      // (the mirror trigger keeps the frozen product columns truthful).
      const product = await tx.product.create({
        data: {
          storeId,
          sku: group.productSku,
          name: first.productName,
          description: first.description,
          priceIqd: first.priceIqd,
          stockQuantity: first.stockQuantity,
          lowStockThreshold: first.lowStockThreshold,
          categoryId: leafKey ? categoryIds.get(leafKey)! : null,
          isActive: first.isActive,
          requiresPrescription: first.requiresPrescription,
        },
        include: { variants: true },
      });
      createdProducts += 1;
      const defaultVariant = product.variants.find((variant) => variant.isDefault)!;
      if (first.variantSku !== group.productSku || first.variantName !== first.productName || Object.keys(first.options).length) {
        await tx.productVariant.update({ where: { id: defaultVariant.id }, data: { sku: first.variantSku, name: first.variantName, options: first.options as Prisma.InputJsonObject } });
      }
      if (first.stockQuantity > 0) await tx.inventoryMovement.create({ data: { storeId, productId: product.id, variantId: defaultVariant.id, delta: first.stockQuantity, reason: "initial_stock" } });
      let position = 1;
      for (const record of group.rows.slice(1)) {
        const variant = await tx.productVariant.create({
          data: { storeId, productId: product.id, sku: record.variantSku, name: record.variantName, priceIqd: record.priceIqd, stockQuantity: record.stockQuantity, lowStockThreshold: record.lowStockThreshold, isDefault: false, isActive: record.isActive, position, options: record.options as Prisma.InputJsonObject },
        });
        position += 1;
        createdVariants += 1;
        if (record.stockQuantity > 0) await tx.inventoryMovement.create({ data: { storeId, productId: product.id, variantId: variant.id, delta: record.stockQuantity, reason: "initial_stock" } });
      }
    }
    return { createdProducts, createdVariants };
  }, { timeout: 120_000, maxWait: 15_000 });
}

const EXPORT_PAGE_SIZE = 200;

/**
 * Streaming products export: BOM first, then the exact import header, then one
 * row per variant (default first), cursor-paged so a large catalog never loads
 * at once. The output round-trips through the importer unchanged.
 */
export async function exportProductsCsv(storeId: string, write: (chunk: string) => void) {
  write(CSV_UTF8_BOM);
  write(csvLine(PRODUCT_CSV_COLUMNS));
  const categories = await prisma.productCategory.findMany({ where: { storeId, ...LIVE }, select: { id: true, name: true, parentCategoryId: true } });
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const pathOf = (categoryId: string) => {
    const parts: string[] = [];
    let current = categoriesById.get(categoryId);
    let guard = 0;
    while (current && guard < CATEGORY_MAX_DEPTH + 1) {
      parts.unshift(current.name);
      current = current.parentCategoryId ? categoriesById.get(current.parentCategoryId) : undefined;
      guard += 1;
    }
    return parts.join(" > ");
  };
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.product.findMany({
      // PG-2 LIVE: the export is the merchant's catalog, not his trash bin.
      where: { storeId, ...LIVE },
      include: { variants: { where: { deletedAt: null }, orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }] } },
      orderBy: { id: "asc" },
      take: EXPORT_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const product of page) {
      const categoryPath = product.categoryId ? pathOf(product.categoryId) : "";
      for (const variant of product.variants) {
        const options = variant.options && typeof variant.options === "object" && !Array.isArray(variant.options) ? (variant.options as Record<string, unknown>) : {};
        write(csvGuardedLine([
          product.sku,
          product.name,
          product.description ?? "",
          categoryPath,
          product.requiresPrescription,
          variant.sku,
          variant.name,
          variant.priceIqd,
          variant.stockQuantity,
          variant.lowStockThreshold,
          variant.isActive,
          Object.keys(options).length ? JSON.stringify(options) : "",
        ]));
      }
    }
    if (page.length < EXPORT_PAGE_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }
}

export const ORDER_CSV_COLUMNS = [
  "order_number",
  "status",
  "created_at",
  "customer_name",
  "customer_email",
  "recipient_phone",
  "shipping_governorate",
  "shipping_address_line1",
  "shipping_address_line2",
  "payment_status",
  // ق-246: the accountant reconciling this file against the courier's envelope
  // needs to know which courier, which waybill, and when it left.
  "courier_name",
  "tracking_number",
  "handed_over_at",
  "subtotal_iqd",
  "delivery_fee_iqd",
  "discount_iqd",
  "coupon_code",
  "loyalty_points_spent",
  "loyalty_discount_iqd",
  "platform_discount_iqd",
  "total_iqd",
  "product_name",
  "variant_name",
  "sku",
  "quantity",
  "unit_price_iqd",
  "line_total_iqd",
] as const;

function exportDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be an ISO date.`);
  return parsed;
}

/**
 * Streaming orders export: one row PER ORDER ITEM (variant-aware — the item's
 * variant name and SKU ride along) with the order columns repeated, filtered by
 * the same from/to/status semantics as the merchant orders list.
 */
export async function exportOrdersCsv(storeId: string, query: Record<string, unknown>, write: (chunk: string) => void) {
  const from = exportDate(query.from, "from");
  const to = exportDate(query.to, "to");
  let status: string | undefined;
  if (query.status !== undefined && query.status !== "") {
    if (typeof query.status !== "string" || !(ORDER_STATUSES as readonly string[]).includes(query.status)) {
      throw new HttpError(422, "INVALID_ORDER_STATUS_FILTER", "Order status is not supported.");
    }
    status = query.status;
  }
  write(CSV_UTF8_BOM);
  write(csvLine(ORDER_CSV_COLUMNS));
  let cursor: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const where: Prisma.StoreOrderWhereInput = {
      storeId,
      ...(status ? { status } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      // 20-3: this was the FOURTEENTH hand-rolled keyset — 20-2 converted the
      // thirteen that mint a client-facing `nextCursor`, and this internal
      // export loop was not one of them, so `list:guard` never looked at it.
      //
      // It is also the worst possible place for the un-bounded disjunction. A
      // list page is read once; an export walks EVERY page, and a top-level OR
      // cannot be an index starting point, so page k re-walks and discards the
      // k×200 rows before it. That is quadratic, and it measures like it — one
      // store's orders, whole walk, same `store_orders_store_created_id_idx`:
      //
      //     5,000 rows      63 ms  ›   39 ms   (1.6x)
      //    20,000 rows     320 ms  ›  162 ms   (2.0x)
      //    50,000 rows   1,185 ms  ›  353 ms   (3.4x)
      //   100,000 rows   4,088 ms  ›  635 ms   (6.4x)
      //
      // The ratio climbing with the row count IS the quadratic term; the
      // bounded form's own line is linear.
      ...keysetWhere("createdAt", "desc", cursor && { value: cursor.createdAt.toISOString(), id: cursor.id }),
    };
    const page = await prisma.storeOrder.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_PAGE_SIZE,
      select: {
        id: true, orderNumber: true, status: true, createdAt: true, customerName: true, customerEmail: true, recipientPhone: true,
        shippingGovernorate: true, shippingAddressLine1: true, shippingAddressLine2: true, paymentStatus: true,
        courierName: true, trackingNumber: true, handedOverAt: true,
        subtotalIqd: true, deliveryFeeIqd: true, discountIqd: true, couponCode: true, totalIqd: true,
        // ق-187: without these the exported total is short by whatever the
        // shopper redeemed, and the accountant reconciling the file has no
        // column that explains the difference.
        loyaltyPointsSpent: true, loyaltyDiscountIqd: true, platformDiscountIqd: true,
        items: { select: { productName: true, variantName: true, sku: true, quantity: true, unitPriceIqd: true, lineTotalIqd: true }, orderBy: { createdAt: "asc" } },
      },
    });
    for (const order of page) {
      for (const item of order.items) {
        write(csvGuardedLine([
          order.orderNumber,
          order.status,
          order.createdAt.toISOString(),
          order.customerName,
          order.customerEmail ?? "",
          order.recipientPhone ?? "",
          order.shippingGovernorate ?? "",
          order.shippingAddressLine1 ?? "",
          order.shippingAddressLine2 ?? "",
          order.paymentStatus,
          order.courierName ?? "",
          order.trackingNumber ?? "",
          order.handedOverAt?.toISOString() ?? "",
          order.subtotalIqd,
          order.deliveryFeeIqd,
          order.discountIqd,
          order.couponCode ?? "",
          order.loyaltyPointsSpent,
          order.loyaltyDiscountIqd,
          order.platformDiscountIqd,
          order.totalIqd,
          item.productName,
          item.variantName ?? "",
          item.sku ?? "",
          item.quantity,
          item.unitPriceIqd,
          item.lineTotalIqd,
        ]));
      }
    }
    if (page.length < EXPORT_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}

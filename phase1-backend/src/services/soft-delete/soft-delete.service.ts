/**
 * PG-2 — soft delete, restore, and the trash bin (plan §1).
 *
 * This is the ONLY module allowed to write `deletedAt` on any model;
 * `tests/pg2.no-deleted-leak.test.ts` fails CI on a write anywhere else.
 *
 * Two rules shape everything below.
 *
 * 1. «deleted ⇒ is_active = false» is a database CHECK, not a convention. Every
 *    write here therefore moves `deletedAt` and `isActive` together, and the
 *    whole public storefront — including the raw-SQL checkout lock — is closed
 *    with zero changes on the payment path.
 * 2. `deletedEventId` points at the audit event that killed the row, so a
 *    restore revives ONLY what died in the SAME event. A variant the merchant
 *    deleted on Monday is not resurrected on Thursday with its product.
 *
 * The unique constraints are PARTIAL (`WHERE deleted_at IS NULL`), so deleting
 * frees the code immediately and it is the RESTORE that negotiates: a taken SKU
 * / category name / coupon code / team seat answers 409 naming the live holder
 * and the same endpoint accepts an override in the same call. There is never a
 * silent rename — a SKU is the merchant's key (labels, supplier, CSV).
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../../auth/auth.errors.js";
import { resolvePermissionSet, type PermissionCode } from "../../auth/staff-permissions.js";
import { prisma } from "../../db/prisma.js";
import { encodeListCursor, keysetWhere, parseListLimit, readListCursor } from "../list-page.js";
import { assertDemoWritable } from "../../demo/demo-mode.js";
import { assertWithinPlanLimit } from "../entitlement.service.js";
import { recordAuditEvent, type AuditActor } from "./audit-log.service.js";
import { LIVE, TRASHED, TRASH_ENTITY_TYPES, TRASH_RETENTION_DAYS, purgeAtFor, type TrashEntityType } from "./constants.js";
import { reasonForBlockingTable } from "./fk-violations.js";

export interface SoftDeleteResult {
  id: string;
  entityType: TrashEntityType;
  deletedAt: Date;
  /** When the purge sweep becomes eligible to hard-delete this row. */
  purgeAt: Date;
  /**
   * ع-1 — TRUE when a restricting foreign key already holds this row, so the
   * purge will refuse it on day 31 and it stays in the bin for good (ق-97).
   *
   * The undo bar MUST branch on this. Without it the merchant reads «يُحذف
   * نهائياً بعد ٣٠ يوماً» one second after the confirmation sheet promised him
   * the opposite about the very same row — a sentence that is not merely
   * inconsistent but false, and false in the direction that pushes him back to
   * hiding products instead of removing them, which is the behaviour this whole
   * feature exists to end.
   */
  keptForRecords: boolean;
  /** The merchant-facing «محفوظ لسجلاتك» reason, or null when it is not kept. */
  keptReason: string | null;
}

export interface RestoreOverrides {
  sku?: unknown;
  variantSkus?: unknown;
  categoryId?: unknown;
  code?: unknown;
}

export function assertTrashEntityType(value: unknown): TrashEntityType {
  if (typeof value !== "string" || !TRASH_ENTITY_TYPES.includes(value as TrashEntityType)) {
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested trash entity type does not exist.");
  }
  return value as TrashEntityType;
}

function overrideText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(422, "INVALID_INPUT", `${field} must be a non-empty string within ${maxLength} characters.`);
  }
  return value.trim();
}

type SkuConflict = { scope: "product" | "variant"; variantId?: string; sku: string; liveId: string; liveName: string };

function skuConflictError(conflicts: SkuConflict[]): HttpError {
  const first = conflicts[0]!;
  return new HttpError(
    409,
    "SKU_TAKEN_BY_ACTIVE_PRODUCT",
    `الرمز «${first.sku}» يحمله الآن منتج آخر: «${first.liveName}». اختر رمزاً جديداً للمنتج المستعاد.`,
    { conflicts },
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function softDelete(entityType: TrashEntityType, storeId: string, id: string, actor: AuditActor): Promise<SoftDeleteResult> {
  const outcome = entityType === "product" ? await softDeleteProduct(storeId, id, actor)
    : entityType === "product_category" ? await softDeleteCategory(storeId, id, actor)
    : entityType === "coupon" ? await softDeleteCoupon(storeId, id, actor)
    : await softDeleteMembership(storeId, id, actor);
  return withKeptPrediction(storeId, outcome);
}

function result(entityType: TrashEntityType, id: string, deletedAt: Date): SoftDeleteResult {
  return { id, entityType, deletedAt, purgeAt: purgeAtFor(deletedAt), keptForRecords: false, keptReason: null };
}

/**
 * ع-1 — answers «will this row ever actually leave?» for the row just deleted,
 * using the SAME prediction the bin renders, so the undo bar and the bin can
 * never tell the merchant two different stories about one row.
 *
 * Runs after the transaction commits: it is a read, and a storage-shaped delay
 * here must not hold write locks on the row the merchant just removed.
 */
async function withKeptPrediction(storeId: string, outcome: SoftDeleteResult): Promise<SoftDeleteResult> {
  const kept = await keptForRecordsIds(outcome.entityType, storeId, [outcome.id]);
  const reason = kept.get(outcome.id);
  return reason ? { ...outcome, keptForRecords: true, keptReason: reason } : outcome;
}

async function softDeleteProduct(storeId: string, id: string, actor: AuditActor): Promise<SoftDeleteResult> {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id, storeId, ...LIVE },
      include: { variants: { where: LIVE, orderBy: [{ isDefault: "desc" }, { position: "asc" }] }, images: { select: { id: true } } },
    });
    if (!product) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product was not found in this store.");

    // The two guards that survive owner decision (ب): both protect an operation
    // happening RIGHT NOW. «Sold two months ago» is not one of them — a product
    // referenced by an order enters the trash like any other and is stopped at
    // PURGE time by the foreign-key wall, where it keeps the «محفوظ لسجلاتك» badge.
    //
    // HONEST LIMIT: being inside this transaction does NOT close the window.
    // Under READ COMMITTED, `addCartItem` reads the variant outside its own
    // transaction and can insert a cart row for a product deleted here a moment
    // later. The customer then sees an unavailable line and checkout answers 422
    // PRODUCT_UNAVAILABLE — no sale, no stock move, no money — and the row waits
    // in the trash carrying the «موجود في سلة زبون» badge. Closing it properly is
    // a BEFORE INSERT trigger on cart_items (backlog PG-2/ع-5), not a comment.
    const inLiveCart = await tx.cartItem.count({ where: { productId: product.id, storeId, cart: { status: "active" } } });
    if (inLiveCart > 0) {
      throw new HttpError(409, "PRODUCT_IN_ACTIVE_CART", "هذا المنتج موجود الآن في سلة زبون نشطة — لا يمكن إزالته أثناء عملية شراء جارية.", { hint: "deactivate" });
    }
    const activeReservations = await tx.inventoryReservation.count({ where: { productId: product.id, storeId, status: "active" } });
    if (activeReservations > 0) {
      throw new HttpError(409, "PRODUCT_HAS_ACTIVE_RESERVATION", "هذا المنتج عليه حجز مخزون نشط لطلب قائم — لا يمكن إزالته الآن.", { hint: "deactivate" });
    }

    const eventId = await recordAuditEvent(tx, {
      storeId,
      entityType: "product",
      entityId: product.id,
      entityLabel: product.name,
      entitySecondary: product.sku,
      action: "soft_deleted",
      actor,
      metadata: {
        sku: product.sku,
        name: product.name,
        description: product.description,
        priceIqd: product.priceIqd,
        stockQuantity: product.stockQuantity,
        categoryId: product.categoryId,
        isActive: product.isActive,
        requiresPrescription: product.requiresPrescription,
        imageCount: product.images.length,
        variants: product.variants.map((variant) => ({ id: variant.id, sku: variant.sku, name: variant.name, isDefault: variant.isDefault, isActive: variant.isActive })),
      },
    });

    const deletedAt = new Date();
    await tx.product.update({
      where: { id: product.id },
      data: { deletedAt, deletedEventId: eventId, deletedWasActive: product.isActive, isActive: false, purgeBlockedAt: null, purgeBlockReason: null },
    });
    // Per-row, not updateMany: each variant carries its OWN `deletedWasActive`
    // snapshot, which is what lets a disabled variant come back disabled.
    for (const variant of product.variants) {
      await tx.productVariant.update({
        where: { id: variant.id },
        data: { deletedAt, deletedEventId: eventId, deletedWasActive: variant.isActive, isActive: false },
      });
    }

    // The product is the ONLY one of the four that is emptied out of carts
    // (plan §1.و exception 1). Live carts were refused above, so what is left
    // here belongs to expired / merged / converted carts: rows nobody can buy
    // from, which would otherwise block the purge forever. The version bump
    // keeps any client holding that cart honest.
    const staleItems = await tx.cartItem.findMany({ where: { productId: product.id, storeId }, select: { id: true, cartId: true } });
    if (staleItems.length) {
      await tx.cartItem.deleteMany({ where: { productId: product.id, storeId } });
      // Array.from, not a bare for…of over the Set: the ROOT tsconfig targets
      // ES5 and `pnpm check` compiles this file too.
      for (const cartId of Array.from(new Set(staleItems.map((item) => item.cartId)))) {
        await tx.shoppingCart.update({ where: { id: cartId }, data: { version: { increment: 1 } } });
      }
    }
    return result("product", product.id, deletedAt);
  });
}

async function softDeleteCategory(storeId: string, id: string, actor: AuditActor): Promise<SoftDeleteResult> {
  return prisma.$transaction(async (tx) => {
    const category = await tx.productCategory.findFirst({ where: { id, storeId, ...LIVE } });
    if (!category) throw new HttpError(404, "CATEGORY_NOT_FOUND", "The requested category was not found in this store.");
    const childCount = await tx.productCategory.count({ where: { parentCategoryId: category.id, storeId, ...LIVE } });
    if (childCount > 0) throw new HttpError(409, "CATEGORY_HAS_CHILDREN", "لا يمكن حذف تصنيف يحتوي على تصنيفات فرعية. احذف الفروع أو انقلها أولاً.");
    // LIVE products only (plan §1.و exception 2): counting trashed ones would
    // leave the merchant unable, for 30 days, to delete a category he sees empty
    // — the very «looks like a bug» pattern decision (أ) rejected.
    const productCount = await tx.product.count({ where: { categoryId: category.id, storeId, ...LIVE } });
    if (productCount > 0) throw new HttpError(409, "CATEGORY_IN_USE", "لا يمكن حذف تصنيف ما زالت له منتجات. انقل منتجاته إلى تصنيف آخر أو احذفها أولاً.");

    const eventId = await recordAuditEvent(tx, {
      storeId,
      entityType: "product_category",
      entityId: category.id,
      entityLabel: category.name,
      action: "soft_deleted",
      actor,
      metadata: { name: category.name, normalizedName: category.normalizedName, parentCategoryId: category.parentCategoryId },
    });
    const deletedAt = new Date();
    await tx.productCategory.update({ where: { id: category.id }, data: { deletedAt, deletedEventId: eventId, purgeBlockedAt: null, purgeBlockReason: null } });
    return result("product_category", category.id, deletedAt);
  });
}

async function softDeleteCoupon(storeId: string, id: string, actor: AuditActor): Promise<SoftDeleteResult> {
  return prisma.$transaction(async (tx) => {
    const coupon = await tx.coupon.findFirst({ where: { id, storeId, ...LIVE } });
    if (!coupon) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested coupon was not found in this store.");
    const eventId = await recordAuditEvent(tx, {
      storeId,
      entityType: "coupon",
      entityId: coupon.id,
      entityLabel: coupon.code,
      action: "soft_deleted",
      actor,
      metadata: { code: coupon.code, kind: coupon.kind, isActive: coupon.isActive, startsAt: coupon.startsAt, endsAt: coupon.endsAt },
    });
    const deletedAt = new Date();
    await tx.coupon.update({
      where: { id: coupon.id },
      data: { deletedAt, deletedEventId: eventId, deletedWasActive: coupon.isActive, isActive: false, purgeBlockedAt: null, purgeBlockReason: null },
    });
    return result("coupon", coupon.id, deletedAt);
  });
}

async function softDeleteMembership(storeId: string, id: string, actor: AuditActor): Promise<SoftDeleteResult> {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.storeStaffMembership.findFirst({
      where: { id, storeId, ...LIVE },
      include: { staff: { select: { email: true, displayName: true } }, permissionOverrides: { select: { permissionCode: true, effect: true } } },
    });
    if (!membership) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested team membership was not found in this store.");
    assertDemoWritable("demo_staff", membership.staff.email);

    // New guard (plan §1.و): never remove the LAST membership that can still
    // manage the team — that is how a store locks itself out of its own roster.
    if (membership.isActive && resolvePermissionSet(membership.roleCode, membership.permissionOverrides).has("team.manage")) {
      const survivors = await tx.storeStaffMembership.findMany({
        where: { storeId, isActive: true, id: { not: membership.id }, ...LIVE },
        select: { roleCode: true, permissionOverrides: { select: { permissionCode: true, effect: true } } },
      });
      const stillManaged = survivors.some((other) => resolvePermissionSet(other.roleCode, other.permissionOverrides).has("team.manage"));
      if (!stillManaged) {
        throw new HttpError(409, "LAST_TEAM_MANAGER", "لا يمكن إزالة آخر عضوية تملك صلاحية إدارة الفريق — أضف مديراً آخر أولاً.");
      }
    }

    const eventId = await recordAuditEvent(tx, {
      storeId,
      entityType: "staff_membership",
      entityId: membership.id,
      entityLabel: membership.staff.displayName,
      entitySecondary: membership.staff.email,
      action: "soft_deleted",
      actor,
      metadata: {
        staffId: membership.staffId,
        email: membership.staff.email,
        roleCode: membership.roleCode,
        isActive: membership.isActive,
        overrides: membership.permissionOverrides,
      },
    });
    const deletedAt = new Date();
    await tx.storeStaffMembership.update({
      where: { id: membership.id },
      data: {
        deletedAt,
        deletedEventId: eventId,
        deletedWasActive: membership.isActive,
        isActive: false,
        permissionVersion: { increment: 1 },
        purgeBlockedAt: null,
        purgeBlockReason: null,
      },
    });
    // D14-07: removal takes effect immediately — open sessions die now.
    await tx.staffSession.updateMany({ where: { membershipId: membership.id, revokedAt: null }, data: { revokedAt: deletedAt } });
    // ق-227 — THE LAST MEMBERSHIP RELEASES THE ADDRESS.
    //
    // A store removes a MEMBERSHIP and never the person, which is right: he may
    // work in other shops. But a person NO shop employs was still holding his
    // email hostage across all four identities — he could not become a merchant,
    // could not be re-added anywhere, and the victim of a merchant who typed a
    // stranger's address could never register on Codiq at all. That is the hole
    // ق-143 closed for platform staff; this is the same close, one table over.
    //
    // Scoped across EVERY store, not this one: an employee of two shops keeps his
    // identity when the first lets him go. And his remaining sessions go with the
    // identity — an account nobody employs must not stay signed in anywhere.
    const stillEmployed = await tx.storeStaffMembership.findFirst({
      where: { staffId: membership.staffId, deletedAt: null, id: { not: membership.id } },
      select: { id: true },
    });
    if (!stillEmployed) {
      await tx.staff.update({ where: { id: membership.staffId }, data: { deletedAt } });
      await tx.staffSession.updateMany({ where: { staffId: membership.staffId, revokedAt: null }, data: { revokedAt: deletedAt } });
    }
    return result("staff_membership", membership.id, deletedAt);
  });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export async function restore(entityType: TrashEntityType, storeId: string, id: string, actor: AuditActor, overrides: RestoreOverrides = {}) {
  if (entityType === "product") return restoreProduct(storeId, id, actor, overrides);
  if (entityType === "product_category") return restoreCategory(storeId, id, actor);
  if (entityType === "coupon") return restoreCoupon(storeId, id, actor, overrides);
  return restoreMembership(storeId, id, actor);
}

const CLEAR_DELETE_STAMP = { deletedAt: null, deletedEventId: null, purgeBlockedAt: null, purgeBlockReason: null } as const;

type TrashTable = "products" | "product_categories" | "coupons" | "store_staff_memberships";

/**
 * Re-reads the trashed row `FOR UPDATE` inside the restore transaction.
 *
 * The purge sweep now deletes with `deleted_at IS NOT NULL` in its own WHERE, so
 * the two writers SERIALIZE on this row instead of racing: whoever takes the lock
 * first wins, and the loser re-evaluates its predicate under READ COMMITTED and
 * finds nothing. Without it the merchant could be answered «restored» and watch
 * the sweep hard-delete the same row seconds later — variants, images, S3 bytes
 * and all. That is the one unrecoverable outcome this feature can produce, and a
 * plain `findFirst` cannot prevent it because a plain SELECT takes no lock.
 *
 * `table` is a closed union, never caller input, so `Prisma.raw` is safe here.
 */
async function lockTrashedRow(tx: Prisma.TransactionClient, table: TrashTable, id: string, storeId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM ${Prisma.raw(table)}
    WHERE id = ${id}::uuid AND store_id = ${storeId}::uuid AND deleted_at IS NOT NULL
    FOR UPDATE`);
  return rows.length > 0;
}

/** The store's owner, needed to re-charge a restore against the plan (ح-1). */
async function merchantIdForStore(tx: Prisma.TransactionClient, storeId: string): Promise<string> {
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { merchantId: true } });
  if (!store) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested store was not found.");
  return store.merchantId;
}

/**
 * Revives the trashed ancestor chain of a category so a restored product lands
 * back in a REAL tree, not under a parent that is itself in the bin. Returns
 * the ids revived; throws 409 CATEGORY_NAME_TAKEN naming the live holder.
 */
async function reviveCategoryChain(tx: Prisma.TransactionClient, storeId: string, categoryId: string, actor: AuditActor): Promise<string[]> {
  const revived: string[] = [];
  let current: string | null = categoryId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const category: { id: string; name: string; normalizedName: string; parentCategoryId: string | null; deletedAt: Date | null } | null =
      await tx.productCategory.findFirst({ where: { id: current, storeId }, select: { id: true, name: true, normalizedName: true, parentCategoryId: true, deletedAt: true } });
    if (!category) break;
    if (category.deletedAt) {
      const holder = await tx.productCategory.findFirst({ where: { storeId, normalizedName: category.normalizedName, ...LIVE }, select: { id: true, name: true } });
      if (holder) {
        throw new HttpError(
          409,
          "CATEGORY_NAME_TAKEN",
          `اسم التصنيف «${category.name}» صار الآن لتصنيف حيّ آخر. اختر تصنيفاً بديلاً للمنتج المستعاد أو أعده بلا تصنيف.`,
          { conflicts: [{ scope: "category", name: category.name, liveId: holder.id, liveName: holder.name }] },
        );
      }
      // Same lock as the entry point: an ancestor revived here is an expired
      // purge candidate in its own right.
      if (!(await lockTrashedRow(tx, "product_categories", category.id, storeId))) break;
      await tx.productCategory.update({ where: { id: category.id }, data: CLEAR_DELETE_STAMP });
      await recordAuditEvent(tx, {
        storeId,
        entityType: "product_category",
        entityId: category.id,
        entityLabel: category.name,
        action: "restored",
        actor,
        metadata: { reason: "revived_with_product" },
      });
      revived.push(category.id);
    }
    current = category.parentCategoryId;
  }
  return revived;
}

async function restoreProduct(storeId: string, id: string, actor: AuditActor, overrides: RestoreOverrides) {
  const requestedSku = overrideText(overrides.sku, "sku", 80);
  const requestedCategoryRaw = overrides.categoryId;
  const variantSkuOverrides = new Map<string, string>();
  if (overrides.variantSkus !== undefined) {
    if (typeof overrides.variantSkus !== "object" || overrides.variantSkus === null || Array.isArray(overrides.variantSkus)) {
      throw new HttpError(422, "INVALID_INPUT", "variantSkus must be an object keyed by variant id.");
    }
    for (const [variantId, value] of Object.entries(overrides.variantSkus as Record<string, unknown>)) {
      variantSkuOverrides.set(variantId, overrideText(value, `variantSkus.${variantId}`, 80)!);
    }
  }

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id, storeId, ...TRASHED } });
    if (!product) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product was not found in the trash of this store.");
    if (!(await lockTrashedRow(tx, "products", product.id, storeId))) {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested product was not found in the trash of this store.");
    }
    // ح-1: deleting RELEASES the quota (a merchant at his cap must be able to
    // replace a product), so restoring must RE-SPEND it. Without this line the
    // ladder «delete 50 → create 50 → restore the 50» parks a free-plan store at
    // 150 products for good, and nothing re-checks it afterwards.
    await assertWithinPlanLimit(tx, await merchantIdForStore(tx, storeId), "max_products", 1, "أو احذف منتجاً آخر لاستعادة هذا المنتج");
    // Only the variants that died in the SAME event come back — this is the
    // structural half of the promise, not a convention (plan §1.هـ).
    const variants = await tx.productVariant.findMany({ where: { productId: product.id, storeId, ...TRASHED, deletedEventId: product.deletedEventId }, orderBy: [{ isDefault: "desc" }, { position: "asc" }] });

    const conflicts: SkuConflict[] = [];
    const nextSku = requestedSku ?? product.sku;
    const productHolder = await tx.product.findFirst({ where: { storeId, sku: nextSku, ...LIVE }, select: { id: true, name: true } });
    if (productHolder) conflicts.push({ scope: "product", sku: nextSku, liveId: productHolder.id, liveName: productHolder.name });
    const nextVariantSkus = new Map<string, string>();
    for (const variant of variants) {
      const sku = variantSkuOverrides.get(variant.id) ?? variant.sku;
      nextVariantSkus.set(variant.id, sku);
      const holder = await tx.productVariant.findFirst({ where: { storeId, sku, ...LIVE }, select: { id: true, name: true } });
      if (holder) conflicts.push({ scope: "variant", variantId: variant.id, sku, liveId: holder.id, liveName: holder.name });
    }
    if (conflicts.length) throw skuConflictError(conflicts);

    // Category: an explicit override wins; otherwise the product's own category
    // (and every trashed ancestor of it) is revived in THIS transaction.
    let categoryId: string | null = product.categoryId;
    if (requestedCategoryRaw !== undefined) {
      if (requestedCategoryRaw === null || requestedCategoryRaw === "") categoryId = null;
      else {
        if (typeof requestedCategoryRaw !== "string") throw new HttpError(422, "INVALID_INPUT", "categoryId is invalid.");
        const target = await tx.productCategory.findFirst({ where: { id: requestedCategoryRaw, storeId, ...LIVE }, select: { id: true } });
        if (!target) throw new HttpError(404, "CATEGORY_NOT_FOUND", "The requested category was not found in this store.");
        categoryId = target.id;
      }
    } else if (categoryId) {
      await reviveCategoryChain(tx, storeId, categoryId, actor);
    }

    for (const variant of variants) {
      await tx.productVariant.update({
        where: { id: variant.id },
        data: { deletedAt: null, deletedEventId: null, deletedWasActive: null, isActive: variant.deletedWasActive ?? false, sku: nextVariantSkus.get(variant.id)! },
      });
    }
    await tx.product.update({
      where: { id: product.id },
      data: { ...CLEAR_DELETE_STAMP, deletedWasActive: null, isActive: product.deletedWasActive ?? false, sku: nextSku, categoryId },
    });
    await recordAuditEvent(tx, {
      storeId,
      entityType: "product",
      entityId: product.id,
      entityLabel: product.name,
      entitySecondary: nextSku,
      action: "restored",
      actor,
      metadata: { sku: nextSku, previousSku: product.sku, categoryId, restoredVariants: variants.length },
    });
    return { id: product.id, entityType: "product" as const, sku: nextSku, categoryId, restoredVariants: variants.length };
  });
}

async function restoreCategory(storeId: string, id: string, actor: AuditActor) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.productCategory.findFirst({ where: { id, storeId, ...TRASHED } });
    if (!category) throw new HttpError(404, "CATEGORY_NOT_FOUND", "The requested category was not found in the trash of this store.");
    if (!(await lockTrashedRow(tx, "product_categories", category.id, storeId))) {
      throw new HttpError(404, "CATEGORY_NOT_FOUND", "The requested category was not found in the trash of this store.");
    }
    await reviveCategoryChain(tx, storeId, category.id, actor);
    return { id: category.id, entityType: "product_category" as const, name: category.name };
  });
}

async function restoreCoupon(storeId: string, id: string, actor: AuditActor, overrides: RestoreOverrides) {
  const requestedCode = overrideText(overrides.code, "code", 40);
  return prisma.$transaction(async (tx) => {
    const coupon = await tx.coupon.findFirst({ where: { id, storeId, ...TRASHED } });
    if (!coupon) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested coupon was not found in the trash of this store.");
    if (!(await lockTrashedRow(tx, "coupons", coupon.id, storeId))) {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested coupon was not found in the trash of this store.");
    }
    const code = requestedCode ?? coupon.code;
    const codeNormalized = code.trim().toUpperCase();
    const holder = await tx.coupon.findFirst({ where: { storeId, codeNormalized, ...LIVE }, select: { id: true, code: true } });
    if (holder) {
      throw new HttpError(
        409,
        "COUPON_CODE_TAKEN",
        `الرمز «${code}» يحمله الآن كوبون حيّ آخر. اختر رمزاً جديداً للكوبون المستعاد.`,
        { conflicts: [{ scope: "coupon", code, liveId: holder.id, liveName: holder.code }] },
      );
    }
    // The validity window is NOT extended (plan §1.و exception 3): a coupon whose
    // endsAt has passed comes back EXPIRED. We do not back-date a commercial offer.
    await tx.coupon.update({
      where: { id: coupon.id },
      data: { ...CLEAR_DELETE_STAMP, deletedWasActive: null, isActive: coupon.deletedWasActive ?? false, code, codeNormalized },
    });
    await recordAuditEvent(tx, {
      storeId,
      entityType: "coupon",
      entityId: coupon.id,
      entityLabel: code,
      action: "restored",
      actor,
      metadata: { code, previousCode: coupon.code, endsAt: coupon.endsAt },
    });
    return { id: coupon.id, entityType: "coupon" as const, code, expired: Boolean(coupon.endsAt && coupon.endsAt < new Date()) };
  });
}

async function restoreMembership(storeId: string, id: string, actor: AuditActor) {
  return prisma.$transaction(async (tx) => {
    const membership = await tx.storeStaffMembership.findFirst({
      where: { id, storeId, ...TRASHED },
      include: { staff: { select: { email: true, displayName: true } } },
    });
    if (!membership) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested team membership was not found in the trash of this store.");
    if (!(await lockTrashedRow(tx, "store_staff_memberships", membership.id, storeId))) {
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested team membership was not found in the trash of this store.");
    }
    // ح-1 on the seat count — but ONLY when the seat comes back OCCUPIED.
    // `merchantUsage.max_staff` counts `isActive` rows, so a membership that was
    // suspended before it was removed returns suspended and spends nothing;
    // refusing that restore would be a limit the merchant never crossed.
    if (membership.deletedWasActive) {
      await assertWithinPlanLimit(tx, await merchantIdForStore(tx, storeId), "max_staff", 1, "أو أوقف موظفاً آخر لإعادة هذه العضوية");
    }
    // The nicer special case (plan §1.أ): if the person is already back on the
    // team, the merchant HAS what he wanted — say so and link the live seat.
    const holder = await tx.storeStaffMembership.findFirst({ where: { storeId, staffId: membership.staffId, ...LIVE }, select: { id: true } });
    if (holder) {
      throw new HttpError(
        409,
        "STAFF_ALREADY_ON_TEAM",
        `${membership.staff.displayName} عاد إلى الفريق بالفعل — لا حاجة لاستعادة العضوية القديمة.`,
        { conflicts: [{ scope: "staff_membership", email: membership.staff.email, liveId: holder.id, liveName: membership.staff.displayName }] },
      );
    }
    // ق-227: the identity comes back with the seat — unless the address it holds
    // was claimed by someone else while nobody employed him. Refused by NAME
    // rather than by a 23505 from three layers down: the merchant is restoring a
    // seat and deserves to be told which person he cannot restore, and why.
    const staffRow = await tx.staff.findUniqueOrThrow({ where: { id: membership.staffId }, select: { deletedAt: true, email: true } });
    if (staffRow.deletedAt) {
      const claimedElsewhere = await Promise.all([
        tx.staff.findFirst({ where: { email: staffRow.email, deletedAt: null }, select: { id: true } }),
        tx.merchant.findFirst({ where: { email: staffRow.email }, select: { id: true } }),
        tx.platformOwner.findFirst({ where: { email: staffRow.email }, select: { id: true } }),
        tx.platformStaff.findFirst({ where: { email: staffRow.email, deletedAt: null }, select: { id: true } }),
      ]);
      if (claimedElsewhere.some(Boolean)) {
        throw new HttpError(
          409,
          "STAFF_EMAIL_TAKEN_SINCE",
          `${membership.staff.displayName} لم يعد يملك هذا البريد — سُجّل لحساب آخر بعد إزالته. أضِفه من جديد ببريد يخصّه.`,
          { conflicts: [{ scope: "staff", email: staffRow.email }] },
        );
      }
      await tx.staff.update({ where: { id: membership.staffId }, data: { deletedAt: null } });
    }
    await tx.storeStaffMembership.update({
      where: { id: membership.id },
      data: { ...CLEAR_DELETE_STAMP, deletedWasActive: null, isActive: membership.deletedWasActive ?? false, permissionVersion: { increment: 1 } },
    });
    // Overrides survive (they were never deleted); SESSIONS do not — the person
    // signs in again. Reviving a revoked session would resurrect a credential.
    await recordAuditEvent(tx, {
      storeId,
      entityType: "staff_membership",
      entityId: membership.id,
      entityLabel: membership.staff.displayName,
      entitySecondary: membership.staff.email,
      action: "restored",
      actor,
      metadata: { staffId: membership.staffId, roleCode: membership.roleCode },
    });
    return { id: membership.id, entityType: "staff_membership" as const, email: membership.staff.email };
  });
}

// ---------------------------------------------------------------------------
// Trash listing
// ---------------------------------------------------------------------------

export interface TrashRow {
  id: string;
  entityType: TrashEntityType;
  label: string;
  secondary: string | null;
  deletedAt: Date;
  purgeAt: Date;
  deletedBy: string | null;
  purgeBlockedAt: Date | null;
  purgeBlockReason: string | null;
  /**
   * True when a restricting foreign key ALREADY points at this row, so the purge
   * sweep is going to refuse it — known on day one instead of on day 31.
   *
   * Without this the bin would promise «يُحذف نهائياً بعد ٣٠ يوماً» for the whole
   * retention window on exactly the rows that are never going to be deleted, one
   * screen after the confirmation sheet told the merchant the opposite. Under
   * ق-97 that is not an edge case: a product sold and then retired is THE common
   * case the decision was made for.
   */
  keptForRecords: boolean;
  /** The reason to show for a kept row — the sweep's own string, or the prediction's. */
  keptReason: string | null;
}

const deletedEventSelect = { select: { actorLabel: true } } as const;

export const TRASH_PAGE_MAX = 100;
const TRASH_PAGE_DEFAULT = 25;

/**
 * ح-3 — the SECOND permission each trash entity answers to.
 *
 * `catalog.trash.restore` alone used to gate all four types, which quietly made
 * it the loosest door into two much stricter rooms: a member holding it could
 * put a dismissed colleague back on the team without `team.manage`, or revive a
 * coupon with a real financial effect without `settings.manage`. One operation
 * must not have two gates of different strictness — the strict one simply stops
 * meaning anything. The trash surface therefore requires BOTH codes, and the bin
 * listing hides the rows the reader could not act on anyway.
 */
export const TRASH_GOVERNING_PERMISSION: Record<TrashEntityType, PermissionCode | null> = {
  product: null,
  product_category: null,
  coupon: "settings.manage",
  staff_membership: "team.manage",
};

export function mayTouchTrashEntity(entityType: TrashEntityType, permissions: ReadonlySet<PermissionCode>): boolean {
  const governing = TRASH_GOVERNING_PERMISSION[entityType];
  return governing === null || permissions.has(governing);
}

export function assertMayTouchTrashEntity(entityType: TrashEntityType, permissions: ReadonlySet<PermissionCode>): void {
  const governing = TRASH_GOVERNING_PERMISSION[entityType];
  if (governing && !permissions.has(governing)) {
    throw new HttpError(403, "STAFF_PERMISSION_DENIED", `This staff membership lacks the ${governing} permission.`);
  }
}

/**
 * The bin's cursor is `(deletedAt, id)` of the last merged row.
 *
 * Plain `<` on the id is deliberate — Postgres compares uuids by value, which is
 * the same order as a lexicographic compare of their canonical lowercase text,
 * while `localeCompare` is NOT. The JS merge and the SQL predicate must agree or
 * a page boundary silently drops a row. `encodeListCursor` preserves that: the
 * id travels as its canonical text and `keysetWhere` compares it with the same
 * `lt`.
 *
 * 20-2: the payload was this module's own `base64url("<iso>|<uuid>")`, a third
 * dialect beside the encoded order cursor and the raw-id lists. It is decoded
 * here, once, so a merchant's open bin keeps working across the deploy, and it
 * is the whole of the deletion when that can no longer be in flight. The
 * refusal is the platform's one cursor refusal — `400 INVALID_CURSOR` — and no
 * longer this module's own `422 INVALID_INPUT`: phase 22 translates codes, and a
 * code that means «bad input» on one list and «bad cursor» on another cannot be
 * translated once.
 */
const TRASH_KIND = "merchant.trash";

function legacyTrashCursor(raw: string): { value: Date; id: string } | undefined {
  const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!id || !iso) return undefined;
  const deletedAt = new Date(iso);
  if (Number.isNaN(deletedAt.valueOf())) return undefined;
  return { value: deletedAt, id };
}

function sortTrashDescending(left: TrashRow, right: TrashRow): number {
  const byTime = right.deletedAt.valueOf() - left.deletedAt.valueOf();
  if (byTime !== 0) return byTime;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

export interface TrashPage {
  retentionDays: number;
  items: TrashRow[];
  nextCursor: string | null;
}

/**
 * Which trashed rows a restricting foreign key already holds. One grouped query
 * per referencing table, never one per row.
 */
async function keptForRecordsIds(entityType: TrashEntityType, storeId: string, ids: string[]): Promise<Map<string, string>> {
  const kept = new Map<string, string>();
  if (!ids.length) return kept;
  if (entityType === "product") {
    // order_items.product_id → products(id) ON DELETE RESTRICT. Scoped through
    // the order because order_items carries no store_id of its own.
    const sold = await prisma.orderItem.groupBy({ by: ["productId"], where: { productId: { in: ids }, order: { storeId } } });
    for (const row of sold) if (row.productId) kept.set(row.productId, reasonForBlockingTable("order_items"));
    return kept;
  }
  if (entityType === "coupon") {
    const redeemed = await prisma.couponRedemption.groupBy({ by: ["couponId"], where: { couponId: { in: ids }, storeId } });
    for (const row of redeemed) kept.set(row.couponId, reasonForBlockingTable("coupon_redemptions"));
    const onOrders = await prisma.storeOrder.groupBy({ by: ["couponId"], where: { couponId: { in: ids }, storeId } });
    for (const row of onOrders) if (row.couponId && !kept.has(row.couponId)) kept.set(row.couponId, reasonForBlockingTable("store_orders_coupon"));
    return kept;
  }
  if (entityType === "product_category") {
    // products.category_id → product_categories(id) ON DELETE RESTRICT, and a
    // TRASHED product still holds the reference. It is only a permanent block
    // when that product is itself kept; otherwise the pass order clears both,
    // so only a KEPT product makes its category kept too.
    // ع-9: `storeId` is what lets this use products_store_category_idx by its
    // LEADING column. Without it Postgres scanned the whole products heap — from
    // inside an HTTP handler, and even for a category holding zero products.
    const referencing = await prisma.product.findMany({ where: { categoryId: { in: ids }, storeId }, select: { id: true, categoryId: true } });
    if (!referencing.length) return kept;
    const keptProducts = await keptForRecordsIds("product", storeId, referencing.map((product) => product.id));
    for (const product of referencing) {
      if (product.categoryId && keptProducts.has(product.id)) kept.set(product.categoryId, reasonForBlockingTable("products_category"));
    }
    return kept;
  }
  // staff_sessions is Restrict, but the purge deletes the membership's revoked
  // sessions first, so it is never a permanent block. Nothing to predict.
  return kept;
}

/** Stamps the prediction onto a page of rows, one grouped query per type present. */
async function stampKeptForRecords(storeId: string, rows: TrashRow[]): Promise<void> {
  for (const entityType of TRASH_ENTITY_TYPES) {
    const ofType = rows.filter((row) => row.entityType === entityType);
    if (!ofType.length) continue;
    const kept = await keptForRecordsIds(entityType, storeId, ofType.map((row) => row.id));
    for (const row of ofType) {
      const reason = kept.get(row.id);
      if (!reason) continue;
      row.keptForRecords = true;
      // A row the sweep has ALREADY refused keeps the reason it recorded; the
      // prediction only speaks for rows the sweep has not reached yet.
      row.keptReason = row.keptReason ?? reason;
    }
  }
}

/**
 * The trash bin. `deletedAt` is a MANDATORY discriminator in the UI: two trashed
 * rows may legitimately carry the same SKU (delete ABC → create ABC → delete it)
 * and that is correct, not a bug.
 *
 * ع-6 — paginated like `listAuditEvents`, and for the same reason: owner decision
 * ق-97 sends every product that was ever sold into the bin and the purge wall
 * keeps it there, so the set grows monotonically for a busy store. Each table is
 * asked for `limit + 1` rows under the same keyset predicate, then the four
 * streams are merged and cut — which is exact, because every stream is already
 * ordered by the very key the merge sorts on.
 */
export async function listTrash(
  storeId: string,
  permissions: ReadonlySet<PermissionCode>,
  rawEntityType?: unknown,
  rawLimit?: unknown,
  rawCursor?: unknown,
): Promise<TrashPage> {
  const only = rawEntityType === undefined || rawEntityType === "" ? undefined : assertTrashEntityType(rawEntityType);
  if (only) assertMayTouchTrashEntity(only, permissions);
  const limit = parseListLimit(rawLimit, TRASH_PAGE_MAX, TRASH_PAGE_DEFAULT);
  const cursor = await readListCursor(TRASH_KIND, rawCursor, { legacyEncoded: legacyTrashCursor });
  const page = { ...TRASHED, ...keysetWhere("deletedAt", "desc", cursor) };
  const order = [{ deletedAt: "desc" as const }, { id: "desc" as const }];
  const take = limit + 1;
  const wants = (entityType: TrashEntityType) =>
    (only === undefined || only === entityType) && mayTouchTrashEntity(entityType, permissions);
  const items: TrashRow[] = [];

  if (wants("product")) {
    const rows = await prisma.product.findMany({
      where: { storeId, ...page },
      select: { id: true, name: true, sku: true, deletedAt: true, purgeBlockedAt: true, purgeBlockReason: true, deletedEvent: deletedEventSelect },
      orderBy: order,
      take,
    });
    for (const row of rows) items.push(trashRow("product", row.id, row.name, row.sku, row));
  }
  if (wants("product_category")) {
    const rows = await prisma.productCategory.findMany({
      where: { storeId, ...page },
      select: { id: true, name: true, deletedAt: true, purgeBlockedAt: true, purgeBlockReason: true, deletedEvent: deletedEventSelect },
      orderBy: order,
      take,
    });
    for (const row of rows) items.push(trashRow("product_category", row.id, row.name, null, row));
  }
  if (wants("coupon")) {
    const rows = await prisma.coupon.findMany({
      where: { storeId, ...page },
      select: { id: true, code: true, kind: true, deletedAt: true, purgeBlockedAt: true, purgeBlockReason: true, deletedEvent: deletedEventSelect },
      orderBy: order,
      take,
    });
    for (const row of rows) items.push(trashRow("coupon", row.id, row.code, row.kind, row));
  }
  if (wants("staff_membership")) {
    const rows = await prisma.storeStaffMembership.findMany({
      where: { storeId, ...page },
      select: { id: true, deletedAt: true, purgeBlockedAt: true, purgeBlockReason: true, staff: { select: { displayName: true, email: true } }, deletedEvent: deletedEventSelect },
      orderBy: order,
      take,
    });
    for (const row of rows) items.push(trashRow("staff_membership", row.id, row.staff.displayName, row.staff.email, row));
  }
  items.sort(sortTrashDescending);
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  // AFTER the cut, never before: the prediction costs one grouped query per
  // entity type on the page, and rows sliced off this page would have paid for
  // an answer nobody reads.
  await stampKeptForRecords(storeId, pageItems);
  return {
    retentionDays: TRASH_RETENTION_DAYS,
    items: pageItems,
    nextCursor: hasMore && pageItems.length ? encodeListCursor(TRASH_KIND, pageItems[pageItems.length - 1]!.deletedAt, pageItems[pageItems.length - 1]!.id) : null,
  };
}

function trashRow(
  entityType: TrashEntityType,
  id: string,
  label: string,
  secondary: string | null,
  row: { deletedAt: Date | null; purgeBlockedAt: Date | null; purgeBlockReason: string | null; deletedEvent: { actorLabel: string } | null },
): TrashRow {
  const deletedAt = row.deletedAt!;
  return {
    id,
    entityType,
    label,
    secondary,
    deletedAt,
    purgeAt: purgeAtFor(deletedAt),
    deletedBy: row.deletedEvent?.actorLabel ?? null,
    purgeBlockedAt: row.purgeBlockedAt,
    purgeBlockReason: row.purgeBlockReason,
    // Seeded from what the sweep already OBSERVED; `listTrash` then adds the
    // prediction for rows the sweep has not reached yet.
    keptForRecords: row.purgeBlockedAt !== null,
    keptReason: row.purgeBlockReason,
  };
}

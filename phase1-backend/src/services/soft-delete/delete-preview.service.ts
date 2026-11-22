/**
 * PG-2 — what the merchant is told BEFORE he confirms a delete.
 *
 * WHY THIS FILE EXISTS AT ALL: plan §4 requires the confirmation sheet to say
 * «سجل حركة المخزون (١٤ حركة) يُحفظ دائماً» with «عدد الحركات الحقيقي من الخادم»,
 * and ق-10 (المحتوى الصادق) forbids any number the client made up. The plan's
 * backend section never specified an endpoint that serves those numbers, so the
 * sheet had exactly two lawful options: read them from the server, or drop the
 * numbers entirely. This is that read.
 *
 * Every field below is a live COUNT or a stored value — nothing is estimated,
 * and `retentionDays` comes from the same TRASH_RETENTION_DAYS constant the
 * purge job obeys, so the sheet cannot drift from the actual retention window.
 *
 * Read-only: this module never writes `deletedAt`, which stays the exclusive
 * privilege of `soft-delete.service.ts`.
 */
import { HttpError } from "../../auth/auth.errors.js";
import type { PermissionCode } from "../../auth/staff-permissions.js";
import { prisma } from "../../db/prisma.js";
import { NON_CONSUMING_STATUSES } from "../analytics.service.js";
import { LIVE, TRASH_RETENTION_DAYS, type TrashEntityType } from "./constants.js";

export interface DeletePreview {
  entityType: TrashEntityType;
  id: string;
  label: string;
  secondary: string | null;
  retentionDays: number;
  /**
   * Counts that are true at this instant. A key is present only when it means
   * something for this entity type — the sheet renders a line per present key
   * and says nothing at all about an absent one.
   */
  effects: Record<string, number | string | boolean | null>;
}

/**
 * The permission that already governs each entity's DELETE. The preview must
 * ride the SAME code, not `catalog.trash.view`: whoever may delete the row must
 * be able to read the consequences first, and whoever may not delete it has no
 * business counting its orders.
 */
export const DELETE_PREVIEW_PERMISSION = {
  product: "catalog.products.delete",
  product_category: "catalog.categories.manage",
  coupon: "settings.manage",
  staff_membership: "team.manage",
} as const;

/**
 * ع-2 — the SALES FIGURES in this preview answer to `orders.view`, not to the
 * delete permission.
 *
 * A merchant who hires a stock keeper and deliberately sets «حذف منتج: سماح»
 * with «عرض الطلبات: منع» is refused …/orders and …/analytics/top-products by
 * the platform — and was then handed the real per-product order count by this
 * sheet, in the same session, one product at a time, from which the store's
 * cumulative sales ranking is a walk down his own catalogue. A permission that
 * is denied and changes nothing empties the team screen of its meaning.
 *
 * What survives without the code is everything the sheet actually PROMISES:
 * that the row will be kept for the records, that its movement history is never
 * lost. Those are qualitative facts about the row's fate, not sales data, and
 * ق-97 requires the sheet to state them.
 */
function maySeeSalesFigures(permissions: ReadonlySet<PermissionCode>): boolean {
  return permissions.has("orders.view");
}

export async function deletePreview(entityType: TrashEntityType, storeId: string, id: string, permissions: ReadonlySet<PermissionCode>): Promise<DeletePreview> {
  if (entityType === "product") return productPreview(storeId, id, permissions);
  if (entityType === "product_category") return categoryPreview(storeId, id);
  if (entityType === "coupon") return couponPreview(storeId, id, permissions);
  return membershipPreview(storeId, id);
}

function shell(entityType: TrashEntityType, id: string, label: string, secondary: string | null, effects: DeletePreview["effects"]): DeletePreview {
  return { entityType, id, label, secondary, retentionDays: TRASH_RETENTION_DAYS, effects };
}

async function productPreview(storeId: string, id: string, permissions: ReadonlySet<PermissionCode>): Promise<DeletePreview> {
  const product = await prisma.product.findFirst({
    where: { id, storeId, ...LIVE },
    select: { id: true, name: true, sku: true, _count: { select: { images: true, variants: { where: { deletedAt: null } } } } },
  });
  if (!product) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المنتج غير موجود في هذا المتجر.");
  // Four independent counts, all store-scoped. `inventoryMovements` is the one
  // the sheet promises to preserve; `orders` is what will later block the purge
  // and keep the row under the «محفوظ لسجلاتك» badge forever (ق-97).
  //
  // `orders` counts ORDERS, not order_items. Since phase 20A one order carries
  // one order_item PER VARIANT, so counting items would tell a merchant whose
  // customer bought size M and size L in a single order that the shirt was
  // «مباع في طلبان» — a sales figure the UI would have invented out of a real
  // number, which is the same lie ق-10 forbids.
  // ع-6: TWO order counts, because they answer two different questions and the
  // sheet was conflating them. `orders` is every order that references the
  // product — cancelled ones included — because `order_items → products` is
  // RESTRICT regardless of status, so that is what predicts the purge block.
  // `soldOrders` excludes the statuses that consumed nothing, because that is
  // the one the word «مباع» may stand on: telling a merchant whose only two
  // customers both cancelled that his shoe was «مباع في طلبان» is a sales claim
  // his own analytics screen contradicts on the next tab.
  const [inventoryMovements, orders, soldOrders, liveCartItems, activeReservations] = await Promise.all([
    prisma.inventoryMovement.count({ where: { productId: product.id, storeId } }),
    prisma.storeOrder.count({ where: { storeId, items: { some: { productId: product.id } } } }),
    prisma.storeOrder.count({ where: { storeId, status: { notIn: [...NON_CONSUMING_STATUSES] }, items: { some: { productId: product.id } } } }),
    prisma.cartItem.count({ where: { productId: product.id, storeId, cart: { status: "active" } } }),
    prisma.inventoryReservation.count({ where: { productId: product.id, storeId, status: "active" } }),
  ]);
  return shell("product", product.id, product.name, product.sku, {
    // The row's FATE — always shown, because the sheet promises it (ق-97).
    keptForRecords: orders > 0,
    // The NUMBERS — only for a reader allowed to see this store's sales.
    ...(maySeeSalesFigures(permissions) ? { inventoryMovements, orders, soldOrders } : {}),
    liveCartItems,
    activeReservations,
    variants: product._count.variants,
    images: product._count.images,
  });
}

async function categoryPreview(storeId: string, id: string): Promise<DeletePreview> {
  const category = await prisma.productCategory.findFirst({ where: { id, storeId, ...LIVE }, select: { id: true, name: true } });
  if (!category) throw new HttpError(404, "CATEGORY_NOT_FOUND", "التصنيف غير موجود في هذا المتجر.");
  const [liveProducts, liveChildren] = await Promise.all([
    prisma.product.count({ where: { categoryId: category.id, storeId, ...LIVE } }),
    prisma.productCategory.count({ where: { parentCategoryId: category.id, storeId, ...LIVE } }),
  ]);
  return shell("product_category", category.id, category.name, null, { liveProducts, liveChildren });
}

async function couponPreview(storeId: string, id: string, permissions: ReadonlySet<PermissionCode>): Promise<DeletePreview> {
  const coupon = await prisma.coupon.findFirst({ where: { id, storeId, ...LIVE }, select: { id: true, code: true, endsAt: true } });
  if (!coupon) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الكوبون غير موجود في هذا المتجر.");
  const [redemptions, onOrders] = await Promise.all([
    prisma.couponRedemption.count({ where: { couponId: coupon.id, storeId } }),
    prisma.storeOrder.count({ where: { couponId: coupon.id, storeId } }),
  ]);
  // `endsAt` travels as an ISO string so the sheet can warn, truthfully, that a
  // restore does NOT extend an expired window (plan §1.و exception 3).
  //
  // ع-5: the coupon branch knew the row would be kept forever and did not say so,
  // while the product branch did. A merchant who runs one Eid coupon a year was
  // being left to believe its record dies in a month.
  return shell("coupon", coupon.id, coupon.code, null, {
    keptForRecords: redemptions > 0 || onOrders > 0,
    ...(maySeeSalesFigures(permissions) ? { redemptions } : {}),
    endsAt: coupon.endsAt ? coupon.endsAt.toISOString() : null,
  });
}

async function membershipPreview(storeId: string, id: string): Promise<DeletePreview> {
  const membership = await prisma.storeStaffMembership.findFirst({
    where: { id, storeId, ...LIVE },
    select: { id: true, roleCode: true, staff: { select: { displayName: true, email: true } } },
  });
  if (!membership) throw new HttpError(404, "RESOURCE_NOT_FOUND", "العضوية غير موجودة في فريق هذا المتجر.");
  // ع-4: «open» means a session that would actually be ACCEPTED — identity.ts
  // requires expiresAt > now on every request. Counting only `revokedAt: null`
  // measured «times signed in since the last suspension», and because a staff
  // session lasts eight hours, nothing sweeps the expired ones and there is no
  // staff sign-out route at all, the number only ever grew. It told a merchant
  // dismissing someone at a tense moment that 180 doors were open when one was.
  const openSessions = await prisma.staffSession.count({ where: { membershipId: membership.id, revokedAt: null, expiresAt: { gt: new Date() } } });
  return shell("staff_membership", membership.id, membership.staff.displayName, membership.staff.email, { openSessions, roleCode: membership.roleCode });
}

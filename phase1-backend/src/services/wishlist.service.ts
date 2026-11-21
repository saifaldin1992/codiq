/**
 * CD-2 «قائمة الرغبات» — saved variants, and «نبّهني عند التوفر».
 *
 * SAVED AT THE VARIANT, NOT THE PRODUCT. «نبّهني عند التوفر» is a question about
 * a size or a colour. A product-level answer would page a shopper the moment
 * ANY variant returned and send him to a page where the one he wanted is still
 * missing — a notification that wastes his trip is worse than none.
 *
 * ASKING TO BE PAGED IS A SEPARATE ACT. Saving something is not consent to be
 * mailed about it, so `notifyOnRestock` is its own switch and defaults off. The
 * message itself is classified MARKETING (see the migration), so it also obeys
 * the unsubscribe and the store's daily cap.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "./list-page.js";

const LIVE = { deletedAt: null } as const;
/** A wishlist a person actually uses; past this it is a hoard, and a mail-out. */
export const WISHLIST_LIMIT = 200;

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const WISHLIST_KIND = "storefront.account.wishlist";

/**
 * D-18: capped at WISHLIST_LIMIT with no page 2. A shopper who saves things for
 * months could not reach the ones he saved first.
 */
export async function listWishlist(
  storeId: string,
  customerId: string,
  rawLimit?: unknown,
  rawCursor?: unknown
) {
  const limit = parseListLimit(rawLimit, 100, WISHLIST_LIMIT);
  const cursor = await readListCursor(WISHLIST_KIND, rawCursor);
  const rows = await prisma.wishlistItem.findMany({
    where: { storeId, customerId, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      notifyOnRestock: true,
      createdAt: true,
      product: { select: { id: true, name: true, isActive: true, deletedAt: true } },
      variant: {
        select: {
          id: true,
          name: true,
          sku: true,
          priceIqd: true,
          stockQuantity: true,
          isActive: true,
          isDefault: true,
          deletedAt: true,
        },
      },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(WISHLIST_KIND, last.createdAt, last.id)
  );
  return {
    nextCursor,
    items: page
      // A trashed or withdrawn product is not shown, but the row is left alone:
      // the merchant may restore it, and a wishlist that silently forgot what
      // the shopper saved would be a worse bug than a hidden line.
      .filter(
        (item) =>
          item.product.deletedAt === null &&
          item.variant.deletedAt === null &&
          item.product.isActive &&
          item.variant.isActive
      )
      .map((item) => ({
        id: item.id,
        notifyOnRestock: item.notifyOnRestock,
        createdAt: item.createdAt,
        productId: item.product.id,
        productName: item.product.name,
        variantId: item.variant.id,
        variantName: item.variant.isDefault ? null : item.variant.name,
        sku: item.variant.sku,
        priceIqd: item.variant.priceIqd,
        inStock: item.variant.stockQuantity > 0,
      })),
  };
}

/**
 * 19-ج: the HTTP edge parses this body through `wishlistItemSchema` first, so a
 * missing or malformed `variantId` answers 422 VALIDATION_FAILED naming the
 * field. The guards below stay for the same reason product-review.service.ts
 * kept its own: this function is exported, and a public function that trusts its
 * caller is one waiting to be called wrongly.
 */
export async function addToWishlist(
  storeId: string,
  customerId: string,
  input: { variantId: unknown; notifyOnRestock?: unknown }
) {
  if (typeof input.variantId !== "string" || !input.variantId) {
    throw new HttpError(422, "INVALID_INPUT", "variantId مطلوب.");
  }
  if (input.notifyOnRestock !== undefined && typeof input.notifyOnRestock !== "boolean") {
    throw new HttpError(422, "INVALID_INPUT", "notifyOnRestock يجب أن يكون true أو false.");
  }
  const variant = await prisma.productVariant.findFirst({
    where: {
      id: input.variantId,
      storeId,
      isActive: true,
      ...LIVE,
      product: { isActive: true, ...LIVE },
    },
    select: { id: true, productId: true },
  });
  // 404, not 403: a variant of another store and a variant that does not exist
  // must be indistinguishable from here, or this endpoint answers «does store X
  // sell this?» for anyone with a customer account anywhere.
  if (!variant) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المنتج غير متاح.");

  const existing = await prisma.wishlistItem.findUnique({
    where: { storeId_customerId_variantId: { storeId, customerId, variantId: variant.id } },
    select: { id: true },
  });
  if (existing) {
    // Adding twice is a double tap, not an error. The notify flag is still
    // honoured, so «احفظ» then «نبّهني» works without a separate call.
    return prisma.wishlistItem.update({
      where: { id: existing.id },
      data: {
        ...(input.notifyOnRestock !== undefined ? { notifyOnRestock: input.notifyOnRestock } : {}),
      },
      select: { id: true, variantId: true, notifyOnRestock: true, createdAt: true },
    });
  }

  const count = await prisma.wishlistItem.count({ where: { storeId, customerId } });
  if (count >= WISHLIST_LIMIT) {
    throw new HttpError(
      422,
      "WISHLIST_FULL",
      `قائمة رغباتك بلغت ${WISHLIST_LIMIT} عنصراً. احذف شيئاً قبل الإضافة.`
    );
  }

  return prisma.wishlistItem.create({
    data: {
      storeId,
      customerId,
      variantId: variant.id,
      productId: variant.productId,
      notifyOnRestock: input.notifyOnRestock === true,
    },
    select: { id: true, variantId: true, notifyOnRestock: true, createdAt: true },
  });
}

export async function removeFromWishlist(storeId: string, customerId: string, variantId: string) {
  const deleted = await prisma.wishlistItem.deleteMany({
    where: { storeId, customerId, variantId },
  });
  if (deleted.count === 0)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "العنصر غير موجود في قائمتك.");
}

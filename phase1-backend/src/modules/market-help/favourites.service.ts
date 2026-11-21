/**
 * Marketplace M7 «المفضّلة» — products the shopper saved and stores he follows.
 * Lists page by when they were saved, newest first, and are shown with the
 * same cards as the rest of the market; anything no longer in the market
 * (unlisted store, deleted product) simply drops out of the page.
 */
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { listMarketProducts } from "../market-catalog/products.service.js";
import type { MarketProductQuery } from "../market-catalog/schema.js";
import { marketStoreCardsByIds } from "../market-stores/directory.service.js";

/** A shopper may keep this many of each. Past it he is asked to remove some — no silent drop. */
export const FAVOURITES_CAP = 500;
const PAGE_MAX = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id: string, what: string) {
  if (!UUID.test(id)) throw new HttpError(404, `${what}_NOT_FOUND`, "غير موجود.");
}

export async function addFavouriteProduct(shopperId: string, productId: string) {
  assertUuid(productId, "PRODUCT");
  const [card] = (await listMarketProducts({ ids: [productId], limit: 1, period: "month" } as MarketProductQuery)).products;
  if (!card) throw new HttpError(404, "PRODUCT_NOT_FOUND", "هذا المنتج غير متاح في السوق.");
  const product = await prisma.product.findFirstOrThrow({ where: { id: productId, deletedAt: null }, select: { storeId: true } });
  if (await prisma.shopperFavouriteProduct.count({ where: { shopperId } }) >= FAVOURITES_CAP) {
    const exists = await prisma.shopperFavouriteProduct.findUnique({ where: { shopperId_productId: { shopperId, productId } }, select: { productId: true } });
    if (!exists) throw new HttpError(409, "FAVOURITES_FULL", `المفضّلة ممتلئة (${FAVOURITES_CAP} منتج). احذف بعضها أولاً.`);
  }
  await prisma.shopperFavouriteProduct.createMany({ data: [{ shopperId, productId, storeId: product.storeId }], skipDuplicates: true });
  return { productId, favourite: true };
}

export async function removeFavouriteProduct(shopperId: string, productId: string) {
  assertUuid(productId, "PRODUCT");
  await prisma.shopperFavouriteProduct.deleteMany({ where: { shopperId, productId } });
  return { productId, favourite: false };
}

export async function followStore(shopperId: string, storeSlug: string) {
  const card = await storeBySlug(storeSlug);
  if (await prisma.shopperFollowedStore.count({ where: { shopperId } }) >= FAVOURITES_CAP) {
    const exists = await prisma.shopperFollowedStore.findUnique({ where: { shopperId_storeId: { shopperId, storeId: card.id } }, select: { storeId: true } });
    if (!exists) throw new HttpError(409, "FAVOURITES_FULL", `تتابع ${FAVOURITES_CAP} متجراً، وهو الحدّ الأعلى.`);
  }
  await prisma.shopperFollowedStore.createMany({ data: [{ shopperId, storeId: card.id }], skipDuplicates: true });
  return { storeSlug: card.slug, following: true, followers: await prisma.shopperFollowedStore.count({ where: { storeId: card.id } }) };
}

export async function unfollowStore(shopperId: string, storeSlug: string) {
  const store = await prisma.store.findUnique({ where: { slug: storeSlug }, select: { id: true, slug: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "هذا المتجر غير موجود في السوق.");
  await prisma.shopperFollowedStore.deleteMany({ where: { shopperId, storeId: store.id } });
  return { storeSlug: store.slug, following: false, followers: await prisma.shopperFollowedStore.count({ where: { storeId: store.id } }) };
}

/** A store that is in the market right now — following an unlisted one is refused. */
async function storeBySlug(slug: string) {
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, slug: true } });
  const cards = store ? await marketStoreCardsByIds([store.id]) : [];
  if (!store || !cards.length) throw new HttpError(404, "STORE_NOT_FOUND", "هذا المتجر غير موجود في السوق.");
  return store;
}

/** Saved products, newest first. */
export async function favouriteProducts(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, PAGE_MAX, PAGE_MAX);
  const cursor = decodeListCursor("market-favourite-products", rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.shopperFavouriteProduct.findMany({
    where: { shopperId, ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, productId: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { productId: "desc" }],
    take: limit + 1,
    select: { productId: true, createdAt: true },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor("market-favourite-products", last.createdAt, last.productId));
  const ids = page.map((row) => row.productId);
  const cards = ids.length ? (await listMarketProducts({ ids, limit: PAGE_MAX, period: "month" } as MarketProductQuery)).products : [];
  const byId = new Map(cards.map((card) => [card.id, card]));
  return { products: ids.map((id) => byId.get(id)).filter((card): card is NonNullable<typeof card> => Boolean(card)), nextCursor };
}

/** Followed stores, newest first. */
export async function followedStores(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, PAGE_MAX, PAGE_MAX);
  const cursor = decodeListCursor("market-followed-stores", rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const rows = await prisma.shopperFollowedStore.findMany({
    where: { shopperId, ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, storeId: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { storeId: "desc" }],
    take: limit + 1,
    select: { storeId: true, createdAt: true },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor("market-followed-stores", last.createdAt, last.storeId));
  return { stores: await marketStoreCardsByIds(page.map((row) => row.storeId)), nextCursor };
}

/**
 * Which of these products / stores the shopper saved — the hearts on a page of
 * cards. Asked per page (at most 48 ids), never «send me everything I saved».
 */
export async function favouriteFlags(shopperId: string, productIds: string[], storeSlugs: string[]) {
  const [products, stores] = await Promise.all([
    productIds.length ? prisma.shopperFavouriteProduct.findMany({ where: { shopperId, productId: { in: productIds } }, select: { productId: true } }) : [],
    storeSlugs.length ? prisma.shopperFollowedStore.findMany({ where: { shopperId, store: { slug: { in: storeSlugs } } }, select: { store: { select: { slug: true } } } }) : [],
  ]);
  return { products: products.map((row) => row.productId), stores: stores.map((row) => row.store.slug) };
}

/** «اشتريت منها» — the stores he has bought from, most recent first. */
export async function purchasedFromStores(shopperId: string) {
  const rows = await prisma.$queryRaw<{ store_id: string }[]>`
    SELECT o.store_id FROM store_orders o JOIN customers c ON c.id = o.customer_id AND c.store_id = o.store_id
     WHERE c.shopper_id = ${shopperId}::uuid AND o.status NOT IN ('cancelled', 'rejected')
     GROUP BY o.store_id ORDER BY max(o.created_at) DESC LIMIT 12`;
  return { stores: await marketStoreCardsByIds(rows.map((row) => row.store_id)) };
}

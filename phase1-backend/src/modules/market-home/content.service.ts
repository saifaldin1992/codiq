/**
 * The owner's side: banners, collections, malls, the front page's blocks and
 * the market category tree. Everything here is platform content — no tenant
 * column to scope by — so every write is gated by `brand.manage` at the route.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { deleteMarketImageObjects, putMarketImage } from "../../services/product-image-storage.service.js";
import { forgetMarketCategories } from "../market-catalog/categories.service.js";
import { bannerImageUrl } from "./home.service.js";
import type { BannerInput, CollectionInput, HomeSectionsInput, MallInput } from "./schema.js";

const date = (value: string | null) => (value === null ? null : new Date(value));

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ── banners ──────────────────────────────────────────────────────────────────

const BANNER_SELECT = {
  id: true, placement: true, title: true, subtitle: true, imageObjectKey: true, linkKind: true, linkTarget: true,
  startsAt: true, endsAt: true, sortOrder: true, isActive: true, isAd: true, views: true, clicks: true, createdAt: true,
} satisfies Prisma.MarketBannerSelect;

function bannerView(row: Prisma.MarketBannerGetPayload<{ select: typeof BANNER_SELECT }>) {
  const { imageObjectKey, ...rest } = row;
  return { ...rest, imageUrl: bannerImageUrl(row.id, imageObjectKey) };
}

/** Bounded: the owner's whole banner board (a few dozen across four placements). */
export async function listBanners() {
  const rows = await prisma.marketBanner.findMany({ orderBy: [{ placement: "asc" }, { sortOrder: "asc" }, { createdAt: "desc" }], take: 200, select: BANNER_SELECT });
  return { banners: rows.map(bannerView) };
}

function bannerData(input: BannerInput) {
  return { placement: input.placement, title: input.title, subtitle: input.subtitle, linkKind: input.linkKind, linkTarget: input.linkTarget, startsAt: date(input.startsAt), endsAt: date(input.endsAt), sortOrder: input.sortOrder, isActive: input.isActive, isAd: input.isAd };
}

export async function createBanner(input: BannerInput) {
  return { banner: bannerView(await prisma.marketBanner.create({ data: bannerData(input), select: BANNER_SELECT })) };
}

export async function updateBanner(id: string, input: BannerInput) {
  const moved = await prisma.marketBanner.updateMany({ where: { id }, data: bannerData(input) });
  if (moved.count === 0) throw new HttpError(404, "BANNER_NOT_FOUND", "البنر غير موجود.");
  return { banner: bannerView(await prisma.marketBanner.findUniqueOrThrow({ where: { id }, select: BANNER_SELECT })) };
}

export async function deleteBanner(id: string) {
  const row = await prisma.marketBanner.findUnique({ where: { id }, select: { imageObjectKey: true } });
  if (!row) throw new HttpError(404, "BANNER_NOT_FOUND", "البنر غير موجود.");
  await prisma.marketBanner.delete({ where: { id } });
  if (row.imageObjectKey) await deleteMarketImageObjects([row.imageObjectKey]);
  return { deleted: true };
}

export async function setBannerImage(id: string, file: Express.Multer.File | undefined) {
  if (!file) throw new HttpError(422, "INVALID_BANNER_IMAGE", "صورة البنر مطلوبة.");
  const row = await prisma.marketBanner.findUnique({ where: { id }, select: { imageObjectKey: true } });
  if (!row) throw new HttpError(404, "BANNER_NOT_FOUND", "البنر غير موجود.");
  const stored = await putMarketImage("banners", file);
  try {
    await prisma.marketBanner.update({ where: { id }, data: { imageObjectKey: stored.objectKey, imageContentType: stored.contentType, imageByteSize: stored.byteSize } });
  } catch (error) {
    await deleteMarketImageObjects([stored.objectKey]);
    throw error;
  }
  if (row.imageObjectKey) await deleteMarketImageObjects([row.imageObjectKey]);
  return { banner: bannerView(await prisma.marketBanner.findUniqueOrThrow({ where: { id }, select: BANNER_SELECT })) };
}

// ── collections ──────────────────────────────────────────────────────────────

const COLLECTION_SELECT = {
  id: true, slug: true, kind: true, title: true, subtitle: true, headlineDiscountPercent: true, startsAt: true, endsAt: true, sortOrder: true, isActive: true,
  items: { select: { productId: true, product: { select: { name: true, store: { select: { name: true } } } } }, orderBy: { sortOrder: "asc" as const } },
} satisfies Prisma.MarketCollectionSelect;

function collectionView(row: Prisma.MarketCollectionGetPayload<{ select: typeof COLLECTION_SELECT }>) {
  const { items, ...rest } = row;
  return { ...rest, items: items.map((item) => ({ productId: item.productId, name: item.product.name, storeName: item.product.store.name })) };
}

/** Bounded: the owner's collections, each up to two hundred products. */
export async function listCollections() {
  const rows = await prisma.marketCollection.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }], take: 200, select: COLLECTION_SELECT });
  return { collections: rows.map(collectionView) };
}

function collectionData(input: CollectionInput) {
  return { slug: input.slug, kind: input.kind, title: input.title, subtitle: input.subtitle, headlineDiscountPercent: input.headlineDiscountPercent, startsAt: date(input.startsAt), endsAt: date(input.endsAt), sortOrder: input.sortOrder, isActive: input.isActive };
}

export async function createCollection(input: CollectionInput) {
  try {
    return { collection: collectionView(await prisma.marketCollection.create({ data: collectionData(input), select: COLLECTION_SELECT })) };
  } catch (error) {
    if (uniqueViolation(error)) throw new HttpError(409, "SLUG_TAKEN", "هذا الرابط مستخدم لمجموعة أخرى.");
    throw error;
  }
}

export async function updateCollection(id: string, input: CollectionInput) {
  try {
    const moved = await prisma.marketCollection.updateMany({ where: { id }, data: collectionData(input) });
    if (moved.count === 0) throw new HttpError(404, "COLLECTION_NOT_FOUND", "المجموعة غير موجودة.");
  } catch (error) {
    if (uniqueViolation(error)) throw new HttpError(409, "SLUG_TAKEN", "هذا الرابط مستخدم لمجموعة أخرى.");
    throw error;
  }
  return { collection: collectionView(await prisma.marketCollection.findUniqueOrThrow({ where: { id }, select: COLLECTION_SELECT })) };
}

export async function deleteCollection(id: string) {
  const deleted = await prisma.marketCollection.deleteMany({ where: { id } });
  if (deleted.count === 0) throw new HttpError(404, "COLLECTION_NOT_FOUND", "المجموعة غير موجودة.");
  return { deleted: true };
}

/** Replaces the product list, in the given order. Unknown or deleted products are refused by name. */
export async function setCollectionItems(id: string, productIds: string[]) {
  const collection = await prisma.marketCollection.findUnique({ where: { id }, select: { id: true } });
  if (!collection) throw new HttpError(404, "COLLECTION_NOT_FOUND", "المجموعة غير موجودة.");
  const unique = Array.from(new Set(productIds));
  const products = await prisma.product.findMany({ where: { id: { in: unique }, deletedAt: null }, select: { id: true, storeId: true } });
  const known = new Map(products.map((product) => [product.id, product.storeId]));
  const missing = unique.filter((productId) => !known.has(productId));
  if (missing.length) throw new HttpError(422, "PRODUCT_NOT_FOUND", "منتجات غير موجودة في الكتالوج.", { productIds: missing });
  await prisma.$transaction([
    prisma.marketCollectionItem.deleteMany({ where: { collectionId: id } }),
    prisma.marketCollectionItem.createMany({ data: unique.map((productId, index) => ({ collectionId: id, productId, storeId: known.get(productId) as string, sortOrder: index })) }),
  ]);
  return { collection: collectionView(await prisma.marketCollection.findUniqueOrThrow({ where: { id }, select: COLLECTION_SELECT })) };
}

// ── malls ────────────────────────────────────────────────────────────────────

const MALL_SELECT = {
  id: true, slug: true, name: true, description: true, sortOrder: true, isActive: true,
  stores: { select: { store: { select: { slug: true, name: true, marketStatus: true } } }, orderBy: { sortOrder: "asc" as const } },
} satisfies Prisma.MarketMallSelect;

function mallView(row: Prisma.MarketMallGetPayload<{ select: typeof MALL_SELECT }>) {
  const { stores, ...rest } = row;
  return { ...rest, stores: stores.map((member) => ({ slug: member.store.slug, name: member.store.name, listed: member.store.marketStatus === "listed" })) };
}

/** Bounded: the owner's malls, each up to a hundred stores. */
export async function listMalls() {
  const rows = await prisma.marketMall.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 100, select: MALL_SELECT });
  return { malls: rows.map(mallView) };
}

export async function createMall(input: MallInput) {
  try {
    return { mall: mallView(await prisma.marketMall.create({ data: input, select: MALL_SELECT })) };
  } catch (error) {
    if (uniqueViolation(error)) throw new HttpError(409, "SLUG_TAKEN", "هذا الرابط مستخدم لمول آخر.");
    throw error;
  }
}

export async function updateMall(id: string, input: MallInput) {
  try {
    const moved = await prisma.marketMall.updateMany({ where: { id }, data: input });
    if (moved.count === 0) throw new HttpError(404, "MALL_NOT_FOUND", "المول غير موجود.");
  } catch (error) {
    if (uniqueViolation(error)) throw new HttpError(409, "SLUG_TAKEN", "هذا الرابط مستخدم لمول آخر.");
    throw error;
  }
  return { mall: mallView(await prisma.marketMall.findUniqueOrThrow({ where: { id }, select: MALL_SELECT })) };
}

export async function deleteMall(id: string) {
  const deleted = await prisma.marketMall.deleteMany({ where: { id } });
  if (deleted.count === 0) throw new HttpError(404, "MALL_NOT_FOUND", "المول غير موجود.");
  return { deleted: true };
}

/** Replaces the mall's stores, by slug, in the given order. */
export async function setMallStores(id: string, storeSlugs: string[]) {
  const mall = await prisma.marketMall.findUnique({ where: { id }, select: { id: true } });
  if (!mall) throw new HttpError(404, "MALL_NOT_FOUND", "المول غير موجود.");
  const unique = Array.from(new Set(storeSlugs));
  const stores = await prisma.store.findMany({ where: { slug: { in: unique } }, select: { id: true, slug: true } });
  const bySlug = new Map(stores.map((store) => [store.slug, store.id]));
  const missing = unique.filter((slug) => !bySlug.has(slug));
  if (missing.length) throw new HttpError(422, "STORE_NOT_FOUND", "متاجر غير موجودة.", { storeSlugs: missing });
  await prisma.$transaction([
    prisma.marketMallStore.deleteMany({ where: { mallId: id } }),
    prisma.marketMallStore.createMany({ data: unique.map((slug, index) => ({ mallId: id, storeId: bySlug.get(slug) as string, sortOrder: index })) }),
  ]);
  return { mall: mallView(await prisma.marketMall.findUniqueOrThrow({ where: { id }, select: MALL_SELECT })) };
}

// ── the front page ───────────────────────────────────────────────────────────

/** Bounded: at most forty blocks. Inactive ones included — the owner switches them back on from here. */
export async function listHomeSections() {
  return { sections: await prisma.marketHomeSection.findMany({ orderBy: { position: "asc" }, take: 40 }) };
}

/** Replaces the whole page at once: the order the owner sees is the order shoppers get. */
export async function replaceHomeSections(input: HomeSectionsInput) {
  await prisma.$transaction([
    prisma.marketHomeSection.deleteMany({}),
    prisma.marketHomeSection.createMany({ data: input.sections.map((section, index) => ({ kind: section.kind, title: section.title, config: section.config, isActive: section.isActive, position: index + 1 })) }),
  ]);
  return listHomeSections();
}

// ── the category tree ────────────────────────────────────────────────────────

async function assertParent(parentId: number | null, selfId: number | null) {
  if (parentId === null) return;
  if (parentId === selfId) throw new HttpError(422, "INVALID_CATEGORY_PARENT", "لا تكون الفئة أمّاً لنفسها.");
  const parent = await prisma.marketCategory.findUnique({ where: { id: parentId }, select: { parentId: true } });
  if (!parent) throw new HttpError(422, "INVALID_CATEGORY_PARENT", "الفئة الأمّ غير موجودة.");
  if (parent.parentId !== null) throw new HttpError(422, "CATEGORY_DEPTH_EXCEEDED", "فئات السوق مستويان فقط: اختر فئة رئيسيّة.");
  if (selfId !== null && (await prisma.marketCategory.count({ where: { parentId: selfId } })) > 0) {
    throw new HttpError(422, "CATEGORY_DEPTH_EXCEEDED", "لهذه الفئة فئات فرعيّة، فلا تصير فرعيّة بنفسها.");
  }
}

/** Bounded: the whole tree, inactive categories included (about fifty rows). */
export async function listCategoriesForOwner() {
  return { categories: await prisma.marketCategory.findMany({ orderBy: [{ parentId: { sort: "asc", nulls: "first" } }, { sortOrder: "asc" }, { id: "asc" }], select: { id: true, slug: true, nameAr: true, parentId: true, sortOrder: true, isActive: true } }) };
}

export async function createCategory(input: { slug: string; name: string; parentId: number | null; sortOrder: number }) {
  await assertParent(input.parentId, null);
  try {
    const row = await prisma.marketCategory.create({ data: { slug: input.slug, nameAr: input.name, parentId: input.parentId, sortOrder: input.sortOrder }, select: { id: true } });
    forgetMarketCategories();
    return { categoryId: row.id };
  } catch (error) {
    if (uniqueViolation(error)) throw new HttpError(409, "SLUG_TAKEN", "هذا الرابط مستخدم لفئة أخرى.");
    throw error;
  }
}

export async function updateCategory(id: number, input: { name: string; parentId: number | null; sortOrder: number; isActive: boolean }) {
  await assertParent(input.parentId, id);
  const moved = await prisma.marketCategory.updateMany({ where: { id }, data: { nameAr: input.name, parentId: input.parentId, sortOrder: input.sortOrder, isActive: input.isActive } });
  if (moved.count === 0) throw new HttpError(404, "CATEGORY_NOT_FOUND", "الفئة غير موجودة.");
  forgetMarketCategories();
  return { categoryId: id };
}

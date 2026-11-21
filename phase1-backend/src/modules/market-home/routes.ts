/**
 * Marketplace M3 routes.
 *
 *   shopper  GET /market/home (collections and malls ride it) · /market/collections/:slug · /market/malls/:slug · /market/banners/:id/image
 *            POST /market/banners/:id/events  (a view or a tap; origin-checked and rate-limited)
 *   owner    /platform/market/{banners,collections,malls,home-sections,categories}  (brand.manage)
 */
import multer from "multer";
import type { Express, Request } from "express";
import { asyncRoute, authenticatedUpload, limitUpload, requireTrustedWriteOrigin, uploadLimits } from "../../http/shared.js";
import { clientIp } from "../../http/client-ip.js";
import { parseOrThrow } from "../../http/validate.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { getStoreLogoBytes, storeImageConstraints } from "../../services/product-image-storage.service.js";
import { bannerImage, collectionPage, mallPage, marketHome, recordBannerEvent } from "./home.service.js";
import {
  createBanner, createCategory, createCollection, createMall, deleteBanner, deleteCollection, deleteMall, listBanners, listCategoriesForOwner, listCollections,
  listHomeSections, listMalls, replaceHomeSections, setBannerImage, setCollectionItems, setMallStores, updateBanner, updateCategory, updateCollection, updateMall,
} from "./content.service.js";
import {
  bannerEventSchema, bannerSchema, categoryCreateSchema, categoryUpdateSchema, collectionItemsSchema, collectionSchema, homeSectionsSchema, mallSchema, mallStoresSchema,
} from "./schema.js";

const SHORT_PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=300";
const bannerUpload = multer({ storage: multer.memoryStorage(), limits: uploadLimits({ fileSize: storeImageConstraints.maxBytes, files: 1 }) });

async function guardBannerUpload(request: Request) {
  requireTrustedWriteOrigin(request);
  const { actor } = await requirePlatformActor(request, "brand.manage");
  await limitUpload("market_banner_upload", `${actor.kind}:${actor.id}`);
}

/** Every owner route: brand.manage. Write routes check the origin themselves, in their own body (csrf:guard reads it there). */
async function owner(request: Request) {
  await requirePlatformActor(request, "brand.manage");
}

export function registerMarketHomeRoutes(app: Express) {
  // ── shopper ───────────────────────────────────────────────────────────────
  app.get("/market/home", asyncRoute(async (_request, response) => {
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await marketHome());
  }));


  app.get("/market/collections/:slug", asyncRoute(async (request, response) => {
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await collectionPage(request.params.slug));
  }));


  app.get("/market/malls/:slug", asyncRoute(async (request, response) => {
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await mallPage(request.params.slug));
  }));

  app.get("/market/banners/:bannerId/image", asyncRoute(async (request, response) => {
    const image = await bannerImage(request.params.bannerId);
    const bytes = await getStoreLogoBytes(image.objectKey);
    // Immutable: the URL carries `?v=<uuid>` that changes with every upload.
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.status(200).contentType(image.contentType).send(bytes);
  }));

  app.post("/market/banners/:bannerId/events", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    // Generous for a person scrolling, tight for a script inflating an advertiser's numbers.
    await consumeStorefrontRateLimit({ scope: "market_banner_event", rawKey: clientIp(request), limit: 300, windowMs: 10 * 60 * 1000 });
    const input = parseOrThrow(bannerEventSchema, request.body ?? {});
    response.status(200).json(await recordBannerEvent(request.params.bannerId, input.kind));
  }));

  // ── owner ─────────────────────────────────────────────────────────────────
  app.get("/platform/market/banners", asyncRoute(async (request, response) => { await owner(request); response.status(200).json(await listBanners()); }));
  app.post("/platform/market/banners", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(201).json(await createBanner(parseOrThrow(bannerSchema, request.body ?? {})));
  }));
  app.put("/platform/market/banners/:bannerId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(200).json(await updateBanner(request.params.bannerId, parseOrThrow(bannerSchema, request.body ?? {})));
  }));
  app.delete("/platform/market/banners/:bannerId", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); await owner(request); response.status(200).json(await deleteBanner(request.params.bannerId)); }));
  app.post("/platform/market/banners/:bannerId/image", authenticatedUpload(guardBannerUpload, bannerUpload.single("image")), asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(200).json(await setBannerImage(request.params.bannerId, request.file));
  }));

  app.get("/platform/market/collections", asyncRoute(async (request, response) => { await owner(request); response.status(200).json(await listCollections()); }));
  app.post("/platform/market/collections", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(201).json(await createCollection(parseOrThrow(collectionSchema, request.body ?? {})));
  }));
  app.put("/platform/market/collections/:collectionId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(200).json(await updateCollection(request.params.collectionId, parseOrThrow(collectionSchema, request.body ?? {})));
  }));
  app.delete("/platform/market/collections/:collectionId", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); await owner(request); response.status(200).json(await deleteCollection(request.params.collectionId)); }));
  app.put("/platform/market/collections/:collectionId/items", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(200).json(await setCollectionItems(request.params.collectionId, parseOrThrow(collectionItemsSchema, request.body ?? {}).productIds));
  }));

  app.get("/platform/market/malls", asyncRoute(async (request, response) => { await owner(request); response.status(200).json(await listMalls()); }));
  app.post("/platform/market/malls", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(201).json(await createMall(parseOrThrow(mallSchema, request.body ?? {})));
  }));
  app.put("/platform/market/malls/:mallId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(200).json(await updateMall(request.params.mallId, parseOrThrow(mallSchema, request.body ?? {})));
  }));
  app.delete("/platform/market/malls/:mallId", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); await owner(request); response.status(200).json(await deleteMall(request.params.mallId)); }));
  app.put("/platform/market/malls/:mallId/stores", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(200).json(await setMallStores(request.params.mallId, parseOrThrow(mallStoresSchema, request.body ?? {}).storeSlugs));
  }));

  app.get("/platform/market/home-sections", asyncRoute(async (request, response) => { await owner(request); response.status(200).json(await listHomeSections()); }));
  app.put("/platform/market/home-sections", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(200).json(await replaceHomeSections(parseOrThrow(homeSectionsSchema, request.body ?? {})));
  }));

  app.get("/platform/market/categories", asyncRoute(async (request, response) => { await owner(request); response.status(200).json(await listCategoriesForOwner()); }));
  app.post("/platform/market/categories", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    response.status(201).json(await createCategory(parseOrThrow(categoryCreateSchema, request.body ?? {})));
  }));
  app.put("/platform/market/categories/:categoryId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request); await owner(request);
    const id = Number(request.params.categoryId);
    const input = parseOrThrow(categoryUpdateSchema, request.body ?? {});
    response.status(200).json(await updateCategory(Number.isInteger(id) && id > 0 ? id : -1, input));
  }));
}

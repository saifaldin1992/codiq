/**
 * ق-198 — the routes behind the merchant's own front-page images.
 *
 * Two audiences, deliberately split:
 *  · the MERCHANT lists, uploads, reorders, hides and deletes — behind
 *    `settings.manage`, because the shop's front page is its policy and not its
 *    daily traffic (the same code ق-179 chose for who may buy here);
 *  · the SHOPPER reads the live slides and their bytes, unauthenticated, through
 *    the storefront store resolver so a disabled store's banners vanish with it.
 *
 * The upload rides `authenticatedUpload` for the reason its own comment gives:
 * multer must not buffer a megabyte from a caller who is about to be refused.
 */
import multer from "multer";
import type { Express as ExpressApp } from "express";
import {
  asyncRoute,
  authenticatedUpload,
  limitUpload,
  uploadLimits,
  requireTrustedWriteOrigin,
  resolveStorefrontStore,
  cachePublicStorefront,
} from "../shared.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { parseOrThrow } from "../validate.js";
import {
  createStoreBannerSchema,
  updateStoreBannerSchema,
} from "../schemas/store-banner.schema.js";
import {
  addStoreBanner,
  deleteStoreBanner,
  listStoreBanners,
  publicStoreBanners,
  storeBannerObject,
  updateStoreBanner,
} from "../../services/store-banner.service.js";
import {
  getStoreBannerBytes,
  storeImageConstraints,
} from "../../services/product-image-storage.service.js";

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  // ق-238: the STORE-image ceiling, no longer the product one. A product upload
  // is re-encoded on the way in, so its fifteen megabytes cost nothing once
  // stored; a banner is kept exactly as sent, so its number is still a storage
  // number. Refusing at the multer layer also means a fifteen-megabyte body is
  // never buffered into memory only to be rejected a line later.
  limits: uploadLimits({ fileSize: storeImageConstraints.maxBytes, files: 1 }),
});

async function guardBannerUpload(request: import("express").Request) {
  requireTrustedWriteOrigin(request);
  const { store, actor } = await requireStoreActor(request, "settings.manage");
  await limitUpload("store_banner_upload", `${store.id}:${actor.kind}:${actor.id}`);
}

export function registerStoreBannerRoutes(app: ExpressApp) {
  app.get(
    "/merchant/stores/:storeSlug/banners",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "settings.manage");
      const { banners } = await listStoreBanners(store.id, store.slug);
      response.status(200).json({ storeSlug: store.slug, banners });
    })
  );

  app.post(
    "/merchant/stores/:storeSlug/banners",
    authenticatedUpload(guardBannerUpload, bannerUpload.single("image")),
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "settings.manage");
      const body = parseOrThrow(createStoreBannerSchema, request.body ?? {});
      // The merchant who owns the store pays for the bytes — the actor may be a
      // staff member, but the plan belongs to the merchant.
      response
        .status(201)
        .json({
          banner: await addStoreBanner(store.id, store.slug, store.merchantId, request.file, body),
        });
    })
  );

  app.patch(
    "/merchant/stores/:storeSlug/banners/:bannerId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "settings.manage");
      const body = parseOrThrow(updateStoreBannerSchema, request.body ?? {});
      response
        .status(200)
        .json({
          banner: await updateStoreBanner(store.id, store.slug, request.params.bannerId, body),
        });
    })
  );

  app.delete(
    "/merchant/stores/:storeSlug/banners/:bannerId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "settings.manage");
      await deleteStoreBanner(store.id, request.params.bannerId);
      response.status(204).end();
    })
  );

  // ── the shopper's side ────────────────────────────────────────────────────
  // `resolveStorefrontStore` rather than `resolveStore`: a disabled store, or one
  // whose merchant is disabled, must vanish here exactly as its products do.
  app.get(
    "/store/:storeSlug/banners",
    asyncRoute(async (request, response) => {
      const store = await resolveStorefrontStore(request.params.storeSlug);
      cachePublicStorefront(response);
      response
        .status(200)
        .json({ storeSlug: store.slug, banners: await publicStoreBanners(store.id, store.slug) });
    })
  );

  app.get(
    "/store/:storeSlug/banners/:bannerId/image",
    asyncRoute(async (request, response) => {
      const store = await resolveStorefrontStore(request.params.storeSlug);
      const banner = await storeBannerObject(store.id, request.params.bannerId);
      const bytes = await getStoreBannerBytes(banner.objectKey);
      // Immutable: the object key carries a uuid, so a slide's bytes never change
      // under one id. A replaced slide is a new row with a new id.
      response.setHeader("cache-control", "public, max-age=31536000, immutable");
      response.status(200).contentType(banner.contentType).send(bytes);
    })
  );
}

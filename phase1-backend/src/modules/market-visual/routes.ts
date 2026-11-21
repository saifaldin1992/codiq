/**
 * Marketplace M12 routes.
 *
 *   shopper  POST /market/search/image                 a photo (≤ 8 MB, JPG/PNG/WebP by its bytes) → look-alike products
 *            GET  /market/products/:productId/look-alike «يشبهه في الشكل»
 *   owner    GET  /platform/market/image-index          how many products have a fingerprint
 *            POST /platform/market/image-index/run      fingerprint the next batch
 */
import multer from "multer";
import type { Express, Request } from "express";
import {
  asyncRoute,
  authenticatedUpload,
  requireTrustedWriteOrigin,
  uploadLimits,
} from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { clientIp } from "../../http/client-ip.js";
import { HttpError } from "../../auth/auth.errors.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { detectedImageType } from "../../services/product-image-storage.service.js";
import {
  imageIndexStatus,
  indexProductImages,
  indexProductSoon,
  lookAlike,
  searchByImage,
} from "./visual.service.js";
import { imageCommitListeners } from "../../services/product-catalog.service.js";
import { imageIndexRunSchema } from "./schema.js";

/** The same number as http/errors.ts names in its «too large» message. */
export const SEARCH_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: SEARCH_PHOTO_MAX_BYTES, files: 1 }),
});

/** Anyone may search by photo (no account), so the guard is the origin and a per-address budget — before a byte is buffered. */
async function guardPhotoSearch(request: Request) {
  requireTrustedWriteOrigin(request);
  await consumeStorefrontRateLimit({
    scope: "market_image_search",
    rawKey: clientIp(request),
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
}

export function registerMarketVisualRoutes(app: Express) {
  if (!imageCommitListeners.includes(indexProductSoon)) imageCommitListeners.push(indexProductSoon);

  app.post(
    "/market/search/image",
    authenticatedUpload(guardPhotoSearch, photoUpload.single("image")),
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const file = request.file;
      if (!file?.buffer?.length)
        throw new HttpError(422, "IMAGE_REQUIRED", "اختر صورة أو التقطها.");
      if (!detectedImageType(file.buffer))
        throw new HttpError(
          422,
          "IMAGE_TYPE_NOT_ALLOWED",
          "الصورة يجب أن تكون JPG أو PNG أو WebP."
        );
      response.setHeader("cache-control", "private, no-store");
      response.status(200).json(await searchByImage(file.buffer));
    })
  );

  app.get(
    "/market/products/:productId/look-alike",
    asyncRoute(async (request, response) => {
      response.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=900");
      response.status(200).json(await lookAlike(String(request.params.productId)));
    })
  );

  app.get(
    "/platform/market/image-index",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "merchants.manage");
      response.status(200).json(await imageIndexStatus());
    })
  );

  app.post(
    "/platform/market/image-index/run",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "merchants.manage");
      const input = parseOrThrow(imageIndexRunSchema, request.body ?? {});
      response.status(200).json(await indexProductImages(input.limit));
    })
  );
}

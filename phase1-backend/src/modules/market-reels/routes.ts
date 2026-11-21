/**
 * Marketplace M10 routes — short videos.
 *
 *   anyone    /market/reels(?store=) · /market/reels/:reelId(/video|/poster|/view)
 *   shopper   /market/reels/:reelId/like
 *   merchant  /merchant/stores/:storeSlug/market-reels(/:reelId(/video))   (catalog.products.update)
 *   owner     /platform/market/reels(/:reelId(/decision|/video))           (brand.manage)
 */
import multer from "multer";
import type { Express, Request, Response } from "express";
import { asyncRoute, authenticatedUpload, limitUpload, requireTrustedWriteOrigin, uploadLimits } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { clientIp } from "../../http/client-ip.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { REEL_MAX_BYTES } from "../../services/product-image-storage.service.js";
import { optionalShopper, requireShopper } from "../market-account/shopper-auth.js";
import { decideReel, deleteReel, recordView, reelPage, reelPoster, reelQueue, reelVideo, reelsFeed, setLike, storeReels, uploadReel } from "./reels.service.js";
import { reelDecisionSchema, reelFeedQuerySchema, reelLikeSchema, reelQueueQuerySchema, reelUploadSchema } from "./schema.js";

// The video and an optional poster. The ceiling is the video's; the poster is
// held to the image ceiling by its own validator when it is stored.
const reelUpload = multer({ storage: multer.memoryStorage(), limits: uploadLimits({ fileSize: REEL_MAX_BYTES, files: 2 }) });

async function guardReelUpload(request: Request) {
  requireTrustedWriteOrigin(request);
  const { store, actor } = await requireStoreActor(request, "catalog.products.update");
  await limitUpload("market_reel_upload", `${store.id}:${actor.id}`);
}

function streamVideo(_request: Request, response: Response, video: Awaited<ReturnType<typeof reelVideo>>, cache: string) {
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("content-type", video.contentType);
  response.setHeader("cache-control", cache);
  if (video.contentLength !== null) response.setHeader("content-length", String(video.contentLength));
  if (video.partial && video.contentRange) { response.status(206); response.setHeader("content-range", video.contentRange); } else response.status(200);
  // A storage read that breaks mid-way ends the response instead of leaving it hanging.
  (video.body as NodeJS.ReadableStream & { on(event: "error", listener: () => void): unknown }).on("error", () => response.destroy());
  // The player hangs up as soon as it has what it wanted: stop reading from storage too.
  response.on("close", () => (video.body as unknown as { destroy?: () => void }).destroy?.());
  video.body.pipe(response);
}

export function registerMarketReelsRoutes(app: Express) {
  app.get("/market/reels", asyncRoute(async (request, response) => {
    const shopper = await optionalShopper(request);
    const query = parseOrThrow(reelFeedQuerySchema, request.query ?? {});
    response.status(200).json(await reelsFeed({ storeSlug: query.store, cursor: query.cursor, limit: query.limit }, shopper?.id ?? null));
  }));
  app.get("/market/reels/:reelId", asyncRoute(async (request, response) => {
    const shopper = await optionalShopper(request);
    response.status(200).json(await reelPage(request.params.reelId, shopper?.id ?? null));
  }));
  app.get("/market/reels/:reelId/video", asyncRoute(async (request, response) => {
    streamVideo(request, response, await reelVideo(request.params.reelId, request.header("range")), "public, max-age=3600");
  }));
  app.get("/market/reels/:reelId/poster", asyncRoute(async (request, response) => {
    const poster = await reelPoster(request.params.reelId);
    response.setHeader("cache-control", "public, max-age=86400");
    response.status(200).contentType(poster.contentType).send(poster.bytes);
  }));
  app.post("/market/reels/:reelId/view", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const shopper = await optionalShopper(request);
    await consumeStorefrontRateLimit({ scope: "market_reel_view", rawKey: clientIp(request), limit: 600, windowMs: 10 * 60 * 1000 });
    response.status(200).json(await recordView(request.params.reelId, { shopperId: shopper?.id ?? null, ip: clientIp(request) }));
  }));
  app.put("/market/reels/:reelId/like", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await setLike(request.params.reelId, shopper.id, parseOrThrow(reelLikeSchema, request.body ?? {}).liked));
  }));

  app.post("/merchant/stores/:storeSlug/market-reels", authenticatedUpload(guardReelUpload, reelUpload.fields([{ name: "video", maxCount: 1 }, { name: "poster", maxCount: 1 }])), asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "catalog.products.update");
    const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>;
    response.status(201).json(await uploadReel(store.id, parseOrThrow(reelUploadSchema, request.body ?? {}), { video: files.video?.[0], poster: files.poster?.[0] }));
  }));
  app.get("/merchant/stores/:storeSlug/market-reels", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "catalog.products.update");
    response.status(200).json({ storeSlug: store.slug, ...(await storeReels(store.id, request.query.cursor, request.query.limit)) });
  }));
  app.get("/merchant/stores/:storeSlug/market-reels/:reelId/video", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "catalog.products.update");
    streamVideo(request, response, await reelVideo(request.params.reelId, request.header("range"), { storeId: store.id }), "private, max-age=600");
  }));
  app.delete("/merchant/stores/:storeSlug/market-reels/:reelId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "catalog.products.update");
    response.status(200).json(await deleteReel(store.id, request.params.reelId));
  }));

  app.get("/platform/market/reels", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "brand.manage");
    const query = parseOrThrow(reelQueueQuerySchema, request.query ?? {});
    response.status(200).json(await reelQueue(query.status, query.cursor, query.limit));
  }));
  app.get("/platform/market/reels/:reelId/video", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "brand.manage");
    streamVideo(request, response, await reelVideo(request.params.reelId, request.header("range"), { owner: true }), "private, max-age=600");
  }));
  app.post("/platform/market/reels/:reelId/decision", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json(await decideReel(request.params.reelId, parseOrThrow(reelDecisionSchema, request.body ?? {})));
  }));
}

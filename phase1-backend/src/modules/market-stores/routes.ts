/**
 * Marketplace M1 routes — three audiences:
 *
 *   shopper  GET  /market/stores · /market/stores/:storeSlug(/reviews|/cover) · /market/ranking
 *   merchant      /merchant/stores/:storeSlug/market-profile(/listing|/cover)   (settings.manage)
 *   owner         /platform/market/stores(/:storeId/decision|/flags) · /platform/market/metrics/recompute  (merchants.manage)
 */
import multer from "multer";
import type { Express, Request } from "express";
import { asyncRoute, authenticatedUpload, limitUpload, requireTrustedWriteOrigin, uploadLimits } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { storeImageConstraints } from "../../services/product-image-storage.service.js";
import { listedStoreTenant, listMarketStores, marketStoresInBox, marketStoresOnRoute, marketStoreCover, marketStorePage, marketStoreReviews, rankingExplanation } from "./directory.service.js";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
import { leaveMarket, marketProfile, removeStoreCover, requestMarketListing, setStoreCover, updateMarketProfile } from "./profile.service.js";
import { decideMarketListing, marketQueue, setMarketFlags } from "./moderation.service.js";
import { recomputeMarketMetrics } from "./metrics.service.js";
import { recomputeProductStats } from "../market-catalog/stats.service.js";
import { marketDecisionSchema, marketFlagsSchema, marketMapQuerySchema, marketProfileSchema, marketRouteQuerySchema, marketStoreQuerySchema } from "./schema.js";
import { mapConfig, mapTile } from "./map-tiles.service.js";

const coverUpload = multer({ storage: multer.memoryStorage(), limits: uploadLimits({ fileSize: storeImageConstraints.maxBytes, files: 1 }) });

async function guardCoverUpload(request: Request) {
  requireTrustedWriteOrigin(request);
  const { store, actor } = await requireStoreActor(request, "settings.manage");
  await limitUpload("store_cover_upload", `${store.id}:${actor.kind}:${actor.id}`);
}

/** Public lists change with every order; a minute at the edge absorbs a crowd without serving stale ranks for long. */
const SHORT_PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=300";

export function registerMarketStoreRoutes(app: Express) {
  // ── shopper ───────────────────────────────────────────────────────────────
  app.get("/market/stores", asyncRoute(async (request, response) => {
    const query = parseOrThrow(marketStoreQuerySchema, request.query ?? {});
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await listMarketStores(query));
  }));

  app.get("/market/ranking", asyncRoute(async (_request, response) => {
    response.setHeader("cache-control", "public, max-age=3600");
    response.status(200).json(rankingExplanation());
  }));

  // ── Marketplace M11: the map, «على طريقك», and the map's tiles ─────────────
  // Registered before /market/stores/:storeSlug, which would otherwise read «map» as a slug.
  app.get("/market/stores/map", asyncRoute(async (request, response) => {
    const box = parseOrThrow(marketMapQuerySchema, request.query ?? {});
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await marketStoresInBox(box));
  }));

  app.get("/market/stores/on-route", asyncRoute(async (request, response) => {
    const query = parseOrThrow(marketRouteQuerySchema, request.query ?? {});
    // Two points of a shopper's errand: not for a shared cache.
    response.setHeader("cache-control", "private, no-store");
    response.status(200).json(await marketStoresOnRoute({ from: query.from, to: query.to, corridorKm: query.corridor }));
  }));

  app.get("/market/map/config", asyncRoute(async (_request, response) => {
    response.setHeader("cache-control", "public, max-age=300");
    response.status(200).json(mapConfig());
  }));

  app.get("/market/map/tiles/:z/:x/:y", asyncRoute(async (request, response) => {
    const tile = await mapTile(String(request.params.z), String(request.params.x), String(request.params.y));
    response.setHeader("content-type", tile.type);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
    response.status(200).end(tile.body);
  }));

  app.get("/market/stores/:storeSlug", asyncRoute(async (request, response) => {
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await marketStorePage(request.params.storeSlug));
  }));

  app.get("/market/stores/:storeSlug/reviews", asyncRoute(async (request, response) => {
    const store = await listedStoreTenant(request.params.storeSlug);
    // The same switch as a product's reviews: when the owner turns reviews off, the store's page stops showing them too.
    await assertCapabilityAvailable("cx.reviews", store);
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await marketStoreReviews(store, request.query.cursor, request.query.limit));
  }));

  app.get("/market/stores/:storeSlug/cover", asyncRoute(async (request, response) => {
    const cover = await marketStoreCover(request.params.storeSlug);
    // Immutable: the URL carries `?v=<uuid>` that changes with every upload.
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.status(200).contentType(cover.contentType).send(cover.bytes);
  }));

  // ── merchant ──────────────────────────────────────────────────────────────
  app.get("/merchant/stores/:storeSlug/market-profile", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json(await marketProfile(store.id));
  }));

  app.put("/merchant/stores/:storeSlug/market-profile", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    const input = parseOrThrow(marketProfileSchema, request.body ?? {});
    response.status(200).json(await updateMarketProfile(store.id, input));
  }));

  app.post("/merchant/stores/:storeSlug/market-profile/listing", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json(await requestMarketListing(store.id));
  }));

  app.delete("/merchant/stores/:storeSlug/market-profile/listing", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json(await leaveMarket(store.id));
  }));

  app.post("/merchant/stores/:storeSlug/market-profile/cover", authenticatedUpload(guardCoverUpload, coverUpload.single("image")), asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json(await setStoreCover(store.id, store.merchantId, request.file));
  }));

  app.delete("/merchant/stores/:storeSlug/market-profile/cover", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json(await removeStoreCover(store.id));
  }));

  // ── owner ─────────────────────────────────────────────────────────────────
  app.get("/platform/market/stores", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "merchants.manage");
    response.status(200).json(await marketQueue(request.query.status, request.query.cursor, request.query.limit));
  }));

  app.put("/platform/market/stores/:storeId/decision", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "merchants.manage");
    const input = parseOrThrow(marketDecisionSchema, request.body ?? {});
    response.status(200).json(await decideMarketListing(request.params.storeId, input));
  }));

  app.put("/platform/market/stores/:storeId/flags", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "merchants.manage");
    const input = parseOrThrow(marketFlagsSchema, request.body ?? {});
    response.status(200).json(await setMarketFlags(request.params.storeId, input));
  }));

  app.post("/platform/market/metrics/recompute", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "merchants.manage");
    response.status(200).json({ ...(await recomputeMarketMetrics()), ...(await recomputeProductStats()) });
  }));
}

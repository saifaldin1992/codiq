/**
 * Marketplace M9 routes — the prize wheel.
 *
 *   anyone   /market/wheel · /market/wheel/board
 *   shopper  /market/wheel/spin · /market/wheel/wins(/:winId/claim) · /market/wheel/spins
 *   owner    /platform/market/wheels(/:wheelId(/prizes|/report|/wins)) · /platform/market/wheel-prizes/:prizeId
 *            /platform/market/wheel-wins/:winId/status · /platform/market/wheel/support   (brand.manage)
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { normalizeIraqiMobile } from "../../auth/identity.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { optionalShopper, requireShopper } from "../market-account/shopper-auth.js";
import {
  addPrize,
  claimWin,
  leaderboard,
  myWins,
  ownerWheels,
  saveWheel,
  setWinStatus,
  spin,
  spinLog,
  supportSpins,
  updatePrize,
  wheelPage,
  wheelReport,
  winsQueue,
} from "./wheel.service.js";
import {
  claimSchema,
  prizeSchema,
  queueQuerySchema,
  supportQuerySchema,
  wheelSchema,
  winStatusSchema,
} from "./schema.js";

export function registerMarketWheelRoutes(app: Express) {
  app.get(
    "/market/wheel",
    asyncRoute(async (request, response) => {
      const shopper = await optionalShopper(request);
      response.status(200).json(await wheelPage(shopper?.id ?? null));
    })
  );
  app.get(
    "/market/wheel/board",
    asyncRoute(async (request, response) => {
      const shopper = await optionalShopper(request);
      response.status(200).json(await leaderboard(shopper?.id ?? null));
    })
  );
  app.post(
    "/market/wheel/spin",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      // A spin is cheap to ask for; a burst of them is not a person.
      await consumeStorefrontRateLimit({
        scope: "market_wheel_spin",
        rawKey: shopper.id,
        limit: 30,
        windowMs: 60_000,
      });
      response.status(200).json(await spin(shopper.id));
    })
  );
  app.get(
    "/market/wheel/wins",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(await myWins(shopper.id, request.query.cursor, request.query.limit));
    })
  );
  app.post(
    "/market/wheel/wins/:winId/claim",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(
          await claimWin(
            shopper.id,
            request.params.winId,
            parseOrThrow(claimSchema, request.body ?? {})
          )
        );
    })
  );
  app.get(
    "/market/wheel/spins",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(await spinLog(shopper.id, request.query.cursor, request.query.limit));
    })
  );

  app.get(
    "/platform/market/wheels",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      response.status(200).json(await ownerWheels());
    })
  );
  app.post(
    "/platform/market/wheels",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(201)
        .json(await saveWheel(null, parseOrThrow(wheelSchema, request.body ?? {})));
    })
  );
  app.put(
    "/platform/market/wheels/:wheelId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await saveWheel(request.params.wheelId, parseOrThrow(wheelSchema, request.body ?? {}))
        );
    })
  );
  app.post(
    "/platform/market/wheels/:wheelId/prizes",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(201)
        .json(
          await addPrize(request.params.wheelId, parseOrThrow(prizeSchema, request.body ?? {}))
        );
    })
  );
  app.put(
    "/platform/market/wheel-prizes/:prizeId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await updatePrize(request.params.prizeId, parseOrThrow(prizeSchema, request.body ?? {}))
        );
    })
  );
  app.get(
    "/platform/market/wheels/:wheelId/report",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      response.status(200).json(await wheelReport(request.params.wheelId));
    })
  );
  app.get(
    "/platform/market/wheels/:wheelId/wins",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      const query = parseOrThrow(queueQuerySchema, request.query ?? {});
      response
        .status(200)
        .json(await winsQueue(request.params.wheelId, query.status, query.cursor, query.limit));
    })
  );
  app.post(
    "/platform/market/wheel-wins/:winId/status",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await setWinStatus(
            request.params.winId,
            parseOrThrow(winStatusSchema, request.body ?? {})
          )
        );
    })
  );
  app.get(
    "/platform/market/wheel/support",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      const query = parseOrThrow(supportQuerySchema, request.query ?? {});
      response.status(200).json(await supportSpins(normalizeIraqiMobile(query.phone)));
    })
  );
}

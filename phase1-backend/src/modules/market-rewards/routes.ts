/**
 * Marketplace M8b routes — the platform's coupons and points.
 *
 *   anyone    /market/coupons · /market/coupons/:code
 *   shopper   /market/coupons/:code/claim · /market/me/coupons · /market/me/points · /market/points/redeem
 *   owner     /platform/market/coupons(/:couponId(/stores)) · /platform/market/rewards/report   (brand.manage)
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { optionalShopper, requireShopper } from "../market-account/shopper-auth.js";
import {
  claimCoupon,
  couponPage,
  couponsPage,
  createCoupon,
  ownerCoupons,
  pointsPage,
  redeemPoints,
  rewardsReport,
  setCouponStores,
  updateCoupon,
  wallet,
} from "./rewards.service.js";
import { couponSchema, couponStoresSchema, redeemSchema } from "./schema.js";

export function registerMarketRewardsRoutes(app: Express) {
  app.get(
    "/market/coupons",
    asyncRoute(async (request, response) => {
      const shopper = await optionalShopper(request);
      response.status(200).json(await couponsPage(shopper?.id ?? null));
    })
  );
  app.get(
    "/market/coupons/:code",
    asyncRoute(async (request, response) => {
      const shopper = await optionalShopper(request);
      response.status(200).json(await couponPage(request.params.code, shopper?.id ?? null));
    })
  );
  app.post(
    "/market/coupons/:code/claim",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response.status(201).json(await claimCoupon(shopper.id, request.params.code));
    })
  );
  app.get(
    "/market/me/coupons",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(
          await wallet(shopper.id, request.query.tab, request.query.cursor, request.query.limit)
        );
    })
  );
  app.get(
    "/market/me/points",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(await pointsPage(shopper.id, request.query.cursor, request.query.limit));
    })
  );
  app.post(
    "/market/points/redeem",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(201)
        .json(
          await redeemPoints(shopper.id, parseOrThrow(redeemSchema, request.body ?? {}).couponId)
        );
    })
  );

  app.get(
    "/platform/market/coupons",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      response.status(200).json(await ownerCoupons());
    })
  );
  app.post(
    "/platform/market/coupons",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response.status(201).json(await createCoupon(parseOrThrow(couponSchema, request.body ?? {})));
    })
  );
  app.put(
    "/platform/market/coupons/:couponId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await updateCoupon(
            request.params.couponId,
            parseOrThrow(couponSchema, request.body ?? {})
          )
        );
    })
  );
  app.put(
    "/platform/market/coupons/:couponId/stores",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await setCouponStores(
            request.params.couponId,
            parseOrThrow(couponStoresSchema, request.body ?? {}).storeSlugs
          )
        );
    })
  );
  app.get(
    "/platform/market/rewards/report",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      response.status(200).json(await rewardsReport());
    })
  );
}

/**
 * Marketplace M8a routes — campaigns and «عرض الساعة».
 *
 *   shopper   /market/campaigns/live · /market/campaigns/:slug
 *   merchant  /merchant/stores/:storeSlug/market-campaigns · /market-deals(/:dealId)   (catalog.products.update)
 *   owner     /platform/market/campaigns(/:campaignId(/days|/slots(/:slotId)|/deals)) · /platform/market/deals/:dealId/decision  (brand.manage)
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import {
  addSlot,
  campaignDeals,
  campaignPage,
  createCampaign,
  decideDeal,
  deleteSlot,
  liveCampaigns,
  ownerCampaign,
  ownerCampaigns,
  proposeDeal,
  replaceCampaignDays,
  storeCampaigns,
  updateCampaign,
  withdrawDeal,
} from "./campaigns.service.js";
import {
  campaignDaysSchema,
  campaignSchema,
  dealDecisionSchema,
  dealsQuerySchema,
  proposeDealSchema,
  slotSchema,
} from "./schema.js";

export function registerMarketCampaignRoutes(app: Express) {
  // ── the shopper ──────────────────────────────────────────────────────────
  app.get(
    "/market/campaigns/live",
    asyncRoute(async (_request, response) => {
      response.setHeader("cache-control", "public, max-age=30");
      response.status(200).json(await liveCampaigns());
    })
  );
  app.get(
    "/market/campaigns/:slug",
    asyncRoute(async (request, response) => {
      response.status(200).json(await campaignPage(request.params.slug));
    })
  );

  // ── the store ────────────────────────────────────────────────────────────
  app.get(
    "/merchant/stores/:storeSlug/market-campaigns",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.update");
      response.status(200).json({ storeSlug: store.slug, ...(await storeCampaigns(store.id)) });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/market-deals",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.update");
      response
        .status(201)
        .json(await proposeDeal(store.id, parseOrThrow(proposeDealSchema, request.body ?? {})));
    })
  );
  app.delete(
    "/merchant/stores/:storeSlug/market-deals/:dealId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.update");
      response.status(200).json(await withdrawDeal(store.id, request.params.dealId));
    })
  );

  // ── the owner ────────────────────────────────────────────────────────────
  app.get(
    "/platform/market/campaigns",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      response.status(200).json(await ownerCampaigns());
    })
  );
  app.post(
    "/platform/market/campaigns",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(201)
        .json(await createCampaign(parseOrThrow(campaignSchema, request.body ?? {})));
    })
  );
  app.get(
    "/platform/market/campaigns/:campaignId",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      response.status(200).json(await ownerCampaign(request.params.campaignId));
    })
  );
  app.put(
    "/platform/market/campaigns/:campaignId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await updateCampaign(
            request.params.campaignId,
            parseOrThrow(campaignSchema, request.body ?? {})
          )
        );
    })
  );
  app.put(
    "/platform/market/campaigns/:campaignId/days",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await replaceCampaignDays(
            request.params.campaignId,
            parseOrThrow(campaignDaysSchema, request.body ?? {}).days
          )
        );
    })
  );
  app.post(
    "/platform/market/campaigns/:campaignId/slots",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(201)
        .json(
          await addSlot(request.params.campaignId, parseOrThrow(slotSchema, request.body ?? {}))
        );
    })
  );
  app.delete(
    "/platform/market/campaigns/:campaignId/slots/:slotId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response.status(200).json(await deleteSlot(request.params.campaignId, request.params.slotId));
    })
  );
  app.get(
    "/platform/market/campaigns/:campaignId/deals",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "brand.manage");
      const query = parseOrThrow(dealsQuerySchema, request.query ?? {});
      response
        .status(200)
        .json(
          await campaignDeals(request.params.campaignId, query.status, query.cursor, query.limit)
        );
    })
  );
  app.post(
    "/platform/market/deals/:dealId/decision",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "brand.manage");
      response
        .status(200)
        .json(
          await decideDeal(
            request.params.dealId,
            parseOrThrow(dealDecisionSchema, request.body ?? {})
          )
        );
    })
  );
}

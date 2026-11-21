/**
 * GET /market/geo — public. The same for every visitor, so the browser and the
 * edge may keep it for an hour; a district the owner adds shows within that.
 */
import type { Express } from "express";
import { asyncRoute } from "../../http/shared.js";
import { marketGeography } from "./service.js";

export function registerMarketGeoRoutes(app: Express) {
  app.get(
    "/market/geo",
    asyncRoute(async (_request, response) => {
      response.setHeader("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
      response.status(200).json(await marketGeography());
    })
  );
}

import { defineModule } from "../platform-module.js";
import { registerMarketReelsRoutes } from "./routes.js";

/** Marketplace M10: short videos — stores upload, the owner approves, shoppers watch, like and buy. */
export const marketReelsModule = defineModule({
  id: "market-reels",
  domain: "marketing",
  title: "السوق — المقاطع القصيرة",
  register: registerMarketReelsRoutes,
});

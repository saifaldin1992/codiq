import { defineModule } from "../platform-module.js";
import { registerMarketRewardsRoutes } from "./routes.js";

/** Marketplace M8b: the platform's own coupons (funded by the platform) and points with tiers. */
export const marketRewardsModule = defineModule({
  id: "market-rewards",
  domain: "marketing",
  title: "السوق — كوبونات المنصّة ونقاطها",
  register: registerMarketRewardsRoutes,
});

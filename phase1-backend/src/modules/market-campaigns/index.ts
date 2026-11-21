import { defineModule } from "../platform-module.js";
import { registerMarketCampaignRoutes } from "./routes.js";

/** Marketplace M8a: seasonal campaigns, their day schedule, and «عرض الساعة» funded by the stores. */
export const marketCampaignsModule = defineModule({
  id: "market-campaigns",
  domain: "marketing",
  title: "السوق — الحملات وعروض الساعة",
  register: registerMarketCampaignRoutes,
});

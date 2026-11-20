import { defineModule } from "../platform-module.js";
import { registerMarketGeoRoutes } from "./routes.js";

/** Marketplace M0: the governorates and the districts inside them, for every market screen that asks «where?». */
export const marketGeoModule = defineModule({
  id: "market-geo",
  domain: "storefront",
  title: "السوق — المحافظات ومناطقها",
  register: registerMarketGeoRoutes,
});

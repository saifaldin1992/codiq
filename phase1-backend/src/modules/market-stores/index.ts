import { defineModule } from "../platform-module.js";
import { registerMarketStoreRoutes } from "./routes.js";

/** Marketplace M1: the stores directory, each store's market page, the merchant's market profile and the owner's listing queue. */
export const marketStoresModule = defineModule({
  id: "market-stores",
  domain: "storefront",
  title: "السوق — دليل المتاجر وصفحة المتجر",
  register: registerMarketStoreRoutes,
});

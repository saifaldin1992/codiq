import { defineModule } from "../platform-module.js";
import { registerMarketCatalogRoutes } from "./routes.js";

/** Marketplace M2: the market's categories, products across every listed store, search, and the merchant's market details per product. */
export const marketCatalogModule = defineModule({
  id: "market-catalog",
  domain: "catalog",
  title: "السوق — المنتجات والفئات والبحث",
  register: registerMarketCatalogRoutes,
});

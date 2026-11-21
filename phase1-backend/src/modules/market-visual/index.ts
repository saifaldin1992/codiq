import { defineModule } from "../platform-module.js";
import { registerMarketVisualRoutes } from "./routes.js";

/** Marketplace M12: search the market with a photo, and «يشبهه في الشكل» — pgvector over a local visual fingerprint. */
export const marketVisualModule = defineModule({
  id: "market-visual",
  domain: "catalog",
  title: "السوق — البحث بالصورة",
  register: registerMarketVisualRoutes,
});

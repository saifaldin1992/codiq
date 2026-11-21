import { defineModule } from "../platform-module.js";
import { registerMarketSupportRoutes } from "./routes.js";

/** Marketplace M7b: support tickets from a delivered order — the shopper, the store that sold it, and the owner. */
export const marketSupportModule = defineModule({
  id: "market-support",
  domain: "orders",
  title: "السوق — تذاكر الدعم",
  register: registerMarketSupportRoutes,
});

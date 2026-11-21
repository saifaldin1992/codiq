import { defineModule } from "../platform-module.js";
import { registerMarketCartRoutes } from "./routes.js";

/** Marketplace M5: one cart across the market, checked out store by store through each store's own checkout, and «طلباتي». */
export const marketCartModule = defineModule({
  id: "market-cart",
  domain: "orders",
  title: "السوق — السلّة الموحّدة والدفع لكل متجر وطلباتي",
  register: registerMarketCartRoutes,
});

import { defineModule } from "../platform-module.js";
import { registerMarketOrdersRoutes } from "./routes.js";

/** Marketplace M6: after the order — cancel with a reason, receipt code, delivery stages, ratings, returns. */
export const marketOrdersModule = defineModule({
  id: "market-orders",
  domain: "orders",
  title: "السوق — ما بعد الطلب: الإلغاء والاستلام والتقييم والإرجاع",
  register: registerMarketOrdersRoutes,
});

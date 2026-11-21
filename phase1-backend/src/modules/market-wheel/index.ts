import { defineModule } from "../platform-module.js";
import { registerMarketWheelRoutes } from "./routes.js";

/** Marketplace M9: the prize wheel — daily and earned spins, a server-side draw against stock, prizes to claim. */
export const marketWheelModule = defineModule({
  id: "market-wheel",
  domain: "marketing",
  title: "السوق — عجلة الجوائز",
  register: registerMarketWheelRoutes,
});

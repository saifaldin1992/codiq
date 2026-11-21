import { defineModule } from "../platform-module.js";
import { registerMarketPartnerRoutes } from "./routes.js";

/** Marketplace M13b: sign-in from the partner app (A2) and single-use payment links it pays (F10). */
export const marketPartnerModule = defineModule({
  id: "market-partner",
  domain: "identity",
  title: "السوق — التطبيق الشريك",
  register: registerMarketPartnerRoutes,
});

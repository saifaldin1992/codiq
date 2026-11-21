import { defineModule } from "../platform-module.js";
import { registerMarketHelpRoutes } from "./routes.js";

/** Marketplace M7a: favourites and followed stores, the shopper's inbox, help, contact and app feedback. */
export const marketHelpModule = defineModule({
  id: "market-help",
  domain: "storefront",
  title: "السوق — المفضّلة والإشعارات والمساعدة",
  register: registerMarketHelpRoutes,
});

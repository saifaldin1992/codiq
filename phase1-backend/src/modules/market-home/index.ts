import { defineModule } from "../platform-module.js";
import { registerMarketHomeRoutes } from "./routes.js";

/** Marketplace M3: the market's front page, banners, collections, malls and the category tree, edited by the owner. */
export const marketHomeModule = defineModule({
  id: "market-home",
  domain: "marketing",
  title: "السوق — الرئيسيّة والبنرات والمجموعات والمولات",
  register: registerMarketHomeRoutes,
});

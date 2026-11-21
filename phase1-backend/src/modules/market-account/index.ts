import { defineModule } from "../platform-module.js";
import { registerMarketAccountRoutes } from "./routes.js";

/** Marketplace M4: the market shopper — phone sign-in, profile, picture and delivery addresses. */
export const marketAccountModule = defineModule({
  id: "market-account",
  domain: "identity",
  title: "السوق — حساب المتسوّق وعناوينه",
  register: registerMarketAccountRoutes,
});

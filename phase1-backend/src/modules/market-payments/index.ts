import { defineModule } from "../platform-module.js";
import { registerMarketPaymentsRoutes } from "./routes.js";
import { onOrderStatusChanged } from "./payments.service.js";

/** Marketplace M13a: card payment and instalments through one provider interface; money follows the order. */
export const marketPaymentsModule = defineModule({
  id: "market-payments",
  domain: "orders",
  title: "السوق — الدفع الإلكترونيّ والتقسيط",
  register: registerMarketPaymentsRoutes,
  subscribe(bus) {
    bus.on("order.status_changed", "market-payments", (payload) => onOrderStatusChanged(payload));
  },
});

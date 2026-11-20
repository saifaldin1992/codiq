/**
 * ق-202 — the merchant's home page, one aggregate behind `orders.view`: the
 * same permission the overview cards and the analytics already require, so a
 * packer who may see orders may see the day they add up to.
 */
import type { Express as ExpressApp } from "express";
import { asyncRoute } from "../shared.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { merchantHome } from "../../services/merchant-home.service.js";

export function registerMerchantHomeRoutes(app: ExpressApp) {
  app.get("/merchant/stores/:storeSlug/dashboard/home", asyncRoute(async (request, response) => {
    const { store, actor } = await requireStoreActor(request, "orders.view");
    // Audit 14-أ: the merchant-wide wallet is for the merchant, not for staff holding orders.view.
    response.status(200).json({ storeSlug: store.slug, home: await merchantHome(store.id, store.merchantId, request.query as Record<string, unknown>, new Date(), { includeWallet: actor.kind === "merchant" }) });
  }));
}

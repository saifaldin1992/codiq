/**
 * ق-209 — the merchant's payment switches. Behind `settings.manage`: which
 * money a shop accepts is its policy, not its daily traffic. The shopper's
 * side rides `public-config` (the enabled methods) and the checkout itself.
 */
import type { Express as ExpressApp } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../shared.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { parseOrThrow } from "../validate.js";
import { updatePaymentMethodSchema } from "../schemas/payment-methods.schema.js";
import { listPaymentMethods, updatePaymentMethod } from "../../services/payment-methods.service.js";

export function registerPaymentMethodRoutes(app: ExpressApp) {
  app.get(
    "/merchant/stores/:storeSlug/payment-methods",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "settings.manage");
      response.status(200).json({ storeSlug: store.slug, ...(await listPaymentMethods(store.id)) });
    })
  );

  app.put(
    "/merchant/stores/:storeSlug/payment-methods/:code",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "settings.manage");
      const body = parseOrThrow(updatePaymentMethodSchema, request.body ?? {});
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await updatePaymentMethod(store.id, request.params.code, body)),
        });
    })
  );
}

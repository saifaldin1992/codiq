/**
 * Marketplace M6 routes — after the order.
 *
 *   shopper   /market/orders/:orderId/(cancel|return|rating) · /market/ratings(/pending) · /market/after-sales/options
 *   merchant  /merchant/stores/:storeSlug/orders/:orderId/market(/delivery-stage|/handover)
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { requireShopper } from "../market-account/shopper-auth.js";
import {
  afterSalesOptions, cancelMarketOrder, confirmHandover, myRatings, pendingRatings, rateMarketOrder,
  requestMarketReturn, setDeliveryStage, storeOrderMarketView, withdrawMarketReturn,
} from "./after-sales.service.js";
import { cancelSchema, deliveryStageSchema, handoverSchema, ratingSchema, returnSchema } from "./schema.js";

export function registerMarketOrdersRoutes(app: Express) {
  app.get("/market/after-sales/options", asyncRoute(async (_request, response) => {
    response.status(200).json(afterSalesOptions());
  }));

  app.post("/market/orders/:orderId/cancel", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await cancelMarketOrder(shopper.id, request.params.orderId, parseOrThrow(cancelSchema, request.body ?? {})));
  }));

  app.post("/market/orders/:orderId/return", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(201).json(await requestMarketReturn(shopper.id, request.params.orderId, parseOrThrow(returnSchema, request.body ?? {})));
  }));

  app.delete("/market/orders/:orderId/return", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await withdrawMarketReturn(shopper.id, request.params.orderId));
  }));

  app.put("/market/orders/:orderId/rating", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await rateMarketOrder(shopper.id, request.params.orderId, parseOrThrow(ratingSchema, request.body ?? {})));
  }));

  app.get("/market/ratings/pending", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await pendingRatings(shopper.id, request.query.cursor, request.query.limit));
  }));

  app.get("/market/ratings", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await myRatings(shopper.id, request.query.cursor, request.query.limit));
  }));

  app.get("/merchant/stores/:storeSlug/orders/:orderId/market", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    response.status(200).json(await storeOrderMarketView(store.id, request.params.orderId));
  }));

  app.put("/merchant/stores/:storeSlug/orders/:orderId/delivery-stage", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "orders.update");
    const input = parseOrThrow(deliveryStageSchema, request.body ?? {});
    response.status(200).json(await setDeliveryStage(store.id, request.params.orderId, input.stage));
  }));

  app.post("/merchant/stores/:storeSlug/orders/:orderId/handover", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "orders.update");
    const input = parseOrThrow(handoverSchema, request.body ?? {});
    response.status(200).json(await confirmHandover(store.id, actor, request.params.orderId, input.code));
  }));
}

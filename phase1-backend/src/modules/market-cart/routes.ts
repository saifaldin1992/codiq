/**
 * Marketplace M5 routes — the shopper's cart, per-store checkout and his orders.
 * All require a shopper session; every write checks its origin.
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requireShopper } from "../market-account/shopper-auth.js";
import { acceptCartPrices, addCartLine, clearCart, marketCartView, removeCartLine, updateCartLine } from "./cart.service.js";
import { checkoutSummary, placeMarketOrder, shopperOrder, shopperOrders } from "./checkout.service.js";
import { addItemSchema, cancelOrderSchema, placeOrderSchema, summaryQuerySchema, updateItemSchema } from "./schema.js";
import { cancelShopperOrder } from "./after-sale.service.js";

export function registerMarketCartRoutes(app: Express) {
  app.get("/market/cart", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await marketCartView(shopper.id));
  }));

  app.post("/market/cart/items", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await addCartLine(shopper.id, parseOrThrow(addItemSchema, request.body ?? {})));
  }));

  app.patch("/market/cart/items/:lineId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await updateCartLine(shopper.id, request.params.lineId, parseOrThrow(updateItemSchema, request.body ?? {})));
  }));

  app.delete("/market/cart/items/:lineId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await removeCartLine(shopper.id, request.params.lineId));
  }));

  app.delete("/market/cart", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await clearCart(shopper.id));
  }));

  app.post("/market/cart/accept-prices", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await acceptCartPrices(shopper.id));
  }));

  app.get("/market/checkout/:storeSlug", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    const query = parseOrThrow(summaryQuerySchema, request.query ?? {});
    response.status(200).json(await checkoutSummary(shopper, request.params.storeSlug, query));
  }));

  app.post("/market/checkout/:storeSlug", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    const input = parseOrThrow(placeOrderSchema, request.body ?? {});
    const result = await placeMarketOrder(shopper, request.params.storeSlug, input, request.header("idempotency-key"));
    response.status(result.replayed ? 200 : 201).json({ storeSlug: request.params.storeSlug, replayed: result.replayed, order: { id: result.order.id, orderNumber: result.order.orderNumber, totalIqd: result.order.totalIqd, status: result.order.status } });
  }));

  app.get("/market/orders", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await shopperOrders(shopper.id, request.query.cursor, request.query.limit, request.query.status));
  }));

  app.get("/market/orders/:orderId", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await shopperOrder(shopper.id, request.params.orderId));
  }));

  // M6 «إلغاء الطلب»: a reason from the list, through the store's own self-cancel (PG-1).
  app.post("/market/orders/:orderId/cancel", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    const input = parseOrThrow(cancelOrderSchema, request.body ?? {});
    response.status(200).json(await cancelShopperOrder(shopper.id, request.params.orderId, input));
  }));
}

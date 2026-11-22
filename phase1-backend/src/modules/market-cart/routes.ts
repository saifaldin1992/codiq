/**
 * Marketplace M5 routes — the shopper's cart, per-store checkout and his orders.
 * All require a shopper session; every write checks its origin.
 */
import type { Express } from "express";
import {
  asyncRoute,
  limitStorefrontWriteWithAddressCeiling,
  refundStorefrontWriteWithAddressCeiling,
  requireTrustedWriteOrigin,
} from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { clientIp } from "../../http/client-ip.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { requireShopper } from "../market-account/shopper-auth.js";
import {
  acceptCartPrices,
  addCartLine,
  clearCart,
  marketCartView,
  removeCartLine,
  updateCartLine,
} from "./cart.service.js";
import {
  checkoutSummary,
  goodsToCover,
  placeMarketOrder,
  shopperOrder,
  shopperOrders,
} from "./checkout.service.js";
import { startInstalmentPlan } from "../market-payments/payments.service.js";
import { listedStoreTenant } from "../market-stores/directory.service.js";
import {
  addItemSchema,
  placeOrderSchema,
  summaryQuerySchema,
  updateItemSchema,
  instalmentStartSchema,
} from "./schema.js";

export function registerMarketCartRoutes(app: Express) {
  app.get(
    "/market/cart",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response.status(200).json(await marketCartView(shopper.id));
    })
  );

  app.post(
    "/market/cart/items",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(await addCartLine(shopper.id, parseOrThrow(addItemSchema, request.body ?? {})));
    })
  );

  app.patch(
    "/market/cart/items/:lineId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(
          await updateCartLine(
            shopper.id,
            request.params.lineId,
            parseOrThrow(updateItemSchema, request.body ?? {})
          )
        );
    })
  );

  app.delete(
    "/market/cart/items/:lineId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response.status(200).json(await removeCartLine(shopper.id, request.params.lineId));
    })
  );

  app.delete(
    "/market/cart",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response.status(200).json(await clearCart(shopper.id));
    })
  );

  app.post(
    "/market/cart/accept-prices",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response.status(200).json(await acceptCartPrices(shopper.id));
    })
  );

  app.get(
    "/market/checkout/:storeSlug",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      const query = parseOrThrow(summaryQuerySchema, request.query ?? {});
      // Security pass 2026-11: a coupon in the query is a coupon GUESS until proven
      // otherwise. The storefront's own preview allows thirty per ten minutes; this
      // path reached the same `previewCoupon` with no limit at all, so a shopper
      // could enumerate a store's codes. Same budget here, per shopper per store,
      // and a ceiling per address for many accounts behind one IP.
      if (query.coupon) {
        await consumeStorefrontRateLimit({
          scope: "market_coupon_preview",
          rawKey: `${shopper.id}:${request.params.storeSlug}`,
          limit: 30,
          windowMs: 10 * 60 * 1000,
        });
        await consumeStorefrontRateLimit({
          scope: "market_coupon_preview_ip",
          rawKey: clientIp(request),
          limit: 120,
          windowMs: 10 * 60 * 1000,
        });
      }
      response.status(200).json(await checkoutSummary(shopper, request.params.storeSlug, query));
    })
  );

  app.post(
    "/market/checkout/:storeSlug",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      // The storefront checkout's budget (12 per shopper, 40 per address): each POST can try a
      // coupon code, so the summary's limit meant nothing without this (review batch 2, م-١٤).
      await limitStorefrontWriteWithAddressCeiling(request, "market_checkout", shopper.id, 12, 40);
      const input = parseOrThrow(placeOrderSchema, request.body ?? {});
      const result = await placeMarketOrder(
        shopper,
        request.params.storeSlug,
        input,
        request.header("idempotency-key")
      );
      // ق-224: a replay reads an order that exists — its budget goes back.
      if (result.replayed)
        await refundStorefrontWriteWithAddressCeiling(request, "market_checkout", shopper.id);
      response.status(result.replayed ? 200 : 201).json({
        storeSlug: request.params.storeSlug,
        replayed: result.replayed,
        order: {
          id: result.order.id,
          orderNumber: result.order.orderNumber,
          totalIqd: result.order.totalIqd,
          status: result.order.status,
        },
        ...("payment" in result && result.payment ? { payment: result.payment } : {}),
      });
    })
  );

  // Marketplace M13a: the shopper chose a lender and a term — the lender sends him a code.
  app.post(
    "/market/checkout/:storeSlug/instalments",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      const input = parseOrThrow(instalmentStartSchema, request.body ?? {});
      await consumeStorefrontRateLimit({
        scope: "market_instalment_start",
        rawKey: shopper.id,
        limit: 10,
        windowMs: 10 * 60 * 1000,
      });
      const store = await listedStoreTenant(request.params.storeSlug);
      const goods = await goodsToCover(shopper, request.params.storeSlug, input);
      response.status(201).json(
        await startInstalmentPlan(shopper, store.id, goods, {
          lender: input.lender,
          months: input.months,
        })
      );
    })
  );

  app.get(
    "/market/orders",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(
          await shopperOrders(
            shopper.id,
            request.query.cursor,
            request.query.limit,
            request.query.status
          )
        );
    })
  );

  app.get(
    "/market/orders/:orderId",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response.status(200).json(await shopperOrder(shopper.id, request.params.orderId));
    })
  );
}

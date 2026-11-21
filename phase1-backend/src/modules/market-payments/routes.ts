/**
 * Marketplace M13a routes.
 *
 *   shopper   GET  /market/payments/:paymentId                  his payment (the gateway page, the order page)
 *             POST /market/payments/:paymentId/test-provider    the TEST gateway's page: approve or decline (fake mode only)
 *   provider  POST /payments/webhooks/card                       the gateway's signed notification
 *   owner     GET  /platform/market/payments                     every online payment, newest first
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { HttpError } from "../../auth/auth.errors.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { requireShopper } from "../market-account/shopper-auth.js";
import { prisma } from "../../db/prisma.js";
import { handleCardNotification, paymentsForOwner, shopperPayment } from "./payments.service.js";
import { paymentsMode, signNotification } from "./providers.js";
import { ownerPaymentsQuerySchema, testProviderSchema } from "./schema.js";

type RawBodyRequest = { rawBody?: Buffer };

export function registerMarketPaymentsRoutes(app: Express) {
  app.get(
    "/market/payments/:paymentId",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response.setHeader("cache-control", "private, no-store");
      response.status(200).json(await shopperPayment(shopper.id, String(request.params.paymentId)));
    })
  );

  // The test gateway's «hosted page» answers here: it signs a notification exactly as a real
  // gateway would and hands it to the same handler the webhook uses. Absent outside fake mode.
  app.post(
    "/market/payments/:paymentId/test-provider",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      if (paymentsMode() !== "fake") throw new HttpError(404, "RESOURCE_NOT_FOUND", "غير موجود.");
      const { shopper } = await requireShopper(request);
      const input = parseOrThrow(testProviderSchema, request.body ?? {});
      const payment = await prisma.marketPayment.findFirst({
        where: { id: String(request.params.paymentId), shopperId: shopper.id, method: "card" },
        select: { providerRef: true, amountIqd: true },
      });
      if (!payment?.providerRef)
        throw new HttpError(404, "PAYMENT_NOT_FOUND", "عملية الدفع غير موجودة.");
      const raw = Buffer.from(
        JSON.stringify({
          eventId: randomUUID(),
          type: input.outcome === "approve" ? "payment.succeeded" : "payment.failed",
          providerRef: payment.providerRef,
          amountIqd: payment.amountIqd,
        })
      );
      await handleCardNotification(raw, signNotification(raw));
      response.status(200).json(await shopperPayment(shopper.id, String(request.params.paymentId)));
    })
  );

  app.post(
    "/payments/webhooks/card",
    asyncRoute(async (request, response) => {
      // Server to server: no browser, no cookie, no Origin. The HMAC over the raw body is the guard.
      const raw = (request as unknown as RawBodyRequest).rawBody;
      if (!raw) throw new HttpError(400, "PAYMENT_NOTIFICATION_EMPTY", "إشعار فارغ.");
      response
        .status(200)
        .json(await handleCardNotification(raw, request.header("x-codiq-signature") ?? undefined));
    })
  );

  app.get(
    "/platform/market/payments",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "merchants.manage");
      const query = parseOrThrow(ownerPaymentsQuerySchema, request.query ?? {});
      response.status(200).json(await paymentsForOwner(query));
    })
  );
}

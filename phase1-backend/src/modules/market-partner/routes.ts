/**
 * Marketplace M13b routes.
 *
 *   shopper  POST   /market/partner/enter                    the partner's signed handoff → a session (A2)
 *            GET    /market/me/partner                       linked? last synced?
 *            DELETE /market/me/partner                       unlink
 *            POST   /market/checkout/:storeSlug/partner-link a single-use payment link for this store's cart (F10)
 *            GET    /market/partner-links/:linkId            is it paid yet?
 *   partner  POST   /partner/payment-links/complete          signed: «I took the money for this link»
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { clientIp } from "../../http/client-ip.js";
import { HttpError } from "../../auth/auth.errors.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { requireShopper, setShopperCookie } from "../market-account/shopper-auth.js";
import { completePaymentLink, createPaymentLink, enterFromPartner, partnerLinkOf, paymentLinkStatus, unlinkPartner } from "./partner.service.js";
import { partnerEnterSchema, partnerLinkSchema } from "./schema.js";

type RawBodyRequest = { rawBody?: Buffer };

export function registerMarketPartnerRoutes(app: Express) {
  app.post("/market/partner/enter", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await consumeStorefrontRateLimit({ scope: "market_partner_enter", rawKey: clientIp(request), limit: 30, windowMs: 10 * 60 * 1000 });
    const input = parseOrThrow(partnerEnterSchema, request.body ?? {});
    const result = await enterFromPartner(input.token);
    setShopperCookie(response, result.token);
    response.status(200).json({ shopper: result.shopper, linkedNow: result.linkedNow });
  }));

  app.get("/market/me/partner", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await partnerLinkOf(shopper.id));
  }));

  app.delete("/market/me/partner", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await unlinkPartner(shopper.id));
  }));

  app.post("/market/checkout/:storeSlug/partner-link", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    const input = parseOrThrow(partnerLinkSchema, request.body ?? {});
    await consumeStorefrontRateLimit({ scope: "market_partner_link", rawKey: shopper.id, limit: 20, windowMs: 10 * 60 * 1000 });
    response.setHeader("cache-control", "private, no-store");
    response.status(201).json(await createPaymentLink(shopper, request.params.storeSlug, input));
  }));

  app.get("/market/partner-links/:linkId", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.setHeader("cache-control", "private, no-store");
    response.status(200).json(await paymentLinkStatus(shopper.id, String(request.params.linkId)));
  }));

  app.post("/partner/payment-links/complete", asyncRoute(async (request, response) => {
    // Server to server: no browser, no cookie, no Origin. The HMAC over the raw body is the guard.
    const raw = (request as unknown as RawBodyRequest).rawBody;
    if (!raw) throw new HttpError(400, "PARTNER_BODY_INVALID", "جسم الطلب فارغ.");
    const result = await completePaymentLink(raw, request.header("x-codiq-signature") ?? undefined);
    response.status(result.ok ? 200 : 409).json(result);
  }));
}

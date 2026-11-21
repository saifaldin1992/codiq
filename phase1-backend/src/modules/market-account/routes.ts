/**
 * Marketplace M4 routes — the shopper's own account. Every route but the two
 * sign-in steps requires a shopper session; every write checks its origin.
 */
import multer from "multer";
import type { Express, Request } from "express";
import { asyncRoute, authenticatedUpload, limitUpload, requireTrustedWriteOrigin, uploadLimits } from "../../http/shared.js";
import { clientIp } from "../../http/client-ip.js";
import { parseOrThrow } from "../../http/validate.js";
import { endCurrentSession } from "../../services/session.service.js";
import { storeImageConstraints } from "../../services/product-image-storage.service.js";
import { clearShopperCookie, requireShopper, setShopperCookie, shopperToken } from "./shopper-auth.js";
import { storesBoughtFrom } from "../market-stores/directory.service.js";
import {
  avatarBytes, createAddress, deleteAddress, deliveryQuote, listAddresses, removeAvatar, requestAddressPhoneCode, requestLoginCode, setAvatar, setDefaultAddress, shopperView,
  updateAddress, updateProfile, verifyLoginCode,
} from "./account.service.js";
import { addressPhoneCodeSchema, addressSchema, profileSchema, requestCodeSchema, verifyCodeSchema } from "./schema.js";

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: uploadLimits({ fileSize: storeImageConstraints.maxBytes, files: 1 }) });

async function guardAvatarUpload(request: Request) {
  requireTrustedWriteOrigin(request);
  const { shopper } = await requireShopper(request);
  await limitUpload("shopper_avatar_upload", shopper.id);
}

export function registerMarketAccountRoutes(app: Express) {
  // ── sign-in ───────────────────────────────────────────────────────────────
  app.post("/market/auth/code", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const input = parseOrThrow(requestCodeSchema, request.body ?? {});
    response.status(200).json(await requestLoginCode(input.phone, clientIp(request)));
  }));

  app.post("/market/auth/verify", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const input = parseOrThrow(verifyCodeSchema, request.body ?? {});
    const result = await verifyLoginCode(input.challengeId, input.code);
    setShopperCookie(response, result.token);
    // The token is returned for an app that cannot hold cookies; the browser uses the HttpOnly cookie.
    response.status(200).json({ shopper: result.shopper, isNew: result.isNew, accessToken: result.token });
  }));

  app.post("/market/auth/logout", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { claims } = await requireShopper(request).catch(() => ({ claims: null }));
    if (claims) await endCurrentSession(claims);
    clearShopperCookie(response);
    response.status(200).json({ signedOut: true });
  }));

  // ── profile ───────────────────────────────────────────────────────────────
  // «Who am I?» — nobody, for a visitor carrying no session at all (every
  // anonymous page load asks, and an anonymous visitor is not an error). A
  // session that IS presented must verify, or this is a 401 like anywhere else.
  app.get("/market/me", asyncRoute(async (request, response) => {
    if (!shopperToken(request)) { response.status(200).json({ shopper: null }); return; }
    const { shopper } = await requireShopper(request);
    response.status(200).json({ shopper: shopperView(shopper) });
  }));

  app.put("/market/me", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await updateProfile(shopper.id, parseOrThrow(profileSchema, request.body ?? {})));
  }));

  app.post("/market/me/avatar", authenticatedUpload(guardAvatarUpload, avatarUpload.single("image")), asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await setAvatar(shopper.id, request.file));
  }));

  app.delete("/market/me/avatar", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await removeAvatar(shopper.id));
  }));

  app.get("/market/me/avatar", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    const avatar = await avatarBytes(shopper.id);
    // Private: the shopper's own picture, cached only by his own browser.
    response.setHeader("cache-control", "private, max-age=86400");
    response.status(200).contentType(avatar.contentType).send(avatar.bytes);
  }));

  // «اشتريت منها»: the stores this shopper completed an order from. Private — his own history.
  app.get("/market/me/stores", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.setHeader("cache-control", "private, no-store");
    response.status(200).json(await storesBoughtFrom(shopper.id));
  }));

  // ── addresses ─────────────────────────────────────────────────────────────
  app.get("/market/me/addresses", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await listAddresses(shopper.id));
  }));

  app.post("/market/me/addresses/phone-code", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    const input = parseOrThrow(addressPhoneCodeSchema, request.body ?? {});
    response.status(200).json(await requestAddressPhoneCode(shopper.id, input.phone, clientIp(request)));
  }));

  app.post("/market/me/addresses", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(201).json(await createAddress(shopper, parseOrThrow(addressSchema, request.body ?? {})));
  }));

  app.put("/market/me/addresses/:addressId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await updateAddress(shopper, request.params.addressId, parseOrThrow(addressSchema, request.body ?? {})));
  }));

  app.delete("/market/me/addresses/:addressId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await deleteAddress(shopper.id, request.params.addressId));
  }));

  app.post("/market/me/addresses/:addressId/default", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await setDefaultAddress(shopper.id, request.params.addressId));
  }));

  app.get("/market/me/addresses/:addressId/delivery", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    const store = typeof request.query.store === "string" ? request.query.store : "";
    response.status(200).json(await deliveryQuote(shopper.id, request.params.addressId, store));
  }));
}

/**
 * ق-199 — the routes behind «واجهة المتجر».
 *
 * Two audiences, split exactly as the banner routes are:
 *  · the MERCHANT reads and writes every field, and replaces or removes the
 *    logo — behind `settings.manage`, because the shop's face is its policy;
 *  · the SHOPPER reads the logo bytes and the written policies, unauthenticated,
 *    through `resolveStorefrontStore` so a disabled store vanishes whole.
 *
 * The rest of what the shopper needs rides `GET /store/:slug/public-config`
 * (marketing.ts), which spreads `publicStorefrontConfig` into the payload it
 * already had — one fetch, not two.
 */
import multer from "multer";
import type { Express as ExpressApp, Request } from "express";
import { asyncRoute, authenticatedUpload, limitUpload, uploadLimits, requireTrustedWriteOrigin, resolveStorefrontStore } from "../shared.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { parseOrThrow } from "../validate.js";
import { updateStorefrontSettingsSchema } from "../schemas/storefront-config.schema.js";
import { removeStoreLogo, setStoreLogo, storeCustomPage, storeLogoObject, storePolicy, storefrontSettings, updateStorefrontSettings } from "../../services/storefront-config.service.js";
import { getStoreLogoBytes, storeImageConstraints } from "../../services/product-image-storage.service.js";

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: storeImageConstraints.maxBytes, files: 1 }),
});

async function guardLogoUpload(request: Request) {
  requireTrustedWriteOrigin(request);
  const { store, actor } = await requireStoreActor(request, "settings.manage");
  await limitUpload("store_logo_upload", `${store.id}:${actor.kind}:${actor.id}`);
}

export function registerStorefrontConfigRoutes(app: ExpressApp) {
  app.get("/merchant/stores/:storeSlug/storefront", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json({ storeSlug: store.slug, storefront: await storefrontSettings(store.id) });
  }));

  app.put("/merchant/stores/:storeSlug/storefront", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    const body = parseOrThrow(updateStorefrontSettingsSchema, request.body ?? {});
    response.status(200).json({ storeSlug: store.slug, storefront: await updateStorefrontSettings(store.id, body) });
  }));

  app.post("/merchant/stores/:storeSlug/storefront/logo", authenticatedUpload(guardLogoUpload, logoUpload.single("image")), asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json({ storeSlug: store.slug, storefront: await setStoreLogo(store.id, store.merchantId, request.file) });
  }));

  app.delete("/merchant/stores/:storeSlug/storefront/logo", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json({ storeSlug: store.slug, storefront: await removeStoreLogo(store.id) });
  }));

  // ── the shopper's side ────────────────────────────────────────────────────
  app.get("/store/:storeSlug/logo", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    const logo = await storeLogoObject(store.id);
    const bytes = await getStoreLogoBytes(logo.objectKey);
    // Immutable because the URL the payload hands out carries `?v=<uuid>`,
    // which changes with every new upload; a replaced logo is a new URL.
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.status(200).contentType(logo.contentType).send(bytes);
  }));

  app.get("/store/:storeSlug/policies/:kind", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    response.status(200).json({ storeSlug: store.slug, policy: await storePolicy(store.id, request.params.kind) });
  }));

  // ق-211 — one of the merchant's own footer pages. Its own route rather than a
  // seventh policy kind: the policies are a closed set the checkout screen names,
  // and these are whatever this shop needed to say.
  app.get("/store/:storeSlug/pages/:pageSlug", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    response.status(200).json({ storeSlug: store.slug, page: await storeCustomPage(store.id, request.params.pageSlug) });
  }));
}

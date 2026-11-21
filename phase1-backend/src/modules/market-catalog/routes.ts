/**
 * Marketplace M2 routes.
 *
 *   shopper   GET /market/categories(/:slug) · /market/products(/:productId) · /market/search/suggest · /market/search/popular
 *   merchant  /merchant/stores/:storeSlug/market-catalog/…   (catalog.categories.manage, catalog.products.update)
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { marketCategoryPage, marketCategoryTree } from "./categories.service.js";
import { listMarketProducts, marketProductPage } from "./products.service.js";
import { popularSearches, searchSuggestions } from "./search.service.js";
import { mapStoreCategory, marketProductFieldsPage, replaceProductAddons, storeCategoryMappings, updateProductMarketFields } from "./merchant.service.js";
import { categoryMappingSchema, marketProductQuerySchema, productAddonsSchema, productMarketFieldsSchema } from "./schema.js";

const SHORT_PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=300";

export function registerMarketCatalogRoutes(app: Express) {
  // ── shopper ───────────────────────────────────────────────────────────────
  app.get("/market/categories", asyncRoute(async (_request, response) => {
    response.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=3600");
    response.status(200).json(await marketCategoryTree());
  }));

  app.get("/market/categories/:slug", asyncRoute(async (request, response) => {
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await marketCategoryPage(request.params.slug));
  }));

  app.get("/market/products", asyncRoute(async (request, response) => {
    const query = parseOrThrow(marketProductQuerySchema, request.query ?? {});
    // A searched page is not cached at the edge: the count of searches must see each one.
    response.setHeader("cache-control", query.q ? "private, no-store" : SHORT_PUBLIC_CACHE);
    response.status(200).json(await listMarketProducts(query));
  }));

  app.get("/market/products/:productId", asyncRoute(async (request, response) => {
    // Not cached: every open is a view the merchant's «الأكثر زيارة» counts.
    response.setHeader("cache-control", "private, no-store");
    response.status(200).json(await marketProductPage(request.params.productId, { countView: true }));
  }));

  app.get("/market/search/suggest", asyncRoute(async (request, response) => {
    const raw = typeof request.query.q === "string" ? request.query.q.slice(0, 80) : "";
    response.setHeader("cache-control", SHORT_PUBLIC_CACHE);
    response.status(200).json(await searchSuggestions(raw));
  }));

  app.get("/market/search/popular", asyncRoute(async (_request, response) => {
    response.setHeader("cache-control", "public, max-age=600");
    response.status(200).json(await popularSearches());
  }));

  // ── merchant ──────────────────────────────────────────────────────────────
  app.get("/merchant/stores/:storeSlug/market-catalog/categories", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "catalog.categories.manage");
    response.status(200).json({ storeSlug: store.slug, ...(await storeCategoryMappings(store.id)) });
  }));

  app.put("/merchant/stores/:storeSlug/market-catalog/categories/:categoryId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "catalog.categories.manage");
    const input = parseOrThrow(categoryMappingSchema, request.body ?? {});
    response.status(200).json(await mapStoreCategory(store.id, request.params.categoryId, input.marketCategoryId));
  }));

  app.get("/merchant/stores/:storeSlug/market-catalog/products", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "catalog.products.update");
    response.status(200).json({ storeSlug: store.slug, ...(await marketProductFieldsPage(store.id, request.query.cursor, request.query.limit)) });
  }));

  app.put("/merchant/stores/:storeSlug/market-catalog/products/:productId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "catalog.products.update");
    const input = parseOrThrow(productMarketFieldsSchema, request.body ?? {});
    response.status(200).json(await updateProductMarketFields(store.id, request.params.productId, input));
  }));

  app.put("/merchant/stores/:storeSlug/market-catalog/products/:productId/addons", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "catalog.products.update");
    const input = parseOrThrow(productAddonsSchema, request.body ?? {});
    response.status(200).json(await replaceProductAddons(store.id, request.params.productId, input.addons));
  }));
}

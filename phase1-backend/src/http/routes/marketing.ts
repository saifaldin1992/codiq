/**
 * codiq phase 20B-1/2 — marketing routes (coupons D-08, analytics D-09,
 * abandoned carts D-24).
 *
 * Merchant coupon management is guarded by settings.manage (approved decision
 * §8.5 — the marketing.* permission family is deferred). This block used to say
 * the routes offer NO DELETE because redemptions reference a coupon forever;
 * PG-2 added the soft DELETE and the restore below, and the sentence became
 * false about its own file. What is still true is narrower: the coupon ROW is
 * never hard-deleted while a redemption points at it — the purge sweep is
 * refused by the foreign key and the row keeps its «محفوظ لسجلاتك» badge in the
 * trash bin. The public coupon preview is advisory only and rate-limited
 * (scope `coupon_preview`, limit 30 per window); the checkout transaction
 * remains the sole authority on whether a coupon applies.
 *
 * Phase 20B-2 appends the analytics GETs (orders.view — read-only aggregates,
 * zero writes, zero checkout involvement) and the abandoned-cart surfaces
 * (settings.manage for configuration, customers.view for the list/stats).
 */
import { stockForecasts } from "../../services/stock-forecast.service.js";
import { merchantMonthlyReport } from "../../services/merchant-monthly-report.service.js";
import { publicStoreVerification } from "../../services/store-verification.service.js";
import type { Express } from "express";
import { HttpError } from "../../auth/auth.errors.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { abandonedCartSettingsView, abandonedCartsPanel, updateAbandonedCartSettings } from "../../services/abandoned-cart.service.js";
import { analyticsSummary, couponsUsage, customersSummary, salesSeries, statusFunnel, topProducts } from "../../services/analytics.service.js";
import { createCoupon, deleteCoupon, listCoupons, previewCoupon, restoreCoupon, updateCoupon } from "../../services/coupon.service.js";
import { marketingSettingsView, publicPixelsConfig, updateMarketingSettings } from "../../services/marketing-settings.service.js";
import { storeVacationBanner } from "../../services/merchant-store.service.js";
import { assertCapabilityAvailable, publicStoreAvailability } from "../../services/availability.service.js";
import { livePlatformWideWindow } from "../../services/maintenance.service.js";
import { resolveSetting } from "../../services/config.service.js";
import { publicStorefrontConfig } from "../../services/storefront-config.service.js";
import { currentCart } from "../../services/storefront.service.js";
import {
  abandonedCartSettingsSchema,
  restoreCouponSchema,
  couponPreviewSchema,
  createCouponSchema,
  marketingIntegrationsSchema,
  updateCouponSchema,
} from "../schemas/marketing.schema.js";
import { parseOrThrow } from "../validate.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import { asyncRoute, guestCartToken, limitStorefrontWrite, limitStorefrontWriteWithAddressCeiling, requireStorefrontCustomer, requireTrustedWriteOrigin, resolveStorefrontStore, cachePublicStorefront } from "../shared.js";

import { clientIp } from "../client-ip.js";
export function registerMarketingRoutes(app: Express) {
  app.get("/merchant/stores/:storeSlug/marketing/coupons", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("offers.coupons", store);
    // 20-2: `limit`/`cursor` are shape-checked at the edge like every other
    // input; the window and the cursor's meaning stay in services/list-page.ts,
    // so there is one implementation of each rule rather than a schema copy.
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json({ storeSlug: store.slug, ...(await listCoupons(store.id, limit, cursor)) });
  }));
  app.post("/merchant/stores/:storeSlug/marketing/coupons", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("offers.coupons", store);
    const body = parseOrThrow(createCouponSchema, request.body ?? {});
    response.status(201).json({ coupon: await createCoupon(store.id, body) });
  }));
  app.patch("/merchant/stores/:storeSlug/marketing/coupons/:couponId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("offers.coupons", store);
    const body = parseOrThrow(updateCouponSchema, request.body ?? {});
    response.status(200).json({ coupon: await updateCoupon(store.id, request.params.couponId, body) });
  }));
  // PG-2: coupons gained a soft DELETE (200 with { id, deletedAt, purgeAt }) and
  // a restore. The redemption ledger is untouched either way.
  app.delete("/merchant/stores/:storeSlug/marketing/coupons/:couponId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "settings.manage");
    response.status(200).json(await deleteCoupon(store.id, request.params.couponId, actor));
  }));
  // ق-174: kept. No screen calls this — DeleteConfirmSheet restores through the
  // trash route — but phase20b1 asserts it, so it is an API-only act until the
  // owner decides to retire it together with that assertion. Listed in
  // surface.legacy.json, not exempted: the decision is still open.
  app.post("/merchant/stores/:storeSlug/marketing/coupons/:couponId/restore", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("offers.coupons", store);
    const body = parseOrThrow(restoreCouponSchema, request.body ?? {});
    response.status(200).json({ coupon: await restoreCoupon(store.id, request.params.couponId, actor, body) });
  }));

  // Public advisory preview against the caller's own current cart.
  app.post("/store/:storeSlug/cart/coupon-preview", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    let customerId: string | undefined;
    try { customerId = (await requireStorefrontCustomer(request)).customer.id; } catch (error) { if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error; }
    // 19-ج: the body is parsed AFTER the limiter, exactly where it was read
    // before, so a malformed preview still spends one of the thirty attempts.
    // Validating first would hand an unauthenticated caller a free probe.
    await limitStorefrontWriteWithAddressCeiling(request, "coupon_preview", customerId ?? guestCartToken(request) ?? clientIp(request), 30, 120);
    const { couponCode } = parseOrThrow(couponPreviewSchema, request.body ?? {});
    const cart = await currentCart(store.id, { customerId, guestToken: guestCartToken(request) });
    const subtotalIqd = (cart.items as Array<{ quantity: number; priceSnapshotIqd: number }>).reduce((sum, item) => sum + item.quantity * item.priceSnapshotIqd, 0);
    response.status(200).json({ preview: await previewCoupon(store.id, customerId, couponCode, subtotalIqd) });
  }));

  // ---------- Phase 20B-2: analytics (D-09) — aggregated GETs only ----------
  // Strictly separate reads (lesson D-17): every handler below is a pure
  // database aggregate behind orders.view; nothing here writes anything.
  // MD-3: the stock-out forecast. Gated on `inventory.update` rather than on
  // orders.view: the answer to "will this run out" is only useful to someone
  // who can act on it, and it exposes sales velocity per product.
  app.get("/merchant/stores/:storeSlug/inventory/forecast", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "inventory.update");
    response.status(200).json({ storeSlug: store.slug, forecasts: await stockForecasts(store.id, { limit: Number(request.query.limit) || 20 }) });
  }));
  // MD-7: the same permission as every other analytics read -- the monthly
  // page is a view of figures the merchant can already see, arranged for
  // printing and for showing to someone else.
  app.get("/merchant/stores/:storeSlug/reports/monthly", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    response.status(200).json({ report: await merchantMonthlyReport(store.id, request.query.month) });
  }));
  app.get("/merchant/stores/:storeSlug/marketing/analytics/summary", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("data.analytics", store);
    response.status(200).json({ storeSlug: store.slug, summary: await analyticsSummary(store.id, request.query) });
  }));
  app.get("/merchant/stores/:storeSlug/marketing/analytics/sales-series", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("data.analytics", store);
    response.status(200).json({ storeSlug: store.slug, ...(await salesSeries(store.id, request.query)) });
  }));
  app.get("/merchant/stores/:storeSlug/marketing/analytics/top-products", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("data.analytics", store);
    response.status(200).json({ storeSlug: store.slug, ...(await topProducts(store.id, request.query)) });
  }));
  app.get("/merchant/stores/:storeSlug/marketing/analytics/status-funnel", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("data.analytics", store);
    response.status(200).json({ storeSlug: store.slug, ...(await statusFunnel(store.id, request.query)) });
  }));
  app.get("/merchant/stores/:storeSlug/marketing/analytics/customers", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("data.analytics", store);
    response.status(200).json({ storeSlug: store.slug, customers: await customersSummary(store.id) });
  }));
  app.get("/merchant/stores/:storeSlug/marketing/analytics/coupons", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("data.analytics", store);
    response.status(200).json({ storeSlug: store.slug, ...(await couponsUsage(store.id)) });
  }));

  // ---------- Phase 20B-2: abandoned carts (D-24) ----------
  // Configuration is settings.manage (window 1–72h, opt-in default OFF, active
  // same-store recovery coupon only); the list/stats read is customers.view.
  app.get("/merchant/stores/:storeSlug/marketing/abandoned-carts/settings", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("marketing.abandoned_carts", store);
    response.status(200).json({ storeSlug: store.slug, settings: await abandonedCartSettingsView(store.id) });
  }));
  app.put("/merchant/stores/:storeSlug/marketing/abandoned-carts/settings", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("marketing.abandoned_carts", store);
    const body = parseOrThrow(abandonedCartSettingsSchema, request.body ?? {});
    response.status(200).json({ storeSlug: store.slug, settings: await updateAbandonedCartSettings(store.id, body) });
  }));
  app.get("/merchant/stores/:storeSlug/marketing/abandoned-carts", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "customers.view");
    await assertCapabilityAvailable("marketing.abandoned_carts", store);
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json({ storeSlug: store.slug, ...(await abandonedCartsPanel(store.id, limit, cursor)) });
  }));

  // ---------- Phase 20B-3: ad pixels (D-26) ----------
  // Merchant configuration behind settings.manage; the ids are strictly
  // format-validated in the service (anything else is 422 — injection defense).
  app.get("/merchant/stores/:storeSlug/marketing/integrations", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("marketing.pixels", store);
    response.status(200).json({ storeSlug: store.slug, settings: await marketingSettingsView(store.id) });
  }));
  app.put("/merchant/stores/:storeSlug/marketing/integrations", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("marketing.pixels", store);
    const body = parseOrThrow(marketingIntegrationsSchema, request.body ?? {});
    response.status(200).json({ storeSlug: store.slug, settings: await updateMarketingSettings(store.id, body) });
  }));
  // Public storefront config (active stores only — resolveStorefrontStore).
  // The pixels key is ABSENT when the integration is disabled or empty; only
  // format-revalidated ids ever leave the server.
  app.get("/store/:storeSlug/public-config", asyncRoute(async (request, response) => {
    // ق-249: the one shopper route that must answer during maintenance — it carries the message.
    const store = await resolveStorefrontStore(request.params.storeSlug, { allowMaintenance: true });
    // ق-250: a platform-wide window shows as a strip in every shop's shell while it runs.
    const platformWindow = await livePlatformWideWindow();
    const availability = { store: publicStoreAvailability(store), ...(platformWindow ? { platform: { maintenance: { message: platformWindow.messageAr, until: platformWindow.endsAt.toISOString() } } } : {}) };
    const pixels = await publicPixelsConfig(store.id);
    // MD-1: the `vacation` key is ABSENT unless the merchant switched vacation
    // mode on — exactly the `pixels` gating pattern. Browsing is unaffected;
    // only checkout is refused (422 STORE_ON_VACATION).
    const vacation = await storeVacationBanner(store.id);
    // MD-6: `verified` is ABSENT unless the owner granted it -- same gating as
    // `pixels` and `vacation`. A key present and false invites a UI that renders
    // "not verified" at every shopper, which is not what the badge is for.
    const verified = await publicStoreVerification(store.id);
    // ق-199: everything the merchant owns about his shop's face — name, logo,
    // announcement, contact, social, policies, guest checkout, home sections —
    // rides THIS payload, so the shell and the home page make one request. Its
    // optional keys follow the same absent-unless-set gating.
    const storefront = await publicStorefrontConfig(store.id);
    // ق-251: the shopper's «buy without an account» is the hierarchy's answer, not the store column alone.
    const guestCheckout = (await resolveSetting("checkout.guest_allowed", { merchantId: store.merchantId, storeId: store.id })).value === true;
    // Maintenance and vacation ride this payload: a shorter edge window, and checkout re-checks both.
    cachePublicStorefront(response, 30, 10);
    response.status(200).json({ storeSlug: store.slug, availability, ...(pixels ? { pixels } : {}), ...(vacation ? { vacation } : {}), ...(verified ? { verified } : {}), ...storefront, guestCheckout });
  }));
}

import express from "express";
import { registerStoreBannerRoutes } from "./routes/store-banners.js";
import { registerStorefrontConfigRoutes } from "./routes/storefront-config.js";
import { registerPaymentMethodRoutes } from "./routes/payment-methods.js";
import { registerStoreTrafficRoutes } from "./routes/store-traffic.js";
import { registerMerchantHomeRoutes } from "./routes/merchant-home.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { HttpError } from "../auth/auth.errors.js";
import { config } from "../config.js";
import { readinessSummary } from "../config/environment-report.js";
import { prisma } from "../db/prisma.js";
import { isEmailProviderConfigured } from "../notifications/notification-provider.js";
import { demoBlockedSurfaceGuard } from "../demo/demo-mode.js";
import { API_MOUNT_V1, isStorefrontPath } from "./api-version.js";
import { correlationMiddleware } from "./correlation.js";
import { errorHandler } from "./errors.js";
import { securityHeaders } from "./security-headers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerOwnerSecurityRoutes } from "./routes/owner-security.js";
import { registerAccountSecurityRoutes } from "./routes/account-security.js";
import { registerPosRoutes } from "./routes/pos.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerCustomerDelightRoutes } from "./routes/customer-delight.js";
import { registerReviewAndWishlistRoutes } from "./routes/reviews-wishlist.js";
import { registerReturnRoutes } from "./routes/returns.js";
import { registerReturnInspectionRoutes } from "./routes/return-inspection.js";
import { registerMarketingRoutes } from "./routes/marketing.js";
import { registerMerchantRoutes } from "./routes/merchant.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerOpenApiRoutes } from "./routes/openapi.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerStorefrontRoutes } from "./routes/storefront.js";
import { registerTeamRoutes } from "./routes/team.js";
import { registerPlatformStaffRoutes } from "./routes/platform-staff.js";
import { registerPlatformServicesRoutes } from "./routes/platform-services.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { searchEngine } from "../services/search/index.js";
import { asyncRoute } from "./shared.js";

export function createApp() {
  const app = express();
  // Railway terminates TLS at a single proxy hop; without this, request.ip is the
  // proxy address and every IP-keyed rate-limit bucket collapses into one counter.
  app.set("trust proxy", 1);
  // 19-د (D-34): the three hand-set headers that used to sit below the health
  // probes are now the full set in `security-headers.ts` — CSP and HSTS
  // included — and they are mounted FIRST, so a probe, a demo 404 and a normal
  // route all answer with the same headers. They are ALSO mounted by the
  // composite server: `createApp()` is mounted at `/api` there, which is why
  // these headers never once reached an HTML document before this change.
  // D-41 (phase 24-أ): BEFORE the headers, so that even a response that never
  // reaches a route — a demo 404, a rejected probe — carries `x-request-id` and
  // is logged under one id. Idempotent: under the composite server the outer
  // app has already opened this request's context and this call steps aside
  // (correlation.ts says why it must be mounted in both places at all).
  app.use(correlationMiddleware());
  app.use(securityHeaders());
  /**
   * ق-230 — an authenticated answer is never cached, and the rule lives in ONE
   * place.
   *
   * ASVS V8.1.1. Four routes set `no-store` by hand and two of those are public;
   * everything else — an order list with a shopper's name, address and phone, a
   * settlement report, a customer directory — went out with no cache directive at
   * all, which lets a shared proxy or the browser's own disk hold it. In an Iraqi
   * shop the browser is frequently the counter's shared machine, and «الرجوع»
   * after the next person signs in is the whole attack.
   *
   * The condition is the REQUEST carrying an identity, not the response's shape:
   * a bearer token or any of the session cookies. Public reads — the storefront,
   * the landing page, product images with their immutable year — are untouched,
   * and so is any route that already chose its own directive: the check below
   * never overwrites one.
   *
   * Mounted ABOVE the health probes and the demo guard rather than beside the
   * body parser: this is the FIRST thing after the security headers, so there
   * is no band at the top of the stack where a route added later would sit
   * outside the rule. A rule with a hole in it is the rule nobody remembers.
   */
  app.use((request, response, next) => {
    // The test is a SUBSTRING on purpose: D-63 made the dashboard cookie's name
    // environment-dependent (`__Host-codiq_session` wherever `Secure` is set,
    // the bare name in local http development), and `codiq_session` is the part
    // both names share. Anchoring it would have silently stopped marking
    // authenticated answers `no-store` in production only — the one place it
    // matters.
    const carriesIdentity = Boolean(request.header("authorization")) || /codiq_session|codiq_customer_/.test(request.header("cookie") ?? "");
    // Set as the DEFAULT rather than forced at write time: a later
    // `setHeader("cache-control", …)` in a handler simply replaces it, so the
    // image routes keep their immutable year and nothing needs an exemption
    // list to maintain.
    if (carriesIdentity) response.setHeader("cache-control", "no-store");
    next();
  });
  /**
   * D-66 — the probes answer WHETHER, never WHERE.
   *
   * Both of these are unauthenticated by necessity: Railway's health check runs
   * before any credential exists. `env` was being handed to every anonymous
   * caller, and it is the single most useful sentence you can give someone
   * mapping a platform — it separates the production host from the staging one
   * that shares its code, its migrations and, at some point, a merchant's real
   * data. The operator who needs that answer has the dashboard and the logs;
   * the internet does not.
   *
   * `status: "ok"` is the entire contract. `/ready` below adds the readiness
   * signal and verdict-only diagnostics — never a name, a host or a value.
   */
  app.get("/health", (_request, response) => response.status(200).json({ status: "ok" }));
  app.get("/ready", asyncRoute(async (_request, response) => {
    await prisma.$queryRaw`SELECT 1`;
    // PG-6 (ق-74): which engine answered, and the word-similarity threshold
    // THIS connection actually sees. `ALTER DATABASE … SET` applies to NEW
    // sessions only, so a pooled connection older than the migration keeps the
    // 0.6 default and the search silently narrows. Reporting it here turns
    // «the fuzzy match stopped working» into one line of evidence.
    // The mail channel, for the same reason as the threshold above: it is
    // configured by ENVIRONMENT VARIABLES, so «why did no email arrive?» is
    // otherwise answered by reading a dashboard nobody can read from here.
    // Reports only WHETHER a provider resolves — never the host, the user or
    // anything that would put a credential in an unauthenticated response.
    response.status(200).json({
      status: "ok",
      db: "ok",
      // D-66: no `env` here either. It named the deployment to anyone who asked.
      // `threshold()` guards itself, and this guards it again ON PURPOSE.
      //
      // On 2026-09-05 this exact expression answered 500 to every `/ready`
      // request in production for twenty minutes: `current_setting` raised
      // 42704 because pg_trgm's library had not been loaded on that connection,
      // and the raw rejection walked straight out of the route. The engine no
      // longer throws — but the RULE is what matters and it belongs here, where
      // the response is assembled: an OPTIONAL DIAGNOSTIC MAY NEVER DECIDE
      // WHETHER THIS ENDPOINT ANSWERS. The database check above is the readiness
      // signal; everything after it is evidence for a human, and evidence that
      // cannot be gathered is reported as such, not raised.
      search: { engine: searchEngine.name, threshold: await searchEngine.threshold().catch(() => "unavailable") },
      mail: { configured: isEmailProviderConfigured() },
      // Same reasoning as `mail` above, generalised. `mail.configured` answered
      // one variable group out of six; the other five failed at the point of
      // use, hours later, on a merchant's action. `CODIQ_PUBLIC_BASE_URL` was
      // the proof: unset in production, so password recovery answered
      // «unavailable» to everyone from the day it shipped, with nothing in any
      // log to find. Verdicts only — no names, no values (`readinessSummary`
      // enforces that; this endpoint is unauthenticated).
      config: readinessSummary(),
    });
  }));
  // P27-7: in the demo environment the whole platform-owner surface returns a
  // plain 404 before any route, body parsing or session lookup runs. Registered
  // only when the flag is on, so every other environment keeps today's stack.
  if (config.demoMode) app.use(demoBlockedSurfaceGuard);
  // المرحلة 20-4: the storefront is NOT versioned — permanently. The whole
  // reasoning is in `api-version.ts`; the short version is that the customer
  // cookie is scoped to `/api/store/<slug>`, so a shopper who signed in through
  // `/api/v1/store/<slug>` would be handed a cookie his own browser then refuses
  // to send back to the URL that set it.
  //
  // BEFORE `express.json`, so a refused request never buffers a body. Reads
  // `request.baseUrl` rather than `request.originalUrl`: baseUrl is the mount
  // path Express resolved for THIS request, so it is exact — `originalUrl` would
  // also match a store whose own slug began with `v1`.
  app.use((request, _response, next) => {
    if (request.baseUrl === API_MOUNT_V1 && isStorefrontPath(request.path)) {
      next(new HttpError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found."));
      return;
    }
    next();
  });
  // ق-182: the Resend webhook verifies a signature over the RAW bytes; a body
  // re-serialised from the parsed object is a different string and would fail
  // every genuine delivery. `verify` runs before parsing and keeps the bytes.
  app.use(express.json({ limit: "1mb", verify: (request, _response, buffer) => { (request as typeof request & { rawBody?: Buffer }).rawBody = buffer; } }));

  // Express matches routes in registration order. The call sequence below, and
  // the route order inside each module, reproduce the exact global registration
  // order of the pre-split app.ts. Do not reorder these calls.
  registerAuthRoutes(app);
  registerSessionRoutes(app);
  registerOwnerSecurityRoutes(app);
  registerAccountSecurityRoutes(app);
  registerPosRoutes(app);
  // RI-1: appended beside POS (both are physical-stock reconciliation);
  // /inventory/returns shares no pattern with any pre-existing route.
  registerReturnInspectionRoutes(app);
  registerStorefrontRoutes(app);
  // ق-198: registered AFTER the storefront so its /store/:storeSlug/... paths sit
  // beside the rest of the shopper surface, and after the catalog so the merchant
  // paths keep the established order.
  registerStoreBannerRoutes(app);
  registerPlatformRoutes(app);
  registerPublicRoutes(app);
  registerWebhookRoutes(app);
  registerMerchantRoutes(app);
  registerTeamRoutes(app);
  registerNotificationRoutes(app);
  registerOrderRoutes(app);
  registerCatalogRoutes(app);
  // Phase 20B-1: new module registered AFTER every pre-existing one, so the
  // legacy global registration order above stays untouched.
  registerMarketingRoutes(app);
  // CD-1: appended last for the same reason — the pre-existing registration
  // order above stays byte-for-byte the pre-split order.
  registerCustomerDelightRoutes(app);
  registerReviewAndWishlistRoutes(app);
  registerReturnRoutes(app);
  // PG-2: appended last for the same reason — every pre-existing registration
  // above keeps its exact order, and `…/trash…` / `…/audit-events` share no
  // pattern with any route already registered.
  registerTrashRoutes(app);
  // 19-ب: appended LAST for the same reason — `/platform/staff/*` and
  // `/platform/audit-events` share no pattern with any route above.
  registerPlatformStaffRoutes(app);
  // المرحلة 20-4: appended LAST for the same reason as every module above —
  // `/openapi.json` shares no pattern with any route already registered, so the
  // legacy matching order is untouched.
  registerOpenApiRoutes(app);
  // ق-249 (المرحلة 29): appended last for the same reason — `/platform/services`,
  // `/platform/availability/*`, `/platform/feature-flags/*` and `/platform/stores/:slug/status`
  // share no pattern with any route already registered.
  registerPlatformServicesRoutes(app);
  // ق-199: appended after everything above for the same reason — «واجهة
  // المتجر» (`…/storefront`, `/store/:slug/logo`, `/store/:slug/policies/:kind`)
  // shares no pattern with any route already registered.
  registerStorefrontConfigRoutes(app);
  // ق-209: the merchant's payment switches — `…/payment-methods`, a pattern
  // no earlier module registers.
  registerPaymentMethodRoutes(app);
  // ق-202: the visit beacon and the merchant's home aggregate — `…/visit` and
  // `…/dashboard/home` share no pattern with anything above.
  registerStoreTrafficRoutes(app);
  registerMerchantHomeRoutes(app);
  // 20-2 gate: an unmatched API path is a 404, and it is answered HERE.
  //
  // This app is mounted at `/api` inside a composite server whose last route is
  // an SPA catch-all serving the shell to anything unclaimed. So a mistyped or
  // renamed endpoint fell out of this app and was answered `200 text/html` —
  // and `storefront-api.ts`, parsing that as the success it claims to be, hands
  // the caller `null as T`. A removed route therefore surfaced as an empty
  // screen days later, with a 200 in every log and no error to search for.
  //
  // It belongs inside this app rather than beside the catch-all because only
  // here does it reach `errorHandler` below — so a 404 carries the same
  // envelope, the same correlation id and the same one log line as every other
  // failure, and every mounting of `createApp()` gets it, tests included.
  app.all("*", (_request, _response, next) => {
    next(new HttpError(404, "RESOURCE_NOT_FOUND", "The requested resource was not found."));
  });
  app.use(errorHandler);
  return app;
}

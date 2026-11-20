import { platformLogoBytes, readPlatformLogo } from "../../services/platform-brand.service.js";
import { publicContactView, readPlatformContact } from "../../services/platform-contact.service.js";
import type { Express } from "express";
import { loginDemoMerchantGuest } from "../../auth/auth.service.js";
import { config } from "../../config.js";
import { prisma } from "../../db/prisma.js";
import { recordUnsubscribe, verifyUnsubscribeToken } from "../../notifications/messaging-compliance.service.js";
import { publicPlans, registerMerchantWithStore, storeForHost } from "../../services/registration.service.js";
import { consumeStorefrontRateLimit } from "../../services/storefront.service.js";
import { registerMerchantSchema } from "../schemas/registration.schema.js";
import { parseOrThrow } from "../validate.js";
import { asyncRoute, requireTrustedWriteOrigin, setWebSession } from "../shared.js";

import { clientIp } from "../client-ip.js";
export function registerPublicRoutes(app: Express) {
  // P27-20 — every surface reads the brand from here, without a session: the
  // storefront and the landing page have no owner to authenticate.
  app.get("/public/brand", asyncRoute(async (_request, response) => {
    const logo = await readPlatformLogo();
    response.status(200).json({
      logo: logo ? { url: `/api/public/brand/logo/${encodeURIComponent(logo.objectKey)}`, contentType: logo.contentType, version: logo.version } : null,
    });
  }));
  app.get("/public/brand/logo/:objectKey(*)", asyncRoute(async (request, response) => {
    const { body, contentType } = await platformLogoBytes(request.params.objectKey);
    // The key carries the version, so the bytes at a given URL never change and
    // may be cached hard. Changing the logo mints a new URL.
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.setHeader("content-type", contentType);
    /**
     * 19-د (OUTPUT-SAFETY) — an uploaded logo may be an SVG, and an SVG is not a
     * picture: it is a SCRIPT-BEARING DOCUMENT. These bytes are proxied through
     * the app, so they leave the SAME origin that serves the dashboards and
     * carries `codiq_session` (path "/"). One top-level navigation to this URL
     * — a link a colleague sends, or «open image in new tab» — used to render
     * the uploader's `<script>` as the visitor, turning the delegable
     * `brand.manage` permission into every action the victim can perform.
     * `X-Content-Type-Options: nosniff` never helped, because the declared type
     * IS the real one.
     *
     * Three headers, set HERE on the response rather than in any global policy,
     * because this is the one route in the platform that serves bytes a person
     * uploaded:
     *   - `attachment` makes a top-level navigation DOWNLOAD the file instead of
     *     rendering it. Browsers ignore Content-Disposition for `<img src>`
     *     subresource loads, so BrandMark keeps drawing the logo on every
     *     surface — the legitimate use is untouched.
     *   - the per-response CSP leaves no script to run even if some client
     *     renders the document anyway; `style-src` stays inline so a legitimate
     *     SVG still looks right when the owner opens the downloaded file.
     *   - nosniff again, on the response itself, so it cannot be lost.
     * Headers rather than an upload-time filter, because this also covers the
     * bytes already sitting in the bucket, which no new filter could reach.
     */
    response.setHeader("content-disposition", `attachment; filename="${contentType === "image/svg+xml" ? "logo.svg" : "logo.png"}"`);
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    response.setHeader("x-content-type-options", "nosniff");
    response.status(200).end(Buffer.from(body));
  }));
  /**
   * PC-1 — the platform's contact details, for the landing page's footer.
   *
   * PUBLIC and unauthenticated, because the audience is a stranger deciding
   * whether to trust the platform; a contact channel behind a login is not a
   * contact channel. It publishes EXACTLY three fields — `publicContactView`
   * names them one by one rather than spreading the internal record, so the day
   * something private is stored beside them it is not published by accident.
   *
   * Cached at the edge for five minutes with a long `stale-while-revalidate`:
   * these strings change perhaps twice a year, the landing is under a hard speed
   * budget (ق-137), and the worst case of a stale answer is a footer that catches
   * up on the next load. `readPlatformContact` additionally memoizes in-process,
   * so a burst of visitors is one query rather than one query each.
   */
  app.get("/public/contact", asyncRoute(async (_request, response) => {
    const contact = await readPlatformContact();
    response.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=86400");
    response.status(200).json({ contact: publicContactView(contact) });
  }));
  app.get("/public/plans", asyncRoute(async (_request, response) => {
    response.status(200).json({ plans: await publicPlans() });
  }));
  app.get("/public/store-for-host", asyncRoute(async (request, response) => {
    response.status(200).json(await storeForHost(request.query.host));
  }));
  app.post("/public/merchants/register", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await consumeStorefrontRateLimit({ scope: "merchant_self_register", rawKey: clientIp(request), limit: 6, windowMs: 10 * 60 * 1000 });
    const input = parseOrThrow(registerMerchantSchema, request.body ?? {});
    response.status(201).json(await registerMerchantWithStore(input));
  }));

  // P27-7: the client reads the demo flag from the server instead of guessing from
  // the hostname, so the banner is right in every environment. Always registered —
  // it answers {demo:false} outside the demo environment.
  app.get("/public/demo-status", (_request, response) => {
    response.status(200).json({ demo: config.demoMode });
  });
  // P27-7: one-click guest entry. Registered ONLY in the demo environment, so in
  // staging and production this path does not exist at all (404 from the SPA
  // fallback, never a 403 that would confirm the feature).
  if (config.demoMode) {
    app.post("/public/demo-login", asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      // Reuses the existing storefront limiter so a scripted client cannot mint
      // demo sessions in bulk; the window matches the dashboard-login buckets.
      await consumeStorefrontRateLimit({ scope: "demo_guest_login", rawKey: clientIp(request), limit: 30, windowMs: 10 * 60 * 1000 });
      const session = await loginDemoMerchantGuest();
      setWebSession(response, session.accessToken);
      response.status(200).json(session);
    }));
  }

  /**
   * PG-3 — unsubscribe. No session, by design: the recipient of an unwanted
   * email is exactly the person least likely to have an account, and demanding
   * one is how a working unsubscribe link becomes a decorative one.
   *
   * The token is an HMAC over (storeId, email) and grants nothing but the right
   * to stop this store's marketing to this address.
   *
   * GET describes; POST acts. A mail client that pre-fetches links must not be
   * able to unsubscribe someone who never clicked, and a GET that mutates is
   * exactly that bug.
   */
  app.get("/public/unsubscribe/:token", asyncRoute(async (request, response) => {
    await consumeStorefrontRateLimit({ scope: "unsubscribe_view", rawKey: clientIp(request), limit: 60, windowMs: 10 * 60 * 1000 });
    const { storeId, emailNormalized } = verifyUnsubscribeToken(request.params.token);
    const [store, existing] = await Promise.all([
      prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }),
      prisma.notificationUnsubscribe.findUnique({ where: { storeId_emailNormalized: { storeId, emailNormalized } }, select: { unsubscribedAt: true } }),
    ]);
    response.status(200).json({
      storeName: store?.name ?? null,
      email: emailNormalized,
      alreadyUnsubscribed: existing !== null,
      // Said plainly on the page, because the fear that stops people pressing
      // the button is losing their order updates.
      scope: "marketing_only",
    });
  }));

  app.post("/public/unsubscribe/:token", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await consumeStorefrontRateLimit({ scope: "unsubscribe_act", rawKey: clientIp(request), limit: 30, windowMs: 10 * 60 * 1000 });
    const { storeId, emailNormalized } = verifyUnsubscribeToken(request.params.token);
    await recordUnsubscribe(storeId, emailNormalized, "link");
    response.status(200).json({ unsubscribed: true, email: emailNormalized, scope: "marketing_only" });
  }));
}

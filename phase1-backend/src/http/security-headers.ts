/**
 * 19-د (D-34) — the security headers, and the Content-Security-Policy in
 * particular.
 *
 * ============================================================================
 * WHAT WAS ACTUALLY SHIPPED BEFORE THIS FILE, AND WHY IT WAS WORSE THAN IT LOOKS
 * ============================================================================
 *
 * Three headers were set by hand — nosniff, frame-deny, referrer-policy — inside
 * `createApp()`. `createApp()` is mounted at `/api` by the composite server
 * (`server/index.ts`), so those three headers were reaching JSON RESPONSES ONLY.
 * Every HTML DOCUMENT the platform serves — the marketing page, all three
 * dashboards, the till, and every storefront on every custom merchant domain —
 * was served by `express.static` / the SPA catch-all and carried NO security
 * header at all. A CSP protects a document; there was no document being covered.
 *
 * So this middleware is mounted in BOTH places: the composite server (where the
 * documents are) and `createApp()` (which still runs standalone via
 * `phase1:start`, and which every integration test drives directly). Applying it
 * twice to an `/api` response is harmless — every header is written with
 * `setHeader`, so the second application overwrites the first with the identical
 * value.
 *
 * ============================================================================
 * TWO POLICIES, SPLIT BY SURFACE — AND WHY THE SPLIT IS BY *DASHBOARD* PATH
 * ============================================================================
 *
 * The D-34 anchors (`client/src/lib/storefront-pixels.ts`,
 * `services/marketing-settings.service.ts`) ask for the three ad-pixel script
 * origins on STOREFRONT pages only, and none on the dashboards. The obvious
 * implementation — "allow the extras when the path starts with /store/" — is
 * WRONG, and silently so:
 *
 *   A storefront on a CUSTOM MERCHANT DOMAIN is served at `/`, not at
 *   `/store/:slug`. `useHostStorefrontRedirect()` (client/src/App.tsx) resolves
 *   Host → slug and then calls wouter's `navigate(..., { replace: true })` — a
 *   history replacement, NOT a document load. CSP is bound to the DOCUMENT, so
 *   the policy served for `/` is the policy that governs that storefront for its
 *   entire life. Scoping the pixel origins to `/store/*` would leave every
 *   custom-domain storefront — which is the merchant who paid for a domain, i.e.
 *   the ones most likely to be running ads — with its pixels blocked, and the
 *   only symptom would be a console message nobody reads.
 *
 * So the test is INVERTED: the three DASHBOARD prefixes get the strict policy,
 * and everything else gets the storefront policy. Those prefixes — `/platform`,
 * `/merchant`, `/staff` — are unambiguous on every host (they are the same three
 * `Disallow:` lines `robotsTxt()` already publishes), so a dashboard opened on a
 * merchant's own domain is still strict, and `/` on a merchant's domain is still
 * a storefront. `/` on the platform's own host lands in the storefront policy
 * too: it is the public marketing page, it holds no session, and it is the one
 * page that may plausibly want a pixel of its own later.
 *
 * ============================================================================
 * THE DIRECTIVES, ONE REASON EACH
 * ============================================================================
 *
 * Every origin below was read out of the code that needs it. There is no
 * wildcard anywhere in this file, deliberately.
 */
import helmet from "helmet";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * The ad-pixel SCRIPT origins, taken verbatim from the three `loadScript(...)`
 * calls in `client/src/lib/storefront-pixels.ts`. Nothing else is a script
 * origin, on any surface.
 */
const PIXEL_SCRIPT_ORIGINS = [
  "https://connect.facebook.net", // injectMeta → fbevents.js
  "https://analytics.tiktok.com", // injectTikTok → i18n/pixel/events.js
  "https://www.googletagmanager.com", // injectGa4 → gtag/js
] as const;

/**
 * Where those three scripts SEND what they collect.
 *
 * These are not in our source — they live inside the vendor bundles — but
 * allowing a pixel to load and then blocking its beacon is the same silent
 * failure as not allowing it at all: the merchant sees a configured pixel that
 * records nothing. Each host is named exactly; none is a wildcard.
 *
 * Deliberately NOT included: `https://stats.g.doubleclick.net`, which GA4 uses
 * only when the merchant turns Google Signals on. Core GA4 collection does not
 * need it, and an advertising-network origin is not something to grant by
 * default on behalf of a merchant who never asked for it.
 *
 * Known limitation, recorded rather than papered over with a wildcard: GA4 sends
 * EU traffic to regional endpoints (`region1.google-analytics.com` and
 * friends). Iraqi traffic resolves to `www.google-analytics.com`, so this list
 * is right for the platform's market; a merchant with EU visitors would need
 * that host added by name.
 */
const PIXEL_BEACON_ORIGINS = [
  "https://www.facebook.com", // Meta: /tr/ beacons and fetch-based events
  "https://analytics.tiktok.com", // TikTok posts events back to its script origin
  "https://www.google-analytics.com", // GA4 /g/collect
  "https://analytics.google.com", // GA4's secondary collection host
] as const;

/**
 * Google Fonts, verified in `client/index.html` (a `preconnect` pair and one
 * stylesheet `<link>`) and in `client/public/sw.js`, which caches both hosts.
 */
const FONT_STYLESHEET_ORIGIN = "https://fonts.googleapis.com";
const FONT_FILE_ORIGIN = "https://fonts.gstatic.com";

export type SecuritySurface = "platform" | "storefront";

/**
 * The dashboard prefixes. Same three the crawler is told to stay out of.
 * The till lives under `/merchant`, so it is a PLATFORM surface — which is why
 * `worker-src` below is part of the shared base and not a storefront extra.
 */
const PLATFORM_PREFIXES = ["/platform", "/merchant", "/staff"] as const;

/**
 * `createApp()` is mounted at `/api` by the composite server and at the root by
 * `phase1:start`, so the raw request path is not comparable between the two.
 * Normalising the mount prefix away makes one rule serve both, and makes
 * `/api/merchant/...` classify exactly like the `/merchant/...` document does.
 */
export function normaliseSurfacePath(rawUrl: string): string {
  const pathname = rawUrl.split("?")[0]!.split("#")[0]!;
  const withoutApi = pathname === "/api" ? "/" : pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  return withoutApi || "/";
}

export function surfaceForPath(rawUrl: string): SecuritySurface {
  const pathname = normaliseSurfacePath(rawUrl);
  const platform = PLATFORM_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return platform ? "platform" : "storefront";
}

/**
 * The policy, as data, so the guard test asserts the same object the server
 * serves rather than a re-typed copy of it.
 */
export function contentSecurityPolicyDirectives(surface: SecuritySurface): Record<string, string[]> {
  const storefront = surface === "storefront";
  return {
    // A floor, so a directive nobody thought to name falls back to same-origin
    // rather than to «anything».
    "default-src": ["'self'"],

    // Nothing in the platform emits a <base> tag. Left unset it defaults to
    // «allowed», and one injected <base href="//attacker"> re-points every
    // relative URL on the page — including /assets/*.js.
    "base-uri": ["'none'"],

    // No <object>, <embed> or <applet> anywhere in the client. These are the
    // oldest script-execution vector still shipped in browsers.
    "object-src": ["'none'"],

    // The header form of the X-Frame-Options: DENY that already shipped.
    // frame-ancestors is the one modern browsers actually consult; XFO is kept
    // beside it only for the browsers that never learned CSP.
    "frame-ancestors": ["'none'"],

    // No <iframe> exists in the client (verified: zero matches). The Meta pixel
    // sometimes wants one for cookie syncing; refusing it costs an advertiser
    // some match rate and costs the storefront nothing.
    "frame-src": ["'none'"],

    // A form whose action was rewritten cannot post the customer's address or
    // the owner's password to another origin.
    "form-action": ["'self'"],

    // ====================================================================
    // MANDATORY. The POS-offline till (ق-142) registers /sw.js. Without this
    // directive the registration is refused and NOTHING is reported anywhere —
    // the cashier simply finds that the till no longer boots after a power cut.
    // It is in the SHARED base, not a storefront extra, precisely so that no
    // future edit to the storefront list can take it away from /merchant/*.
    // ====================================================================
    "worker-src": ["'self'"],

    // 'self' only, and it is enough: the built shell (dist/public/index.html)
    // carries exactly one <script>, and it has a src. There is no inline script
    // and no <style> element in the build output, so NO 'unsafe-inline' and no
    // hash list is needed here — the JSON-LD blocks the SEO service injects are
    // `type="application/ld+json"`, a data block browsers never execute and CSP
    // therefore never checks.
    "script-src": storefront ? ["'self'", ...PIXEL_SCRIPT_ORIGINS] : ["'self'"],

    // 'unsafe-inline' IS required here, and only here. Two shipped runtime
    // dependencies build <style> elements with document.createElement("style"):
    // `sonner` (the toasts) and `react-style-singleton`, which every Radix
    // overlay pulls in through react-remove-scroll to lock body scroll. Neither
    // accepts a nonce from this codebase. An inline STYLE is a far smaller
    // hazard than an inline SCRIPT — it cannot execute — and it is the price of
    // those two libraries; script-src stays clean, which is the directive that
    // matters.
    "style-src": ["'self'", "'unsafe-inline'", FONT_STYLESHEET_ORIGIN],

    "font-src": ["'self'", FONT_FILE_ORIGIN],

    // `data:` for the inline SVG favicon in index.html; `blob:` for the canvas
    // the merchant's share card renders (client/src/components/ProductShareCard).
    "img-src": storefront ? ["'self'", "data:", "blob:", ...PIXEL_BEACON_ORIGINS] : ["'self'", "data:", "blob:"],

    // The font hosts are here for a reason that is easy to miss: the till's
    // service worker REVALIDATES the Google Fonts stylesheet and files with
    // fetch() from inside the worker (sw.js `fontResponse`), and a worker is
    // governed by the CSP served with its OWN script — which is this one. Which
    // fetch directive a browser charges that request to is not consistent
    // between engines, so both hosts are allowed under connect-src as well as
    // under style-src/font-src. Leaving them out here is the sort of thing that
    // works everywhere in testing and fails on one browser in a shop.
    "connect-src": storefront
      ? ["'self'", FONT_STYLESHEET_ORIGIN, FONT_FILE_ORIGIN, ...PIXEL_BEACON_ORIGINS]
      : ["'self'", FONT_STYLESHEET_ORIGIN, FONT_FILE_ORIGIN],

    // NOT SET, deliberately: `upgrade-insecure-requests`. HSTS below is the
    // mechanism for forcing https, and it is the one that also protects the
    // FIRST request. `upgrade-insecure-requests` would additionally rewrite
    // subresource URLs inside the browser-acceptance suites, which run the real
    // production bundle over http://127.0.0.1.
  };
}

/**
 * The serialized policy, exactly as it goes on the wire — separator included.
 * helmet joins directives with a bare `;`, and the guard test compares this
 * string against a real response byte for byte, so the two must not drift.
 */
export function contentSecurityPolicy(surface: SecuritySurface): string {
  return Object.entries(contentSecurityPolicyDirectives(surface))
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join(";");
}

/**
 * ============================================================================
 * HSTS — one year, on THIS host, and nothing more
 * ============================================================================
 *
 * `includeSubDomains` is OMITTED, and this is the whole reason the decision
 * needed thinking about. Merchants point their OWN domains at this platform
 * (`Store.customDomain`), apex domains included. If a storefront served at
 * `example.com` answered with `includeSubDomains`, this platform would be
 * asserting — in every browser that ever loaded that page, for a year — that
 * EVERY host under a domain we do not own is https-only. `mail.example.com`,
 * an internal tool, a legacy http subdomain: all of them break, none of them
 * are ours, and the merchant cannot undo it by changing anything on his side.
 * That is an outage this platform would be inflicting on someone else's DNS
 * zone.
 *
 * `preload` is omitted for the same reason and one worse: the preload list
 * REQUIRES includeSubDomains, and it is baked into browser binaries — removal
 * takes months. Submitting a merchant's domain to it is not a decision this
 * codebase is entitled to make on his behalf.
 *
 * A year of max-age on the exact host that served the response is the part that
 * is genuinely ours to assert, and it is where nearly all of the value is.
 */
export const HSTS_VALUE = "max-age=31536000";

/**
 * ASVS 5.0 V3.4.1 (L2) asks HSTS to cover subdomains — and on the PLATFORM'S
 * OWN domain it safely can: every host under it is ours (the landing, the
 * dashboards, `<store>.<platform>` storefronts), all served over https. So the
 * platform host and its subdomains get `includeSubDomains`; a merchant's custom
 * domain keeps the bare value above, for every reason given there.
 */
export const HSTS_PLATFORM_VALUE = "max-age=31536000; includeSubDomains";

function platformHostFromEnv(): string | null {
  try {
    const raw = process.env.CODIQ_PUBLIC_BASE_URL;
    return raw ? new URL(raw).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Exported for the guard: the HSTS value a response to `host` carries. */
export function hstsValueFor(host: string | undefined, platformHost: string | null = platformHostFromEnv()): string {
  const name = (host ?? "").split(":")[0]!.toLowerCase();
  if (platformHost && (name === platformHost || name.endsWith(`.${platformHost}`))) return HSTS_PLATFORM_VALUE;
  return HSTS_VALUE;
}

/**
 * HSTS goes out only on https. RFC 6797 §8.1 makes a UA ignore the header when
 * it arrives over plain http anyway, so sending it there is noise that makes the
 * header set harder to reason about — and the browser suites all run over http.
 * Railway terminates TLS at its proxy, so `request.secure` is only truthful once
 * `trust proxy` is set; both mounting points set it.
 */
function isHttps(request: Request): boolean {
  return request.secure || request.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function helmetFor(surface: SecuritySurface): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: contentSecurityPolicyDirectives(surface),
    },
    // Set by hand below, so it can be conditioned on the protocol and so the
    // includeSubDomains/preload decision above is stated where it is made.
    strictTransportSecurity: false,
    // Kept exactly as it shipped. helmet's own default is `no-referrer`, which
    // would be a silent behaviour change to every outbound link on the platform.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    frameguard: { action: "deny" },
    noSniff: true,
    // `0` is the correct modern value: the legacy XSS auditor this header once
    // enabled introduced vulnerabilities of its own and is gone from every
    // current engine. Sending 0 says «do not turn it back on».
    xXssProtection: true,
    crossOriginOpenerPolicy: { policy: "same-origin" },

    // ==================================================================
    // Explicitly NOT shipped. Each of these is a helmet default, and each is
    // switched off on purpose so that the header set this platform sends is
    // exactly the list the guard test asserts — never «whatever helmet's next
    // major decided».
    // ==================================================================
    //
    // CORP would forbid other origins from embedding our images. A merchant's
    // storefront runs on his OWN domain, so «cross-origin» here is a boundary
    // real merchants cross — a product image pulled into a merchant's blog, for
    // instance. Changing that is a behaviour change with no test covering it,
    // and it is not what D-34 asked for.
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
    // Would disable DNS prefetch, working against the two `preconnect` hints
    // index.html carries for the font hosts.
    xDnsPrefetchControl: false,
    originAgentCluster: false,
    xDownloadOptions: false,
    xPermittedCrossDomainPolicies: false,
    // This one is a REMOVAL, not an addition: Express advertises
    // `X-Powered-By: Express` unless something strips it.
    hidePoweredBy: true,
  });
}

const HELMET_BY_SURFACE: Record<SecuritySurface, RequestHandler> = {
  platform: helmetFor("platform"),
  storefront: helmetFor("storefront"),
};

/**
 * The single middleware. Mount it as early as possible — before static files,
 * before body parsing, before any route — so that a response produced by a
 * short-circuiting guard carries the same headers as a normal one.
 */
export function securityHeaders(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (isHttps(request)) response.setHeader("Strict-Transport-Security", hstsValueFor(request.hostname));
    HELMET_BY_SURFACE[surfaceForPath(request.originalUrl || request.url)](request, response, next);
  };
}

/**
 * The exact set of header names this platform sends, for the guard test. A
 * header appearing on a response that is not in this list is a header nobody
 * decided to send.
 */
export const SECURITY_HEADER_NAMES = [
  "content-security-policy",
  "cross-origin-opener-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
  "x-xss-protection",
] as const;

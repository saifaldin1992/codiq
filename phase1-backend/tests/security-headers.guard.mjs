/**
 * codiq 19-د (D-34) — the security headers, asserted on a REAL response.
 *
 * Mirrors `cookie-secure-check.mjs`: the rules that are easy to get wrong are
 * pinned by name, with the reason attached, so a future edit that quietly
 * loosens one fails here instead of in a shop.
 *
 * THE ONE THAT MATTERS MOST is `worker-src 'self'`. The POS-offline till (ق-142)
 * registers `/sw.js`; a CSP without that directive refuses the registration and
 * reports NOTHING — no error, no log, no user-visible failure until the day the
 * power goes out and the till will not boot. It is asserted for BOTH surfaces
 * below, because the till lives under `/merchant` and would otherwise be
 * covered only by the policy nobody was thinking about while writing the
 * storefront one.
 *
 * The second is the shape of the surface split. A storefront on a CUSTOM
 * MERCHANT DOMAIN is served at `/`, and reaches `/store/:slug` by a history
 * replacement that never loads a new document — so the policy served for `/` is
 * the policy that storefront lives under forever. Scoping the pixel origins to
 * `/store/*` would break exactly the merchants who bought a domain to run ads.
 */
import assert from "node:assert/strict";
import http from "node:http";

/** A CSP directive is a LIST of sources; membership is exact, never a substring. */
const hasSource = (sources, source) => Array.isArray(sources) && sources.some((value) => value === source);

// This guard boots the real app but never issues a query, so the two values
// `config.ts` demands at import are supplied here rather than requiring a
// database to assert a header. The URL points at a host that cannot resolve, so
// a future query added to this path fails loudly instead of touching anything.
process.env.SESSION_JWT_SECRET ??= "security-headers-guard-secret-not-for-production";
process.env.DATABASE_URL ??= "postgresql://guard:guard@headers-guard-never-connects.invalid:5432/guard";

const {
  contentSecurityPolicy,
  contentSecurityPolicyDirectives,
  surfaceForPath,
  normaliseSurfacePath,
  HSTS_VALUE,
  hstsValueFor,
  SECURITY_HEADER_NAMES,
} = await import("../src/http/security-headers.ts");

// ===========================================================================
// 1. THE SURFACE SPLIT
// ===========================================================================

for (const dashboard of [
  "/platform",
  "/platform/login",
  "/platform/staff/dashboard",
  "/merchant",
  "/merchant/dashboard",
  "/merchant/stores/abc/till",
  "/staff/login",
  "/staff/stores/abc/dashboard",
  // The same paths as they arrive at the API app, which the composite server
  // mounts under /api. One rule has to serve both mount points.
  "/api/merchant/stores/abc/orders",
  "/api/platform/staff",
]) {
  assert.equal(surfaceForPath(dashboard), "platform", `«${dashboard}» is a dashboard — it gets NO third-party script origin`);
}

for (const storefront of [
  "/",
  "/store/some-shop",
  "/store/some-shop/checkout",
  "/api/store/some-shop/public-config",
  "/unsubscribe/abc",
  "/demo",
  // A custom merchant domain serves its storefront HERE, at the root, and never
  // loads another document. This single line is the reason the split is by
  // dashboard prefix rather than by `/store/`.
  "/?codiq_host=shop.example.com",
]) {
  assert.equal(surfaceForPath(storefront), "storefront", `«${storefront}» may carry a storefront — the ad pixels must load`);
}

// A path that merely BEGINS with the letters of a dashboard prefix is not one.
assert.equal(surfaceForPath("/merchants-guide"), "storefront", "prefix matching must be on path segments, not on characters");
assert.equal(surfaceForPath("/platformer"), "storefront", "…the same trap in the other direction");

assert.equal(normaliseSurfacePath("/api/merchant/x?y=1"), "/merchant/x", "the query string is not part of the path");
assert.equal(normaliseSurfacePath("/api"), "/", "the bare mount point is the root");
assert.equal(normaliseSurfacePath("/apiary/merchant"), "/apiary/merchant", "only the exact /api mount prefix is stripped");

// ===========================================================================
// 2. THE DIRECTIVES THAT KEEP SHIPPED FEATURES ALIVE
// ===========================================================================

const platform = contentSecurityPolicyDirectives("platform");
const storefront = contentSecurityPolicyDirectives("storefront");

for (const [name, directives] of [["platform", platform], ["storefront", storefront]]) {
  // ق-142. Without this the till's service worker never registers, and nothing
  // anywhere says so.
  assert.deepEqual(directives["worker-src"], ["'self'"], `${name}: worker-src 'self' is MANDATORY — POS-offline dies silently without it`);
  // /sw.js is same-origin, so the script that becomes the worker is covered too.
  assert.ok(directives["script-src"].includes("'self'"), `${name}: script-src must cover the same-origin /sw.js and /assets/*`);

  // The built shell carries exactly one <script>, and it has a src. There is no
  // inline script in dist/public/index.html, so there is no excuse for either.
  assert.ok(!directives["script-src"].includes("'unsafe-inline'"), `${name}: script-src must never carry 'unsafe-inline' — the build has no inline script`);
  assert.ok(!directives["script-src"].includes("'unsafe-eval'"), `${name}: script-src must never carry 'unsafe-eval'`);

  // The floor, and the three that close off the cheapest injection vectors.
  assert.deepEqual(directives["default-src"], ["'self'"], `${name}: default-src is the floor for every directive nobody named`);
  assert.deepEqual(directives["base-uri"], ["'none'"], `${name}: an injected <base> re-points every relative URL, /assets/*.js included`);
  assert.deepEqual(directives["object-src"], ["'none'"], `${name}: no <object>/<embed> exists in the client`);
  assert.deepEqual(directives["frame-ancestors"], ["'none'"], `${name}: the modern form of the X-Frame-Options DENY that already shipped`);
  assert.deepEqual(directives["form-action"], ["'self'"], `${name}: a rewritten form action must not post the customer's address elsewhere`);

  // Google Fonts, verified in client/index.html and in the SW's font cache.
  assert.ok(hasSource(directives["style-src"], "https://fonts.googleapis.com"), `${name}: the font stylesheet <link> in index.html`);
  assert.ok(hasSource(directives["font-src"], "https://fonts.gstatic.com"), `${name}: the font files that stylesheet names`);
  // The till's SW revalidates both hosts with fetch() from INSIDE the worker,
  // and a worker runs under the CSP served with its own script. Which fetch
  // directive an engine charges that to is not consistent, so both are allowed
  // under connect-src as well.
  assert.ok(hasSource(directives["connect-src"], "https://fonts.googleapis.com"), `${name}: sw.js fontResponse() revalidates the stylesheet from inside the worker`);
  assert.ok(hasSource(directives["connect-src"], "https://fonts.gstatic.com"), `${name}: …and the font files`);
  assert.ok(directives["connect-src"].includes("'self'"), `${name}: the SPA and the till queue both talk to /api on this origin`);

  // No wildcard, anywhere, in any directive. The whole point of reading the
  // pixel code was to avoid one.
  for (const [directive, values] of Object.entries(directives)) {
    for (const value of values) {
      assert.ok(!value.includes("*"), `${name}: «${value}» in ${directive} is a wildcard — every origin here must be named`);
    }
  }
}

// The three ad-pixel script origins, exactly as `storefront-pixels.ts` loads
// them, and exactly where the D-34 anchors said they belong.
const PIXEL_SCRIPTS = ["https://connect.facebook.net", "https://analytics.tiktok.com", "https://www.googletagmanager.com"];
for (const origin of PIXEL_SCRIPTS) {
  assert.ok(storefront["script-src"].includes(origin), `storefront: ${origin} is loaded by storefront-pixels.ts`);
  assert.ok(!platform["script-src"].includes(origin), `dashboard: ${origin} must NOT be allowed — no dashboard ever mounts StorefrontProvider`);
}
assert.deepEqual(platform["script-src"], ["'self'"], "a dashboard gets exactly one script origin: its own");

// Allowing a pixel to load and then blocking its beacon is the same silent
// failure as blocking it outright — a configured pixel that records nothing.
assert.ok(hasSource(storefront["connect-src"], "https://www.facebook.com"), "storefront: the Meta pixel's beacon host");
assert.ok(hasSource(storefront["connect-src"], "https://www.google-analytics.com"), "storefront: GA4 /g/collect");
assert.ok(!platform["connect-src"].some((value) => PIXEL_SCRIPTS.includes(value) || value.includes("facebook") || value.includes("google-analytics")),
  "dashboard: no third-party telemetry origin at all");

// 'unsafe-inline' on STYLE only, and only because two shipped dependencies
// build <style> elements at runtime (sonner; react-style-singleton, which every
// Radix overlay pulls in). An inline style cannot execute.
assert.ok(storefront["style-src"].includes("'unsafe-inline'"), "style-src carries 'unsafe-inline' for sonner and react-style-singleton");
assert.ok(platform["style-src"].includes("'unsafe-inline'"), "…on the dashboards too, which is where the Radix overlays live");

// data: for the inline SVG favicon; blob: for the share-card canvas.
for (const scheme of ["data:", "blob:"]) {
  assert.ok(storefront["img-src"].includes(scheme), `img-src ${scheme}`);
  assert.ok(platform["img-src"].includes(scheme), `img-src ${scheme} on the dashboards`);
}

// ===========================================================================
// 3. HSTS — and the two attributes that are omitted on purpose
// ===========================================================================

assert.equal(HSTS_VALUE, "max-age=31536000", "one year on the host that served the response");
assert.ok(
  !/includeSubDomains/i.test(HSTS_VALUE),
  "HSTS must NOT claim includeSubDomains: merchants point their OWN apex domains here, and this platform would be asserting https-only over every unrelated subdomain of a zone it does not own — for a year, undoable from their side",
);
assert.ok(
  !/preload/i.test(HSTS_VALUE),
  "HSTS must NOT ask for preload: the list requires includeSubDomains and is baked into browser binaries — not a commitment to make on a merchant's behalf",
);

// ===========================================================================
// 4. A REAL RESPONSE, THROUGH THE REAL APP
// ===========================================================================

const { createApp } = await import("../src/http/app.ts");

function listen(app) {
  return new Promise((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
}

function getter(server) {
  const { port } = server.address();
  return (path, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path, headers }, (response) => {
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
        })
        .on("error", reject);
    });
}

const apiServer = await listen(createApp());
const get = getter(apiServer);

/** Everything a normal Express response carries anyway. What is left is ours. */
const ORDINARY = new Set(["content-type", "content-length", "date", "connection", "keep-alive", "etag", "vary", "transfer-encoding", "access-control-allow-origin"]);
const securityHeadersOf = (headers) => Object.keys(headers).filter((name) => !ORDINARY.has(name)).sort();

// D-41 (24-أ): `x-request-id` is DECIDED, not incidental — it is the string a
// merchant reads back when he reports «صار خطأ», and the edge middleware sets
// it on every response including this one. It is named here rather than added
// to SECURITY_HEADER_NAMES because it is not a security header: the rule that
// «a header nobody decided to send is as much a defect as a missing one» keeps
// its force, and this is the record of the decision.
const DECIDED = [...SECURITY_HEADER_NAMES, "x-request-id"].sort();

// A storefront-surface response, over plain http.
const health = await get("/health");
assert.equal(health.status, 200, "the health probe still answers");
assert.deepEqual(
  securityHeadersOf(health.headers),
  DECIDED,
  "the EXACT header set — a header nobody decided to send is as much a defect as a missing one",
);
assert.match(health.headers["x-request-id"] ?? "", /^[0-9a-f]{16}$/, "D-41: and the correlation id is on the probe too, not only on the routes");
assert.equal(health.headers["content-security-policy"], contentSecurityPolicy("storefront"), "/health is not a dashboard path");
assert.equal(health.headers["x-content-type-options"], "nosniff", "kept from before this change");
assert.equal(health.headers["x-frame-options"], "DENY", "kept from before this change");
assert.equal(health.headers["referrer-policy"], "strict-origin-when-cross-origin", "kept from before this change — helmet's own default is no-referrer, which would be a silent behaviour change");
assert.equal(health.headers["cross-origin-opener-policy"], "same-origin");
assert.equal(health.headers["x-xss-protection"], "0", "0 is the correct modern value: the legacy auditor introduced vulnerabilities of its own");
assert.equal(health.headers["x-powered-by"], undefined, "Express must stop advertising itself");
assert.equal(health.headers["strict-transport-security"], undefined, "no HSTS over plain http — RFC 6797 §8.1 makes a UA ignore it anyway");

// The same probe behind a TLS-terminating proxy. `trust proxy` is what makes
// this truthful on Railway.
const secure = await get("/health", { "x-forwarded-proto": "https" });
assert.equal(secure.headers["strict-transport-security"], HSTS_VALUE, "HSTS goes out once the request arrived over https");

// ===========================================================================
// 4-ب. ق-230 — AN AUTHENTICATED ANSWER IS NEVER CACHED
// ===========================================================================
//
// ASVS V8.1.1. Four routes set `no-store` by hand and two of those are public;
// everything else — an order list carrying a shopper's name, address and phone,
// a settlement report, a customer directory — went out with NO cache directive
// at all, which lets the browser's own disk and any shared proxy keep it. In an
// Iraqi shop the browser is frequently the counter's shared machine, and
// «الرجوع» after the next person signs in is the whole attack.
//
// The condition is the REQUEST carrying an identity, not the response's shape:
// there is no list of «sensitive routes» to maintain, and therefore none to
// forget a route from.
const withBearer = await get("/health", { authorization: "Bearer not-a-real-token" });
assert.equal(withBearer.headers["cache-control"], "no-store", "ق-230: a request that carries a bearer token gets no-store, whatever it asked for");
assert.deepEqual(
  securityHeadersOf(withBearer.headers),
  [...DECIDED, "cache-control"].sort(),
  "…and cache-control is the ONLY addition — the exact-set rule holds for an authenticated response too",
);

// `__Host-codiq_session` is D-63's name for the SAME cookie in every environment
// that sets `Secure` — which is every deployed one. It is listed explicitly
// because ق-230's rule is a substring test, and a substring test is exactly the
// kind that keeps passing on the un-prefixed name in CI while marking nothing in
// production.
for (const cookie of ["codiq_session=abc", "__Host-codiq_session=abc", "codiq_customer_some-shop=abc", "other=1; __Host-codiq_session=abc"]) {
  const withCookie = await get("/health", { cookie });
  assert.equal(withCookie.headers["cache-control"], "no-store", `ق-230: «${cookie}» is an identity — the merchant, staff and platform cookies all share the codiq_session name, and a shopper's is per-store`);
}

// The other half of the rule, and the half that is easy to lose: a PUBLIC read
// is untouched. A product image with its immutable year, the storefront itself,
// the landing page — no directive is added, so nothing that was cacheable
// yesterday stops being cacheable today.
const anonymous = await get("/health", { cookie: "cart_id=abc; locale=ar" });
assert.equal(anonymous.headers["cache-control"], undefined, "ق-230: a request with no identity gets no directive from us — the public surface keeps its caching");

// And a route that CHOSE its own directive keeps it. `no-store` is set as the
// DEFAULT, before the routes, rather than forced at write time — which is why
// `/openapi.json` still answers `no-cache` to an authenticated integrator and
// why the image routes keep their immutable year with no exemption list to
// maintain. An exemption list is the thing that rots.
const openapi = await get("/openapi.json", { authorization: "Bearer not-a-real-token" });
assert.equal(openapi.status, 200, "the OpenAPI document still answers");
assert.equal(openapi.headers["cache-control"], "no-cache", "ق-230: a handler's own cache-control REPLACES the default — the middleware must never overwrite a decision a route already made");

apiServer.close();

// The DOCUMENT surface, which is the one D-34 was actually about. The composite
// server answers the SPA shell with 200 for every unmatched path, so this stub
// reproduces its shape: the real middleware, then a catch-all. (Note for anyone
// reading a raw response: on a path that matches NOTHING, Express's own
// finalhandler replaces the policy with `default-src 'none'` — stricter than
// ours, and it never reaches a document, because documents are never 404s.)
const express = (await import("express")).default;
const { securityHeaders } = await import("../src/http/security-headers.ts");
const { correlationMiddleware } = await import("../src/http/correlation.ts");
const shell = express();
// The mount ORDER mirrors `server/index.ts` exactly, correlation first: this
// stub is a mirror of the real outer app, and a mirror that has drifted proves
// nothing about the surface it claims to stand for.
shell.use(correlationMiddleware());
shell.use(securityHeaders());
shell.get("*", (_request, response) => response.type("html").send("<!doctype html><title>shell</title>"));
const shellServer = await listen(shell);
const getDocument = getter(shellServer);

const till = await getDocument("/merchant/stores/some-shop/till");
assert.equal(till.status, 200);
assert.equal(till.headers["content-security-policy"], contentSecurityPolicy("platform"), "the till is under /merchant — it gets the strict policy");
assert.ok(/worker-src 'self'/.test(till.headers["content-security-policy"]), "…and it still carries worker-src, or the till stops booting offline");
assert.deepEqual(securityHeadersOf(till.headers), DECIDED, "an HTML document carries the same set as an API response");

// The document a CUSTOM MERCHANT DOMAIN actually serves: the root. It never
// loads another document, so this policy governs that storefront for good.
const customDomainRoot = await getDocument("/");
assert.equal(
  customDomainRoot.headers["content-security-policy"],
  contentSecurityPolicy("storefront"),
  "`/` is where a custom merchant domain serves its storefront — its pixels must be allowed by THIS document's policy",
);

const storePage = await getDocument("/store/some-shop/checkout");
assert.equal(storePage.headers["content-security-policy"], contentSecurityPolicy("storefront"), "the storefront on the platform's own host");

shellServer.close();

// ===========================================================================
// 5. THE COMPOSITE SERVER MOUNTS IT, AND MOUNTS IT FIRST
// ===========================================================================
//
// This is the regression that D-34 actually was: the headers existed, inside an
// app mounted at `/api`, so not one HTML document ever carried them. A
// structural check, because only the composite server serves documents and only
// the browser suites boot it.
const composite = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8"));
const mountIndex = composite.indexOf("securityHeaders()");
assert.ok(mountIndex > 0, "server/index.ts must mount securityHeaders() — it is the only place HTML documents are served");
assert.ok(
  mountIndex < composite.indexOf("express.static"),
  "securityHeaders() must be mounted BEFORE express.static: /sw.js is served from there, and its own response headers are the CSP the till's service worker runs under",
);
// المرحلة 20-4: the API is now mounted TWICE — `/api/v1` and `/api`, the same
// app object — and both mount paths are named constants rather than literals.
// Matching on the single literal `app.use("/api"` would have found nothing and
// compared against -1, which is a comparison that PASSES for a file with no API
// mount at all. So every spelling is searched and the EARLIEST mount is the one
// the headers must precede: covering the first mount is what matters, and if a
// later one slipped above the headers this would still catch it.
const apiMountIndex = Math.min(
  ...[/app\.use\(API_MOUNT_V1/, /app\.use\(API_MOUNT_LEGACY/, /app\.use\("\/api(\/v1)?"/]
    .map((pattern) => composite.search(pattern))
    .filter((index) => index >= 0),
);
assert.ok(Number.isFinite(apiMountIndex), "server/index.ts must mount the CODIQ API app — no mount was found under any known spelling");
assert.ok(
  mountIndex < apiMountIndex,
  "…and before the API, so one middleware covers documents and JSON alike",
);
assert.ok(composite.includes('app.set("trust proxy", 1)'), "the outer app needs trust proxy or req.secure is false behind Railway's TLS termination, and HSTS never goes out");

console.log(
  JSON.stringify(
    {
      securityHeaders: {
        headers: [...SECURITY_HEADER_NAMES, "strict-transport-security (https only)", "x-request-id (D-41)"],
        hsts: { value: HSTS_VALUE, includeSubDomains: false, preload: false, reason: "merchants point their own apex domains at this platform" },
        surfaces: {
          platform: { paths: ["/platform/*", "/merchant/*", "/staff/*"], thirdPartyScriptOrigins: 0 },
          storefront: { paths: ["everything else, including `/` on a custom merchant domain"], thirdPartyScriptOrigins: PIXEL_SCRIPTS.length },
        },
        unsafeSurviving: { "script-src": "none", "style-src": "'unsafe-inline' — sonner + react-style-singleton build <style> at runtime" },
        csp: { platform: contentSecurityPolicy("platform"), storefront: contentSecurityPolicy("storefront") },
      },
    },
    null,
    2,
  ),
);
// ASVS 5.0 V3.4.1 (L2): subdomains are covered on the platform's OWN domain only.
assert.equal(hstsValueFor("codiqos.com", "codiqos.com"), "max-age=31536000; includeSubDomains", "the platform apex covers its subdomains");
assert.equal(hstsValueFor("demo-store.codiqos.com", "codiqos.com"), "max-age=31536000; includeSubDomains", "…and so do its store subdomains");
assert.equal(hstsValueFor("shop.merchant-own.com", "codiqos.com"), HSTS_VALUE, "a merchant's custom domain never gets includeSubDomains");
assert.equal(hstsValueFor("evilcodiqos.com", "codiqos.com"), HSTS_VALUE, "a look-alike host is not the platform");
assert.equal(hstsValueFor("codiqos.com", null), HSTS_VALUE, "no configured platform host: the safe bare value");
console.log("headers:guard OK");

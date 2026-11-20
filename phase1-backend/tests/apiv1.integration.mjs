/**
 * Integration — المرحلة 20-4: بابان، تطبيق واحد.
 *
 * The dual mount is the kind of change that looks free and is not. Everything
 * asserted here is something that would have broken quietly:
 *
 *   · ORDER. `/api` registered ahead of `/api/v1` claims `/api/v1/orders`,
 *     hands the app `/v1/orders`, matches nothing, and answers the 404 net. The
 *     new prefix would exist and 404 everything on it.
 *   · THE STOREFRONT EXCEPTION. `/api/v1/store/*` must NOT work. The customer
 *     cookie is scoped to `/api/store/<slug>`, so a shopper who signed in
 *     through the versioned prefix would be handed a cookie his own browser
 *     refuses to send back to the URL that set it: signed in, then anonymous on
 *     the very next request, with a 200 on both.
 *   · ONE RATE-LIMIT BUCKET. A route reachable by two paths must not get two
 *     budgets. Proven the only way that means anything: spend the budget ACROSS
 *     both prefixes and watch the ceiling arrive on schedule.
 *   · ONE SESSION. A token minted at `/api/v1` must be accepted at `/api` and
 *     the other way round, and its cookie must carry `Path=/` — anything
 *     narrower splits the dashboard in half.
 *
 * Run: pnpm apiv1:test
 */
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import { API_MOUNT_LEGACY, API_MOUNT_V1 } from "../src/http/api-version.ts";
import { createApp } from "../src/http/app.ts";

const summary = {};

// The rate-limit rows this suite is about live in the database for ten minutes,
// so a second run inside that window would start at the ceiling and «prove» the
// bucket is shared by finding it already full. Cleared first, deliberately: a
// test that passes for the wrong reason is the thing this whole phase is about.
const { prisma } = await import("../src/db/prisma.ts");
await prisma.$executeRawUnsafe("DELETE FROM storefront_rate_limits WHERE scope IN ('merchant_self_register', 'dashboard_login')");

// The composite server's own arrangement, reproduced exactly: ONE app object,
// two mount paths, the versioned one first.
const outer = express();
outer.set("trust proxy", 1);
const codiqApi = createApp();
outer.use(API_MOUNT_V1, codiqApi);
outer.use(API_MOUNT_LEGACY, codiqApi);
// The SPA catch-all that made an unmatched `/api` path answer `200 text/html`
// before 20-2. It is here so the 404 assertions below are proving that the net
// inside the app still fires under BOTH prefixes, not that no catch-all exists.
outer.get("*", (_request, response) => response.status(200).type("html").send("<!doctype html><title>shell</title>"));

const server = outer.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const get = (path, init) => fetch(`${base}${path}`, init);

// ============================================================
// 1. Both doors are open, and they answer the same thing.
// ============================================================
const [legacyHealth, versionedHealth] = await Promise.all([get("/api/health"), get("/api/v1/health")]);
assert.equal(legacyHealth.status, 200, "the pre-existing prefix must be untouched");
assert.equal(versionedHealth.status, 200, "/api/v1 must reach the app, not the SPA shell");
assert.deepEqual(await versionedHealth.json(), await legacyHealth.json(), "one app: the two prefixes cannot answer differently");
summary.dualMount = "GET /api/health and GET /api/v1/health are the same response from the same app object";

// A real route, not just the probes: unauthenticated, so a 401 is the proof it
// reached the router. A 404 here would mean the mount claimed nothing.
const versionedGuarded = await get("/api/v1/merchant/stores");
assert.equal(versionedGuarded.status, 401, "a guarded route under /api/v1 must reach its own guard, not the 404 net");
assert.equal((await versionedGuarded.json()).error?.code, "MISSING_SESSION");
summary.guardedRoute = "a session-guarded route answers 401 under /api/v1 — it reached the router";

// ============================================================
// 2. The correlation id and the security headers ride both doors.
// ============================================================
for (const [name, response] of [["legacy", legacyHealth], ["versioned", versionedHealth]]) {
  assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f]{16}$/, `${name}: every response carries one correlation id`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${name}: securityHeaders() must not be prefix-dependent`);
  assert.ok((response.headers.get("content-security-policy") ?? "").includes("worker-src"), `${name}: the CSP that keeps the offline till alive`);
}
summary.edgeMiddleware = "x-request-id and the full security header set are identical under both prefixes";

// ============================================================
// 3. The storefront is NOT versioned. Permanently.
// ============================================================
const storefrontUnderV1 = await get("/api/v1/store/any-slug/products");
assert.equal(storefrontUnderV1.status, 404, "/api/v1/store/* must be refused, not quietly served");
const storefrontUnderV1Body = await storefrontUnderV1.json();
assert.equal(storefrontUnderV1Body.error?.code, "RESOURCE_NOT_FOUND", "refused in the standard envelope, like any other unknown path");
assert.match(storefrontUnderV1Body.error?.requestId ?? "", /^[0-9a-f]{16}$/, "…carrying a correlation id, so a report about it is traceable");

// And the refusal must be about the PREFIX, not about the store: the same path
// on `/api` gets as far as resolving the slug and says so with its own code.
const storefrontUnderLegacy = await get("/api/store/any-slug/products");
assert.equal(storefrontUnderLegacy.status, 404, "an unknown slug is still a 404 on the legacy prefix");
assert.equal((await storefrontUnderLegacy.json()).error?.code, "STORE_NOT_FOUND", "…but with the code that proves the route RAN — the storefront is alive on /api");
summary.storefrontNotVersioned = "/api/v1/store/* is RESOURCE_NOT_FOUND; /api/store/* reaches the route and answers STORE_NOT_FOUND";

// A store whose own slug starts with `v1` must not be caught by the exception:
// the guard reads `request.baseUrl`, which Express resolved, not a string search
// over the URL.
const slugLookingLikeVersion = await get("/api/store/v1-pharmacy/products");
assert.equal((await slugLookingLikeVersion.json()).error?.code, "STORE_NOT_FOUND", "a slug that merely LOOKS like a version prefix is an ordinary slug");
summary.slugNotMistakenForPrefix = "a store slug beginning with «v1» reaches the storefront route normally";

// ============================================================
// 4. An unmatched path is still the 404 net — under both prefixes, and for a
//    version that does not exist.
// ============================================================
for (const path of ["/api/does-not-exist", "/api/v1/does-not-exist", "/api/v2/orders", "/api/v1/v1/orders"]) {
  const response = await get(path);
  assert.equal(response.status, 404, `${path} must be 404, not the SPA shell`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${path} must answer JSON`);
  assert.equal((await response.json()).error?.code, "RESOURCE_NOT_FOUND", `${path} answers the standard envelope`);
}
// …and the shell is still served to everything that is not the API, so the
// assertions above are about the net and not about a missing catch-all.
assert.equal((await get("/dashboard")).status, 200, "a non-API path still gets the SPA shell");
summary.notFoundNet = "/api, /api/v1, an invented /api/v2 and a doubled /api/v1/v1 all answer 404 JSON; non-API paths still get the shell";

// ============================================================
// 5. ONE rate-limit bucket for a route reachable by two paths.
// ============================================================
// `POST /public/merchants/register` spends `merchant_self_register`, limit 6 per
// address per ten minutes, and it spends it BEFORE it validates the body — so an
// empty body is a cheap 422 and the seventh call is the ceiling. If the two
// prefixes had separate buckets (a key built from the path, say) this loop would
// end with 422 and the assertion below would fail.
const registerStatuses = [];
for (let attempt = 0; attempt < 7; attempt += 1) {
  const prefix = attempt % 2 === 0 ? "/api" : "/api/v1";
  const response = await fetch(`${base}${prefix}/public/merchants/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  registerStatuses.push(response.status);
  if (attempt < 6) continue;
  assert.equal(response.status, 429, `the 7th call across BOTH prefixes must be the ceiling; got ${registerStatuses.join(",")}`);
  assert.equal((await response.json()).error?.code, "RATE_LIMITED");
}
assert.deepEqual(registerStatuses.slice(0, 6), [422, 422, 422, 422, 422, 422], "the first six spend the budget and fail on the body, not the ceiling");
summary.oneRateLimitBucket = "six calls alternating between /api and /api/v1 spend ONE budget; the seventh is 429 — the key is (scope, subject), never the path";

// ============================================================
// 6. ONE session across both doors, on a cookie scoped to the whole dashboard.
// ============================================================
const email = `apiv1-${randomUUID()}@codiq.test`;
const password = "Codiq!Apiv1-2026";
const registered = await fetch(`${base}/api/v1/auth/platform/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, displayName: "مالك المنصة" }),
});
assert.equal(registered.status, 201, `owner registration through /api/v1 must work: ${await registered.text()}`);

const loggedIn = await fetch(`${base}/api/v1/auth/platform/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
assert.equal(loggedIn.status, 200, "sign-in through the versioned prefix");
const setCookie = loggedIn.headers.get("set-cookie") ?? "";
assert.match(setCookie, /codiq_session=/, "the dashboard cookie is issued");
assert.match(setCookie, /Path=\//, "…scoped to `/`, so it is sent to BOTH prefixes — anything narrower splits the dashboard in half");
assert.doesNotMatch(setCookie, /Path=\/api\/v1/, "the cookie must never be pinned to the prefix that happened to issue it");
const { accessToken } = await loggedIn.json();

// The token crosses both doors. This is the property that makes the second mount
// safe to ship: no client has to choose a prefix and stay on it.
for (const prefix of ["/api", "/api/v1"]) {
  const probe = await get(`${prefix}/platform/dashboard`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(probe.status, 200, `a session minted at /api/v1 must be accepted at ${prefix}`);
  assert.equal((await probe.json()).area, "platform_owner");
}
summary.oneSession = "a session minted through /api/v1 is accepted at /api and its cookie carries Path=/";

// ============================================================
// 7. The spec is served, unauthenticated, from both doors.
// ============================================================
for (const prefix of ["/api", "/api/v1"]) {
  const spec = await get(`${prefix}/openapi.json`);
  assert.equal(spec.status, 200, `${prefix}/openapi.json must be reachable with no session`);
  const document = await spec.json();
  assert.equal(document.openapi, "3.1.0");
  const operations = Object.values(document.paths).reduce((total, item) => total + Object.keys(item).filter((key) => key !== "servers").length, 0);
  assert.ok(operations > 200, `the document covers the whole API, not a sample — ${operations} operations`);
  assert.ok(document.paths["/store/{storeSlug}/products"], "the storefront is IN the document…");
  assert.deepEqual(
    document.paths["/store/{storeSlug}/products"].servers,
    [{ url: API_MOUNT_LEGACY, description: "المسار الوحيد لواجهة المتجر العام — غير مُصدَّرة بنسخة عمداً." }],
    "…pinned to /api alone, which is how the exception is stated in a form a machine can read",
  );
}
summary.specServed = "GET /openapi.json answers 3.1.0 under both prefixes with no session, and pins the storefront to /api";

server.close();
await prisma.$disconnect();
console.log(JSON.stringify({ suite: "apiv1", status: "passed", summary }, null, 2));

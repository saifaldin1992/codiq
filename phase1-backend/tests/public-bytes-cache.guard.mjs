/**
 * Guard — ق-238: every PUBLIC route that streams stored bytes names a cache policy.
 *
 * WHY THIS IS A RATCHET AND NOT A ONE-TIME FIX.
 *
 * The convention was already the house rule and most of these routes followed
 * it. `store-banners.ts` has argued it in a comment since ق-198 — «the object
 * key carries a uuid, so a slide's bytes never change under one id» — and
 * `public.ts` and `storefront-config.ts` say the same. The product image, the
 * single most requested object on the platform, simply never got the line. That
 * was not a decision anybody made; it was drift, and drift is exactly what a
 * rule living in reviewers' memory produces.
 *
 * WHAT IT COST. Twenty-four product images ride one catalog page. With no
 * directive, no cache anywhere may keep one: not the browser, not a CDN, not
 * the edge. Every shopper re-fetched every picture on every page, and each
 * fetch walked Railway → R2 → Railway → Baghdad and was billed as origin
 * egress for bytes R2 hands out for free.
 *
 * AND THE PART THAT IS NOT OBVIOUS: a header alone does not make Cloudflare
 * cache these. Its default cache set is keyed on FILE EXTENSION, and every one
 * of these URLs is extension-less under `/api` — so it answers DYNAMIC and goes
 * to origin without even looking. The header is necessary and insufficient; the
 * Cache Rule is the other half, and it lives in a dashboard this file cannot
 * see. What this file CAN hold is the half that lives in the repository.
 *
 * SCOPE. Public byte routes only. An authenticated one must NOT be listed with
 * a cache policy of its own — ق-230 stamps `no-store` on every answer carrying
 * an identity, from one middleware above the whole stack, and a handler that
 * set its own `public, max-age=…` would silently overwrite that guard and put a
 * merchant's private picture in a shared cache. Those routes are recorded in
 * AUTHENTICATED below so this file proves it looked at them and decided.
 *
 * Run: pnpm imagecache:guard
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeFileLabel, routeSourceFiles } from "../source-layout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = resolve(here, "..", "src", "http", "routes");

/** The service calls that mean «this handler sends stored bytes to the caller». */
const BYTE_READERS = [
  "getProductImageBytes",
  "getStoreBannerBytes",
  "getStoreLogoBytes",
  "platformLogoBytes",
  // The two prescription routes reach the bucket through a service rather than
  // calling the reader directly. Watching only the direct callers would have let
  // the most sensitive byte route on the platform out of this file entirely.
  "customerPrescriptionFile",
  "merchantPrescriptionFile",
];

/**
 * `file.ts:METHOD /path` → why this byte route carries NO public cache policy.
 * Every entry here is behind a session, and ق-230 already answers for it.
 */
const AUTHENTICATED = {
  "catalog.ts:GET /merchant/stores/:storeSlug/catalog/products/:productId/images/:imageId":
    "behind catalog.products.view — ق-230 stamps no-store; a public directive here would overwrite it and share a merchant's picture",
  "storefront.ts:GET /store/:storeSlug/account/orders/:orderId/prescription":
    "a customer's medical document, behind his own session — it sets private, no-store by hand and nothing may loosen it",
  "orders.ts:GET /merchant/stores/:storeSlug/orders/:orderId/prescription":
    "the same document on the merchant's side, behind orders.view — private, no-store by hand",
};

const ROUTE = /app\.(get)\(\s*"([^"]+)"/g;

const violations = [];
const satisfied = [];
const seenAuthenticated = new Set();

for (const fullPath of routeSourceFiles()) {
  const file = routeFileLabel(fullPath);
  const source = readFileSync(fullPath, "utf8");
  const matches = [...source.matchAll(ROUTE)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index;
    // The handler runs until the next route registration, or to end of file for
    // the last one. Cruder than parsing, and deliberately so: a guard that needs
    // a parser is a guard that breaks on syntax it did not expect.
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const body = source.slice(start, end);
    if (!BYTE_READERS.some((reader) => body.includes(reader))) continue;

    const key = `${file}:${match[1].toUpperCase()} ${match[2]}`;
    if (key in AUTHENTICATED) {
      seenAuthenticated.add(key);
      // An authenticated byte route must not set a PUBLIC policy of its own.
      if (/cache-control"[^)]*public/i.test(body)) {
        violations.push(`${key} — behind a session yet sets a PUBLIC cache directive; ق-230's no-store is being overwritten`);
      }
      continue;
    }
    if (/setHeader\(\s*"cache-control"/i.test(body)) {
      satisfied.push(key);
      continue;
    }
    violations.push(`${key} — serves stored bytes to the public and names no cache policy (ق-238)`);
  }
}

// An allowlist nobody prunes stops meaning anything: an entry that silences
// nothing is a stale entry and fails too (the deleted-leak-guard idiom).
for (const key of Object.keys(AUTHENTICATED)) {
  if (!seenAuthenticated.has(key)) {
    violations.push(`${key} — recorded as authenticated but no such byte route exists; remove the stale entry`);
  }
}

if (!satisfied.length) {
  violations.push("no public byte route was found at all — the detector has drifted from the routes it watches");
}

if (violations.length) {
  console.error(JSON.stringify({ suite: "public-bytes-cache", status: "failed", violations }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  suite: "public-bytes-cache",
  status: "passed",
  summary: {
    publicByteRoutesCovered: satisfied.length,
    routes: satisfied,
    authenticatedByDesign: Object.keys(AUTHENTICATED).length,
  },
}, null, 2));

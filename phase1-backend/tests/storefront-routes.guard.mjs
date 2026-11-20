/**
 * ق-173 — a storefront page the wrapper can dispatch is a page the app router
 * actually delivers.
 *
 * ============================================================================
 * WHAT HAPPENED
 * ============================================================================
 *
 * The storefront has TWO hand-written route lists that must agree:
 *
 *   App.tsx              <Route path="/store/:storeSlug/account/returns" component={StorefrontWrapper} />
 *   StorefrontWrapper    else if (/\/account\/returns$/.test(location)) page = <CustomerReturnsPage />;
 *
 * The addresses page (ق-173) was added to the wrapper, routed, linked from the
 * account menu, type-checked, built — and answered «404 Page Not Found» in the
 * browser, because the app router had never heard of it. Nothing between
 * `tsc` and the browser can tell: the wrapper compiles with a branch nobody
 * reaches, exactly as a server route compiles with no caller (ق-172).
 *
 * The same shape as ق-170 (permission matrix vs. hand-written nav): two lists,
 * hand-maintained, reconciled by nobody. This is the reconciliation.
 *
 * Run: pnpm storefront:routes
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const read = (file) => readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");

const app = read("client/src/App.tsx");
const wrapper = read("client/src/pages/StorefrontWrapper.tsx");

// What the app router delivers to the wrapper: `/store/:storeSlug/<tail>`.
const delivered = new Set(
  Array.from(app.matchAll(/<Route path=\{"\/store\/:storeSlug(\/[^"]*)?"\} component=\{StorefrontWrapper\}/g), (m) => m[1] ?? ""),
);

// What the wrapper knows how to dispatch: a regex ending in `$` over the tail.
// `[^/]+` in the wrapper corresponds to `:param` in the router.
// `(login|register)` in the wrapper is two routes in the router.
const expandAlternation = (tail) => {
  const m = tail.match(/\(([^)]+)\)/);
  if (!m) return [tail];
  return m[1].split("|").flatMap((alt) => expandAlternation(tail.replace(m[0], alt)));
};
const dispatched = Array.from(wrapper.matchAll(/\/\\\/([^$]+)\$\/\.test\(location\)/g), (m) => "/" + m[1].replace(/\\\//g, "/").replace(/\[\^\/\]\+/g, ":param")).flatMap(expandAlternation);

const routerHas = (tail) => {
  for (const d of delivered) {
    const a = d.split("/").filter(Boolean);
    const b = tail.split("/").filter(Boolean);
    if (a.length !== b.length) continue;
    if (a.every((seg, i) => seg === b[i] || (seg.startsWith(":") && b[i] === ":param"))) return true;
  }
  return false;
};

const orphaned = dispatched.filter((tail) => !routerHas(tail));

assert.deepEqual(
  orphaned,
  [],
  `صفحات يعرفها موزّع المتجر ولا يوصلها موجّه التطبيق: ${orphaned.join(", ")}\n\n` +
    `Each of these has a branch in StorefrontWrapper and no <Route> in App.tsx, so the browser answers 404 before the ` +
    `wrapper ever runs. Add <Route path={"/store/:storeSlug<tail>"} component={StorefrontWrapper} /> beside its siblings.`,
);

assert.ok(dispatched.length >= 8, `expected the wrapper's dispatch table, read ${dispatched.length} branches`);

console.log(JSON.stringify({
  suite: "storefront-routes",
  status: "passed",
  summary: { dispatched: dispatched.length, delivered: delivered.size, guarantee: "every storefront page the wrapper dispatches is one the app router delivers" },
}, null, 2));

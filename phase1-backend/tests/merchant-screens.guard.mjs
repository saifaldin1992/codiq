/**
 * Every merchant menu entry marked «implemented» lands on a real screen.
 *
 * The dashboard resolves a path in this order: the order workspace
 * (`/merchant/dashboard/orders…` except the four sub-pages that are screens),
 * the product workspace (`/merchant/dashboard/products…` modes), the home,
 * the roadmap, then the table in `client/src/dashboard/merchant-screens.tsx`.
 * Anything else falls to the «coming soon» placeholder — which is correct for a
 * `{ phase: … }` entry and a silent dead end for an «implemented» one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
const navigation = read("client/src/config/navigation.ts");
const screens = read("client/src/dashboard/merchant-screens.tsx");
const dashboard = read("client/src/pages/MerchantDashboard.tsx");

const merchantNav = navigation.slice(
  navigation.indexOf("export const merchantNavGroups"),
  navigation.indexOf("];", navigation.indexOf("export const merchantNavGroups"))
);
const implemented = [...merchantNav.matchAll(/path:\s*"([^"]+)",\s*status:\s*"implemented"/g)].map(
  (m) => m[1]
);
const screenPaths = new Set(
  [...screens.matchAll(/^\s+"(\/merchant\/dashboard[^"]*)": /gm)].map((m) => m[1])
);
const productModes = new Set(
  [...dashboard.matchAll(/resolvedLocation === "(\/merchant\/dashboard\/products[^"]*)"/g)].map(
    (m) => m[1]
  )
);
const orderScreens = new Set(
  ["delivery", "settlements", "reports", "returns"].map((s) => `/merchant/dashboard/orders/${s}`)
);

const unresolved = implemented.filter((path) => {
  if (screenPaths.has(path) || productModes.has(path)) return false;
  if (path === "/merchant/dashboard") return false; // home
  if (path.startsWith("/merchant/dashboard/orders") && !orderScreens.has(path)) return false; // order workspace
  if (path === "/merchant/dashboard/products") return false; // product list mode
  return true;
});
assert.deepEqual(
  unresolved,
  [],
  `implemented menu entries with no screen — add them to client/src/dashboard/merchant-screens.tsx:\n  ${unresolved.join("\n  ")}`
);
assert.ok(
  implemented.length > 20 && screenPaths.size > 20,
  "the detector found the menu and the screen table"
);
console.log(
  JSON.stringify({
    suite: "merchant-screens",
    status: "passed",
    summary: { implementedEntries: implemented.length, screenTable: screenPaths.size },
  })
);

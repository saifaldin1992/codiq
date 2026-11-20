/**
 * ق-199 — no merchant field without a shopper's view of it, and no view without
 * a merchant field. The «واجهة المتجر» rule, held by a machine.
 *
 * ============================================================================
 * WHAT IT CATCHES
 * ============================================================================
 *
 * The storefront rebuild put every merchant-editable fact about a shop behind
 * ONE schema (`updateStorefrontSettingsSchema`), ONE public payload
 * (`publicStorefrontConfig`) and TWO screens (the merchant's panel and the
 * shopper's shell/pages). Four hand-written lists that must agree — exactly
 * the shape that produced ق-163 (a field the API accepts and no screen sends),
 * ق-167 (a column every writer fills and no screen reads) and ق-172 (a route
 * nobody calls). This guard holds them equal:
 *
 *   1. every key of the merchant's schema is named in `STOREFRONT_FIELDS`;
 *   2. every merchant key is spelled in the merchant's panel — a field the
 *      server accepts and the screen never sends is a promise, not a feature;
 *   3. every public key the map points at is emitted by `publicStorefrontConfig`
 *      AND read by a storefront component — a value that leaves the server and
 *      reaches no pixel is ق-167 pointed at the shopper.
 *
 * Proven by adding a field to the schema and watching (1) fail, then a field to
 * the map with no public emission and watching (3) fail.
 *
 * Run: pnpm storefront:guard
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const read = (file) => readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");

const schema = read("phase1-backend/src/http/schemas/storefront-config.schema.ts");
const service = read("phase1-backend/src/services/storefront-config.service.ts");
const panel = read("client/src/components/StorefrontSettingsPanel.tsx");
const storefront = [
  "client/src/components/StorefrontShell.tsx",
  "client/src/components/StorefrontFooter.tsx",
  "client/src/pages/StorefrontHomePage.tsx",
  "client/src/pages/StorefrontCheckoutPage.tsx",
  "client/src/pages/StorefrontCartPage.tsx",
  "client/src/pages/StorefrontPolicyPage.tsx",
].map(read).join("\n");

// 1. the merchant's schema keys — the `z.object({ … })` of updateStorefrontSettingsSchema.
const schemaBlock = schema.slice(schema.indexOf("export const updateStorefrontSettingsSchema"), schema.indexOf(".refine(", schema.indexOf("export const updateStorefrontSettingsSchema")));
const schemaKeys = [...schemaBlock.matchAll(/^\s{4}(\w+):/gm)].map((match) => match[1]);
assert.ok(schemaKeys.length >= 15, `expected the merchant schema's keys, read ${schemaKeys.length}`);

// 2. the map — merchant key → public key(s).
const mapBlock = service.slice(service.indexOf("export const STOREFRONT_FIELDS"), service.indexOf("};", service.indexOf("export const STOREFRONT_FIELDS")));
const mapped = new Map([...mapBlock.matchAll(/^\s{2}(\w+): \[([^\]]*)\]/gm)].map((match) => [match[1], [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])]));
assert.ok(mapped.size >= 15, `expected STOREFRONT_FIELDS, read ${mapped.size} entries`);

const failures = [];
for (const key of schemaKeys) {
  if (!mapped.has(key)) failures.push(`«${key}» is in the merchant's schema and not in STOREFRONT_FIELDS — say which public key it becomes.`);
  if (!panel.includes(key)) failures.push(`«${key}» is a field the server accepts and StorefrontSettingsPanel.tsx never sends — a promise, not a feature.`);
}
for (const [key, publicKeys] of mapped) {
  if (!schemaKeys.includes(key)) failures.push(`«${key}» is in STOREFRONT_FIELDS and not in the merchant's schema — the map describes a field that does not exist.`);
  for (const publicKey of publicKeys) {
    // The public payload names it as a key — `name:`, `announcement`, `contact`, `guestCheckout:`, `homeSections:`.
    const emitted = new RegExp(`\\b${publicKey}\\b`).test(service.slice(service.indexOf("export async function publicStorefrontConfig")));
    if (!emitted) failures.push(`«${key}» maps to «${publicKey}», which publicStorefrontConfig never emits.`);
    // …and a storefront component reads it as `config.<key>` / `config?.<key>` / destructured.
    const drawn = new RegExp(`config\\??\\.${publicKey}\\b|\\b${publicKey}\\b[^\\n]{0,60}config`).test(storefront);
    if (!drawn) failures.push(`«${key}» maps to «${publicKey}», which no storefront component reads — a value that reaches no pixel.`);
  }
}

assert.deepEqual(failures, [], `«واجهة المتجر» has drifted:\n  · ${failures.join("\n  · ")}`);

console.log(JSON.stringify({
  suite: "storefront-config",
  status: "passed",
  summary: { merchantFields: schemaKeys.length, publicKeys: [...new Set([...mapped.values()].flat())].length, guarantee: "every merchant field has a screen that sends it, a public key that carries it, and a storefront component that draws it" },
}, null, 2));

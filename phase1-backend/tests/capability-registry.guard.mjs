/**
 * ق-249 (المرحلة 29) — every route that belongs to a registered service declares
 * the capability it needs, and the declaration is real.
 *
 * ============================================================================
 * WHY A REGISTRY
 * ============================================================================
 *
 * Availability is enforced by ONE call — `assertCapabilityAvailable("x.y", store)`
 * — placed right after the permission guard of each route. A route that forgets
 * the call is not broken in any visible way: it answers 200 while the owner's
 * screen says the capability is disabled. Nothing else notices. So the routes
 * that must carry the call are LISTED, and the list is checked against the
 * source on every push — the same shape as surface.guard and keyset-index.
 *
 * ============================================================================
 * WHAT IS ASSERTED
 * ============================================================================
 *
 *   1. Every registered route exists in `routes/*.ts` and its handler carries
 *      `assertCapabilityAvailable("<its capability>"`. A route registered with
 *      one code and guarding another is exactly the silent drift this exists for.
 *   2. Every capability code named by the registry is seeded by the catalogue
 *      migration — a route guarding a code the resolver cannot find would fail
 *      every request with 500, and the registry must not be able to say it.
 *   3. THE RATCHET: every route whose path sits inside a service's domain
 *      (the prefixes below) is either registered or named, with a reason, in
 *      `capability-routes.legacy.json`. A domain route in neither list fails;
 *      a legacy route that gained its guard must be deleted from the legacy
 *      list — the list only shrinks.
 *
 * Run: pnpm capability:guard
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ROUTES = path.join(ROOT, "phase1-backend", "src", "http", "routes");
const REGISTRY = JSON.parse(readFileSync(path.join(HERE, "capability-routes.map.json"), "utf8"));
const LEGACY_FILE = path.join(HERE, "capability-routes.legacy.json");
const MIGRATION = path.join(ROOT, "prisma", "migrations", "20260915120000_q249_services_and_availability", "migration.sql");

/** A route is «in a service's domain» when its path matches one of these — the eight services of ق-249. */
const DOMAINS = [
  { service: "pos", test: (p) => /\/pos\//.test(p) },
  { service: "delivery", test: (p) => /\/orders\/(manifest\.csv|couriers|cod-)/.test(p) || /\/orders\/:orderId\/delivery$/.test(p) || /\/delivery-rates/.test(p) },
  { service: "offers", test: (p) => /\/marketing\/coupons/.test(p) || /\/loyalty/.test(p) },
  { service: "customer_experience", test: (p) => /\/reviews/.test(p) || /\/wishlist/.test(p) || /\/returns/.test(p) || /\/track/.test(p) || /\/reorder/.test(p) },
  { service: "marketing", test: (p) => /\/marketing\/(integrations|pixels|abandoned)/.test(p) || /\/share-card/.test(p) },
  { service: "data", test: (p) => /\/(export|import)/.test(p) || /\/marketing\/analytics/.test(p) || /\/monthly-report/.test(p) },
  { service: "team", test: (p) => /^\/merchant\/stores\/:storeSlug\/team(\/|$)/.test(p) },
];

// ── the routes as the server registers them, with their handler text ──────
const routes = [];
for (const file of readdirSync(ROUTES).filter((f) => f.endsWith(".ts")).sort()) {
  const source = readFileSync(path.join(ROUTES, file), "utf8");
  const re = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  const starts = [];
  let m;
  while ((m = re.exec(source))) starts.push({ method: m[1].toUpperCase(), path: m[2], index: m.index });
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    routes.push({ file, key: `${s.method} ${s.path}`, handler: source.slice(s.index, end) });
  });
}
const byKey = new Map(routes.map((r) => [r.key, r]));

// ── 1. every registered route guards the capability it declares ───────────
const failures = [];
for (const row of REGISTRY.routes) {
  const route = byKey.get(row.route);
  if (!route) { failures.push(`${row.route} is in capability-routes.map.json but no routes/*.ts registers it — delete the row or fix the path.`); continue; }
  if (!route.handler.includes(`assertCapabilityAvailable("${row.capability}"`)) {
    failures.push(`${row.route} (${route.file}) is registered for «${row.capability}» but its handler does not call assertCapabilityAvailable("${row.capability}", …). The owner's switch would not reach it.`);
  }
}

// ── 2. every declared capability is seeded ─────────────────────────────────
const migration = readFileSync(MIGRATION, "utf8");
const seeded = new Set([...migration.matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g)].map((m) => m[1]));
for (const row of REGISTRY.routes) {
  if (!seeded.has(row.capability)) failures.push(`${row.route} declares «${row.capability}», which the catalogue migration never seeds — the resolver would answer 500 CAPABILITY_UNKNOWN.`);
}

// ── 3. the ratchet over domain routes ──────────────────────────────────────
const registered = new Set(REGISTRY.routes.map((r) => r.route));
const domainRoutes = routes.filter((r) => DOMAINS.some((d) => d.test(r.path ?? r.key.split(" ")[1])));
let legacy;
try { legacy = JSON.parse(readFileSync(LEGACY_FILE, "utf8")); }
catch {
  const missing = domainRoutes.filter((r) => !registered.has(r.key)).map((r) => r.key);
  console.error(`capability-routes.legacy.json is missing. Domain routes without a guard today (${missing.length}):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
for (const route of domainRoutes) {
  if (registered.has(route.key)) {
    if (route.key in legacy.unregistered) failures.push(`${route.key} now carries its guard — delete it from capability-routes.legacy.json (the list only shrinks).`);
    continue;
  }
  if (!(route.key in legacy.unregistered)) failures.push(`${route.key} (${route.file}) sits in a service's domain and declares no capability. Add assertCapabilityAvailable(…) after its guard and a row in capability-routes.map.json — or name it in capability-routes.legacy.json with the reason it may stay unguarded.`);
}
for (const key of Object.keys(legacy.unregistered)) {
  if (!byKey.has(key)) failures.push(`capability-routes.legacy.json names ${key}, which no routes/*.ts registers — delete the stale row.`);
}

// ── 4. ق-251: the merchant's menu names capabilities for its availability badges — each must be seeded ──
const navigation = readFileSync(path.join(ROOT, "client", "src", "config", "navigation.ts"), "utf8");
const navCodes = [...navigation.matchAll(/capability: "([a-z0-9_]+\.[a-z0-9_]+)"/g)].map((m) => m[1]);
for (const code of navCodes) {
  if (!seeded.has(code)) failures.push(`client/src/config/navigation.ts names «${code}» as a menu entry's capability, which the catalogue migration never seeds — the badge would never light.`);
}

if (failures.length) {
  console.error(`capability:guard failed:\n\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`);
  process.exit(1);
}
console.log(`capability:guard ok — ${REGISTRY.routes.length} guarded route(s) over ${seeded.size} seeded capabilities; ${Object.keys(legacy.unregistered).length} domain route(s) still unguarded (this number may only fall); ${navCodes.length} menu badge code(s) all seeded.`);

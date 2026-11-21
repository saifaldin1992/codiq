/**
 * ق-172 — every route the server registers has a caller somewhere a person
 * can reach. The general form of ق-124/PS-2, ق-164 and ق-170, which were its
 * first three rows.
 *
 * ============================================================================
 * THE CLASS OF DEFECT, AND WHY NOTHING ELSE CATCHES IT
 * ============================================================================
 *
 * A route with no caller compiles, tests green, deploys, and answers 200 to a
 * request no human being can make. The server tests exercise it directly, so
 * they prove the server right — and the server is not the broken part. This is
 * how the owner's second factor lived a month without a screen, how the
 * loyalty programme shipped «مكتملة بالكامل» with no switch, how three
 * platform permissions were grantable and opened nothing. The audit of
 * 2026-09-06 found sixteen of these in one afternoon and named the fix: read
 * the routing table, read the client, compare, and fail on the seventeenth.
 *
 * It is possible precisely because the client builds its URLs from LITERALS.
 * A path whose literal is nowhere under `client/src` cannot be requested at
 * runtime, whatever else is true.
 *
 * ============================================================================
 * HOW THE TWO SIDES ARE COMPARED
 * ============================================================================
 *
 * Both are reduced to a CANONICAL form in which every dynamic segment is `*`:
 *
 *   server   app.get("/merchant/stores/:storeSlug/orders/:orderId")
 *            → /api/merchant/stores/* /orders/*
 *   client   `/api/merchant/stores/${encodeURIComponent(storeSlug)}/orders/${id}`
 *            → /api/merchant/stores/* /orders/*
 *   client   path(slug, "account", "orders", orderId)        (storefront helper)
 *            → /api/store/* /account/orders/*
 *
 * A server route is REACHED when a client canonical matches it segment by
 * segment; `*` on either side matches anything, so `${base}/${action}` reaches
 * both `…/confirm` and `…/cancel`. Query strings are ignored.
 *
 * THREE THINGS THE MATCHER RESOLVES, and one it refuses to:
 *
 *   1. Names bound to an /api literal in the same file, MULTI-VALUED —
 *      ProductCatalogManager binds `base` three times to three prefixes.
 *   2. Names passed down as JSX PROPS: `<VariantManager base={base}>` hands
 *      the child every literal the parent bound to `base`. Followed to a
 *      fixed point, so a grandchild sees it too.
 *   3. Templates that still begin with an unresolved `${…}` are tried against
 *      the /api literals of THEIR OWN FILE only.
 *
 *   It does NOT try an unresolved tail against prefixes from OTHER files. That
 *   was tried, and it "reached" `DELETE /store/:slug/reviews/:id` — a route the
 *   audit had just proven has no caller — by gluing a storefront prefix onto a
 *   moderation tail. A guard that invents callers is worse than none.
 *
 * Deliberately dumb otherwise, like PS-2: it proves a caller EXISTS, not that
 * the screen works or that the right METHOD is used. Path-only matching is the
 * known weakness — a GET with a screen makes a sibling PUT on the same path
 * look reached. The schema-fields guard (ق-168) covers part of that from the
 * other direction.
 *
 * ============================================================================
 * WHY A RATCHET
 * ============================================================================
 *
 * The current misses are FROZEN in `surface.legacy.json`, each with a note,
 * and the rule is:
 *
 *   · a route not in the legacy list and not reached FAILS — the seventeenth
 *     gap does not get born;
 *   · a legacy route that becomes reached FAILS too, asking to be removed —
 *     the list may only shrink, and it is the audit's to-do list made live;
 *   · a route in EXEMPT is skipped, with its reason beside it.
 *
 * `pnpm surface:guard --write` reseeds the legacy list. Use it once, when this
 * lands, and never to make red green. `--orphans` lists the templates the
 * matcher could not resolve, so its blindness is visible rather than assumed.
 *
 * Run: pnpm surface:guard
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeFileLabel, routeSourceFiles } from "../source-layout.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const ROUTES_DIR = path.join(repoRoot, "phase1-backend/src/http/routes");
const CLIENT_SRC = path.join(repoRoot, "client/src");
const LEGACY = path.join(repoRoot, "phase1-backend/tests/surface.legacy.json");
const API = "/api";

/**
 * Routes with no browser caller BY DESIGN. Each carries its reason; "not built
 * yet" is not one — that is what the legacy list is for.
 */
const EXEMPT = {
  "/api/health": "liveness probe for Railway and the staging healthcheck job — machines, not people",
  "/api/ready": "readiness probe — same",
  "/api/openapi.json": "the contract for integrators; deliberately not a screen",
  "/api/auth/platform/register": "owner bootstrap for `pnpm owner:create`, gated by CODIQ_ALLOW_OWNER_REGISTRATION — a console act, never a screen",
  "/api/webhooks/resend": "Resend calls it, signed with Svix headers over the raw body (ق-182); no screen could, and none should",
  "/api/public/brand/logo/*": "the URL is minted by the server inside the brand payload and reaches the browser as an <img src>; the client never spells it",
  "/api/store/*/banners/*/image": "ق-198: the slide's URL is minted by the server inside the banner payload and reaches the browser as an <img src>; the client never spells it",
  "/api/store/*/logo": "ق-199: the logo's URL is minted by the server inside public-config and reaches the browser as an <img src>; the client never spells it",
  "/api/market/stores/*/cover": "Marketplace M1: the cover's URL is minted by the server inside every store card and page (coverUrl) and reaches the browser as an <img src>; the client never spells it",
  "/api/market/banners/*/image": "Marketplace M3: the banner's URL is minted by the server inside GET /market/home (imageUrl) and reaches the browser as an <img src>; the client never spells it",
  "/api/platform/dashboard": "identity probe answering `{ area }` — the API-v1 contract test proves a session minted at /api/v1 is accepted at /api with it, and the demo suite lists it; for API clients, never a screen",
  "/api/merchant/stores/*/dashboard": "identity probe answering `{ area }` — the API-v1 contract test proves a session minted at /api/v1 is accepted at /api with it, and the demo suite lists it; for API clients, never a screen",
  "/api/staff/stores/*/dashboard": "identity probe answering `{ area }` — the API-v1 contract test proves a session minted at /api/v1 is accepted at /api with it, and the demo suite lists it; for API clients, never a screen",
  "/api/stores/*/account": "identity probe answering `{ area }` — the API-v1 contract test proves a session minted at /api/v1 is accepted at /api with it, and the demo suite lists it; for API clients, never a screen",
};

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(tsx?|jsx?)$/.test(entry)) found.push(full);
  }
  return found;
}

/** `/a/:b/c` → ["api","a","*","c"] */
function canonicalServer(route) {
  return `${API}${route}`.split("?")[0].split("/").filter(Boolean).map((seg) => (seg.startsWith(":") ? "*" : seg));
}

/** A client URL with `${…}` already replaced by `*` → segments; null if it is not an /api path. */
function canonicalClient(url) {
  const at = url.indexOf(`${API}/`);
  if (at === -1) return null;
  return url.slice(at).split("?")[0].split("/").filter(Boolean).map((seg) => (seg.includes("*") ? "*" : seg));
}

function matches(server, client) {
  if (server.length !== client.length) return false;
  return server.every((seg, i) => seg === "*" || client[i] === "*" || seg === client[i]);
}

const star = (text) => text.replace(/\$\{[^}]*\}/g, "*");

// ── server side ──────────────────────────────────────────────────────────────
const routes = [];
for (const file of routeSourceFiles()) {
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
    routes.push({ method: m[1].toUpperCase(), route: m[2], file: path.relative(repoRoot, file).replace(/\\/g, "/"), canon: canonicalServer(m[2]) });
  }
}

// ── client side, pass 1: read every file, bind names to /api literals ────────
const files = sourceFiles(CLIENT_SRC).map((file) => ({ file, source: readFileSync(file, "utf8"), bindings: new Map() }));
const byComponent = new Map(); // "VariantManager" → file record
for (const f of files) {
  // Any name bound to a path-shaped literal — not only ones that start with
  // /api. VariantManager binds `variantsUrl = \`${base}/products/${id}/variants\``
  // and then writes `${variantsUrl}/${variant.id}`: the chain resolves only if
  // the intermediate name is bound too. `${…}` inside a binding is left for
  // `expand` to resolve in turn, so a chain of any length collapses.
  for (const m of f.source.matchAll(/\b(?:const|let)\s+(\w+)\s*=[^;\n]*?(`[^`]*\/[^`]*`|"\/api\/[^"]*")/g)) {
    if (!f.bindings.has(m[1])) f.bindings.set(m[1], new Set());
    f.bindings.get(m[1]).add(m[2].slice(1, -1));
  }
  for (const m of f.source.matchAll(/export\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w*)/g)) byComponent.set(m[1], f);
}

// ── pass 2: props carry bindings from parent to child, to a fixed point ──────
for (let round = 0; round < 4; round += 1) {
  let changed = false;
  for (const f of files) {
    for (const m of f.source.matchAll(/<([A-Z]\w*)\b([^>]*?)\/?>/gs)) {
      const child = byComponent.get(m[1]);
      if (!child || child === f) continue;
      for (const attr of m[2].matchAll(/\b(\w+)=\{(\w+)\}/g)) {
        const values = f.bindings.get(attr[2]);
        if (!values) continue;
        if (!child.bindings.has(attr[1])) child.bindings.set(attr[1], new Set());
        const target = child.bindings.get(attr[1]);
        for (const v of values) if (!target.has(v)) { target.add(v); changed = true; }
      }
    }
  }
  if (!changed) break;
}

// ── pass 3: read every URL the client can spell ──────────────────────────────
const clientCanon = [];
const orphans = [];
for (const f of files) {
  const expand = (template, depth = 0) => {
    const m = template.match(/\$\{(\w+)\}/);
    if (!m || !f.bindings.has(m[1]) || depth > 6) return [template];
    const out = [];
    for (const value of f.bindings.get(m[1])) {
      // a value that names itself would recurse forever; leave it as `*`
      if (value.includes(m[0])) { out.push(template.replace(m[0], "*")); continue; }
      out.push(...expand(template.replace(m[0], value), depth + 1));
    }
    return out;
  };
  const prefixes = new Set([...f.bindings.values()].flatMap((set) => [...set]));
  for (const m of f.source.matchAll(/[`"'](\/api\/[^`"']*)[`"']/g)) prefixes.add(star(m[1]).split("?")[0]);

  for (const m of f.source.matchAll(/`([^`]*)`/g)) {
    for (const expanded of expand(m[1])) {
      const flat = star(expanded);
      if (flat.includes(`${API}/`)) { const c = canonicalClient(flat); if (c) clientCanon.push(c); continue; }
      if (/^\*\//.test(flat)) {
        const tail = flat.slice(1);
        let hit = false;
        for (const prefix of prefixes) { const c = canonicalClient(prefix + tail); if (c) { clientCanon.push(c); hit = true; } }
        if (!hit) orphans.push({ file: path.relative(repoRoot, f.file).replace(/\\/g, "/"), template: m[1].slice(0, 90) });
      }
    }
  }
  for (const m of f.source.matchAll(/["'](\/api\/[^"']*)["']/g)) { const c = canonicalClient(m[1]); if (c) clientCanon.push(c); }
  // the storefront helper: path(slug, "account", "orders", orderId) → /api/store/*/account/orders/*
  for (const m of f.source.matchAll(/\bpath\(([^)]*)\)/g)) {
    const args = m[1].split(",").map((a) => a.trim()).filter(Boolean);
    if (args.length < 2) continue;
    const segs = args.map((a) => (/^["'`]/.test(a) ? a.slice(1, -1) : "*"));
    clientCanon.push(["api", "store", ...segs].map((s) => (s.includes("*") ? "*" : s)));
  }
}

if (process.argv.includes("--orphans")) {
  console.log(`${orphans.length} template(s) the matcher could not resolve:`);
  for (const o of orphans) console.log(`  ${o.file}: \`${o.template}\``);
  process.exit(0);
}

// ── compare ──────────────────────────────────────────────────────────────────
const key = (r) => `${r.method} /${r.canon.join("/")}`;
const reached = new Map();
for (const r of routes) reached.set(key(r), clientCanon.some((c) => matches(r.canon, c)));

const exemptKeys = new Set(Object.keys(EXEMPT).map((p) => `/${canonicalServer(p.slice(API.length)).join("/")}`));
const isExempt = (r) => exemptKeys.has(`/${r.canon.join("/")}`);
const misses = routes.filter((r) => !reached.get(key(r)) && !isExempt(r));

if (process.argv.includes("--write")) {
  const previous = existsSync(LEGACY) ? JSON.parse(readFileSync(LEGACY, "utf8")) : {};
  const seed = {};
  for (const r of misses) seed[key(r)] = previous[key(r)] ?? `registered in ${r.file} — no caller under client/src; build the screen, or say here why not`;
  writeFileSync(LEGACY, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  console.log(`surface.legacy.json rewritten — ${misses.length} unreached of ${routes.length} routes (${orphans.length} unresolved templates; see --orphans)`);
  process.exit(0);
}

const legacy = existsSync(LEGACY) ? JSON.parse(readFileSync(LEGACY, "utf8")) : {};
const born = misses.filter((r) => !(key(r) in legacy));
const stale = Object.keys(legacy).filter((k) => routes.some((r) => key(r) === k && reached.get(k)));
const vanished = Object.keys(legacy).filter((k) => !routes.some((r) => key(r) === k));

const problems = [];
if (born.length) {
  problems.push(
    `${born.length} route(s) with NO caller anywhere under client/src, and not in the legacy list:\n` +
      born.map((r) => `  ${key(r)}  — ${r.file}`).join("\n") +
      `\n  A route nobody can reach answers 200 to nobody. Draw the screen, or — if it is for machines — add it to EXEMPT with the reason.`,
  );
}
if (stale.length) {
  problems.push(
    `${stale.length} legacy route(s) are now REACHED — remove them from surface.legacy.json so the list keeps shrinking:\n` +
      stale.map((k) => `  ${k}`).join("\n"),
  );
}
if (vanished.length) {
  problems.push(`${vanished.length} legacy route(s) no longer exist — remove them from surface.legacy.json:\n` + vanished.map((k) => `  ${k}`).join("\n"));
}

if (problems.length) {
  console.error(`ق-172: the server and the screens disagree.\n\n${problems.join("\n\n")}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    suite: "surface",
    status: "passed",
    summary: {
      routes: routes.length,
      reached: routes.filter((r) => reached.get(key(r))).length,
      legacy: Object.keys(legacy).length,
      exempt: Object.keys(EXEMPT).length,
      unresolvedTemplates: orphans.length,
      guarantee: "no new route without a screen; the legacy list only shrinks",
    },
  }, null, 2));
}

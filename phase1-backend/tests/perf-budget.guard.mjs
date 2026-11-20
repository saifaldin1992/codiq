/**
 * Guard — landing performance budget (ق-137).
 *
 * The owner's rule, verbatim: «اريد الصفحة التعريفية تفتح بسرعة لا تتأخر
 * بالتحميل». What a visitor of «/» downloads before first paint is exactly
 * the entry assets referenced by dist/public/index.html — so this guard
 * measures those, gzipped, against a budget that may only FALL (the same
 * ratchet discipline as theme-tokens: raising a number is an explicit,
 * reviewed edit of perf-budget.json, never a drive-by).
 *
 * History this guard exists to prevent: before the route split (this PR),
 * «/» shipped the ENTIRE application — merchant/owner/staff dashboards, the
 * till, the storefront — 289 KB gzip of JS for a marketing page. The split
 * brought the entry to ~135 KB. One careless top-level import in App.tsx or
 * Home.tsx would silently undo it; this guard makes that a CI failure.
 *
 * Also enforced: the landing ships ZERO raster imagery (vector-only rule from
 * the redesign blueprint) — index.html and every referenced stylesheet must
 * not reference .png/.jpg/.jpeg/.webp/.gif/.avif assets.
 *
 * Run AFTER `pnpm build`. Reads dist/public only; no network, no server.
 */
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const publicDir = join(root, "dist", "public");
const indexHtmlPath = join(publicDir, "index.html");
const budgetPath = join(here, "perf-budget.json");

const fail = (message) => {
  console.error(`perf:guard FAILED — ${message}`);
  process.exit(1);
};

if (!existsSync(indexHtmlPath)) {
  fail(`dist/public/index.html not found — run \`pnpm build\` before this guard (looked at ${indexHtmlPath})`);
}

const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
const html = readFileSync(indexHtmlPath, "utf8");

// Entry assets = everything index.html references from assets/. Lazy chunks
// never appear here; that is the point of the split.
const refs = [...html.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((m) => m[0]);
const uniqueRefs = [...new Set(refs)];
const js = uniqueRefs.filter((r) => r.endsWith(".js"));
const css = uniqueRefs.filter((r) => r.endsWith(".css"));

if (js.length === 0) fail("index.html references no JS entry — the build layout changed; update this guard deliberately.");

const gzipSize = (rel) => {
  const p = join(publicDir, rel);
  if (!existsSync(p)) fail(`index.html references ${rel} but the file does not exist in dist/public`);
  return gzipSync(readFileSync(p)).length;
};

const jsTotal = js.reduce((sum, r) => sum + gzipSize(r), 0);
const cssTotal = css.reduce((sum, r) => sum + gzipSize(r), 0);

// Development-runtime tripwire. Discovered 2026-09-01: Railway's build env
// carried a non-production NODE_ENV, Vite honoured it over the build command,
// and PRODUCTION served react.development + jsxDEV in every chunk — ~18%
// fatter gzip and a measurably slower React for every real user, invisible to
// every other gate (no console output, no test failure, SUCCESS deploys).
// vite.config.ts now forces NODE_ENV=production for builds; this check makes
// sure no future cause — a new env var, a vite upgrade, a config edit — can
// ship a dev-condition bundle again, from any machine or CI.
const DEV_MARKERS = ["jsxDEV", "react.development", "react-dom.development"];
for (const rel of js) {
  const body = readFileSync(join(publicDir, rel), "utf8");
  const found = DEV_MARKERS.filter((marker) => body.includes(marker));
  if (found.length > 0) {
    fail(`${rel} contains React DEVELOPMENT-runtime markers (${found.join(", ")}) — the bundle was built in a dev condition. Check that nothing sets NODE_ENV before \`vite build\` and that vite.config.ts still forces production for the build command.`);
  }
}

// Vector-only rule: no raster imagery reachable from the landing's entry.
const RASTER = /assets\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif|avif)/i;
if (RASTER.test(html)) fail("index.html references a raster image — the landing is vector-only (redesign blueprint).");
for (const sheet of css) {
  const body = readFileSync(join(publicDir, sheet), "utf8");
  if (RASTER.test(body)) fail(`${sheet} references a raster image — the landing is vector-only (redesign blueprint).`);
}

const report = [
  `entry JS  gzip: ${jsTotal.toLocaleString()} B (budget ${budget.entryJsGzipMax.toLocaleString()} B) — ${js.join(", ")}`,
  `entry CSS gzip: ${cssTotal.toLocaleString()} B (budget ${budget.entryCssGzipMax.toLocaleString()} B) — ${css.join(", ")}`,
].join("\n");

if (jsTotal > budget.entryJsGzipMax) {
  fail(`entry JS exceeds the landing budget.\n${report}\nA top-level import in App.tsx/Home.tsx probably pulled a dashboard or a heavy dep into the entry chunk. Split it with lazy(); raising perf-budget.json is a deliberate reviewed edit, not a fix.`);
}
if (cssTotal > budget.entryCssGzipMax) {
  fail(`entry CSS exceeds the landing budget.\n${report}`);
}

console.log(`perf:guard OK\n${report}`);

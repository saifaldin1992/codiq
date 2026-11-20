/**
 * Build step — precache manifest injection for the till service worker
 * (POS-offline v1).
 *
 * Runs as the LAST step of `pnpm build` (package.json), so the embedded list
 * can never describe a previous build: a stale list would 404 inside the SW's
 * atomic addAll and the SW would simply never install — fail-safe, but dead
 * offline. phase1-backend/tests/sw-precache.guard.mjs independently re-derives
 * the same closure and fails CI on drift.
 *
 * Collected: the entry chunk + the TillPage chunk, each with its STATIC import
 * closure and CSS, plus /index.html as the navigation shell. Dynamic imports
 * are deliberately absent — the other lazy pages are not the till's to precache,
 * and their absence is what keeps skipWaiting+clientsClaim safe.
 *
 * Reads dist/public only; no network, no server.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const publicDir = join(root, "dist", "public");
const manifestPath = join(publicDir, ".vite", "manifest.json");
const swPath = join(publicDir, "sw.js");

const fail = (message) => {
  console.error(`generate-sw-manifest FAILED — ${message}`);
  process.exit(1);
};

if (!existsSync(manifestPath)) {
  fail(`dist/public/.vite/manifest.json not found — \`build.manifest: true\` must stay set in vite.config.ts (looked at ${manifestPath})`);
}
if (!existsSync(swPath)) {
  fail("dist/public/sw.js not found — client/public/sw.js should be copied verbatim by the Vite build");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) fail("no isEntry chunk in the Vite manifest — the build layout changed; update this script deliberately.");
const tillKey = Object.keys(manifest).find((key) => key.replace(/\\/g, "/").endsWith("pages/TillPage.tsx"));
if (!tillKey) fail("no TillPage.tsx chunk in the Vite manifest — the till moved or lost its lazy split; update this script deliberately.");

// Static import closure only: `imports`, never `dynamicImports`.
const collectClosure = (startKeys) => {
  const keys = [];
  const queue = startKeys.slice();
  while (queue.length > 0) {
    const key = queue.shift();
    if (keys.indexOf(key) !== -1) continue;
    keys.push(key);
    const chunk = manifest[key];
    if (!chunk) fail(`manifest entry «${key}» is imported but missing from the manifest`);
    for (const imported of chunk.imports ?? []) queue.push(imported);
  }
  return keys;
};

// The skipWaiting+clientsClaim tripwire, enforced where the manifest is born:
// a dynamic import INSIDE the till closure means an activated new SW (old
// caches swept) can be asked for a chunk it never precached — the exact break
// the blueprint's safety argument rules out. The entry chunk is exempt: its
// dynamicImports are the other lazy routes, a pre-existing SPA hazard the SW
// neither causes nor cures.
for (const key of collectClosure([tillKey])) {
  if (key === entryKey) continue; // shared code pulls the entry into the closure; its dynamicImports ARE the lazy routes
  const dynamic = manifest[key].dynamicImports ?? [];
  if (dynamic.length > 0) {
    fail(`«${key}» inside the till closure declares dynamic imports (${dynamic.join(", ")}) — precache them or make them static before shipping; skipWaiting is unsafe otherwise`);
  }
}

const urls = ["/index.html"];
for (const key of collectClosure([entryKey, tillKey])) {
  const chunk = manifest[key];
  if (chunk.file) urls.push(`/${chunk.file}`);
  for (const sheet of chunk.css ?? []) urls.push(`/${sheet}`);
}
const unique = urls.filter((url, index) => urls.indexOf(url) === index).sort();

for (const url of unique) {
  if (url === "/index.html") continue;
  if (!existsSync(join(publicDir, url.slice(1)))) fail(`precache URL ${url} does not exist in dist/public — manifest and output disagree`);
}

const buildHash = createHash("sha256").update(unique.join("\n")).digest("hex").slice(0, 16);

const sw = readFileSync(swPath, "utf8");
if (sw.indexOf("self.__PRECACHE__ = []") === -1) {
  fail("placeholder `self.__PRECACHE__ = []` not found in dist/public/sw.js — already rewritten (run a full `pnpm build`), or client/public/sw.js drifted");
}
if (sw.indexOf("__BUILD_HASH__") === -1) {
  fail("placeholder `__BUILD_HASH__` not found in dist/public/sw.js — client/public/sw.js drifted");
}

const rewritten = sw
  .replace("__BUILD_HASH__", buildHash)
  .replace("self.__PRECACHE__ = []", `self.__PRECACHE__ = ${JSON.stringify(unique)}`);
writeFileSync(swPath, rewritten);

// The Vite manifest maps every source path to its chunk — useful to us, not
// to visitors. dist/public is served verbatim by express.static, so the file
// moves OUT of the web root; sw-precache.guard.mjs reads it at dist/.vite.
const privateViteDir = join(root, "dist", ".vite");
rmSync(privateViteDir, { recursive: true, force: true });
renameSync(join(publicDir, ".vite"), privateViteDir);

console.log(`sw manifest OK — ${unique.length} precache URLs, build ${buildHash}:\n  ${unique.join("\n  ")}`);

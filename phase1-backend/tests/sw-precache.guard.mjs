/**
 * Guard — till service-worker precache (sw:guard, POS-offline v1).
 *
 * Independently re-derives the till route's boot closure from
 * dist/public/.vite/manifest.json and asserts dist/public/sw.js embeds EXACTLY
 * that URL list plus /index.html — the same ratchet discipline as theme-tokens
 * and perf-budget: silent drift becomes a CI failure.
 *
 * Why it matters: sw.js activates with skipWaiting+clientsClaim and deletes
 * every other codiq-till-* cache. That lifecycle is safe ONLY while TillPage
 * has no post-boot dynamic imports — a new icon chunk or a lazy() inside the
 * till that never reaches the precache list bricks the first offline boot
 * after a deploy. The closure is re-derived from the CURRENT manifest, never
 * hardcoded, because chunk hashes change every build.
 *
 * Run AFTER `pnpm build`. Reads dist/public only; no network, no server.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const publicDir = join(root, "dist", "public");
// The manifest lives OUTSIDE the web root: generate-sw-manifest.mjs moves it
// to dist/.vite after use, because dist/public is served verbatim and the
// manifest maps the whole source tree for anyone who asks.
const manifestPath = join(root, "dist", ".vite", "manifest.json");
const swPath = join(publicDir, "sw.js");

const fail = (message) => {
  console.error(`sw:guard FAILED — ${message}`);
  process.exit(1);
};

if (!existsSync(manifestPath)) {
  fail(`ملف dist/.vite/manifest.json غير موجود — شغّل \`pnpm build\` قبل هذا الحارس (المسار: ${manifestPath})`);
}
if (!existsSync(swPath)) {
  fail("ملف dist/public/sw.js غير موجود — يجب أن ينسخه Vite من client/public/sw.js أثناء البناء.");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sw = readFileSync(swPath, "utf8");

// Placeholders must be GONE: their presence means generate-sw-manifest.mjs did
// not run as the last build step and the shipped SW would precache nothing.
if (sw.includes("__BUILD_HASH__")) {
  fail("لم يُستبدل __BUILD_HASH__ في sw.js — يجب أن يكون scripts/generate-sw-manifest.mjs آخر خطوة في `pnpm build`.");
}
const precacheMatch = sw.match(/self\.__PRECACHE__\s*=\s*(\[[\s\S]*?\]);?/);
if (!precacheMatch) {
  fail("لم يُعثر على قائمة self.__PRECACHE__ داخل sw.js — تغيّر شكل الملف؛ حدّث هذا الحارس عمداً.");
}
let embedded;
try {
  embedded = JSON.parse(precacheMatch[1]);
} catch {
  fail("قائمة self.__PRECACHE__ داخل sw.js ليست JSON صالحاً.");
}
if (!Array.isArray(embedded) || embedded.length === 0) {
  fail("قائمة self.__PRECACHE__ داخل sw.js فارغة — لم يكتبها generate-sw-manifest.mjs بعد البناء الحالي.");
}

// Independent re-derivation: entry chunk + TillPage chunk, each with its
// STATIC import closure (`imports`, never `dynamicImports`) and CSS.
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) fail("لا يوجد chunk مدخل (isEntry) في manifest — تغيّر تخطيط البناء.");
const tillKey = Object.keys(manifest).find((key) => key.replace(/\\/g, "/").endsWith("pages/TillPage.tsx"));
if (!tillKey) fail("لا يوجد chunk لصفحة TillPage.tsx في manifest — انتقلت الصفحة أو فقدت تقسيمها الكسول.");

const expected = ["/index.html"];
const seen = [];
const queue = [entryKey, tillKey];
while (queue.length > 0) {
  const key = queue.shift();
  if (seen.indexOf(key) !== -1) continue;
  seen.push(key);
  const chunk = manifest[key];
  if (!chunk) fail(`المدخل «${key}» مستورد لكنه غائب عن manifest.`);
  if (chunk.file) expected.push(`/${chunk.file}`);
  for (const sheet of chunk.css ?? []) expected.push(`/${sheet}`);
  for (const imported of chunk.imports ?? []) queue.push(imported);
}
const expectedUnique = expected.filter((url, index) => expected.indexOf(url) === index).sort();
const embeddedSorted = embedded.slice().sort();

// The skipWaiting+clientsClaim safety claim, ENFORCED and not just narrated:
// any dynamic import inside the till closure (the entry chunk is exempt — its
// dynamicImports are the other lazy routes, a pre-existing SPA hazard) means
// an activated new SW with the old caches swept can be asked for a chunk it
// never precached. That must be a red build, not a bricked till.
const tillClosure = [];
const tillQueue = [tillKey];
while (tillQueue.length > 0) {
  const key = tillQueue.shift();
  if (tillClosure.indexOf(key) !== -1) continue;
  tillClosure.push(key);
  for (const imported of manifest[key]?.imports ?? []) tillQueue.push(imported);
}
for (const key of tillClosure) {
  if (key === entryKey) continue; // shared code pulls the entry into the closure; its dynamicImports ARE the lazy routes
  const dynamic = manifest[key]?.dynamicImports ?? [];
  if (dynamic.length > 0) {
    fail(`المدخل «${key}» داخل إغلاق الكاشير يعلن استيرادات ديناميكية (${dynamic.join("، ")}) — skipWaiting لم يعد آمناً: اجعلها ثابتة أو أدخلها القائمة عمداً في generate-sw-manifest.mjs.`);
  }
}

const missing = expectedUnique.filter((url) => embeddedSorted.indexOf(url) === -1);
const extra = embeddedSorted.filter((url) => expectedUnique.indexOf(url) === -1);
if (missing.length > 0 || extra.length > 0) {
  const lines = [];
  if (missing.length > 0) lines.push(`  ناقصة من sw.js (بوابة العطل الصامت — أيقونة أو استيراد جديد لم يدخل القائمة):\n    ${missing.join("\n    ")}`);
  if (extra.length > 0) lines.push(`  زائدة في sw.js (ستفشل addAll بـ 404 ولن يُثبَّت الـ SW إطلاقاً):\n    ${extra.join("\n    ")}`);
  fail(`قائمة sw.js لا تطابق إغلاق TillPage المشتق من manifest الحالي:\n${lines.join("\n")}\nأعد \`pnpm build\` كاملاً؛ وإن استمر الفشل فقد أُضيف استيراد ديناميكي داخل الكاشير — راجع scripts/generate-sw-manifest.mjs.`);
}

// The cache name must be derived from THIS list, or an unchanged-name deploy
// would serve last build's chunks forever.
const expectedHash = createHash("sha256").update(expectedUnique.join("\n")).digest("hex").slice(0, 16);
const hashMatch = sw.match(/const BUILD_HASH = "([0-9a-f]+)"/);
if (!hashMatch) fail("لم يُعثر على BUILD_HASH داخل sw.js — تغيّر شكل الملف؛ حدّث هذا الحارس عمداً.");
if (hashMatch[1] !== expectedHash) {
  fail(`BUILD_HASH داخل sw.js (${hashMatch[1]}) لا يساوي المشتق من القائمة الحالية (${expectedHash}) — القائمة من بناء سابق؛ أعد \`pnpm build\` كاملاً.`);
}

// Every precached URL must exist in the CURRENT dist — the atomic-addAll
// fail-safe should never be what discovers a stale manifest.
for (const url of embeddedSorted) {
  if (url === "/index.html") {
    if (!existsSync(join(publicDir, "index.html"))) fail("dist/public/index.html غائب رغم وروده في القائمة.");
    continue;
  }
  if (!existsSync(join(publicDir, url.slice(1)))) {
    fail(`الملف ${url} وارد في قائمة sw.js لكنه غير موجود في dist/public — القائمة من بناء سابق.`);
  }
}

console.log(JSON.stringify({ suite: "sw-precache", status: "passed", summary: { urls: embeddedSorted.length, buildHash: expectedHash } }, null, 2));

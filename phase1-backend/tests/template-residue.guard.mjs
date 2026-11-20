/**
 * ق-217 — the scaffold does not come back.
 *
 * ============================================================================
 * WHAT HAPPENED
 * ============================================================================
 *
 * This repository was generated from a template, and phase 10's scope said in
 * writing that the production path must not go through it: «الخادم يخدم الـAPI
 * بلا ملفات القالب». What was actually done was to remove the template's
 * PACKAGES — `vite-plugin-manus-runtime`, drizzle, mysql2 — and to record the
 * storage proxy as deleted in the debt register. Two pieces survived that pass
 * for eleven months, because nothing looked at the product rather than the
 * dependency list:
 *
 *   1. `vite.config.ts` still DEFINED and registered two template plugins: a
 *      debug collector and a `/manus-storage` presign proxy for an API this
 *      platform does not use.
 *   2. `client/public/__manus__/debug-collector.js` — twenty-six kilobytes of
 *      console capture, network capture and SESSION REPLAY — was copied into
 *      `dist/public` by every build and served publicly by `express.static`.
 *
 * The collector's injection was skipped when `NODE_ENV === "production"` at
 * build time. That is precisely the condition ق-137 caught Railway's builder
 * failing: an inherited NODE_ENV that was not "production" produced a
 * development-condition bundle — and, on the same builds, a document carrying
 * the collector to every shopper.
 *
 * The lesson is the general one this repository keeps re-learning: a thing is
 * deleted when the product no longer contains it, not when the register says
 * so. This guard is the register that cannot drift.
 *
 * Run: pnpm template:guard
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const at = (relative) => fileURLToPath(new URL(relative, repoRoot));

/** Every marker of the generator, in the files it would come back through. */
const FORBIDDEN = [/__manus__/i, /manus-storage/i, /manus-debug-collector/i, /vite-plugin-manus/i, /BUILT_IN_FORGE_API/i];

/** Where the product actually lives. `node_modules` and this file are not the product. */
const SCANNED_ROOTS = ["client/src", "client/public", "client/index.html", "server", "phase1-backend/src", "vite.config.ts", "package.json"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".vite"]);
/**
 * ONE allowance, and it is a sentence of history rather than a live reference:
 * `BrandMark.tsx` explains what its inline mark REPLACED. Deleting the sentence
 * would delete the reason the component exists.
 */
const ALLOWED = new Set(["client/src/components/BrandMark.tsx"]);

function* filesUnder(relative) {
  const absolute = at(relative);
  if (!existsSync(absolute)) return;
  if (statSync(absolute).isFile()) { yield relative; return; }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* filesUnder(`${relative}/${entry.name}`);
    } else {
      yield `${relative}/${entry.name}`;
    }
  }
}

const offenders = [];
for (const root of SCANNED_ROOTS) {
  for (const file of filesUnder(root)) {
    if (ALLOWED.has(file)) continue;
    // THE PATH FIRST. The collector that shipped for eleven months lived at a
    // path named after the generator; a check that read only file CONTENT would
    // have waved through a rewritten one sitting in the same public directory —
    // and the directory is what `express.static` serves.
    const byPath = FORBIDDEN.find((pattern) => pattern.test(file));
    if (byPath) { offenders.push(`${file} — path matches ${byPath}`); continue; }
    let text;
    try { text = readFileSync(at(file), "utf8"); } catch { continue; }
    const hit = FORBIDDEN.find((pattern) => pattern.test(text));
    if (hit) offenders.push(`${file} — content matches ${hit}`);
  }
}

assert.deepEqual(
  offenders,
  [],
  `بقايا القالب المولِّد عادت إلى المنتج:\n  ${offenders.join("\n  ")}\n\n` +
    `Phase 10 promised the product would not carry the generator's files (ق-217). A debug collector that ` +
    `captures console, network and session replay must never be shipped to a shopper, and a presign proxy for ` +
    `an API this platform does not use is dead weight with a live route. Remove it, or — if it is genuinely ` +
    `needed — add its path to ALLOWED here with the reason, so the decision is written down where the check is.`,
);

// A guard that scans nothing passes for the wrong reason: the day a directory is
// renamed, this must fail rather than congratulate itself.
const scanned = SCANNED_ROOTS.flatMap((root) => Array.from(filesUnder(root)));
assert.ok(scanned.length >= 200, `expected to scan the product's own files, read ${scanned.length}`);

console.log(JSON.stringify({
  suite: "template-residue",
  status: "passed",
  summary: {
    filesScanned: scanned.length,
    forbiddenMarkers: FORBIDDEN.length,
    allowed: Array.from(ALLOWED),
    guarantee: "no generator-template file, route or capture script is in the product",
  },
}, null, 2));

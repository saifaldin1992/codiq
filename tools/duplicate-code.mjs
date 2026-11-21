/**
 * Duplicate code detector (review plan, docs/CODE_REVIEW_PLAN.md §8).
 *
 * Every window of WINDOW consecutive meaningful lines is normalised — spacing
 * removed, quotes made uniform, imports, comments and lone brackets skipped —
 * and hashed. A window that appears more than once (in the
 * same file or another) is a duplicate; overlapping windows are merged into
 * blocks, so a copied 30-line function is one finding, not 23.
 *
 * A REPORT for the review, then a ratchet (tools/duplicate-baseline.json): the
 * number of duplicated lines may only go down. Generated files and tests'
 * fixtures are out of scope; tests themselves are in.
 *
 *   node tools/duplicate-code.mjs --report    the blocks, biggest first
 *   node tools/duplicate-code.mjs             check against the baseline
 *   node tools/duplicate-code.mjs --write     record lower numbers
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const WINDOW = 8;
const ROOTS = [
  "phase1-backend/src",
  "client/src",
  "shared",
  "server",
  "phase1-backend/scripts",
  "tools",
  "phase1-backend/tests",
];
const SKIP = new Set(["phase1-backend/src/http/openapi.document.ts"]);
const BASELINE = new URL("./duplicate-baseline.json", import.meta.url);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts"))
      yield relative(process.cwd(), path);
  }
}

// Literals keep their content (a table of different strings is not a copy); only the quote
// style and the spacing are made uniform, so a re-indented or re-quoted copy is still found.
const normalise = line =>
  line
    .replace(/^\s*\/\/.*$/, "")
    .replace(/'((?:\\.|[^'\\])*)'/g, '"$1"')
    .replace(/\s+/g, "");
const meaningful = line =>
  line.length > 3 &&
  !/^(import|export\{|\}|\)|\]|\/\*|\*)/.test(line) &&
  !/^[{}()[\];,]+$/.test(line);

const windows = new Map(); // hash → [{ file, start, end }]
const files = new Map();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (SKIP.has(file)) continue;
    const raw = readFileSync(file, "utf8").split("\n");
    const kept = [];
    let inBlockComment = false;
    raw.forEach((line, index) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        return;
      }
      const norm = normalise(trimmed);
      if (meaningful(norm)) kept.push({ norm, line: index + 1 });
    });
    files.set(file, kept);
    for (let i = 0; i + WINDOW <= kept.length; i += 1) {
      const hash = createHash("sha1")
        .update(
          kept
            .slice(i, i + WINDOW)
            .map(row => row.norm)
            .join("\n")
        )
        .digest("hex");
      const list = windows.get(hash) ?? [];
      list.push({ file, at: i });
      windows.set(hash, list);
    }
  }
}

// Mark every kept line that belongs to a repeated window, per file.
const duplicated = new Map(); // file → Set(index into kept)
const blocksBySignature = new Map();
for (const [hash, list] of windows) {
  if (list.length < 2) continue;
  for (const { file, at } of list) {
    const set = duplicated.get(file) ?? new Set();
    for (let k = at; k < at + WINDOW; k += 1) set.add(k);
    duplicated.set(file, set);
  }
  blocksBySignature.set(hash, list);
}
// Merge runs into blocks for the report.
const blocks = [];
for (const [file, set] of duplicated) {
  const kept = files.get(file);
  const sorted = [...set].sort((a, b) => a - b);
  let start = sorted[0];
  for (let i = 1; i <= sorted.length; i += 1) {
    if (i === sorted.length || sorted[i] !== sorted[i - 1] + 1) {
      const end = sorted[i - 1];
      blocks.push({ file, from: kept[start].line, to: kept[end].line, lines: end - start + 1 });
      start = sorted[i];
    }
  }
}
blocks.sort((a, b) => b.lines - a.lines);
const duplicatedLines = blocks.reduce((sum, block) => sum + block.lines, 0);
const totalLines = [...files.values()].reduce((sum, kept) => sum + kept.length, 0);
const perFile = Object.fromEntries([...duplicated].map(([file, set]) => [file, set.size]).sort());
const counts = {
  duplicatedLines,
  blocks: blocks.length,
  percent: Number(((duplicatedLines * 100) / totalLines).toFixed(2)),
};

const mode = process.argv[2];
if (mode === "--report") {
  // For each of the biggest blocks, where its twins are.
  const twinsOf = block => {
    const kept = files.get(block.file);
    const firstIndex = kept.findIndex(row => row.line === block.from);
    const hash = createHash("sha1")
      .update(
        kept
          .slice(firstIndex, firstIndex + WINDOW)
          .map(row => row.norm)
          .join("\n")
      )
      .digest("hex");
    return (windows.get(hash) ?? [])
      .filter(w => w.file !== block.file || files.get(w.file)[w.at].line !== block.from)
      .map(w => `${w.file}:${files.get(w.file)[w.at].line}`);
  };
  console.log(
    JSON.stringify(
      {
        counts,
        totalLines,
        biggest: blocks
          .slice(0, 40)
          .map(block => ({ ...block, alsoAt: twinsOf(block).slice(0, 4) })),
      },
      null,
      2
    )
  );
  process.exit(0);
}
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
if (mode === "--write") {
  if (
    baseline &&
    !process.argv.includes("--first") &&
    duplicatedLines > baseline.counts.duplicatedLines
  ) {
    console.error(
      `refused: duplicated lines went up (${baseline.counts.duplicatedLines} → ` +
        `${duplicatedLines}) — remove the copy, do not raise the baseline.`
    );
    process.exit(1);
  }
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ window: WINDOW, counts, files: perFile }, null, 1)}\n`
  );
  console.log(JSON.stringify({ written: true, counts }));
  process.exit(0);
}
if (!baseline) {
  console.error("no baseline — run `node tools/duplicate-code.mjs --write --first` once");
  process.exit(2);
}
const grown = Object.entries(perFile).filter(
  ([file, lines]) => lines > (baseline.files[file] ?? 0)
);
if (grown.length) {
  console.error(
    `✗ duplicated code was added (reuse what exists, do not copy it):\n  ${grown
      .slice(0, 30)
      .map(
        ([file, lines]) => `${file}: ${lines} duplicated lines (was ${baseline.files[file] ?? 0})`
      )
      .join("\n  ")}`
  );
  process.exit(1);
}
console.log(
  JSON.stringify({ suite: "duplicate-code", status: "passed", counts, baseline: baseline.counts })
);

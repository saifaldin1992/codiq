/**
 * Code shape guard (review plan, docs/CODE_REVIEW_PLAN.md §2 rules 12–14).
 *
 *   line      ≤ 100 characters            (owner's decision, 2026-11-22)
 *   file      ≤ 400 lines in the backend, ≤ 300 in a UI component/page
 *   function  ≤ 60 lines (any function, method, arrow function or component)
 *
 * A RATCHET, like the lint ratchet: tools/shape-baseline.json holds what each
 * file has today. A file may not gain violations; a new file may have none.
 * When a batch of the review brings numbers down, `--write` records the new,
 * lower baseline — and refuses to record a higher one.
 *
 * Counts non-blank lines for file size. Generated files are skipped.
 *
 *   node tools/code-shape.mjs            check (CI)
 *   node tools/code-shape.mjs --report   the worst files, for the review
 *   node tools/code-shape.mjs --write    lower the baseline after a batch
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export const LIMITS = { line: 100, backendFile: 400, uiFile: 300, fn: 60 };
const ROOTS = [
  "phase1-backend/src",
  "client/src",
  "shared",
  "server",
  "phase1-backend/scripts",
  "tools",
];
const SKIP = new Set(["phase1-backend/src/http/openapi.document.ts"]);
const BASELINE = new URL("./shape-baseline.json", import.meta.url);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts"))
      yield relative(process.cwd(), path);
  }
}

function measure(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const longLines = lines.filter((line) => line.length > LIMITS.line).length;
  const size = lines.filter((line) => line.trim()).length;
  const isUi = path.startsWith("client/");
  const fileLimit = isUi ? LIMITS.uiFile : LIMITS.backendFile;
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : undefined
  );
  let longFunctions = 0;
  const visit = (node) => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const start = source.getLineAndCharacterOfPosition(node.body.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      if (end - start + 1 > LIMITS.fn) longFunctions += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { longLines, oversize: size > fileLimit ? size - fileLimit : 0, longFunctions, size };
}

const now = {};
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const path of files(root)) {
    if (SKIP.has(path)) continue;
    const m = measure(path);
    if (m.longLines || m.oversize || m.longFunctions)
      now[path] = { longLines: m.longLines, oversize: m.oversize, longFunctions: m.longFunctions };
  }
}
const totals = (table) =>
  Object.values(table).reduce(
    (sum, row) => ({
      longLines: sum.longLines + row.longLines,
      oversizeFiles: sum.oversizeFiles + (row.oversize ? 1 : 0),
      longFunctions: sum.longFunctions + row.longFunctions,
    }),
    { longLines: 0, oversizeFiles: 0, longFunctions: 0 }
  );

const mode = process.argv[2];
if (mode === "--report") {
  const rows = Object.entries(now).sort(
    (a, b) =>
      b[1].longLines +
      b[1].longFunctions * 10 +
      b[1].oversize -
      (a[1].longLines + a[1].longFunctions * 10 + a[1].oversize)
  );
  console.log(
    JSON.stringify(
      { totals: totals(now), worst: rows.slice(0, 25).map(([path, row]) => ({ path, ...row })) },
      null,
      2
    )
  );
  process.exit(0);
}
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
if (mode === "--write") {
  if (baseline) {
    const worse = Object.entries(now).filter(([path, row]) => {
      const old = baseline.files[path];
      return (
        !old ||
        row.longLines > old.longLines ||
        row.oversize > old.oversize ||
        row.longFunctions > old.longFunctions
      );
    });
    if (worse.length && !process.argv.includes("--first")) {
      console.error(
        `refused: ${worse.length} file(s) would raise the baseline — fix them, do not raise it:\n  ${worse
          .slice(0, 20)
          .map(([path]) => path)
          .join("\n  ")}`
      );
      process.exit(1);
    }
  }
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ limits: LIMITS, totals: totals(now), files: now }, null, 1)}\n`
  );
  console.log(JSON.stringify({ written: true, totals: totals(now) }));
  process.exit(0);
}
if (!baseline) {
  console.error("no baseline — run `node tools/code-shape.mjs --write --first` once");
  process.exit(2);
}
const problems = [];
for (const [path, row] of Object.entries(now)) {
  const old = baseline.files[path] ?? { longLines: 0, oversize: 0, longFunctions: 0 };
  if (row.longLines > old.longLines)
    problems.push(
      `${path}: ${row.longLines} lines over ${LIMITS.line} characters (was ${old.longLines})`
    );
  if (row.oversize > old.oversize)
    problems.push(`${path}: ${row.oversize} lines over the file limit (was ${old.oversize})`);
  if (row.longFunctions > old.longFunctions)
    problems.push(
      `${path}: ${row.longFunctions} functions over ${LIMITS.fn} lines (was ${old.longFunctions})`
    );
}
const t = totals(now),
  b = baseline.totals;
if (problems.length) {
  console.error(
    `✗ code shape got worse (fix it, do not raise the baseline):\n  ${problems.join("\n  ")}`
  );
  process.exit(1);
}
const lowered =
  t.longLines < b.longLines ||
  t.oversizeFiles < b.oversizeFiles ||
  t.longFunctions < b.longFunctions;
console.log(
  JSON.stringify({
    suite: "code-shape",
    status: "passed",
    totals: t,
    baseline: b,
    ...(lowered
      ? { hint: "numbers went down — record them: node tools/code-shape.mjs --write" }
      : {}),
  })
);

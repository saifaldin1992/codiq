/**
 * Unused code detector (review plan, docs/CODE_REVIEW_PLAN.md §8).
 *
 * Builds the whole import graph with TypeScript's own parser — no third-party
 * tool — and reports:
 *
 *   files        not reachable from any entry point (the servers, the client,
 *                every test, script and tool the repository runs)
 *   exports      exported names no other file imports
 *   dependencies packages in package.json that no file imports and no script names
 *
 * Entry points are read, not guessed: every file a package.json script or the
 * CI workflow runs, the client's main, the vite and eslint configs, every test.
 *
 * A REPORT for the review, and a ratchet once the review has deleted what it
 * found (tools/unused-baseline.json): the counts may only go down. A finding is
 * a CANDIDATE — the review checks each one by hand before deleting anything
 * (plan §8: textual search across the repository, then typecheck, build, CI).
 *
 *   node tools/unused-code.mjs --report        the lists
 *   node tools/unused-code.mjs                 check against the baseline
 *   node tools/unused-code.mjs --write         record lower counts
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SOURCE_ROOTS = [
  "phase1-backend/src",
  "phase1-backend/tests",
  "phase1-backend/scripts",
  "client/src",
  "shared",
  "server",
  "tools",
  "scripts",
];
const BASELINE = new URL("./unused-baseline.json", import.meta.url);
const EXT = [".ts", ".tsx", ".mjs", ".js", ".cjs"];

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (EXT.some((ext) => name.endsWith(ext)) && !name.endsWith(".d.ts"))
      yield relative(ROOT, path);
  }
}
const all = new Set(SOURCE_ROOTS.flatMap((root) => [...walk(root)]));
for (const config of ["vite.config.ts", "vitest.backend.config.ts", "eslint.config.mjs"])
  if (existsSync(config)) all.add(config);

function resolve(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = join("client/src", spec.slice(2));
  else if (spec.startsWith("@shared/")) base = join("shared", spec.slice(8));
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else return null;
  const stripped = base.replace(/\.(js|mjs|ts|tsx)$/, "");
  const candidates = [
    base,
    ...EXT.map((ext) => stripped + ext),
    ...EXT.map((ext) => join(base, `index${ext}`)),
  ];
  return candidates.find((candidate) => all.has(candidate)) ?? null;
}

const exportsOf = new Map(); // file → Set(names)
const used = new Map(); // file → Set(names) | "*"
const edges = new Map(); // file → Set(files)
const bare = new Set();
const markUsed = (file, name) => {
  const set = used.get(file) ?? new Set();
  set.add(name);
  used.set(file, set);
};
const hasModifier = (node, kind) => node.modifiers?.some((m) => m.kind === kind);

for (const file of all) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const exported = new Set();
  const out = new Set();
  const link = (spec, names) => {
    const target = resolve(file, spec);
    if (!target) {
      if (!spec.startsWith(".") && !spec.startsWith("node:"))
        bare.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      return;
    }
    out.add(target);
    for (const name of names) markUsed(target, name);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = [];
      if (clause?.name) names.push("default");
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push("*");
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const el of clause.namedBindings.elements)
          names.push((el.propertyName ?? el.name).text);
      if (!clause) names.push("*"); // side-effect import
      link(node.moduleSpecifier.text, names);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.exportClause) {
          link(node.moduleSpecifier.text, ["*"]);
          exported.add("*");
        } else if (ts.isNamedExports(node.exportClause)) {
          link(
            node.moduleSpecifier.text,
            node.exportClause.elements.map((el) => (el.propertyName ?? el.name).text)
          );
          for (const el of node.exportClause.elements) exported.add(el.name.text);
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause))
        for (const el of node.exportClause.elements) exported.add(el.name.text);
    } else if (ts.isExportAssignment(node)) exported.add("default");
    else if (
      ts.isCallExpression(node) &&
      node.arguments.length &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      link(node.arguments[0].text, ["*"]);
    } else if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
      if (isDefault) exported.add("default");
      else if (ts.isVariableStatement(node))
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exported.add(decl.name.text);
        }
      else if (node.name && ts.isIdentifier(node.name)) exported.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  exportsOf.set(file, exported);
  edges.set(file, out);
}

// Entry points: files a script or CI step runs, the client, the configs, every test.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const runTexts = [
  ...Object.values(pkg.scripts ?? {}),
  existsSync(".github/workflows/ci.yml") ? readFileSync(".github/workflows/ci.yml", "utf8") : "",
  existsSync("Dockerfile") ? readFileSync("Dockerfile", "utf8") : "",
].join("\n");
const entries = new Set([
  "client/src/main.tsx",
  "vite.config.ts",
  "vitest.backend.config.ts",
  "eslint.config.mjs",
]);
for (const file of all) {
  if (
    runTexts.includes(file) ||
    /\/tests\/.*\.(mjs|ts)$/.test(file) ||
    /\.test\.(ts|tsx)$/.test(file)
  )
    entries.add(file);
}
for (const match of runTexts.matchAll(
  /(?:phase1-backend|server|tools|scripts)\/[\w./-]+\.(?:ts|mjs|js)/g
))
  if (all.has(match[0])) entries.add(match[0]);
// The servers: whatever the build bundles (esbuild entry points named in package.json).
for (const match of runTexts.matchAll(/esbuild ([\w./-]+\.ts)/g))
  if (all.has(match[1])) entries.add(match[1]);

const reached = new Set();
const stack = [...entries].filter((file) => all.has(file));
while (stack.length) {
  const file = stack.pop();
  if (reached.has(file)) continue;
  reached.add(file);
  for (const next of edges.get(file) ?? []) stack.push(next);
}
const unreachedFiles = [...all]
  .filter((file) => !reached.has(file) && !/\/tests\//.test(file))
  .sort();

const unusedExports = [];
for (const [file, names] of exportsOf) {
  if (entries.has(file) || !reached.has(file)) continue;
  const usedHere = used.get(file) ?? new Set();
  if (usedHere.has("*")) continue;
  for (const name of names)
    if (name !== "*" && !usedHere.has(name)) unusedExports.push(`${file}#${name}`);
}
unusedExports.sort();

// Stylesheets import packages too (`@import "tailwindcss"`).
for (const dir of ["client/src", "client"]) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".css")) continue;
    for (const match of readFileSync(join(dir, name), "utf8").matchAll(
      /@(?:import|plugin)\s+["']([^"'./][^"']*)["']/g
    ))
      bare.add(
        match[1].startsWith("@")
          ? match[1].split("/").slice(0, 2).join("/")
          : match[1].split("/")[0]
      );
  }
}
const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
const unusedDeps = Object.keys(allDeps)
  .filter((dep) => {
    if (bare.has(dep)) return false;
    if (dep.startsWith("@types/")) {
      const base = dep.slice(7).replace("__", "/");
      return !bare.has(base) && !bare.has(`@${base}`) && !["node"].includes(base);
    }
    const bin = dep.split("/").pop();
    return !runTexts.includes(bin) && !runTexts.includes(dep);
  })
  .sort();

const counts = {
  unreachedFiles: unreachedFiles.length,
  unusedExports: unusedExports.length,
  unusedDependencies: unusedDeps.length,
};
const mode = process.argv[2];
if (mode === "--report") {
  console.log(
    JSON.stringify(
      {
        counts,
        entries: entries.size,
        files: all.size,
        unreachedFiles,
        unusedDependencies: unusedDeps,
        unusedExports,
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
    Object.keys(counts).some((key) => counts[key] > baseline.counts[key])
  ) {
    console.error(
      "refused: the counts went up — remove the new unused code, do not raise the baseline. " +
        `now ${JSON.stringify(counts)} baseline ${JSON.stringify(baseline.counts)}`
    );
    process.exit(1);
  }
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      { counts, unreachedFiles, unusedDependencies: unusedDeps, unusedExports },
      null,
      1
    )}\n`
  );
  console.log(JSON.stringify({ written: true, counts }));
  process.exit(0);
}
if (!baseline) {
  console.error("no baseline — run `node tools/unused-code.mjs --write --first` once");
  process.exit(2);
}
const fresh = (list, old) => list.filter((entry) => !old.includes(entry));
const problems = [
  ...fresh(unreachedFiles, baseline.unreachedFiles).map((file) => `new unreachable file: ${file}`),
  ...fresh(unusedExports, baseline.unusedExports).map((entry) => `new unused export: ${entry}`),
  ...fresh(unusedDeps, baseline.unusedDependencies).map((dep) => `new unused dependency: ${dep}`),
];
if (problems.length) {
  console.error(
    `✗ unused code was added (use it or remove it):\n  ${problems.slice(0, 40).join("\n  ")}`
  );
  process.exit(1);
}
console.log(
  JSON.stringify({ suite: "unused-code", status: "passed", counts, baseline: baseline.counts })
);

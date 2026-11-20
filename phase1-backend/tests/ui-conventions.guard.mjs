/**
 * Mechanical guards for interface decisions that are cheap to break by accident
 * and expensive to notice: a rule nobody checks is a promise, not a rule.
 *
 * Today it holds one:
 *
 * **ق-98 / P27-10** — no raw `type="password"` anywhere in `client/src`. Every
 * password field goes through `components/ui/password-input`, so the reveal
 * toggle the owner asked for is present on all of them by construction rather
 * than on the five somebody remembered. This is also ق-06: a visual component is
 * built once in the library and used, never re-hand-rolled beside one screen.
 *
 * The library component itself is the single legitimate place the attribute may
 * appear, and it is excluded by path.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT = join(repoRoot, "client", "src");
const EXTENSIONS = [".ts", ".tsx"];

/** The one file allowed to name the attribute — it is what everything else uses. */
const OWNER_OF_THE_ATTRIBUTE = "client/src/components/ui/password-input.tsx";

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

export function findRawPasswordFields() {
  const violations = [];
  for (const file of sourceFiles(CLIENT)) {
    const relativePath = relative(repoRoot, file).replace(/\\/g, "/");
    if (relativePath === OWNER_OF_THE_ATTRIBUTE) continue;
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (/type\s*=\s*["']password["']/.test(line) || /type:\s*["']password["']/.test(line)) {
        violations.push({ file: relativePath, line: index + 1, text: line.trim().slice(0, 140) });
      }
    });
  }
  return violations;
}

const violations = findRawPasswordFields();
if (violations.length) {
  console.error(
    `P27-10 (ق-98): ${violations.length} password field(s) bypass <PasswordInput>. ` +
    `Use it instead so the reveal toggle is there by construction:\n` +
    violations.map((v) => `  ${v.file}:${v.line} — ${v.text}`).join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ suite: "ui-conventions", status: "passed", summary: { rawPasswordFields: 0 } }, null, 2));
}

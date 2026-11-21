/**
 * Design-token guard — a RATCHET, not a wall.
 *
 * Phase 21's acceptance gate forbids raw colour in any component. Converting all
 * 73 files at once would be one unreviewable diff, so this guard does the thing
 * that actually matters first: it makes the debt STOP GROWING.
 *
 *   - a file already carrying raw colour is listed below with its exact count;
 *   - it may only ever get BETTER — the count is a ceiling, and dropping below
 *     it is rewarded by the guard telling you to lower the number;
 *   - any file NOT on the list must be clean, so every screen written from today
 *     is born on tokens.
 *
 * The list is the honest measure of what phase 21 still owes. When it empties,
 * this guard becomes the wall the plan asks for and the allowlist is deleted.
 *
 * Run: pnpm theme:guard
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLIENT_SRC = fileURLToPath(new URL("../../client/src", import.meta.url));
const HEX = /#[0-9A-Fa-f]{6}\b/g;
/**
 * A SECOND axis, counted but not enforced. `bg-white` is exactly as unthemeable
 * as `bg-[#FFFFFF]` — it just is not a hex, so the gate above cannot see it.
 * Reported so phase 21 sizes the real job rather than the visible half of it.
 */
const LITERAL = /\b(?:bg|text|border|fill|ring|from|to|via)-(?:white|black)\b/g;

/**
 * Files that predate the token layer, with the number of raw colours each still
 * carries. A count may fall; it may never rise. Delete an entry when it hits 0.
 *
 * NOT a permission to keep them — a measured debt with a name on it.
 */
const LEGACY = JSON.parse(
  readFileSync(new URL("./theme-tokens.legacy.json", import.meta.url), "utf8")
);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

const failures = [];
const improved = [];
let remaining = 0;
let literals = 0;

for (const file of walk(CLIENT_SRC)) {
  const relative = path.relative(CLIENT_SRC, file).split(path.sep).join("/");
  const source = readFileSync(file, "utf8");
  const count = (source.match(HEX) ?? []).length;
  literals += (source.match(LITERAL) ?? []).length;
  const allowed = LEGACY[relative];

  if (count === 0) {
    if (allowed !== undefined)
      improved.push(`${relative} is clean — delete its entry from theme-tokens.legacy.json`);
    continue;
  }
  remaining += count;
  if (allowed === undefined) {
    failures.push(
      `${relative}: ${count} raw colour${count === 1 ? "" : "s"} in a file with no legacy allowance.\n` +
        `    Every screen written from now on names a ROLE, not a colour:\n` +
        `    text-[#1E6FDB] → text-[var(--codiq-accent)] · bg-[#FFF0F1] → bg-[var(--codiq-danger-soft)]\n` +
        `    The roles are defined and explained at the top of client/src/index.css.`
    );
  } else if (count > allowed) {
    failures.push(
      `${relative}: ${count} raw colours, up from ${allowed}. This file's debt may only shrink.`
    );
  } else if (count < allowed) {
    improved.push(
      `${relative} is down to ${count} (was ${allowed}) — lower its number in theme-tokens.legacy.json`
    );
  }
}

if (improved.length) {
  console.log("Progress — update the ledger so the ratchet holds:");
  for (const line of improved) console.log(`  · ${line}`);
  console.log("");
}

if (failures.length) {
  console.error("Design-token guard failed:\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}

const files = Object.keys(LEGACY).length;
console.log(
  `theme:guard ok — no new raw colour. Phase 21 still owes ${remaining} value${remaining === 1 ? "" : "s"} across ${files} legacy file${files === 1 ? "" : "s"}.`
);
console.log(
  `  …plus ${literals} literal white/black utilities, which no hex check can see and dark mode will still break on.`
);

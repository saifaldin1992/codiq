/**
 * المرحلة 21 — lower the design-token debt ledger by MEASURING it, never by
 * hand.
 *
 * `theme-tokens.legacy.json` is a ratchet: every file that still carries raw
 * colour is listed with its exact count, a count may fall and may never rise,
 * and an entry is deleted when it reaches zero. Keeping that honest by editing
 * JSON after each conversion is precisely the kind of bookkeeping that drifts —
 * `NotificationCenter.tsx` sat at 52 in the ledger while the file held 51 for
 * long enough that the guard printed the correction on every run.
 *
 * So this recounts from the source and rewrites the ledger, with one rule it
 * will not break: **a number may only go DOWN**. If a file grew, this refuses
 * to record it and exits non-zero — because raising the ceiling is a reviewed
 * decision, and a script that could do it silently would end the ratchet.
 *
 * Run: pnpm theme:ratchet
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = fileURLToPath(new URL("../../client/src", import.meta.url));
const LEDGER = fileURLToPath(new URL("../tests/theme-tokens.legacy.json", import.meta.url));
const HEX = /#[0-9A-Fa-f]{6}\b/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const actual = new Map();
for (const file of walk(CLIENT_SRC)) {
  const relative = path.relative(CLIENT_SRC, file).split(path.sep).join("/");
  const count = (readFileSync(file, "utf8").match(HEX) ?? []).length;
  if (count > 0) actual.set(relative, count);
}

const raised = [];
const lowered = [];
const cleared = [];
const next = {};

for (const [file, allowed] of Object.entries(ledger)) {
  const now = actual.get(file) ?? 0;
  if (now > allowed) {
    raised.push(`${file}: ${allowed} → ${now}`);
    next[file] = allowed;
    continue;
  }
  if (now === 0) {
    cleared.push(file);
    continue;
  }
  if (now < allowed) lowered.push(`${file}: ${allowed} → ${now}`);
  next[file] = now;
}

// A file NOT in the ledger that carries raw colour is a new violation, and the
// guard already fails on it. This script must never quietly enrol one.
const unlisted = [...actual.keys()].filter((file) => !(file in ledger));

if (raised.length || unlisted.length) {
  if (raised.length) {
    console.error(`theme:ratchet REFUSED — ${raised.length} file(s) grew, and the ledger is a ceiling that only falls:`);
    raised.forEach((line) => console.error(`  ${line}`));
  }
  if (unlisted.length) {
    console.error(`theme:ratchet REFUSED — ${unlisted.length} file(s) carry raw colour without being listed; that is a NEW violation for \`pnpm theme:guard\` to fail on, not a debt to enrol:`);
    unlisted.forEach((file) => console.error(`  ${file} (${actual.get(file)})`));
  }
  process.exit(1);
}

const ordered = Object.fromEntries(Object.keys(next).sort().map((key) => [key, next[key]]));
writeFileSync(LEDGER, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");

const remaining = Object.values(ordered).reduce((sum, n) => sum + n, 0);
console.log(JSON.stringify({
  suite: "theme-ratchet",
  status: "updated",
  summary: {
    filesCleared: cleared.length,
    cleared,
    filesLowered: lowered.length,
    lowered,
    filesRemaining: Object.keys(ordered).length,
    valuesRemaining: remaining,
  },
}, null, 2));

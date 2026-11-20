/**
 * Guard — a suite that truncates must clear the shared login counter too.
 *
 * WHY. The dashboard limiter is keyed `platform:<ip>` / `merchant:<ip>` at 30
 * sign-ins per ten minutes. Every suite on a CI runner is the same 127.0.0.1
 * writing into one shared database, so `storefront_rate_limits` is a number a
 * suite INHERITS from whatever ran before it — never one it sets. A suite that
 * resets the world but leaves that table reads another suite's meter.
 *
 * That is not hypothetical. #140 measured phase 8B failing **six runs in ten**
 * for exactly this: it truncated fourteen tables, `storefront_rate_limits` was
 * the one missing, and the owner sign-in answered 429 instead of 200. Nothing
 * about phase 8B was wrong. Phase 14 was the last suite with the same hole.
 *
 * THE RULE IS CONDITIONAL ON PURPOSE — «if you truncate, truncate this too».
 *
 * Phase 6, 7 and 13 clear nothing and import no Prisma client at all: they are
 * pure Playwright flows against a running server. Requiring a database cleanup
 * from them would change what those suites ARE, which is a decision for a person
 * and not a ratchet. So they are not in scope here, and the rule is written so
 * that they never come into scope by accident — while any suite that DOES reach
 * for `TRUNCATE` is held to the full list from its first line.
 *
 * Run: pnpm login:counter:guard
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const COUNTER_TABLE = "storefront_rate_limits";

/**
 * Comments are stripped before the scan.
 *
 * 20-3 found `list-envelope.guard.mjs` reading comments as code, and within the
 * hour I reproduced it myself in a throwaway checker — a `@@index` written
 * inside the comment that documented its removal was counted as a declaration.
 * A guard that reads prose is a guard whose verdict can be changed by writing
 * about it, which is the opposite of what a ratchet is for.
 */
function code(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

const offenders = [];
const holdsTheLine = [];
for (const entry of readdirSync(here)) {
  if (!entry.endsWith(".mjs") && !entry.endsWith(".ts")) continue;
  if (entry.endsWith(".guard.mjs")) continue;
  const source = code(readFileSync(path.join(here, entry), "utf8"));
  // Only suites that already reset state are in scope — see the header.
  if (!/TRUNCATE\s+TABLE/i.test(source)) continue;
  if (source.includes(COUNTER_TABLE)) holdsTheLine.push(entry);
  else offenders.push(entry);
}

assert.ok(holdsTheLine.length > 10, `the scan found only ${holdsTheLine.length} truncating suites — it is probably not reading the files it thinks it is`);
assert.deepEqual(
  offenders,
  [],
  `these suites TRUNCATE but leave the shared login counter, so they read whatever meter the previous suite left behind (#140 measured 6 failures in 10 from exactly this): ${offenders.join(", ")} — add ${COUNTER_TABLE} to the TRUNCATE list`,
);

console.log(JSON.stringify({
  suite: "login-counter",
  status: "passed",
  summary: {
    rule: "a suite that truncates must also clear " + COUNTER_TABLE,
    truncatingSuites: holdsTheLine.length,
    offenders: 0,
    outOfScope: "phase6/7/13 clear nothing and import no Prisma client — deliberately not held to this",
  },
}, null, 2));

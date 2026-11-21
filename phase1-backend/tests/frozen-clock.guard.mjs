/**
 * ق-169 — a test may not write a calendar date down and call it "now".
 *
 * ============================================================================
 * WHAT HAPPENED, TWICE
 * ============================================================================
 *
 * `pg3.integration.mjs` pinned three drains to literal days — `2026-09-05`,
 * `2026-09-06`, `2026-09-07` — and derived a fourth bound from `2026-09-08`.
 * Every one of them was safely in the past or the future on the day it was
 * written. The suite was green for weeks, in CI and on every machine.
 *
 * Then UTC rolled over to 2026-09-07 and the third literal became **today**.
 * The default `drain()` calls earlier in that file run at the real clock, so
 * they sent operational mail to the same recipient inside the very day-window
 * the per-recipient cap test then assumed was empty. Its budget of two was
 * spent before it began:
 *
 *     19-د: the per-recipient operational ceiling must hold at 2 —
 *     {"claimed":5,"sent":0,"retried":0,"deadLettered":0,"skipped":0,"deferred":5}
 *
 * It failed on `main`, on a freshly migrated database, and — an hour later —
 * in CI, blocking a pull request that had nothing to do with messaging. And
 * production was never involved: `messaging-compliance.service.ts` computes
 * both day boundaries with `Date.UTC`, so the real cap never depended on this.
 *
 * THE SECOND TIME IS THE POINT. That same file already carried the lesson in a
 * comment — «this assertion passed every day until 2026-09-05T10:00Z and then
 * failed forever» — written by whoever fixed the previous instance. The lesson
 * was recorded and three literals survived beside it. A comment is not a rule.
 *
 * ============================================================================
 * THE RULE, AND WHY IT IS A RATCHET
 * ============================================================================
 *
 * Not every literal date is a time bomb: one used purely as DATA — a cursor
 * value, a payload field, a formatting fixture — is harmless. Distinguishing
 * them mechanically is not possible, so this does not ban them. It freezes the
 * count: the twenty-two that exist today may shrink and may never grow, and a
 * test file that has none may never gain one.
 *
 * That is the same shape as the design-token ratchet, and for the same reason:
 * a rule nobody can adopt in one sitting is a rule that gets deleted.
 *
 * Comments are skipped — the note above names four dates itself, and a guard
 * that trips over its own explanation is a guard someone silences.
 *
 * Run: pnpm clock:guard
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = fileURLToPath(new URL(".", import.meta.url));
const legacyPath = path.join(testsDir, "frozen-clock.legacy.json");

/** `new Date("2026-09-07…")` and `Date.UTC(2026, 8, 7)`. */
const LITERAL_DATES = /new Date\("20\d\d-|Date\.UTC\(20\d\d\s*,/g;
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

const counts = {};
for (const entry of readdirSync(testsDir)) {
  if (!/\.(mjs|js)$/.test(entry)) continue;
  if (entry === "frozen-clock.guard.mjs") continue;
  // Every literal date counts, however many share a line: counting LINES made a formatter
  // that wraps one line into two look like a new date (review batch 1).
  const hits = readFileSync(path.join(testsDir, entry), "utf8")
    .split(/\r?\n/)
    .filter((line) => !isComment(line))
    .reduce((sum, line) => sum + (line.match(LITERAL_DATES) ?? []).length, 0);
  if (hits > 0) counts[entry] = hits;
}

if (process.argv.includes("--write")) {
  writeFileSync(legacyPath, `${JSON.stringify(counts, null, 2)}\n`, "utf8");
  console.log(
    `frozen-clock.legacy.json rewritten — ${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} literals`
  );
  process.exit(0);
}

const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
const violations = [];

for (const [file, hits] of Object.entries(counts)) {
  const allowed = legacy[file] ?? 0;
  if (hits > allowed) {
    violations.push(
      allowed === 0
        ? `  ${file}: ${hits} literal date(s) in a file that had none. Derive them from Date.now() instead.`
        : `  ${file}: ${hits} literal dates, up from ${allowed}. This file's debt may only shrink.`
    );
  }
}

const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
const budget = Object.values(legacy).reduce((sum, n) => sum + n, 0);

if (violations.length) {
  console.error(
    `ق-169: a test wrote a calendar date down and will one day call it "now".\n${violations.join("\n")}\n\n` +
      `A literal date is safe until the calendar reaches it. pg3 pinned 2026-09-07, stayed green for weeks, and ` +
      `failed in CI the hour UTC rolled over — because the default drains, which run at the real clock, had already ` +
      `spent that day's per-recipient budget.\n\n` +
      `Derive the instant from Date.now() with an offset chosen to avoid collision, the way pg3's utcDay() now does. ` +
      `If the date is genuinely DATA and not a clock, shrink another file's count to keep the total falling, or say ` +
      `so in this file rather than raising the number silently.`
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        suite: "frozen-clock",
        status: "passed",
        summary: {
          literals: total,
          budget,
          files: Object.keys(counts).length,
          guarantee: "no test file gains a hardcoded calendar date; the total may only fall",
        },
      },
      null,
      2
    )
  );
}

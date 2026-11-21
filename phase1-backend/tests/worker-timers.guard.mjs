/**
 * Guard — ق-239: ONE clock in the backend, and it lives in the scheduler.
 *
 * WHY A RATCHET AND NOT A ONE-TIME FIX. The worker grew to NINE independent
 * `setInterval`s, one at a time, each reasonable on its own and each added by
 * someone who could not see the other eight. Their union covered the clock:
 * simulated at one-second resolution over a full day, the database was awake
 * 100% of the time — and, the part that makes this a ratchet rather than a
 * cleanup, 99.7% of that came from the EIGHT nobody suspected. The five-second
 * outbox loop everyone blamed was worth three tenths of one percent.
 *
 * WHAT A TENTH TIMER WOULD COST. Nothing visible. No test fails, no error is
 * logged, no page breaks. Neon simply stops suspending, and the bill returns
 * with no cause anybody can point at — which is exactly how the first nine
 * arrived. A rule that lives in reviewers' memory decays in the same direction.
 * This file is the memory.
 *
 * THE SCHEDULER IS THE ONE EXCEPTION, and it is an exception by construction:
 * it holds the single tick that every periodic job now shares.
 *
 * `setTimeout` IS NOT BANNED, deliberately. The outbox loop reschedules itself
 * with one because its delay varies — that is the adaptive backoff which lets
 * the database sleep, the opposite of the defect. A fixed repeating timer is
 * the thing that cannot be reasoned about locally.
 *
 * Run: pnpm workertimers:guard
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const srcDir = resolve(here, "..", "src");
const serverDir = resolve(root, "server");

/** Path (posix, repo-relative) → why this file may own a repeating timer. */
const ALLOWLIST = {
  "phase1-backend/src/jobs/scheduler.ts":
    "THE tick. Every periodic job shares it — that is the whole point of ق-239, and this is the only file that may hold one.",
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const files = [...walk(srcDir), ...walk(serverDir)];
const violations = [];
const seenAllowed = new Set();

for (const file of files) {
  const key = relative(root, file).split("\\").join("/");
  const source = readFileSync(file, "utf8");
  // Strip block and line comments before looking: this guard's own prose, and
  // the explanations left behind in worker-entry.ts, name `setInterval` on
  // purpose. A guard that cannot tell code from the comment explaining it
  // teaches people to stop writing the comment.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  if (!/\bsetInterval\s*\(/.test(code)) continue;
  if (key in ALLOWLIST) {
    seenAllowed.add(key);
    continue;
  }
  violations.push(
    `${key} — holds a repeating timer. Register a job with the scheduler (ق-239) instead; nine of these kept Neon awake around the clock.`
  );
}

// An allowlist nobody prunes stops meaning anything: an entry that silences
// nothing is a stale entry and fails too (the deleted-leak-guard idiom).
for (const key of Object.keys(ALLOWLIST)) {
  if (!seenAllowed.has(key)) {
    violations.push(`${key} — allowlisted but holds no timer any more; remove the stale entry.`);
  }
}

if (violations.length) {
  console.error(JSON.stringify({ suite: "worker-timers", status: "failed", violations }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      suite: "worker-timers",
      status: "passed",
      summary: {
        filesScanned: files.length,
        repeatingTimers: seenAllowed.size,
        where: [...seenAllowed],
      },
    },
    null,
    2
  )
);

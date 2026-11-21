/**
 * Unit — the one retry policy (src/db/serializable-retry.ts).
 *
 * Why this file exists at all: on 2026-09-04 a POS ticket exhausted its three
 * instant attempts under CI load and the cashier's sale answered 500. That
 * violates the founding principle of the till (ق-132 — «الرفض عند الصندوق هو
 * الشيء الوحيد الممنوع»), and a loaded runner is the same load profile as a
 * busy shop. Four hand-copied loops became one policy; this pins what it does.
 *
 * Run: pnpm retry:test
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

const {
  SERIALIZABLE_ATTEMPTS,
  isRetryableTransactionError,
  sleepBeforeRetry,
  withSerializableRetry,
} = await import("../src/db/serializable-retry.ts");

const summary = {};
const known = (code, meta) =>
  Object.assign(
    new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "6.18.0" }),
    meta ? { meta } : {}
  );

// ============================================================
// 1. What counts as a lost race — and what emphatically does not.
// ============================================================
for (const code of ["P2002", "P2034", "P2028"]) {
  assert.equal(
    isRetryableTransactionError(known(code)),
    true,
    `${code} is a lost race, not an answer`
  );
}
assert.equal(
  isRetryableTransactionError(known("P2010", { code: "40001" })),
  true,
  "raw 40001 serialization_failure is a lost race"
);
assert.equal(
  isRetryableTransactionError(known("P2010", { code: "42P01" })),
  false,
  "a raw query against a missing table is a BUG — retrying hides it"
);
// P2028 is D-47's open half: it was retried NOWHERE before this module.
assert.equal(
  isRetryableTransactionError(known("P2028")),
  true,
  "D-47: a transaction timeout is as retryable as a write conflict"
);
// Business refusals are answers. Retrying them makes a clear no into a slow no.
for (const code of ["P2025", "P2003", "P2000"]) {
  assert.equal(
    isRetryableTransactionError(known(code)),
    false,
    `${code} is an answer, not an accident`
  );
}
assert.equal(
  isRetryableTransactionError(new Error("boom")),
  false,
  "an unknown error is never retried blindly"
);
assert.equal(isRetryableTransactionError(null), false, "null is not retryable");
summary.classification =
  "P2002/P2034/P2028/P2010-40001 retry; business refusals and unknown errors do not";

// ============================================================
// 2. The budget is spent, and only on retryable failures.
// ============================================================
let calls = 0;
await assert.rejects(
  () =>
    withSerializableRetry(async () => {
      calls += 1;
      throw known("P2034");
    }),
  (error) => error.code === "P2034",
  "a permanently conflicting transaction eventually surfaces its real error"
);
assert.equal(
  calls,
  SERIALIZABLE_ATTEMPTS,
  `every attempt is used — ${SERIALIZABLE_ATTEMPTS} of them`
);
assert.ok(
  SERIALIZABLE_ATTEMPTS >= 5,
  "three instant attempts is what failed in CI; the budget must be materially larger"
);

calls = 0;
await assert.rejects(
  () =>
    withSerializableRetry(async () => {
      calls += 1;
      throw known("P2025");
    }),
  (error) => error.code === "P2025"
);
assert.equal(calls, 1, "a business refusal is not retried even once");
summary.budget = `${SERIALIZABLE_ATTEMPTS} attempts on a lost race, 1 on a refusal`;

// ============================================================
// 3. It succeeds on a later attempt — the whole point.
// ============================================================
calls = 0;
const value = await withSerializableRetry(async () => {
  calls += 1;
  if (calls < 4) throw known("P2034");
  return "sold";
});
assert.equal(value, "sold", "the sale goes through once the race is won");
assert.equal(calls, 4, "…on the attempt that won it");
summary.recovery =
  "a transaction that loses three races and wins the fourth still returns its value";

// ============================================================
// 4. The wait is real and it is JITTERED.
// ============================================================
// Fixed backoff wakes two colliding writers at the same instant and they
// collide again — the retry becomes a metronome keeping them in lockstep.
const waits = [];
for (let i = 0; i < 40; i += 1) {
  const started = process.hrtime.bigint();
  await sleepBeforeRetry(0);
  waits.push(Number(process.hrtime.bigint() - started) / 1e6);
}
assert.ok(
  Math.max(...waits) > Math.min(...waits) + 1,
  `the backoff is randomised, not a metronome (min ${Math.min(...waits).toFixed(1)}ms, max ${Math.max(...waits).toFixed(1)}ms)`
);

const early = [];
const later = [];
for (let i = 0; i < 12; i += 1) {
  let started = process.hrtime.bigint();
  await sleepBeforeRetry(0);
  early.push(Number(process.hrtime.bigint() - started) / 1e6);
  started = process.hrtime.bigint();
  await sleepBeforeRetry(3);
  later.push(Number(process.hrtime.bigint() - started) / 1e6);
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
assert.ok(
  mean(later) > mean(early),
  `the wait grows with the attempt (attempt 0 ~${mean(early).toFixed(1)}ms, attempt 3 ~${mean(later).toFixed(1)}ms)`
);
summary.backoff = `jittered and growing — attempt 0 ~${mean(early).toFixed(0)}ms, attempt 3 ~${mean(later).toFixed(0)}ms`;

// ============================================================
// 5. Every call site uses THIS policy — no fifth private copy.
// ============================================================
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const servicesDir = fileURLToPath(new URL("../src/services", import.meta.url));
const strays = [];
for (const entry of readdirSync(servicesDir)) {
  if (!entry.endsWith(".ts")) continue;
  const source = readFileSync(path.join(servicesDir, entry), "utf8");
  // THIS CHECK USED TO BE `has a numeric bound AND never mentions the constant`,
  // AND IT WAS FOOLED — by a HALF-DONE conversion, which is the likeliest way
  // this ever goes wrong and the one shape the old rule could not see.
  //
  // `storefront.service.ts` had `for (attempt = 0; attempt < 3; ...)` with
  // `if (attempt < SERIALIZABLE_ATTEMPTS - 1) continue` INSIDE it. The retry
  // condition was converted; the loop bound was not. So the condition believed
  // it had six attempts while the loop stopped at three, and the guard passed
  // because the file DID mention the constant. A comment three lines above even
  // claimed «same budget and jitter as the till» — a property the code did not
  // have. Two concurrent checkouts on one idempotency key exhausted the three
  // and a shopper's order answered 500 (caught in CI on 2026-09-05).
  //
  // So the rule is now about the LITERAL, not about the file: no numeric bound
  // on an attempt counter may survive anywhere, whatever else the file says.
  // It is the same lesson `env:check` was written for the same day — a
  // half-finished edit is never a decision, and it is exactly what boots clean
  // and fails under load.
  for (const match of source.matchAll(/attempt\s*<\s*(\d+)/g))
    strays.push(`${entry} (attempt < ${match[1]})`);
}
assert.deepEqual(
  strays,
  [],
  `a hard-coded retry bound survives: ${strays.join(", ")} — the LOOP BOUND must be SERIALIZABLE_ATTEMPTS, not a literal, even where the retry condition already uses it`
);
summary.singleSource =
  "no service carries a hard-coded retry bound — loop AND condition both read the shared constant";

// ============================================================
// 6. And when the budget IS exhausted, the answer is honest.
// ============================================================
// P2034 appeared NOWHERE in `errors.ts`, so an exhausted budget fell through to
// the 500 fallthrough and told a shopper «Unexpected server error» — the exact
// sentence ق-132 exists to prevent, and a lie besides: nothing was broken, the
// row was contended. 503 because the condition is temporary and retrying is the
// right response, which the message now says in words he can act on.
const { classifyError } = await import("../src/http/errors.ts");
for (const error of [
  known("P2034"),
  known("P2002"),
  known("P2028"),
  known("P2010", { code: "40001" }),
]) {
  const outcome = classifyError(error, { path: "/store/x/checkout" });
  // P2002 keeps its own 409 — a duplicate identity is a real refusal, and it is
  // matched well before this branch. The other three are pure contention.
  const expected = error.code === "P2002" ? 409 : 503;
  assert.equal(
    outcome.status,
    expected,
    `${error.code} must answer ${expected}, not a 500 that blames the platform`
  );
  assert.equal(
    outcome.mapped,
    true,
    `${error.code} is a KNOWN outcome — an unmapped one is logged as a fault with a stack and pages someone`
  );
}
assert.equal(
  classifyError(known("P2034"), { path: "/store/x/checkout" }).error.code,
  "TRANSACTION_CONTENTION"
);
// The guard against over-reach: a genuinely unknown error keeps its 500.
const unknown = classifyError(new Error("something we did not foresee"), {
  path: "/store/x/checkout",
});
assert.equal(unknown.status, 500, "an error nobody classified is still ours, and still a 500");
assert.equal(unknown.mapped, false);
summary.exhaustedIsHonest =
  "an exhausted budget answers 503 TRANSACTION_CONTENTION, not a 500 that blames the platform";

console.log(JSON.stringify({ suite: "serializable-retry", status: "passed", summary }, null, 2));

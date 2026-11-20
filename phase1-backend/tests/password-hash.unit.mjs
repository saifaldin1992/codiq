/**
 * D-36 — a password compare must not stop the platform.
 *
 * `bcryptjs` is the pure-JavaScript bcrypt: a cost-12 compare is ~250–500 ms of
 * work ON THE EVENT LOOP. While it runs, nothing else runs — every request in
 * flight waits, the health probe waits, the outbox signal waits. On a platform
 * that serves the API, every dashboard and every storefront from ONE process,
 * a burst of sign-in attempts is a CPU-exhaustion denial of service reachable
 * from any login form, and the rate limiter only bounds how many per window,
 * not the fact that each one freezes the loop.
 *
 * Native `bcrypt` runs the same algorithm on libuv's threadpool. Same hash
 * format, same cost, same ~250 ms — but the loop keeps serving while it runs.
 *
 * FOUR THINGS ARE ASSERTED, in the order they matter:
 *
 *   1. COMPATIBILITY — a hash minted by bcryptjs 3.0.2 (the library being
 *      retired) verifies under the new one. Every merchant, staff member,
 *      owner and shopper in production holds one of those; a swap that could
 *      not read them would sign the whole platform out.
 *   2. new hashes are `$2b$12$` — cost unchanged, prefix the old library reads
 *      too, so a rollback is not a lockout either
 *   3. `ABSENT_IDENTITY_HASH` — the constant-work partner of every login door
 *      (19-د) — is still a real cost-12 hash that matches nothing and costs as
 *      much as a real compare, so the timing oracle stays closed
 *   4. THE POINT: the event loop stays responsive DURING a compare. A 1 ms
 *      timer scheduled before the compare must fire while the compare is still
 *      running. Under bcryptjs it cannot — the loop is busy — and this fails.
 *
 * Run: pnpm password:hash
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

process.env.SESSION_JWT_SECRET ??= "password-hash-unit-secret-not-for-production";
process.env.DATABASE_URL ??= "postgresql://guard:guard@password-hash-never-connects.invalid:5432/guard";

const { createPasswordHash, verifyPassword, ABSENT_IDENTITY_HASH } = await import("../src/auth/identity.ts");

const summary = {};

// ============================================================
// 1. A hash the OLD library minted still opens the door.
// ============================================================
// Minted with bcryptjs 3.0.2 at cost 12 on 2026-09-14, the day of the swap,
// from the literal below. It is the shape every stored password hash has.
const LEGACY_PASSWORD = "Codiq-Compat-2026!";
const LEGACY_HASH = "$2b$12$a/tU1tlQNE4j/xBbGPDOxunb3yzIp7IF.vbqST31SENR8KfnnYHz6";
assert.equal(await verifyPassword(LEGACY_PASSWORD, LEGACY_HASH), true, "D-36: a bcryptjs-minted hash MUST verify under native bcrypt — otherwise the swap signs everyone out");
assert.equal(await verifyPassword("Codiq-Compat-2026?", LEGACY_HASH), false, "…and a near miss still fails");
assert.equal(await verifyPassword(undefined, LEGACY_HASH), false, "…and a non-string never verifies");
summary.legacyHashesVerify = "a bcryptjs 3.0.2 hash verifies under the native library";

// ============================================================
// 2. New hashes keep the format and the cost.
// ============================================================
const fresh = await createPasswordHash("Codiq-Fresh-2026!");
assert.match(fresh, /^\$2b\$12\$/, "new hashes are $2b$ at cost 12 — the old library reads these too, so a rollback is not a lockout");
assert.equal(await verifyPassword("Codiq-Fresh-2026!", fresh), true);
assert.notEqual(await createPasswordHash("Codiq-Fresh-2026!"), fresh, "salted: the same password never hashes the same twice");
summary.freshHashes = "$2b$12$, verifiable, salted";

// ============================================================
// 3. The constant-work partner still costs what a real compare costs.
// ============================================================
assert.match(ABSENT_IDENTITY_HASH, /^\$2b\$12\$/, "ABSENT_IDENTITY_HASH is a real cost-12 hash, not a sentinel string");
const absentStarted = performance.now();
assert.equal(await verifyPassword("anything at all", ABSENT_IDENTITY_HASH), false, "…that matches nothing");
const absentMs = performance.now() - absentStarted;
const realStarted = performance.now();
await verifyPassword("Codiq-Fresh-2026!", fresh);
const realMs = performance.now() - realStarted;
assert.ok(absentMs > 20, `the dummy compare does real work (${absentMs.toFixed(0)} ms) — if it were free, «no such account» would answer faster than «wrong password» and the clock would name every account`);
assert.ok(Math.abs(absentMs - realMs) < Math.max(realMs, absentMs) * 0.75, `…and costs about what a real compare costs (${absentMs.toFixed(0)} vs ${realMs.toFixed(0)} ms)`);
summary.constantWork = `absent ${absentMs.toFixed(0)} ms vs real ${realMs.toFixed(0)} ms`;

// ============================================================
// 4. THE POINT — the loop keeps turning while a compare runs.
// ============================================================
// A 1 ms timer is armed, then a cost-12 compare is awaited. If the compare
// occupies the event loop, the timer cannot fire until it finishes and its lag
// equals the compare's duration. If the compare runs on the threadpool the
// timer fires almost at once. The compare must itself be slow enough for the
// distinction to mean something, which the assertion checks first.
let timerFiredAt = null;
const armed = performance.now();
setTimeout(() => { timerFiredAt = performance.now(); }, 1);
await verifyPassword("Codiq-Fresh-2026!", fresh);
const compareMs = performance.now() - armed;
// Give the timer's callback a turn to run if it has not already.
await new Promise((resolve) => setImmediate(resolve));
assert.ok(compareMs > 20, `a cost-12 compare is slow enough to measure (${compareMs.toFixed(0)} ms)`);
assert.notEqual(timerFiredAt, null, "the timer fired");
const lagMs = timerFiredAt - armed;
assert.ok(lagMs < compareMs / 2, `D-36: the 1 ms timer fired after ${lagMs.toFixed(0)} ms while the compare took ${compareMs.toFixed(0)} ms — the loop was BLOCKED for the compare's whole duration. Native bcrypt must hash on the threadpool.`);
summary.loopStaysResponsive = `1 ms timer fired after ${lagMs.toFixed(1)} ms during a ${compareMs.toFixed(0)} ms compare`;

console.log(JSON.stringify({ suite: "password-hash", status: "passed", summary }, null, 2));

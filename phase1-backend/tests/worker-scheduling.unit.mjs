/**
 * Unit — ق-239: one tick for eight jobs, and a loop that asks only when asked to.
 *
 * The defect this pins is invisible by construction. Nine independent timers
 * broke nothing: no test failed, no error was logged, no page was slow. They
 * simply meant the database was never idle for five consecutive minutes, so Neon
 * never suspended, and the bill was 110.6 CU-hours against a 100-hour quota with
 * THREE test merchants and no customers. Every one of those hours was paid for
 * an empty answer.
 *
 * Simulated at one-second resolution over a full day:
 *
 *     nine timers as they were         100.0% awake
 *     everything EXCEPT the outbox      99.7%     ← the five-second loop was not the cause
 *     one scheduler, 30-minute tick     16.3%
 *
 * What is pinned here, in the order it can silently rot:
 *
 *   1. A JOB RUNS ON ITS OWN PERIOD, not on the tick's. A six-hour sweep must
 *      not become half-hourly because the tick is half-hourly.
 *   2. THE FIRST TICK IS IMMEDIATE. Seeding «last run» with the clock instead of
 *      null would skip every job's first pass after every deploy — invisible,
 *      and it makes a restart look like a fix.
 *   3. ONE JOB'S FAILURE COSTS ONLY ITS OWN TURN. Each timer used to carry its
 *      own catch; the shared burst must not trade that away.
 *   4. A SLOW TICK IS SKIPPED, NOT QUEUED. Queuing turns one slow pass into a
 *      growing backlog of passes.
 *   5. THE OUTBOX DRAINS FAST AND SLEEPS DEEP. Reset on work, double on silence.
 *   6. `wake()` COLLAPSES THE BACKOFF — the signal from whoever wrote the row.
 *
 * Run: pnpm workersched:test
 */
import assert from "node:assert/strict";

const { startJobScheduler } = await import("../src/jobs/scheduler.ts");
const { startOutboxWorker } = await import("../src/notifications/outbox-worker.ts");
const { setOutboxSignalSink, signalOutboxWork, isOutboxSignalMessage, OUTBOX_SIGNAL_MESSAGE } =
  await import("../src/jobs/outbox-signal.ts");

const summary = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// 1. EACH JOB KEEPS ITS OWN PERIOD; THE TICK ONLY OFFERS A TURN.
// ============================================================
{
  const runs = { often: 0, rare: 0 };
  // A huge tickMs so the interval never fires on its own — every tick here is
  // driven by hand, which is the only way to assert scheduling without sleeping
  // through real periods.
  const scheduler = startJobScheduler([
    { name: "often", everyMs: 0, run: async () => { runs.often += 1; } },
    { name: "rare", everyMs: 60 * 60 * 1000, run: async () => { runs.rare += 1; } },
  ], 60 * 60 * 1000);

  // 2. THE CONSTRUCTOR ALREADY RAN ONE TICK — a deploy must not mean a tick of nothing.
  await sleep(20);
  assert.equal(runs.often, 1, "the first tick must run at startup, not one tick later");
  assert.equal(runs.rare, 1, "a job that has never run is due on its first tick, whatever its period");

  await scheduler.tickNow();
  assert.equal(runs.often, 2, "a zero-period job runs on every tick");
  assert.equal(runs.rare, 1, "an hourly job must NOT run again on the next tick — its period, not the tick's");

  await scheduler.tickNow();
  assert.equal(runs.often, 3);
  assert.equal(runs.rare, 1, "still not due");
  scheduler.stop();
  summary.ownPeriod = "zero-period ran 3x, hourly ran 1x across 3 ticks";
}

// ============================================================
// 3. A THROWING JOB COSTS ITSELF ITS TURN AND NOTHING MORE.
// ============================================================
{
  const ran = [];
  const scheduler = startJobScheduler([
    { name: "before", everyMs: 0, run: async () => { ran.push("before"); } },
    { name: "explodes", everyMs: 0, run: async () => { ran.push("explodes"); throw new Error("job failed on purpose"); } },
    { name: "after", everyMs: 0, run: async () => { ran.push("after"); } },
  ], 60 * 60 * 1000);
  await sleep(20);
  assert.deepEqual(ran, ["before", "explodes", "after"], "a sibling's failure must not cost the jobs after it their turn");
  scheduler.stop();
  summary.failureIsolated = "the job after the thrower still ran";
}

// ============================================================
// 4. A TICK STILL WORKING WHEN THE NEXT ARRIVES IS SKIPPED.
// ============================================================
{
  let started = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const scheduler = startJobScheduler([
    { name: "slow", everyMs: 0, run: async () => { started += 1; await held; } },
  ], 60 * 60 * 1000);
  await sleep(20);
  assert.equal(started, 1, "the startup tick began the slow job");
  // A second tick while the first is still inside the job must not start it again.
  //
  // AND WHEN THE GUARD IS REMOVED, THIS LINE DOES NOT FAIL — IT HANGS. `tickNow`
  // would enter the slow job a second time and await a promise this test only
  // resolves on the line below, so the suite deadlocks rather than asserting.
  // That is a harsher failure than an assertion and worth knowing about: proving
  // this guard by reintroducing the defect needs a timeout, not patience.
  await scheduler.tickNow();
  assert.equal(started, 1, "an overlapping tick must be skipped, never queued");
  release();
  await sleep(20);
  await scheduler.tickNow();
  assert.equal(started, 2, "once the slow pass finished, the next tick proceeds normally");
  scheduler.stop();
  summary.overlapSkipped = "second tick skipped while the first was inside a job";
}

// ============================================================
// 5. THE OUTBOX DRAINS FAST AND BACKS OFF WHEN THE QUEUE IS EMPTY.
// ============================================================
{
  const empty = { claimed: 0, sent: 0, retried: 0, deadLettered: 0, skipped: 0, deferred: 0 };
  const busy = { ...empty, claimed: 1, sent: 1 };
  let passes = 0;
  let mode = "busy";
  const stamps = [];
  const worker = startOutboxWorker(null, {
    fastMs: 20,
    idleMaxMs: 320,
    fastWindowMs: 100,
    runPass: async () => { passes += 1; stamps.push(Date.now()); return mode === "busy" ? busy : empty; },
  });

  // RATES, not counts. The two windows are different lengths on purpose — a
  // backed-off loop is measured by how FAR APART its passes are, and comparing
  // raw counts across unequal windows is how that measurement goes wrong.
  const BUSY_MS = 200;
  await sleep(BUSY_MS);
  const whileBusy = passes;
  assert.ok(whileBusy >= 4, `a draining queue must be polled fast (got ${whileBusy} passes in ${BUSY_MS}ms at 20ms)`);
  const busyRate = whileBusy / BUSY_MS;

  // The moment it finds nothing, the wait must start doubling: 20 → 40 → 80 → …
  mode = "idle";
  const atIdle = passes;
  const IDLE_MS = 600;
  await sleep(IDLE_MS);
  const whileIdle = passes - atIdle;
  const idleRate = whileIdle / IDLE_MS;
  assert.ok(idleRate < busyRate / 2, `an idle loop must ask at less than half a busy one's rate (busy ${busyRate.toFixed(3)}/ms, idle ${idleRate.toFixed(3)}/ms)`);
  // And the gap must genuinely be widening rather than merely being slower once.
  const gaps = stamps.slice(-4).map((at, index, all) => (index === 0 ? 0 : at - all[index - 1])).slice(1);
  assert.ok(gaps[gaps.length - 1] > gaps[0], `the wait must keep growing while the queue stays empty (gaps ${gaps.join("ms, ")}ms)`);
  summary.backoff = `busy ${(busyRate * 1000).toFixed(1)}/s · idle ${(idleRate * 1000).toFixed(1)}/s · last gaps ${gaps.join("/")}ms`;

  // ============================================================
  // 6. `wake()` COLLAPSES THE BACKOFF.
  // ============================================================
  // The backoff has climbed to its ceiling by now; one signal must undo that.
  const beforeWake = passes;
  const wokeAt = Date.now();
  worker.wake();
  await sleep(90);
  const afterWake = passes - beforeWake;
  assert.ok(afterWake >= 2, `wake() must return the loop to the fast interval (got ${afterWake} passes in 90ms)`);
  // And the FIRST pass after the signal must arrive promptly — the shopper's
  // confirmation is the reason this mechanism exists at all.
  const firstAfter = stamps.find((at) => at >= wokeAt);
  assert.ok(firstAfter !== undefined && firstAfter - wokeAt < 60, `the first pass after a signal must be prompt (waited ${firstAfter - wokeAt}ms)`);
  worker.stop();
  const afterStop = passes;
  await sleep(80);
  assert.equal(passes, afterStop, "a stopped worker must not schedule another pass");
  summary.wake = `wake() produced ${passes - beforeWake} passes in 60ms after the backoff had climbed`;
}

// ============================================================
// 7. THE SIGNAL IS BEST EFFORT AND NEVER REACHES THE CALLER.
// ============================================================
// It fires from inside the transaction that enqueues. A bookkeeping nudge that
// can fail an order is worse than no nudge at all.
{
  let called = 0;
  setOutboxSignalSink(() => { called += 1; });
  signalOutboxWork();
  assert.equal(called, 1, "a registered sink receives the signal");

  setOutboxSignalSink(() => { throw new Error("channel is gone"); });
  assert.doesNotThrow(() => signalOutboxWork(), "a dead channel must never throw into the enqueueing transaction");

  setOutboxSignalSink(null);
  assert.doesNotThrow(() => signalOutboxWork(), "no sink at all — tests, CI, a worker-less run — is a no-op");

  assert.equal(isOutboxSignalMessage(OUTBOX_SIGNAL_MESSAGE), true);
  for (const other of ["", "codiq", { t: "codiq:outbox" }, null, undefined, 0]) {
    assert.equal(isOutboxSignalMessage(other), false, `«${String(other)}» is not the signal — an IPC channel is an API`);
  }
  summary.signal = "delivered, swallows a dead channel, no-ops with no sink, 6 impostors rejected";
}

console.log(JSON.stringify({ suite: "worker-scheduling", status: "passed", summary }, null, 2));

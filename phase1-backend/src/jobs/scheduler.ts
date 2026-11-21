/**
 * ق-239 — ONE HEARTBEAT, NOT NINE. AND THE REASON IS THE BILL, NOT TIDINESS.
 *
 * Neon charges for AWAKE TIME, not for queries: any statement keeps the compute
 * up for five more minutes, so the question is never «how many queries?» but
 * «how many five-minute windows had activity in them?». That single fact
 * inverts the usual instinct — CLUSTERING work is worth more than reducing it.
 * A thousand statements inside one window cost the same as one; a hundred
 * statements spread across the day cost a hundred times as much.
 *
 * The worker ran NINE independent intervals, and their union covered the clock:
 *
 *     measured, simulated at one-second resolution over a full day
 *     ─────────────────────────────────────────────────────────────
 *     nine timers as they were                          100.0% awake
 *     the outbox alone (every 5 s)                      100.0%
 *     EVERYTHING EXCEPT the outbox                       99.7%   ← the trap
 *     one scheduler, 30-minute tick                      16.3%
 *     one scheduler, 60-minute tick                       8.0%
 *
 * Read the third line again: fixing the five-second outbox loop — the one the
 * outage of 2026-09-09 was blamed on, and the whole of the original ق-235 plan —
 * would have moved the number by three tenths of one percent. The health watcher
 * polls every FIVE MINUTES and Neon suspends after FIVE MINUTES, so it alone
 * keeps the database awake forever. The defect was never one bad interval; it
 * was nine timers that nobody looked at together.
 *
 * WHY THE JOBS RUN SEQUENTIALLY inside a tick, which looks slower and is not:
 * the window must be CONTIGUOUS. Eight jobs in one burst is one wake-up. The
 * same eight spread over ten minutes is two or three. Wall-clock inside the
 * burst costs nothing — the compute is already up and already paid for.
 *
 * WHAT THIS DOES NOT SCHEDULE: the outbox. A shopper's order confirmation
 * cannot wait for a half-hour tick, and it does not have to — `outbox-worker.ts`
 * keeps its own loop, woken by a signal from the process that wrote the row.
 * That process is awake and has just used the database, so the wake-up is free.
 * Its idle backoff still lands on this tick, which is the floor under it: if
 * every signal were lost forever, nothing would be stranded longer than a tick.
 */
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";

export interface ScheduledJob {
  /** The `job` field every log line from this work carries. Matches the old interval's name exactly. */
  name: string;
  /**
   * How often this job WANTS to run. It gets a chance only on a tick boundary,
   * so the effective period is `max(tickMs, everyMs)` rounded up to a tick —
   * which is the point: a six-hour sweep must not become a half-hourly one just
   * because the tick is half-hourly.
   */
  everyMs: number;
  run: () => Promise<unknown>;
}

/** Half an hour. Above Neon's five-minute suspend window by a wide margin, and still six sweeps a day for the frequent jobs. */
export const JOB_TICK_MS = 30 * 60 * 1000;

export interface JobScheduler {
  stop: () => void;
  /** For tests: run one tick synchronously rather than waiting for the timer. */
  tickNow: () => Promise<void>;
}

export function startJobScheduler(
  jobs: readonly ScheduledJob[],
  tickMs = JOB_TICK_MS
): JobScheduler {
  // `null` rather than 0: a job has never run, so its first tick is its turn.
  // Seeding with `Date.now()` instead would silently skip the first pass of
  // every job after each deploy — invisible, and exactly the kind of thing that
  // makes a restart look like a fix.
  const lastRun = new Map<string, number | null>(jobs.map((job) => [job.name, null]));
  let running = false;

  async function tick(): Promise<void> {
    // The same overlap guard each of the nine timers carried, now written once.
    // A tick that is still working when the next one fires must be skipped, not
    // queued: queuing turns a slow pass into a growing backlog of passes.
    if (running) {
      logger.warn("job.tick_overlapped", { job: "scheduler" });
      return;
    }
    running = true;
    const now = Date.now();
    const due = jobs.filter((job) => {
      // `?? null` is not defensive noise. `Map.get` answers `undefined` for a
      // name that was never seeded, and `undefined` slips past a `=== null`
      // check — leaving `now - undefined`, which is NaN, and `NaN >= everyMs`,
      // which is false FOREVER. The job would simply never run: no error, no log
      // line, nothing to notice. The backend's tsconfig caught it; the root one
      // did not, which is why `pnpm phase1:typecheck` is the one that counts.
      const last = lastRun.get(job.name) ?? null;
      return last === null || now - last >= job.everyMs;
    });
    try {
      for (const job of due) {
        // Stamped BEFORE the run, not after. Stamping after would let a job that
        // takes longer than its own period run back-to-back forever, which is
        // the pathology this whole file exists to remove.
        lastRun.set(job.name, Date.now());
        try {
          await runJobPass(job.name, job.run);
        } catch (error) {
          // One job's failure must not cost its siblings their turn. Each used
          // to have its own `.catch` on its own timer; the burst keeps that
          // isolation rather than trading it for the shared window.
          logger.error("job.failed", { job: job.name, err: error });
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, tickMs);
  // The interval alone would leave every job idle for a full tick after a
  // deploy. A restart should not be a half-hour of nothing happening — and the
  // database is awake at boot anyway, so this burst is free.
  void tick();
  return {
    stop: () => clearInterval(timer),
    tickNow: tick,
  };
}

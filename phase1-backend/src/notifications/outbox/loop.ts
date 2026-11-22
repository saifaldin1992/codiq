/**
 * Outbox worker — loop. Split verbatim from outbox-worker.ts
 * (review batch 5, ت-١); outbox-worker.ts re-exports what it always exported.
 */
import type { NotificationProvider } from "../notification-provider.js";
import { runJobPass } from "../../logging/context.js";
import { logger } from "../../logging/logger.js";
import { type OutboxBatchResult, processOutboxBatch } from "./batch.js";

/**
 * Continuous loop for the standalone worker process; guarded against overlap.
 *
 * D-41 (phase 24-أ): every PASS runs inside its own correlation id, so a
 * notification that failed to send is traceable to the run that tried — which
 * is the only way «this message never arrived» becomes a line to read rather
 * than a guess about which of the last few hundred passes it was in.
 */
export interface OutboxWorkerOptions {
  /** While there is work to drain. */
  fastMs?: number;
  /** The ceiling the idle backoff climbs to. Pass the scheduler's tick: it is the floor under every message. */
  idleMaxMs?: number;
  /** How long one signal keeps the loop in fast mode. */
  fastWindowMs?: number;
  /**
   * The pass itself. Production never passes it — the default is exactly what
   * this worker has always done. It exists so the BACKOFF can be tested without
   * a database: the loop's decisions are pure arithmetic over a batch result,
   * and making them reachable only through Postgres would mean the one thing
   * worth pinning here is the one thing nothing pins.
   */
  runPass?: () => Promise<OutboxBatchResult>;
}

export interface OutboxWorker {
  stop: () => void;
  /** «There is work.» Resets to fast and holds it for `fastWindowMs`. Idempotent and free to call often. */
  wake: () => void;
}

const OUTBOX_FAST_MS = 1_000;

const OUTBOX_FAST_WINDOW_MS = 60_000;

/**
 * ق-239 — IT ASKS FAST WHEN THERE IS WORK, AND ALMOST NEVER WHEN THERE IS NOT.
 *
 * A fixed five-second interval is 17,280 questions a day whose answer is «no
 * rows», and — because Neon suspends only after five minutes of silence — it is
 * also a guarantee the database never sleeps. That was measured, not guessed:
 * `production` 54.3 CU-h + `staging` 56.3 = 110.6 against a 100 CU-h quota, with
 * three test merchants and no customers. The bill was 100% empty wake-ups.
 *
 * Three rules replace the one interval:
 *
 *   DRAIN FAST. A pass that did anything schedules the next in a second. A queue
 *   that is moving must not be throttled — the old five seconds was slower here
 *   than this is.
 *
 *   BACK OFF WHEN IDLE. A pass that found nothing doubles its wait, up to
 *   `idleMaxMs`. Within a few minutes of quiet the gap exceeds Neon's suspend
 *   window and the compute is allowed to sleep, which is the entire point.
 *
 *   WAKE ON A SIGNAL, NOT ON A GUESS. `wake()` is called by the process that
 *   just WROTE an outbox row — which means the database is awake at that instant
 *   because that same transaction woke it. The signal therefore costs nothing at
 *   all, and the shopper's confirmation goes out in about a second instead of
 *   waiting out a backoff.
 *
 * AND WHY `LISTEN/NOTIFY` IS NOT USED, since it is the obvious answer and it is
 * wrong here: Neon severs the listening session when the compute suspends, and a
 * NOTIFY delivered while nobody is listening is gone — notifications are not
 * durable. Re-establishing the listener is itself a query, so holding one open
 * would keep the database awake: precisely the cost being removed. On a
 * scale-to-zero database the channel has to live OUTSIDE the database.
 *
 * The poll is the floor under all of it. If every signal were lost forever,
 * nothing would be stranded longer than `idleMaxMs`.
 */
export function startOutboxWorker(
  provider: NotificationProvider | null,
  options: OutboxWorkerOptions = {}
): OutboxWorker {
  const fastMs = options.fastMs ?? OUTBOX_FAST_MS;
  const idleMaxMs = Math.max(fastMs, options.idleMaxMs ?? 30 * 60 * 1000);
  const fastWindowMs = options.fastWindowMs ?? OUTBOX_FAST_WINDOW_MS;
  const runPass = options.runPass ?? (() => processOutboxBatch(provider));

  let running = false;
  let stopped = false;
  let delayMs = fastMs;
  let fastUntil = 0;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    // `unref` so a worker with nothing to do never holds the process open on its
    // own — shutdown is decided by SIGTERM, not by a pending timer.
    timer = setTimeout(() => {
      void pass();
    }, ms);
    timer.unref?.();
  };

  async function pass(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runJobPass("outbox", runPass);
      if (result.sent > 0 || result.deadLettered > 0 || result.retried > 0) {
        logger.info("job.pass", { job: "outbox", ...result });
      }
      // `claimed`, not `sent`: a pass that claimed rows and skipped every one of
      // them (no provider, no recipient) still DID work, and the next row may be
      // sendable. Keying the reset on `sent` alone would back off in exactly the
      // situation where a queue is being worked through.
      if (result.claimed > 0) delayMs = fastMs;
      else if (Date.now() < fastUntil) delayMs = fastMs;
      else delayMs = Math.min(delayMs * 2, idleMaxMs);
    } catch (error) {
      logger.error("job.failed", { job: "outbox", err: error });
      // A failing pass backs off too. Hammering a database that just refused a
      // query is how a transient fault becomes an outage.
      delayMs = Math.min(Math.max(delayMs * 2, fastMs), idleMaxMs);
    } finally {
      running = false;
      schedule(delayMs);
    }
  }

  schedule(fastMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    wake: () => {
      if (stopped) return;
      fastUntil = Date.now() + fastWindowMs;
      delayMs = fastMs;
      // Not «run now»: the signal fires from inside the enqueueing TRANSACTION,
      // so the row may not be committed yet. A single immediate poll could miss
      // it and then back off for a full window. The fast window polls until it
      // appears, and costs nothing — that transaction has the database awake.
      if (!running) schedule(fastMs);
    },
  };
}

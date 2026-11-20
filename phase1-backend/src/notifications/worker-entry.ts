/**
 * codiq phase 15 — standalone outbox worker process (ADR-004).
 *
 * Runs as its own OS process (spawned beside the HTTP server in production or
 * via `pnpm phase15:worker`) — never a timer inside an HTTP request path.
 *
 * ق-239 — TWO CLOCKS IN THIS PROCESS, NOT NINE.
 *
 * It used to hold nine independent `setInterval`s, and their union covered the
 * day: simulated at one-second resolution, the database was awake 100% of the
 * time. The instinct was to blame the outbox loop for asking every five seconds
 * — and that instinct was wrong in a way worth writing down: with the outbox
 * removed entirely and the other eight left alone, the number is 99.7%. The
 * health watcher polls every FIVE MINUTES and Neon suspends after FIVE MINUTES,
 * so it alone never lets the database sleep.
 *
 * So the eight periodic jobs now share ONE tick, and run back to back inside it
 * (`jobs/scheduler.ts` argues why contiguous beats spread out). The outbox keeps
 * its own loop, because an order confirmation cannot wait for a tick.
 *
 * Each job keeps the period it always had; the tick only decides WHEN it gets
 * its turn. Nothing about what any of them does has changed.
 */
import { prisma } from "../db/prisma.js";
import { ABANDONED_CART_SCAN_INTERVAL_MS, scanAbandonedCarts } from "./abandoned-cart-scanner.js";
import { purgeExpiredSoftDeletes, TRASH_PURGE_INTERVAL_MS } from "../services/soft-delete/purge-job.js";
import { RETENTION_SWEEP_INTERVAL_MS, sweepOperationalRetention } from "../services/retention-job.js";
import { releaseExpiredReservations, RESERVATION_EXPIRY_INTERVAL_MS } from "../services/reservation-expiry-job.js";
import { resolveNotificationProvider } from "./notification-provider.js";
import { MERCHANT_DIGEST_SCAN_INTERVAL_MS, scanMerchantDigests } from "./merchant-digest-scanner.js";
import { expireLapsedTrials, remindEndingTrials, TRIAL_EXPIRY_SCAN_INTERVAL_MS } from "./trial-expiry-scanner.js";
import { RESTOCK_SCAN_INTERVAL_MS, scanRestocks } from "./restock-scanner.js";
import { startOutboxWorker } from "./outbox-worker.js";
import { logger } from "../logging/logger.js";
import { HEALTH_WATCH_INTERVAL_MS, runHealthWatch } from "../services/platform-health.service.js";
import { MAINTENANCE_TICK_INTERVAL_MS, tickMaintenanceWindows } from "../services/maintenance.service.js";
import { JOB_TICK_MS, startJobScheduler, type ScheduledJob } from "../jobs/scheduler.js";
import { isOutboxSignalMessage, setOutboxSignalSink } from "../jobs/outbox-signal.js";

// A garbage interval env value would make setInterval(fn, NaN) fire near
// continuously — fall back to the default instead.
function intervalFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const provider = resolveNotificationProvider();

/**
 * The eight periodic jobs, each with the period it has always had.
 *
 * They are DESCRIPTORS now rather than eight `start*` wrappers, and the wrappers
 * are gone: every one of them was the identical four lines
 * (`setInterval` → overlap guard → `runJobPass` → `.catch`), written eight
 * times. The scheduler writes them once. Nothing here calls `setInterval`, and
 * `worker-timers.guard.mjs` keeps it that way — a tenth timer added a year from
 * now would reopen the whole defect silently: nothing fails, the database
 * simply stops sleeping and the bill comes back with no visible cause.
 */
const JOBS: ScheduledJob[] = [
  // Phase 20B-2: only enqueues outbox rows; delivery stays with the loop below.
  { name: "abandoned-cart", everyMs: intervalFromEnv(process.env.CODIQ_ABANDONED_CART_SCAN_INTERVAL_MS, ABANDONED_CART_SCAN_INTERVAL_MS), run: () => scanAbandonedCarts() },
  // CD-2: enqueues only; the marketing gate in the outbox worker decides whether each message may go out.
  { name: "restock", everyMs: intervalFromEnv(process.env.CODIQ_RESTOCK_SCAN_INTERVAL_MS, RESTOCK_SCAN_INTERVAL_MS), run: () => scanRestocks() },
  // MD-3: once-per-store-per-day is enforced by the outbox unique key, not by this schedule — so a missed or repeated pass changes nothing.
  { name: "merchant-digest", everyMs: intervalFromEnv(process.env.CODIQ_MERCHANT_DIGEST_SCAN_INTERVAL_MS, MERCHANT_DIGEST_SCAN_INTERVAL_MS), run: () => scanMerchantDigests() },
  // ق-128: ends a lapsed free month by WRITING a free-plan row. Letting `ends_at`
  // merely pass would leave the merchant with no active subscription at all —
  // a dead dashboard and a dead checkout rather than a downgrade.
  { name: "trial-expiry", everyMs: intervalFromEnv(process.env.CODIQ_TRIAL_EXPIRY_SCAN_INTERVAL_MS, TRIAL_EXPIRY_SCAN_INTERVAL_MS), run: async () => ({ reminded: await remindEndingTrials(), expired: await expireLapsedTrials() }) },
  // ق-250: maintenance windows start and end on the CLOCK at read time; this job only
  // stamps the ones that ended and mails «it is over». A missed pass changes nothing.
  { name: "maintenance-windows", everyMs: intervalFromEnv(process.env.CODIQ_MAINTENANCE_TICK_INTERVAL_MS, MAINTENANCE_TICK_INTERVAL_MS), run: () => tickMaintenanceWindows() },
  // D-46: releases reservations older than 72 h whose order is still `new`, so an
  // abandoned COD order stops hiding stock from the storefront and the till.
  { name: "reservation-expiry", everyMs: intervalFromEnv(process.env.CODIQ_RESERVATION_EXPIRY_INTERVAL_MS, RESERVATION_EXPIRY_INTERVAL_MS), run: () => releaseExpiredReservations() },
  // ق-188: the only one that watches the others rather than doing work of its own.
  // It cannot see THIS process dying; that needs a prober outside it (ق-235's
  // hourly Sentry monitor on /api/ready), and this is not a substitute for it.
  { name: "health-watch", everyMs: intervalFromEnv(process.env.CODIQ_HEALTH_WATCH_INTERVAL_MS, HEALTH_WATCH_INTERVAL_MS), run: () => runHealthWatch(provider) },
  // PG-2: each expired row is hard-deleted in its own transaction and a
  // foreign-key refusal is a recorded outcome, not a crash.
  { name: "trash-purger", everyMs: intervalFromEnv(process.env.CODIQ_TRASH_PURGE_INTERVAL_MS, TRASH_PURGE_INTERVAL_MS), run: () => purgeExpiredSoftDeletes() },
  // D-39: OPERATIONAL rows only — rate limits, dead sessions, settled
  // notifications, abandoned guest carts, spent idempotency keys. The audit and
  // ledger tables are never swept; `services/retention.ts` says why, at length.
  { name: "retention", everyMs: intervalFromEnv(process.env.CODIQ_RETENTION_SWEEP_INTERVAL_MS, RETENTION_SWEEP_INTERVAL_MS), run: () => sweepOperationalRetention() },
];

const tickMs = intervalFromEnv(process.env.CODIQ_JOB_TICK_MS, JOB_TICK_MS);
const scheduler = startJobScheduler(JOBS, tickMs);
logger.info("worker.started", { job: "scheduler", tickMs, jobs: JOBS.map((job) => job.name) });

logger.info("worker.started", { job: "outbox", provider: provider?.name ?? null });
/**
 * The idle ceiling is the SCHEDULER'S TICK, not a number of its own. That makes
 * the tick a single floor under everything this process does: whatever else
 * fails — every signal lost, the API never speaking — nothing waits longer than
 * one tick. `CODIQ_NOTIFICATIONS_INTERVAL_MS` still overrides it, and now means
 * what its name always implied: how long the worker may stay quiet.
 */
const worker = startOutboxWorker(provider, { idleMaxMs: intervalFromEnv(process.env.CODIQ_NOTIFICATIONS_INTERVAL_MS, tickMs) });

// TWO WAYS A ROW ARRIVES, AND BOTH WAKE THE SAME LOOP.
//
//   from the API   — a checkout, a status change: an IPC message from the parent
//   from HERE      — the scanners above enqueue too, and they must not have to
//                    round-trip through the parent to tell a loop in their own
//                    process that they just wrote a row
setOutboxSignalSink(() => worker.wake());
process.on("message", (message) => { if (isOutboxSignalMessage(message)) worker.wake(); });

async function shutdown(signal: string) {
  logger.info("worker.stopping", { signal });
  setOutboxSignalSink(null);
  scheduler.stop();
  worker.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * ق-239 — «THERE IS WORK», SAID OUTSIDE THE DATABASE.
 *
 * The outbox worker backs off to a long idle poll so Neon is allowed to sleep,
 * which leaves one question: how does it learn that a row arrived without being
 * told to ask constantly?
 *
 * NOT THROUGH POSTGRES. `LISTEN/NOTIFY` is the textbook answer and it does not
 * work on a database that suspends: Neon severs the listening session when the
 * compute scales to zero, a NOTIFY delivered with nobody listening is gone
 * (notifications are not durable), and re-opening the listener is itself a query
 * — so holding one would keep the compute awake, which is the exact cost being
 * removed. On scale-to-zero the channel must live outside the database.
 *
 * SO: THE PROCESS THAT WROTE THE ROW SAYS SO, DIRECTLY. The worker is a child of
 * the API server (`server/index.ts`), so a single IPC message crosses between
 * them — no network, no broker, no database. And the timing is what makes it
 * free: whoever enqueues has just run a transaction, so the compute is awake at
 * that instant anyway. The signal adds nothing to the bill and removes the wait.
 *
 * A SINK, NOT AN IMPORT, because this module is loaded in BOTH processes and
 * they mean different things by «tell the worker»:
 *
 *   API process     → send an IPC message to the child
 *   worker process  → wake its own loop, no message at all (the scanners enqueue)
 *   tests / CI      → nobody registers a sink; every call is a no-op
 *
 * And it is the seam for later: when the worker becomes its own Railway service
 * (gap 3), only the sink changes — an internal HTTP call over Railway's private
 * network, which carries no egress cost. One line, not a rewrite.
 *
 * BEST EFFORT, ALWAYS. A lost signal costs LATENCY and nothing else: the idle
 * poll is the floor, and nothing is ever stranded longer than one tick. So this
 * must never throw into the transaction that called it — a bookkeeping nudge
 * that can fail an order is worse than no nudge at all.
 */
import { logger } from "../logging/logger.js";

export type OutboxSignalSink = () => void;

let sink: OutboxSignalSink | null = null;

/** Registered once per process at startup. `null` unregisters — used on shutdown. */
export function setOutboxSignalSink(next: OutboxSignalSink | null): void {
  sink = next;
}

export function signalOutboxWork(): void {
  if (!sink) return;
  try {
    sink();
  } catch (error) {
    // Logged at debug rather than error on purpose: this is a latency
    // optimisation failing, not the platform. Raising it to error would teach
    // whoever reads the log that something is broken when nothing is.
    logger.debug("outbox.signal_failed", { job: "outbox", err: error });
  }
}

/** The message the API child-process channel carries. Narrow on purpose — an IPC channel is an API. */
export const OUTBOX_SIGNAL_MESSAGE = "codiq:outbox";

export function isOutboxSignalMessage(message: unknown): boolean {
  return message === OUTBOX_SIGNAL_MESSAGE;
}

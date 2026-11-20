/**
 * D-41 (phase 24-أ) — the correlation id, and how it travels.
 *
 * WHY AsyncLocalStorage and not a parameter. The id has to appear on a log line
 * written five calls deep inside a service that has no idea an HTTP request
 * exists. Threading it through every signature would touch essentially every
 * file in `src/services` — a diff nobody can review, in files another phase is
 * editing right now — and it would still miss the one place that matters most:
 * the `catch` in a job loop. ALS carries it through promises and timers without
 * a single signature change, and a service that never asks for it is unchanged.
 *
 * The store is a mutable bag on purpose. `setLogContext` lets a layer that
 * LEARNS something — the session verifier learning who the actor is, a money
 * path learning which settlement it is writing — record it once, so that an
 * error thrown afterwards is logged WITH it. That is the whole difference
 * between «a request failed» and «this merchant's settlement failed».
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface LogContext {
  /** 16 hex characters. See `newCorrelationId`. */
  requestId: string;
  /** `Date.now()` at the edge; the error line's `durationMs` is measured from it. */
  startedAt: number;
  /** Set for a background pass instead of a request: `outbox`, `retention`, … */
  job?: string;
  /** Everything else a layer chose to record — actor, store, order, settlement. */
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Sixteen lowercase hex characters, not a UUID.
 *
 * A merchant in Baghdad reporting «صار خطأ» has to read this back over
 * WhatsApp or type it into a support form. Sixty-four bits is far past
 * collision risk at this platform's volume — and the line carries a timestamp,
 * so the search is always «this id, that hour» — while thirty-six characters of
 * UUID with four dashes is a string people transcribe wrongly. Hex has no
 * case to get wrong and no character pair that looks alike in a WhatsApp font.
 */
export function newCorrelationId(): string {
  return randomBytes(8).toString("hex");
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

/** The id of the request or job pass in flight, or `null` outside both. */
export function currentCorrelationId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/**
 * Adds to the context of the request or job pass in flight. A no-op outside
 * one — a service must never have to ask whether it is inside a request, and
 * must never fail because it is not.
 */
export function setLogContext(patch: Record<string, unknown>): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    store[key] = value;
  }
}

export function runWithLogContext<T>(seed: LogContext, run: () => T): T {
  return storage.run(seed, run);
}

/**
 * A background pass gets its own correlation id, exactly as a request does.
 *
 * Requirement 5 of D-41: the outbox worker, the retention and reservation
 * sweeps and the trash purge all run outside any request, and a failed send
 * that cannot be tied to a run is a report with no thread to pull. One id per
 * PASS, not per process: two passes of the same job must be distinguishable,
 * because the interesting question is always «which run».
 */
export function runJobPass<T>(job: string, run: () => Promise<T>): Promise<T> {
  return storage.run({ requestId: newCorrelationId(), startedAt: Date.now(), job }, run);
}

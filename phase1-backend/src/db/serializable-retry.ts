import { Prisma } from "@prisma/client";

/**
 * The ONE definition of "this transaction lost a race, run it again".
 *
 * Four call sites had grown their own copy of this loop — two in the till, two
 * in the storefront — each with the same two flaws:
 *
 * 1. **A budget of three attempts, spent instantly.** `continue` retries in the
 *    same microtask, so two writers racing over one row collide, both retry at
 *    once, collide again, and burn the whole budget inside a millisecond. CI
 *    proved it on 2026-09-04: a POS ticket exhausted three attempts and the
 *    cashier's sale answered 500. A loaded CI runner is not a laboratory — it
 *    is the same load profile as a busy shop, which is exactly when a till must
 *    not fail (ق-132: «الرفض عند الصندوق هو الشيء الوحيد الممنوع»).
 *
 * 2. **P2028 was never retried anywhere** (the open half of debt D-47). A
 *    transaction that exceeds Prisma's timeout is as retryable as one that lost
 *    a write conflict; treating it as fatal turned a slow moment into a refused
 *    sale.
 *
 * Backoff is jittered on purpose. Fixed backoff makes two colliding writers
 * wake at the same instant and collide again — the retry becomes a metronome
 * keeping them in lockstep. Random spread is what actually breaks the tie.
 *
 * What is NOT retried: every business refusal. A 409, a 422, a permission
 * denial and a sold-out variant are answers, not accidents — retrying them
 * would turn a clear refusal into a slow one.
 */
export const SERIALIZABLE_ATTEMPTS = 6;

/** Milliseconds before attempt N (0-based): ~5, 10, 20, 40, 80 plus jitter. */
function backoffMs(attempt: number): number {
  const base = 5 * Math.pow(2, attempt);
  return base + Math.random() * base;
}

/**
 * P2002 unique violation (two writers minted the same key), P2034 write
 * conflict / deadlock, P2028 transaction timeout, and P2010 raw-query failure
 * carrying Postgres 40001 (serialization_failure) — the four shapes a lost race
 * takes through Prisma.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (["P2002", "P2034", "P2028"].includes(error.code)) return true;
  return error.code === "P2010" && (error as { meta?: { code?: string } }).meta?.code === "40001";
}

/**
 * Waits out the jittered backoff for the attempt that just failed. Exported for
 * the loops that own a `finally` of their own and so cannot be wrapped whole.
 */
export function sleepBeforeRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
}

/**
 * Runs `work` under the caller's own transaction, retrying only a lost race.
 * The caller keeps ownership of the transaction itself (isolation level,
 * timeouts, what happens in the `finally`) — this owns only the decision to go
 * around again, and the wait before doing so.
 */
export async function withSerializableRetry<T>(work: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      if (attempt >= SERIALIZABLE_ATTEMPTS - 1 || !isRetryableTransactionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    }
  }
}

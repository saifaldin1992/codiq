/**
 * codiq phase 15 — outbox worker (ADR-004).
 * Claims due rows with an atomic, token-stamped update so two workers can never
 * send the same row twice, delivers through the provider abstraction, and applies
 * exponential backoff with a dead-letter terminal state. The worker is
 * deterministic and database-driven; tests call processOutboxBatch directly.
 */
/**
 * Outbox worker — split by job into ./outbox/*.ts (review batch 5, ت-١).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export { renderMessage } from "./outbox/render.js";
export {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BASE_RETRY_SECONDS,
  STALE_CLAIM_RECOVERY_MS,
  retryDelaySeconds,
  processOutboxBatch,
} from "./outbox/batch.js";
export type { OutboxBatchResult } from "./outbox/batch.js";
export { startOutboxWorker } from "./outbox/loop.js";
export type { OutboxWorkerOptions, OutboxWorker } from "./outbox/loop.js";

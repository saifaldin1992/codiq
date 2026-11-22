/**
 * codiq phase 17 — append-only financial ledger, reports, and settlements (ADR-006).
 * A completed order writes one ledger entry inside the SAME transaction as the
 * status transition, snapshotting the plan and commission at that moment. A return
 * within the approved window writes the reversal entry automatically; outside the
 * window only an owner-authored manual adjustment can reverse it. The database
 * refuses UPDATE/DELETE on ledger entries and settlements outright.
 */
/**
 * Finance — split by job into ./finance/*.ts (review batch 2, ت-١٠).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  RETURN_REVERSAL_WINDOW_DAYS,
  recordOrderCompletion,
  recordOrderReturn,
  createManualReturnAdjustment,
} from "./finance/ledger.js";
export type { ReturnReversalOutcome } from "./finance/ledger.js";
export {
  merchantFinanceReport,
  merchantSettlements,
  platformFinanceReport,
} from "./finance/reports.js";
export { previewSettlement, createSettlement } from "./finance/settlements.js";

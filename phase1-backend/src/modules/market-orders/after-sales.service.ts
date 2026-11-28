/**
 * Marketplace M6 — what the shopper can do once an order is placed: cancel it
 * with a reason, hand over the receipt code, rate it, ask to return it.
 *
 * Nothing here moves an order by itself. Cancelling goes through PG-1's
 * `cancelOwnOrder`, a return through CD-3's `requestReturn`, product stars
 * through `upsertProductReview`, and the store's code check through
 * `transitionOrderStatus` — each the one path that keeps stock, money and
 * notifications consistent. This file only finds the order from the SHOPPER's
 * side (any store he bought from) and records what the market adds: the reason
 * code, the hand-over code, the order rating.
 */
/**
 * After-sales — split by job into ./after-sales/*.ts (review batch 6, ت-٤).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  RATING_WINDOW_DAYS,
  HANDOVER_MAX_FAILURES,
  cancelMarketOrder,
  requestMarketReturn,
  withdrawMarketReturn,
  rateMarketOrder,
  pendingRatings,
  myRatings,
} from "./after-sales/shopper.js";
export { ensureHandoverCode, afterSalesState, afterSalesOptions } from "./after-sales/state.js";
export { storeOrderMarketView, setDeliveryStage, confirmHandover } from "./after-sales/store.js";

/**
 * The market cart: one basket across every store, shown grouped by store.
 *
 * It is a LIST, never a second checkout. Prices are snapshotted when a line is
 * added (and when its quantity rises, or its options change), exactly as the
 * store cart does, so checkout can refuse a price that moved instead of
 * charging a number the shopper never saw. Stock, the per-order cap and the
 * add-ons are checked here for a fast, honest answer, and checked AGAIN under
 * lock by the store's checkout — which is the only place that decides.
 */
/**
 * The market cart — split by job into ./cart/*.ts (review batch 2, ت-١٥).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export { MAX_LINE_QUANTITY } from "./cart/rules.js";
export { addCartLine, updateCartLine, removeCartLine, clearCart } from "./cart/lines.js";
export { marketCartView, repriceMarketLines, acceptCartPrices } from "./cart/view.js";

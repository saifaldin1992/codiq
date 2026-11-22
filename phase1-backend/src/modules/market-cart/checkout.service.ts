/**
 * Paying for one store's lines of the market cart.
 *
 * THE WHOLE TRICK: the store's lines are moved into the shopper's own customer
 * cart AT THAT STORE, and the store's existing `checkout()` runs unchanged —
 * the same serializable transaction, variant locks, stock reservations, coupon
 * lock order, loyalty, commission, ledger, notification and domain event as a
 * purchase made on the storefront. The market adds no money logic of its own.
 *
 * The shopper becomes a customer of the store on his first order there: a
 * customers row with shopper_id set (or, if the store already knew his phone,
 * that existing row is linked — his phone is proven by the one-time code).
 */
/**
 * Market checkout — split by job into ./checkout/*.ts (review batch 2, ت-١٢).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export { customerForShopper } from "./checkout/customer.js";
export { goodsToCover, checkoutSummary } from "./checkout/summary.js";
export { placeMarketOrder } from "./checkout/place.js";
export { shopperOrders, shopperOrder } from "./checkout/orders.js";

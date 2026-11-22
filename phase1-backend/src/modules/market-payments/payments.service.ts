/**
 * Marketplace M13a — paying a market order online.
 *
 * CARD. The order is placed first («بانتظار الدفع»: its stock is held and the
 * store cannot accept it yet), a session is opened with the gateway, and the
 * shopper pays on the gateway's page. Only the gateway's SIGNED notification
 * marks it paid — never the shopper's browser coming back. Not paid within
 * 30 minutes: the order is cancelled and its stock returns.
 *
 * INSTALMENTS. The shopper picks a lender and a term on the checkout page; the
 * lender checks his account and capacity and sends him a code; the code
 * approves the plan and only then is the order placed. The plan covers the
 * goods; the delivery fee is paid in cash at the door.
 *
 * AFTERWARDS. Cancelled or rejected: a paid card is refunded, a plan cancelled.
 * Returned: the card is refunded, the plan brought to 0 (G8). Every step is a
 * row in market_payment_events.
 */
/**
 * Market payments — split by job into ./payments/*.ts (review batch 2, ت-٨).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export { sweepSoon, onlineOptions } from "./payments/options.js";
export {
  CARD_WINDOW_MS,
  openCardSession,
  handleCardNotification,
  expireStalePayments,
} from "./payments/card.js";
export {
  startInstalmentPlan,
  confirmInstalmentPlan,
  attachInstalmentPlan,
  abandonInstalmentPlan,
} from "./payments/instalments.js";
export { onOrderStatusChanged } from "./payments/after-order.js";
export { shopperPayment, paymentsForOwner, instalmentTeaser } from "./payments/screens.js";

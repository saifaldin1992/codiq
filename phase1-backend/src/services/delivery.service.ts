/**
 * ق-246 — التوصيل ونقدُ الاستلام.
 *
 * THE MARKET FACT THIS SERVES. CODIQ is cash-on-delivery by construction: the
 * parcel goes to a courier company, the courier collects the cash from the
 * shopper, and pays the merchant back later — days later, in a lump, across
 * many orders. Until this module the platform knew every order and nothing
 * about what happens to it after it leaves the shelf: not who took it, not its
 * waybill number, not when it left, not whether its cash ever came back. The
 * merchant reconciled with the courier out of a paper notebook.
 *
 * Three things, and only three:
 *
 *   · HANDOVER — who took the parcel, its tracking number, and when. Recorded
 *     at the «قيد التوصيل» transition (the moment it actually happens) or
 *     corrected afterwards.
 *   · THE MANIFEST — the day's handed-over parcels as a CSV the courier's own
 *     system ingests, one row per parcel with the cash to collect.
 *   · RECONCILIATION — per courier, per window: what the courier collected
 *     (delivered orders), what the merchant has marked as received, and the
 *     difference. Marking is the merchant's act; the number he checks it
 *     against is the platform's.
 *
 * WHAT THIS IS NOT. It is not D-04 («تسوية نقد COD الآلية مع الناقلين») —
 * automated settlement through courier APIs is phase 25أ and an owner
 * decision. This is the manual precursor that makes that later phase a
 * replacement of the data source, not a redesign: the columns and the screen
 * are the ones an integration would fill.
 *
 * The expected cash for a delivered order is `totalIqd` — what the shopper
 * paid the courier. Courier fees, delivery-fee splits and shortfalls are the
 * merchant's arrangement with the courier and are deliberately NOT modelled in
 * v1: a wrong number the platform asserts is worse than a number the merchant
 * reconciles himself against the total he can see.
 */
/**
 * Delivery and cash on delivery — split by job into ./delivery/*.ts (review batch 4, ت-٥).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  COURIER_NAME_MAX_LENGTH,
  TRACKING_NUMBER_MAX_LENGTH,
  DELIVERY_WINDOW_MAX_DAYS,
  COURIER_SUGGESTION_DAYS,
  parseDeliveryFields,
  deliverySelect,
} from "./delivery/fields.js";
export type { DeliveryActor } from "./delivery/fields.js";
export { updateOrderDelivery, listCourierNames } from "./delivery/handover.js";
export { MANIFEST_CSV_COLUMNS, courierManifestCsv } from "./delivery/manifest.js";
export { codReconciliation, markCodCollected } from "./delivery/reconciliation.js";
export type { CourierReconciliationRow } from "./delivery/reconciliation.js";

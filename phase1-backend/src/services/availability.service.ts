/**
 * المرحلة 29 (ق-249) — the platform's control layer: what exists (services and
 * their capabilities), whether it is available RIGHT NOW and for WHOM
 * (defaults, overrides per platform/merchant/store, the store's own status,
 * the merchant's suspension, external dependencies, rollout flags), and why.
 *
 * Availability is not authorization. RBAC answers «who», the entitlement
 * resolver answers «on which plan», and this module answers «is it on, here,
 * now». Every answer carries its SOURCE so the merchant's screen can say «معطّلة
 * من المنصّة» rather than a bare «غير متاحة», and the owner's audit can say who
 * turned it off.
 *
 * Precedence — the higher restriction always wins (01 §13, 02 §6):
 *
 *   merchant suspended        → MERCHANT_DISABLED
 *   store suspended / closed  → STORE_DISABLED
 *   store in maintenance      → MAINTENANCE
 *   platform override         → its state
 *   merchant override         → its state
 *   store override            → its state
 *   service default state     → COMING_SOON / DISABLED / DEPRECATED / RETIRED
 *   capability default state  → same
 *   dependency unavailable    → DEPENDENCY_UNAVAILABLE
 *   rollout flag off          → COMING_SOON
 *   otherwise                 → AVAILABLE
 *
 * A capability-specific override beats a service-wide one at the same scope
 * (more specific wins); an override to AVAILABLE at a higher scope re-enables
 * what a default disables — that is what an override is for.
 */
/**
 * Availability — split by job into ./availability/*.ts (review batch 4, ت-٨).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  SERVICE_STATES,
  AVAILABILITY_STATES,
  OVERRIDE_STATES,
  STORE_STATUSES,
  MERCHANT_STORE_STATUSES,
  STORE_STATUS_MESSAGE_MAX_LENGTH,
  AVAILABILITY_SOURCES,
  CUSTOMER_MESSAGES,
  STATE_LABELS_AR,
  customerMessageFor,
  effectiveState,
} from "./availability/states.js";
export type {
  ServiceState,
  AvailabilityState,
  OverrideState,
  StoreStatus,
  AvailabilitySource,
  AvailabilityFacts,
  EffectiveAvailability,
} from "./availability/states.js";
export {
  EXTERNAL_DEPENDENCY_CHECKS,
  resetExternalDependencyCache,
  listServiceCatalogue,
  updateServiceState,
  updateCapabilityState,
} from "./availability/catalogue.js";
export {
  resolveAvailability,
  assertCapabilityAvailable,
  merchantServicesView,
} from "./availability/resolve.js";
export type { AvailabilityAnswer } from "./availability/resolve.js";
export {
  setAvailabilityOverride,
  revokeAvailabilityOverride,
  listAvailabilityOverrides,
} from "./availability/overrides.js";
export type { OverrideInput } from "./availability/overrides.js";
export {
  effectiveStoreState,
  storeStatus,
  setStoreStatusByMerchant,
  setStoreStatusByPlatform,
  publicStoreAvailability,
  merchantAvailabilityNotices,
} from "./availability/store-status.js";
export type {
  StoreStatusView,
  EffectiveStoreState,
  PublicStoreAvailability,
} from "./availability/store-status.js";

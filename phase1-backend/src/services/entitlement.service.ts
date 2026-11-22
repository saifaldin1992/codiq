/**
 * codiq phase 16 — plan entitlement resolver (ADR-005).
 * One server-side service answers every gated write: usage is computed live from
 * the database against the merchant's ACTIVE subscription, and exceeding a limit
 * returns 403 PLAN_LIMIT_EXCEEDED with a clear Arabic message. The client never
 * supplies plan, merchant, or usage context.
 */
/**
 * Plans and entitlements — split by job into ./entitlement/*.ts (review batch 4, ت-٢).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  PLAN_FEATURE_CODES,
  QUOTA_EXEMPT_STATUSES,
  activePlanForMerchant,
} from "./entitlement/plans.js";
export type { PlanFeatureCode, PlanSummary } from "./entitlement/plans.js";
export { merchantUsage, assertWithinPlanLimit } from "./entitlement/usage.js";
export {
  DEFAULT_PLAN_CODE,
  TRIAL_PLAN_CODE,
  TRIAL_DAYS,
  subscribeMerchantToDefaultPlan,
  subscriptionSummary,
  merchantEntitlementsView,
} from "./entitlement/subscribe.js";
export {
  listPlans,
  updatePlan,
  PLAN_CODE_PATTERN,
  createPlan,
  setPlanArchived,
} from "./entitlement/catalog.js";
export {
  listMerchantsWithPlans,
  assignMerchantSubscription,
  createUpgradeRequest,
  listUpgradeRequests,
  decideUpgradeRequest,
} from "./entitlement/merchants.js";

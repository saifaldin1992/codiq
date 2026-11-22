/**
 * Availability — states. Split verbatim from availability.service.ts
 * (review batch 4, ت-٨); availability.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

export type DbClient = Prisma.TransactionClient | typeof prisma;

export const SERVICE_STATES = [
  "available",
  "coming_soon",
  "disabled",
  "deprecated",
  "retired",
] as const;

export type ServiceState = (typeof SERVICE_STATES)[number];

export const AVAILABILITY_STATES = [
  "AVAILABLE",
  "COMING_SOON",
  "DISABLED",
  "MAINTENANCE",
  "SCHEDULED_MAINTENANCE",
  "TEMPORARILY_UNAVAILABLE",
  "PLAN_RESTRICTED",
  "ENTITLEMENT_RESTRICTED",
  "MERCHANT_DISABLED",
  "STORE_DISABLED",
  "DEPENDENCY_UNAVAILABLE",
  "DEPRECATED",
  "RETIRED",
] as const;

export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** The states an owner may SET by hand; the rest are derived facts, never typed. */
export const OVERRIDE_STATES = [
  "AVAILABLE",
  "COMING_SOON",
  "DISABLED",
  "MAINTENANCE",
  "TEMPORARILY_UNAVAILABLE",
  "DEPRECATED",
  "RETIRED",
] as const;

export type OverrideState = (typeof OVERRIDE_STATES)[number];

export const STORE_STATUSES = ["active", "paused", "maintenance", "suspended", "closed"] as const;

export type StoreStatus = (typeof STORE_STATUSES)[number];

/** What a merchant may set on his own store; `suspended` is the platform's alone. */
export const MERCHANT_STORE_STATUSES = ["active", "paused", "maintenance", "closed"] as const;

export const STORE_STATUS_MESSAGE_MAX_LENGTH = 500;

export const AVAILABILITY_SOURCES = [
  "merchant",
  "store",
  "platform_override",
  "maintenance_window",
  "incident",
  "merchant_override",
  "store_override",
  "service",
  "capability",
  "dependency",
  "flag",
  "none",
] as const;

export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

/** The customer-facing sentences — approved verbatim by the owner (01 §13). */
export const CUSTOMER_MESSAGES = {
  COMING_SOON: { ar: "الخدمة ستتاح قريبًا.", en: "This service is coming soon." },
  MAINTENANCE: { ar: "الخدمة تحت الصيانة.", en: "This service is under maintenance." },
  STORE_MAINTENANCE: {
    ar: "المتجر مغلق للصيانة.",
    en: "Store temporarily closed for maintenance.",
  },
  UNAVAILABLE: { ar: "هذه الخدمة غير متاحة حالياً.", en: "This service is currently unavailable." },
} as const;

/** What the merchant reads next to a state — one word he can act on. */
export const STATE_LABELS_AR: Record<AvailabilityState, string> = {
  AVAILABLE: "متاحة",
  COMING_SOON: "قريباً",
  DISABLED: "معطّلة",
  MAINTENANCE: "تحت الصيانة",
  SCHEDULED_MAINTENANCE: "صيانة مجدولة",
  TEMPORARILY_UNAVAILABLE: "متوقّفة مؤقّتاً",
  PLAN_RESTRICTED: "غير مشمولة بخطّتك",
  ENTITLEMENT_RESTRICTED: "خارج استحقاقك",
  MERCHANT_DISABLED: "الحساب موقوف",
  STORE_DISABLED: "المتجر موقوف",
  DEPENDENCY_UNAVAILABLE: "تعتمد على خدمةٍ غير متاحة",
  DEPRECATED: "ستُوقف قريباً",
  RETIRED: "أُوقفت",
};

function serviceStateToAvailability(state: ServiceState): AvailabilityState | null {
  switch (state) {
    case "coming_soon":
      return "COMING_SOON";
    case "disabled":
      return "DISABLED";
    case "deprecated":
      return "DEPRECATED";
    case "retired":
      return "RETIRED";
    default:
      return null;
  }
}

export function customerMessageFor(state: AvailabilityState): string {
  if (state === "COMING_SOON") return CUSTOMER_MESSAGES.COMING_SOON.ar;
  if (state === "MAINTENANCE" || state === "SCHEDULED_MAINTENANCE")
    return CUSTOMER_MESSAGES.MAINTENANCE.ar;
  return CUSTOMER_MESSAGES.UNAVAILABLE.ar;
}

// ─────────────────────────────────────────────────────────── the pure resolver
export interface AvailabilityFacts {
  merchantActive: boolean;
  /** Null when resolving at merchant level (no store in context). */
  storeStatus: StoreStatus | null;
  platformOverride: OverrideState | null;
  merchantOverride: OverrideState | null;
  storeOverride: OverrideState | null;
  serviceState: ServiceState;
  capabilityState: ServiceState;
  dependencyUnavailable: boolean;
  /** Null when no flag governs the capability; false when rollout says «not yet» here. */
  flag: boolean | null;
  /** ق-250: a live maintenance window covers this capability — platform, service, capability, merchant or store scope. */
  maintenanceWindow?: boolean;
  /** ق-250: an open incident that BLOCKS touches this capability. */
  incidentBlocking?: boolean;
}

export interface EffectiveAvailability {
  state: AvailabilityState;
  source: AvailabilitySource;
}

/**
 * Pure, so the precedence matrix is a unit test rather than a database fixture.
 * Every branch names its source; the order IS the specification above.
 */
export function effectiveState(facts: AvailabilityFacts): EffectiveAvailability {
  if (!facts.merchantActive) return { state: "MERCHANT_DISABLED", source: "merchant" };
  if (facts.storeStatus === "suspended" || facts.storeStatus === "closed")
    return { state: "STORE_DISABLED", source: "store" };
  if (facts.storeStatus === "maintenance") return { state: "MAINTENANCE", source: "store" };
  if (facts.platformOverride) return { state: facts.platformOverride, source: "platform_override" };
  // ق-250: the clock and the incident desk speak after the owner's explicit override and before any merchant-level word.
  if (facts.maintenanceWindow) return { state: "MAINTENANCE", source: "maintenance_window" };
  if (facts.incidentBlocking) return { state: "TEMPORARILY_UNAVAILABLE", source: "incident" };
  if (facts.merchantOverride) return { state: facts.merchantOverride, source: "merchant_override" };
  if (facts.storeOverride) return { state: facts.storeOverride, source: "store_override" };
  const fromService = serviceStateToAvailability(facts.serviceState);
  if (fromService) return { state: fromService, source: "service" };
  const fromCapability = serviceStateToAvailability(facts.capabilityState);
  if (fromCapability) return { state: fromCapability, source: "capability" };
  if (facts.dependencyUnavailable) return { state: "DEPENDENCY_UNAVAILABLE", source: "dependency" };
  if (facts.flag === false) return { state: "COMING_SOON", source: "flag" };
  return { state: "AVAILABLE", source: "none" };
}

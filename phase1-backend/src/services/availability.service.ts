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
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { prisma } from "../db/prisma.js";
import { flagDecisionFor } from "./feature-flags.service.js";
import { loadOpenIncidents, pickIncidentFor, type OpenIncident } from "./incidents.service.js";
import { liveStoreWindow, loadLiveWindows, maintenanceNoticesFor, pickWindowFor, type LiveWindow } from "./maintenance.service.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export const SERVICE_STATES = ["available", "coming_soon", "disabled", "deprecated", "retired"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export const AVAILABILITY_STATES = [
  "AVAILABLE", "COMING_SOON", "DISABLED", "MAINTENANCE", "SCHEDULED_MAINTENANCE", "TEMPORARILY_UNAVAILABLE",
  "PLAN_RESTRICTED", "ENTITLEMENT_RESTRICTED", "MERCHANT_DISABLED", "STORE_DISABLED", "DEPENDENCY_UNAVAILABLE",
  "DEPRECATED", "RETIRED",
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** The states an owner may SET by hand; the rest are derived facts, never typed. */
export const OVERRIDE_STATES = ["AVAILABLE", "COMING_SOON", "DISABLED", "MAINTENANCE", "TEMPORARILY_UNAVAILABLE", "DEPRECATED", "RETIRED"] as const;
export type OverrideState = (typeof OVERRIDE_STATES)[number];

export const STORE_STATUSES = ["active", "paused", "maintenance", "suspended", "closed"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];
/** What a merchant may set on his own store; `suspended` is the platform's alone. */
export const MERCHANT_STORE_STATUSES = ["active", "paused", "maintenance", "closed"] as const;
export const STORE_STATUS_MESSAGE_MAX_LENGTH = 500;

export const AVAILABILITY_SOURCES = ["merchant", "store", "platform_override", "maintenance_window", "incident", "merchant_override", "store_override", "service", "capability", "dependency", "flag", "none"] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

/** The customer-facing sentences — approved verbatim by the owner (01 §13). */
export const CUSTOMER_MESSAGES = {
  COMING_SOON: { ar: "الخدمة ستتاح قريبًا.", en: "This service is coming soon." },
  MAINTENANCE: { ar: "الخدمة تحت الصيانة.", en: "This service is under maintenance." },
  STORE_MAINTENANCE: { ar: "المتجر مغلق للصيانة.", en: "Store temporarily closed for maintenance." },
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
    case "coming_soon": return "COMING_SOON";
    case "disabled": return "DISABLED";
    case "deprecated": return "DEPRECATED";
    case "retired": return "RETIRED";
    default: return null;
  }
}

export function customerMessageFor(state: AvailabilityState): string {
  if (state === "COMING_SOON") return CUSTOMER_MESSAGES.COMING_SOON.ar;
  if (state === "MAINTENANCE" || state === "SCHEDULED_MAINTENANCE") return CUSTOMER_MESSAGES.MAINTENANCE.ar;
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
  if (facts.storeStatus === "suspended" || facts.storeStatus === "closed") return { state: "STORE_DISABLED", source: "store" };
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

// ─────────────────────────────────────────────────────────── external dependencies
/**
 * `service_dependencies.kind = 'external'` names something the SERVER knows
 * how to check. A key nobody registered here is a dependency that cannot be
 * verified, and an unverifiable dependency counts as unavailable — the guard
 * fails loud rather than reporting a green nobody measured.
 */
export const EXTERNAL_DEPENDENCY_CHECKS: Record<string, () => Promise<boolean>> = {
  mail_provider: async () => {
    const { resolveNotificationProvider } = await import("../notifications/notification-provider.js");
    try { return (await resolveNotificationProvider()) !== null; } catch { return false; }
  },
};

const externalDependencyCache = new Map<string, { value: boolean; until: number }>();
async function externalDependencyAvailable(target: string): Promise<boolean> {
  const cached = externalDependencyCache.get(target);
  if (cached && cached.until > Date.now()) return cached.value;
  const check = EXTERNAL_DEPENDENCY_CHECKS[target];
  const value = check ? await check() : false;
  externalDependencyCache.set(target, { value, until: Date.now() + 30_000 });
  return value;
}
/** Tests flip a provider and must see the answer change at once. */
export function resetExternalDependencyCache() { externalDependencyCache.clear(); }

// ─────────────────────────────────────────────────────────── the catalogue
const capabilitySelect = { id: true, code: true, name: true, description: true, state: true, sortOrder: true, serviceId: true } satisfies Prisma.CapabilitySelect;
const serviceSelect = {
  id: true, code: true, name: true, description: true, state: true, sortOrder: true,
  capabilities: { select: capabilitySelect, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] },
  dependencies: { select: { kind: true, target: true, note: true } },
} satisfies Prisma.ServiceSelect;

export async function listServiceCatalogue(client: DbClient = prisma) {
  const services = await client.service.findMany({ select: serviceSelect, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
  return services.map((service) => ({
    code: service.code, name: service.name, description: service.description, state: service.state as ServiceState,
    dependencies: service.dependencies,
    capabilities: service.capabilities.map((capability) => ({ code: capability.code, name: capability.name, description: capability.description, state: capability.state as ServiceState })),
  }));
}

function assertServiceState(value: unknown): ServiceState {
  if (typeof value !== "string" || !(SERVICE_STATES as readonly string[]).includes(value)) {
    throw new HttpError(422, "INVALID_SERVICE_STATE", `حالة الخدمة يجب أن تكون إحدى: ${SERVICE_STATES.join("، ")}.`);
  }
  return value as ServiceState;
}

export async function updateServiceState(actor: PlatformActor, code: string, input: { state?: unknown; name?: unknown; description?: unknown }) {
  const data: { state?: ServiceState; name?: string; description?: string } = {};
  if (input.state !== undefined) data.state = assertServiceState(input.state);
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) throw new HttpError(422, "INVALID_SERVICE_NAME", "اسم الخدمة بين حرفٍ و80 حرفاً.");
    data.name = input.name.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > 300) throw new HttpError(422, "INVALID_SERVICE_DESCRIPTION", "وصف الخدمة حتى 300 حرف.");
    data.description = input.description.trim();
  }
  return prisma.$transaction(async (tx) => {
    const before = await tx.service.findUnique({ where: { code }, select: { id: true, name: true, state: true } });
    if (!before) throw new HttpError(404, "SERVICE_NOT_FOUND", "الخدمة المطلوبة غير موجودة.");
    const service = await tx.service.update({ where: { id: before.id }, data, select: serviceSelect });
    await recordPlatformAuditEvent(tx, {
      entityType: "service", entityId: service.id, entityLabel: service.name, action: "service_state_changed", actor,
      metadata: { code, before: { state: before.state, name: before.name }, after: { state: service.state, name: service.name } },
    });
    return service;
  });
}

export async function updateCapabilityState(actor: PlatformActor, code: string, input: { state?: unknown }) {
  const state = assertServiceState(input.state);
  return prisma.$transaction(async (tx) => {
    const before = await tx.capability.findUnique({ where: { code }, select: { id: true, name: true, state: true } });
    if (!before) throw new HttpError(404, "CAPABILITY_NOT_FOUND", "القدرة المطلوبة غير موجودة.");
    const capability = await tx.capability.update({ where: { id: before.id }, data: { state }, select: capabilitySelect });
    await recordPlatformAuditEvent(tx, {
      entityType: "capability", entityId: capability.id, entityLabel: capability.name, action: "capability_state_changed", actor,
      metadata: { code, before: before.state, after: state },
    });
    return capability;
  });
}

// ─────────────────────────────────────────────────────────── resolving one capability
interface LiveOverride { scope: string; state: string; capabilityId: string | null; serviceId: string | null }

function pickOverride(rows: LiveOverride[], scope: string, capabilityId: string, serviceId: string): OverrideState | null {
  const inScope = rows.filter((row) => row.scope === scope);
  const specific = inScope.find((row) => row.capabilityId === capabilityId);
  if (specific) return specific.state as OverrideState;
  const wide = inScope.find((row) => row.serviceId === serviceId);
  return wide ? (wide.state as OverrideState) : null;
}

export interface AvailabilityAnswer extends EffectiveAvailability {
  capability: string;
  service: string;
  message: string;
  /** ق-250: an open incident that touches the capability WITHOUT blocking it — said, not enforced. */
  notice?: { kind: "incident"; title: string; message: string; severity: string };
}

/**
 * The one question every gated route asks. Reads the catalogue row, the live
 * overrides that could touch it, the merchant's and store's own state, and the
 * flag — then hands the facts to the pure resolver.
 */
export async function resolveAvailability(capabilityCode: string, tenant: { merchantId: string; storeId?: string | null }, client: DbClient = prisma, preloaded: { windows?: LiveWindow[]; incidents?: OpenIncident[] } = {}): Promise<AvailabilityAnswer> {
  const capability = await client.capability.findUnique({ where: { code: capabilityCode }, select: { id: true, code: true, state: true, service: { select: { id: true, code: true, state: true, dependencies: { select: { kind: true, target: true } } } } } });
  if (!capability) throw new HttpError(500, "CAPABILITY_UNKNOWN", `القدرة ${capabilityCode} ليست في الكتالوج.`);
  const now = new Date();
  const [merchant, store, overrides] = await Promise.all([
    client.merchant.findUnique({ where: { id: tenant.merchantId }, select: { isActive: true, approvalStatus: true } }),
    tenant.storeId ? client.store.findUnique({ where: { id: tenant.storeId }, select: { id: true, status: true, statusMessage: true, maintenanceUntil: true } }) : Promise.resolve(null),
    client.availabilityOverride.findMany({
      where: {
        revokedAt: null,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
        OR: [
          { scope: "platform" },
          { scope: "merchant", merchantId: tenant.merchantId },
          ...(tenant.storeId ? [{ scope: "store", storeId: tenant.storeId }] : []),
        ],
      },
      select: { scope: true, state: true, capabilityId: true, serviceId: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const relevant = overrides.filter((row) => row.capabilityId === capability.id || row.serviceId === capability.service.id);
  // ق-250: one read of the live windows and open incidents per request; the merchant view preloads them once for all 23.
  const windows = preloaded.windows ?? await loadLiveWindows(tenant, now, client);
  const incidents = preloaded.incidents ?? await loadOpenIncidents(client);
  const subject = { serviceId: capability.service.id, serviceCode: capability.service.code, capabilityId: capability.id, capabilityCode: capability.code };
  const window = pickWindowFor(windows, subject);
  const incident = pickIncidentFor(incidents, subject);
  const storeState = store ? await effectiveStoreState(store, now, client) : null;
  let dependencyUnavailable = false;
  for (const dependency of capability.service.dependencies) {
    if (dependency.kind === "external") { if (!(await externalDependencyAvailable(dependency.target))) { dependencyUnavailable = true; break; } }
    else {
      const upstream = await client.service.findUnique({ where: { code: dependency.target }, select: { state: true } });
      if (!upstream || upstream.state === "disabled" || upstream.state === "retired") { dependencyUnavailable = true; break; }
    }
  }
  const flag = await flagDecisionFor(capabilityCode, { merchantId: tenant.merchantId, storeId: tenant.storeId ?? null }, client);
  const facts: AvailabilityFacts = {
    merchantActive: Boolean(merchant?.isActive) && merchant?.approvalStatus === "approved",
    storeStatus: storeState ? storeState.status : null,
    platformOverride: pickOverride(relevant, "platform", capability.id, capability.service.id),
    merchantOverride: pickOverride(relevant, "merchant", capability.id, capability.service.id),
    storeOverride: pickOverride(relevant, "store", capability.id, capability.service.id),
    serviceState: capability.service.state as ServiceState,
    capabilityState: capability.state as ServiceState,
    dependencyUnavailable,
    flag,
    maintenanceWindow: window !== null,
    incidentBlocking: incident?.blocks === true,
  };
  const effective = effectiveState(facts);
  // The sentence the shopper reads: the window's own, the incident's own, the merchant's own — else the approved default.
  const message = effective.source === "maintenance_window" && window ? window.messageAr
    : effective.source === "incident" && incident ? incident.publicMessage
    : effective.source === "store" && effective.state === "MAINTENANCE" && storeState?.message ? storeState.message
    : customerMessageFor(effective.state);
  return {
    ...effective, capability: capability.code, service: capability.service.code, message,
    ...(incident && !incident.blocks ? { notice: { kind: "incident" as const, title: incident.title, message: incident.publicMessage, severity: incident.severity } } : {}),
  };
}

/**
 * The gate a route calls right after its permission guard. 423 rather than 403:
 * the caller IS allowed; the thing is switched off, here, now — and the body
 * says by whom so the screen can say it too.
 */
export async function assertCapabilityAvailable(capabilityCode: string, tenant: { merchantId: string; id?: string; storeId?: string | null }): Promise<void> {
  const answer = await resolveAvailability(capabilityCode, { merchantId: tenant.merchantId, storeId: tenant.storeId ?? tenant.id ?? null });
  if (answer.state === "AVAILABLE") return;
  throw new HttpError(423, "CAPABILITY_UNAVAILABLE", answer.message, { capability: answer.capability, service: answer.service, state: answer.state, source: answer.source });
}

/** The merchant's screen: every service and capability with its effective state and why. */
export async function merchantServicesView(merchantId: string, storeId: string) {
  const catalogue = await listServiceCatalogue();
  const [windows, incidents] = await Promise.all([loadLiveWindows({ merchantId, storeId }), loadOpenIncidents()]);
  const services = [];
  for (const service of catalogue) {
    const capabilities = [];
    for (const capability of service.capabilities) {
      const answer = await resolveAvailability(capability.code, { merchantId, storeId }, prisma, { windows, incidents });
      capabilities.push({ code: capability.code, name: capability.name, description: capability.description, state: answer.state, label: STATE_LABELS_AR[answer.state], source: answer.source });
    }
    const worst = capabilities.find((c) => c.state !== "AVAILABLE");
    services.push({ code: service.code, name: service.name, description: service.description, state: capabilities.every((c) => c.state === "AVAILABLE") ? "AVAILABLE" : worst ? worst.state : "AVAILABLE", capabilities });
  }
  return services;
}

// ─────────────────────────────────────────────────────────── overrides
export interface OverrideInput {
  scope?: unknown; merchantId?: string | null; storeId?: string | null;
  serviceCode?: unknown; capabilityCode?: unknown; state?: unknown; reason?: unknown; startsAt?: unknown; endsAt?: unknown;
}

function parseInstant(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "INVALID_OVERRIDE_WINDOW", `${field} يجب أن يكون تاريخاً بصيغة ISO-8601.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new HttpError(422, "INVALID_OVERRIDE_WINDOW", `${field} يجب أن يكون تاريخاً بصيغة ISO-8601.`);
  return parsed;
}

export async function setAvailabilityOverride(actor: PlatformActor, input: OverrideInput) {
  if (input.scope !== "platform" && input.scope !== "merchant" && input.scope !== "store") throw new HttpError(422, "INVALID_OVERRIDE_SCOPE", "النطاق: platform أو merchant أو store.");
  if (input.scope === "merchant" && !input.merchantId) throw new HttpError(422, "OVERRIDE_TARGET_REQUIRED", "تجاوزُ تاجرٍ يحتاج التاجر.");
  if (input.scope === "store" && !input.storeId) throw new HttpError(422, "OVERRIDE_TARGET_REQUIRED", "تجاوزُ متجرٍ يحتاج المتجر.");
  if (typeof input.state !== "string" || !(OVERRIDE_STATES as readonly string[]).includes(input.state)) throw new HttpError(422, "INVALID_OVERRIDE_STATE", `الحالة يجب أن تكون إحدى: ${OVERRIDE_STATES.join("، ")}.`);
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 300) throw new HttpError(422, "INVALID_OVERRIDE_REASON", "السبب بين 3 و300 حرفاً — سيقرؤه من يرفع التجاوز بعد شهور.");
  const hasService = typeof input.serviceCode === "string" && input.serviceCode.length > 0;
  const hasCapability = typeof input.capabilityCode === "string" && input.capabilityCode.length > 0;
  if (hasService === hasCapability) throw new HttpError(422, "INVALID_OVERRIDE_SUBJECT", "التجاوز على خدمةٍ أو على قدرةٍ — واحدة منهما.");
  const startsAt = parseInstant(input.startsAt, "startsAt");
  const endsAt = parseInstant(input.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt) throw new HttpError(422, "INVALID_OVERRIDE_WINDOW", "نهاية التجاوز بعد بدايته.");
  const state = input.state as OverrideState;
  const reason = input.reason.trim();
  return prisma.$transaction(async (tx) => {
    const service = hasService ? await tx.service.findUnique({ where: { code: input.serviceCode as string }, select: { id: true, name: true } }) : null;
    const capability = hasCapability ? await tx.capability.findUnique({ where: { code: input.capabilityCode as string }, select: { id: true, name: true } }) : null;
    if (hasService && !service) throw new HttpError(404, "SERVICE_NOT_FOUND", "الخدمة المطلوبة غير موجودة.");
    if (hasCapability && !capability) throw new HttpError(404, "CAPABILITY_NOT_FOUND", "القدرة المطلوبة غير موجودة.");
    const scope = input.scope as "platform" | "merchant" | "store";
    const merchantId = scope === "merchant" ? input.merchantId! : null;
    const storeId = scope === "store" ? input.storeId! : null;
    // One live override per (scope, target, subject): the newer replaces the older by revoking it.
    await tx.availabilityOverride.updateMany({
      where: { scope, merchantId, storeId, serviceId: service?.id ?? null, capabilityId: capability?.id ?? null, revokedAt: null },
      data: { revokedAt: new Date(), revokedByKind: actor.kind, revokedById: actor.id },
    });
    const row = await tx.availabilityOverride.create({
      data: { scope, merchantId, storeId, serviceId: service?.id ?? null, capabilityId: capability?.id ?? null, state, reason, startsAt, endsAt, createdByKind: actor.kind, createdById: actor.id },
      select: overrideSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "availability_override", entityId: row.id, entityLabel: `${service?.name ?? capability?.name} — ${state}`, action: "availability_override_set", actor,
      metadata: { scope, merchantId, storeId, serviceCode: hasService ? String(input.serviceCode) : null, capabilityCode: hasCapability ? String(input.capabilityCode) : null, state, reason, startsAt: startsAt?.toISOString() ?? null, endsAt: endsAt?.toISOString() ?? null },
    });
    return overrideView(row);
  });
}

export async function revokeAvailabilityOverride(actor: PlatformActor, id: string) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.availabilityOverride.findUnique({ where: { id }, select: overrideSelect });
    if (!row) throw new HttpError(404, "OVERRIDE_NOT_FOUND", "التجاوز المطلوب غير موجود.");
    if (row.revokedAt) return overrideView(row);
    const revoked = await tx.availabilityOverride.update({ where: { id }, data: { revokedAt: new Date(), revokedByKind: actor.kind, revokedById: actor.id }, select: overrideSelect });
    await recordPlatformAuditEvent(tx, {
      entityType: "availability_override", entityId: id, entityLabel: `${row.service?.name ?? row.capability?.name} — ${row.state}`, action: "availability_override_revoked", actor,
      metadata: { scope: row.scope, state: row.state },
    });
    return overrideView(revoked);
  });
}

const overrideSelect = {
  id: true, scope: true, state: true, reason: true, startsAt: true, endsAt: true, createdAt: true, createdByKind: true, revokedAt: true,
  merchant: { select: { id: true, email: true, businessName: true } },
  store: { select: { id: true, slug: true, name: true } },
  service: { select: { code: true, name: true } },
  capability: { select: { code: true, name: true } },
} as const;

function overrideView(row: Prisma.AvailabilityOverrideGetPayload<{ select: typeof overrideSelect }>) {
  return {
    id: row.id, scope: row.scope, state: row.state, reason: row.reason,
    startsAt: row.startsAt?.toISOString() ?? null, endsAt: row.endsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), createdByKind: row.createdByKind, revokedAt: row.revokedAt?.toISOString() ?? null,
    merchant: row.merchant ? { id: row.merchant.id, email: row.merchant.email, businessName: row.merchant.businessName } : null,
    store: row.store ? { id: row.store.id, slug: row.store.slug, name: row.store.name } : null,
    subject: row.capability ? { kind: "capability" as const, code: row.capability.code, name: row.capability.name } : { kind: "service" as const, code: row.service!.code, name: row.service!.name },
  };
}

export async function listAvailabilityOverrides(rawLimit?: unknown, rawCursor?: unknown, rawLive?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor("availability_overrides", rawCursor);
  const liveOnly = rawLive === undefined || rawLive === "" || rawLive === "true" || rawLive === "1";
  const rows = await prisma.availabilityOverride.findMany({
    where: { ...(liveOnly ? { revokedAt: null } : {}), ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: overrideSelect,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor("availability_overrides", last.createdAt, last.id));
  return { overrides: page.map(overrideView), nextCursor };
}

// ─────────────────────────────────────────────────────────── store status
export interface StoreStatusView { status: StoreStatus; message: string | null; maintenanceUntil: string | null; source?: EffectiveStoreState["source"] }

/**
 * ق-250: the store's status as the CLOCK sees it. Three things can differ from the column:
 *   - `maintenance` whose «until» has passed → active (the merchant said until, and until came);
 *   - `active` / `paused` with a live store-scope window → maintenance, with the window's sentence and end;
 *   - anything else → the column, verbatim. Nothing here writes; the column is tidied by nobody and needs no tidying.
 */
export interface EffectiveStoreState { status: StoreStatus; message: string | null; until: Date | null; source: "status" | "clock" | "window" }
export async function effectiveStoreState(store: { id: string; status: string; statusMessage: string | null; maintenanceUntil: Date | null }, now: Date = new Date(), client: DbClient = prisma): Promise<EffectiveStoreState> {
  const status = store.status as StoreStatus;
  if (status === "maintenance" && store.maintenanceUntil && store.maintenanceUntil.valueOf() <= now.valueOf()) return { status: "active", message: null, until: null, source: "clock" };
  if (status === "active" || status === "paused") {
    const window = await liveStoreWindow(store.id, now, client);
    if (window) return { status: "maintenance", message: window.messageAr, until: window.endsAt, source: "window" };
  }
  return { status, message: store.statusMessage, until: store.maintenanceUntil, source: "status" };
}

export async function storeStatus(storeId: string, client: DbClient = prisma): Promise<StoreStatusView> {
  const store = await client.store.findUnique({ where: { id: storeId }, select: { id: true, status: true, statusMessage: true, maintenanceUntil: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر المطلوب غير موجود.");
  const effective = await effectiveStoreState(store, new Date(), client);
  return { status: effective.status, message: effective.message, maintenanceUntil: effective.until?.toISOString() ?? null, source: effective.source };
}

/**
 * The merchant's own switch: active / paused (browsing open, checkout closed —
 * the MD-1 vacation) / maintenance (closed to shoppers, the dashboard stays) /
 * closed. `suspended` is the platform's word and is refused here; a store the
 * platform suspended cannot be talked out of it from this door either.
 */
export async function setStoreStatusByMerchant(storeId: string, input: { status?: unknown; message?: unknown; maintenanceUntil?: unknown }): Promise<StoreStatusView> {
  if (typeof input.status !== "string" || !(MERCHANT_STORE_STATUSES as readonly string[]).includes(input.status)) {
    throw new HttpError(422, "INVALID_STORE_STATUS", `حالة المتجر يجب أن تكون إحدى: ${MERCHANT_STORE_STATUSES.join("، ")}.`);
  }
  const status = input.status as StoreStatus;
  const message = parseStatusMessage(input.message);
  const until = parseInstant(input.maintenanceUntil, "maintenanceUntil");
  if (until && status !== "maintenance") throw new HttpError(422, "INVALID_STORE_STATUS", "موعد انتهاء الصيانة يُرسل مع حالة الصيانة فقط.");
  if (until && until <= new Date()) throw new HttpError(422, "INVALID_STORE_STATUS", "موعد انتهاء الصيانة في المستقبل.");
  return prisma.$transaction(async (tx) => {
    const current = await tx.store.findUnique({ where: { id: storeId }, select: { status: true } });
    if (!current) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر المطلوب غير موجود.");
    if (current.status === "suspended") throw new HttpError(409, "STORE_SUSPENDED", "المتجر موقوف من المنصّة — تواصل مع الدعم.");
    const data: Prisma.StoreUpdateInput = { status, maintenanceUntil: status === "maintenance" ? until : null };
    if (message !== undefined) { data.statusMessage = message; data.vacationMessage = message; }
    const store = await tx.store.update({ where: { id: storeId }, data, select: { status: true, statusMessage: true, maintenanceUntil: true } });
    return { status: store.status as StoreStatus, message: store.statusMessage, maintenanceUntil: store.maintenanceUntil?.toISOString() ?? null };
  });
}

/** The platform's switch: suspend a single store, or lift the suspension back to `active`. */
export async function setStoreStatusByPlatform(actor: PlatformActor, storeId: string, input: { status?: unknown; message?: unknown }): Promise<StoreStatusView> {
  if (input.status !== "suspended" && input.status !== "active") throw new HttpError(422, "INVALID_STORE_STATUS", "المنصّة توقف المتجر (suspended) أو تعيده (active).");
  const status = input.status as StoreStatus;
  const message = parseStatusMessage(input.message);
  return prisma.$transaction(async (tx) => {
    const before = await tx.store.findUnique({ where: { id: storeId }, select: { status: true, name: true, slug: true } });
    if (!before) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر المطلوب غير موجود.");
    const store = await tx.store.update({ where: { id: storeId }, data: { status, maintenanceUntil: null, ...(message !== undefined ? { statusMessage: message } : {}) }, select: { status: true, statusMessage: true, maintenanceUntil: true } });
    await recordPlatformAuditEvent(tx, { entityType: "store", entityId: storeId, entityLabel: `${before.name} (${before.slug})`, action: "store_status_changed", actor, metadata: { before: before.status, after: store.status, message: message ?? null } });
    return { status: store.status as StoreStatus, message: store.statusMessage, maintenanceUntil: store.maintenanceUntil?.toISOString() ?? null };
  });
}

function parseStatusMessage(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > STORE_STATUS_MESSAGE_MAX_LENGTH) throw new HttpError(422, "INVALID_STORE_STATUS", `رسالة الحالة حتى ${STORE_STATUS_MESSAGE_MAX_LENGTH} حرف.`);
  return value.trim() || null;
}

/** What the shopper's shell reads — always present, so the client never guesses. */
export interface PublicStoreAvailability { status: StoreStatus; message?: string; until?: string }

export function publicStoreAvailability(store: { status: string; statusMessage: string | null; maintenanceUntil: Date | null }): PublicStoreAvailability {
  const status = store.status as StoreStatus;
  if (status === "maintenance") return { status, message: store.statusMessage?.trim() || CUSTOMER_MESSAGES.STORE_MAINTENANCE.ar, ...(store.maintenanceUntil ? { until: store.maintenanceUntil.toISOString() } : {}) };
  if (status === "paused") return { status, message: store.statusMessage?.trim() || "المتجر في إجازة مؤقتة — يمكنك التصفّح، وسنستأنف استقبال الطلبات قريباً." };
  return { status };
}

/** ق-250: what the merchant's dashboard shows above everything — running and upcoming maintenance, and open incidents. */
export async function merchantAvailabilityNotices(merchantId: string, storeId: string) {
  const now = new Date();
  const [maintenance, incidents] = await Promise.all([maintenanceNoticesFor({ merchantId, storeId }, now), loadOpenIncidents()]);
  return {
    maintenance: maintenance.map((window) => ({ id: window.id, phase: window.phase, scope: window.scope, subject: window.subject, startsAt: window.startsAt, endsAt: window.endsAt, startsAtLocal: window.startsAtLocal, endsAtLocal: window.endsAtLocal, messageAr: window.messageAr, affects: window.affects })),
    incidents: incidents.map((incident) => ({ id: incident.id, status: incident.status, severity: incident.severity, title: incident.title, publicMessage: incident.publicMessage, affects: incident.affects, blocks: incident.blocks })),
  };
}

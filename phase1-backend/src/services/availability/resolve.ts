/**
 * Availability — resolve. Split verbatim from availability.service.ts
 * (review batch 4, ت-٨); availability.service.ts re-exports what it always exported.
 */
import { prisma } from "../../db/prisma.js";
import { type LiveWindow, loadLiveWindows, pickWindowFor } from "../maintenance.service.js";
import { type OpenIncident, loadOpenIncidents, pickIncidentFor } from "../incidents.service.js";
import { HttpError } from "../../auth/auth.errors.js";
import { flagDecisionFor } from "../feature-flags.service.js";
import {
  type OverrideState,
  type EffectiveAvailability,
  type DbClient,
  type AvailabilityFacts,
  type ServiceState,
  effectiveState,
  customerMessageFor,
  STATE_LABELS_AR,
} from "./states.js";
import { effectiveStoreState } from "./store-status.js";
import { externalDependencyAvailable, listServiceCatalogue } from "./catalogue.js";

// ─────────────────────────────────────────────────────────── resolving one capability
interface LiveOverride {
  scope: string;
  state: string;
  capabilityId: string | null;
  serviceId: string | null;
}

function pickOverride(
  rows: LiveOverride[],
  scope: string,
  capabilityId: string,
  serviceId: string
): OverrideState | null {
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
export async function resolveAvailability(
  capabilityCode: string,
  tenant: { merchantId: string; storeId?: string | null },
  client: DbClient = prisma,
  preloaded: { windows?: LiveWindow[]; incidents?: OpenIncident[] } = {}
): Promise<AvailabilityAnswer> {
  const capability = await client.capability.findUnique({
    where: { code: capabilityCode },
    select: {
      id: true,
      code: true,
      state: true,
      service: {
        select: {
          id: true,
          code: true,
          state: true,
          dependencies: { select: { kind: true, target: true } },
        },
      },
    },
  });
  if (!capability)
    throw new HttpError(500, "CAPABILITY_UNKNOWN", `القدرة ${capabilityCode} ليست في الكتالوج.`);
  const now = new Date();
  const [merchant, store, overrides] = await Promise.all([
    client.merchant.findUnique({
      where: { id: tenant.merchantId },
      select: { isActive: true, approvalStatus: true },
    }),
    tenant.storeId
      ? client.store.findUnique({
          where: { id: tenant.storeId },
          select: { id: true, status: true, statusMessage: true, maintenanceUntil: true },
        })
      : Promise.resolve(null),
    client.availabilityOverride.findMany({
      where: {
        revokedAt: null,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
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
  const relevant = overrides.filter(
    (row) => row.capabilityId === capability.id || row.serviceId === capability.service.id
  );
  // ق-250: one read of the live windows and open incidents per request; the merchant view preloads them once for all 23.
  const windows = preloaded.windows ?? (await loadLiveWindows(tenant, now, client));
  const incidents = preloaded.incidents ?? (await loadOpenIncidents(client));
  const subject = {
    serviceId: capability.service.id,
    serviceCode: capability.service.code,
    capabilityId: capability.id,
    capabilityCode: capability.code,
  };
  const window = pickWindowFor(windows, subject);
  const incident = pickIncidentFor(incidents, subject);
  const storeState = store ? await effectiveStoreState(store, now, client) : null;
  let dependencyUnavailable = false;
  for (const dependency of capability.service.dependencies) {
    if (dependency.kind === "external") {
      if (!(await externalDependencyAvailable(dependency.target))) {
        dependencyUnavailable = true;
        break;
      }
    } else {
      const upstream = await client.service.findUnique({
        where: { code: dependency.target },
        select: { state: true },
      });
      if (!upstream || upstream.state === "disabled" || upstream.state === "retired") {
        dependencyUnavailable = true;
        break;
      }
    }
  }
  const flag = await flagDecisionFor(
    capabilityCode,
    { merchantId: tenant.merchantId, storeId: tenant.storeId ?? null },
    client
  );
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
  const message =
    effective.source === "maintenance_window" && window
      ? window.messageAr
      : effective.source === "incident" && incident
        ? incident.publicMessage
        : effective.source === "store" && effective.state === "MAINTENANCE" && storeState?.message
          ? storeState.message
          : customerMessageFor(effective.state);
  return {
    ...effective,
    capability: capability.code,
    service: capability.service.code,
    message,
    ...(incident && !incident.blocks
      ? {
          notice: {
            kind: "incident" as const,
            title: incident.title,
            message: incident.publicMessage,
            severity: incident.severity,
          },
        }
      : {}),
  };
}

/**
 * The gate a route calls right after its permission guard. 423 rather than 403:
 * the caller IS allowed; the thing is switched off, here, now — and the body
 * says by whom so the screen can say it too.
 */
export async function assertCapabilityAvailable(
  capabilityCode: string,
  tenant: { merchantId: string; id?: string; storeId?: string | null }
): Promise<void> {
  const answer = await resolveAvailability(capabilityCode, {
    merchantId: tenant.merchantId,
    storeId: tenant.storeId ?? tenant.id ?? null,
  });
  if (answer.state === "AVAILABLE") return;
  throw new HttpError(423, "CAPABILITY_UNAVAILABLE", answer.message, {
    capability: answer.capability,
    service: answer.service,
    state: answer.state,
    source: answer.source,
  });
}

/** The merchant's screen: every service and capability with its effective state and why. */
export async function merchantServicesView(merchantId: string, storeId: string) {
  const catalogue = await listServiceCatalogue();
  const [windows, incidents] = await Promise.all([
    loadLiveWindows({ merchantId, storeId }),
    loadOpenIncidents(),
  ]);
  const services = [];
  for (const service of catalogue) {
    const capabilities = [];
    for (const capability of service.capabilities) {
      const answer = await resolveAvailability(capability.code, { merchantId, storeId }, prisma, {
        windows,
        incidents,
      });
      capabilities.push({
        code: capability.code,
        name: capability.name,
        description: capability.description,
        state: answer.state,
        label: STATE_LABELS_AR[answer.state],
        source: answer.source,
      });
    }
    const worst = capabilities.find((c) => c.state !== "AVAILABLE");
    services.push({
      code: service.code,
      name: service.name,
      description: service.description,
      state: capabilities.every((c) => c.state === "AVAILABLE")
        ? "AVAILABLE"
        : worst
          ? worst.state
          : "AVAILABLE",
      capabilities,
    });
  }
  return services;
}

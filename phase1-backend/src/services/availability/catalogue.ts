/**
 * Availability — catalogue. Split verbatim from availability.service.ts
 * (review batch 4, ت-٨); availability.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "../platform-audit.service.js";
import { type DbClient, type ServiceState, SERVICE_STATES } from "./states.js";

// ─────────────────────────────────────────────────────────── external dependencies
/**
 * `service_dependencies.kind = 'external'` names something the SERVER knows
 * how to check. A key nobody registered here is a dependency that cannot be
 * verified, and an unverifiable dependency counts as unavailable — the guard
 * fails loud rather than reporting a green nobody measured.
 */
export const EXTERNAL_DEPENDENCY_CHECKS: Record<string, () => Promise<boolean>> = {
  mail_provider: async () => {
    const { resolveNotificationProvider } = await import(
      "../../notifications/notification-provider.js"
    );
    try {
      return (await resolveNotificationProvider()) !== null;
    } catch {
      return false;
    }
  },
};

const externalDependencyCache = new Map<string, { value: boolean; until: number }>();

export async function externalDependencyAvailable(target: string): Promise<boolean> {
  const cached = externalDependencyCache.get(target);
  if (cached && cached.until > Date.now()) return cached.value;
  const check = EXTERNAL_DEPENDENCY_CHECKS[target];
  const value = check ? await check() : false;
  externalDependencyCache.set(target, { value, until: Date.now() + 30_000 });
  return value;
}

/** Tests flip a provider and must see the answer change at once. */
export function resetExternalDependencyCache() {
  externalDependencyCache.clear();
}

// ─────────────────────────────────────────────────────────── the catalogue
const capabilitySelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  state: true,
  sortOrder: true,
  serviceId: true,
} satisfies Prisma.CapabilitySelect;

const serviceSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  state: true,
  sortOrder: true,
  capabilities: { select: capabilitySelect, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] },
  dependencies: { select: { kind: true, target: true, note: true } },
} satisfies Prisma.ServiceSelect;

export async function listServiceCatalogue(client: DbClient = prisma) {
  const services = await client.service.findMany({
    select: serviceSelect,
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
  return services.map((service) => ({
    code: service.code,
    name: service.name,
    description: service.description,
    state: service.state as ServiceState,
    dependencies: service.dependencies,
    capabilities: service.capabilities.map((capability) => ({
      code: capability.code,
      name: capability.name,
      description: capability.description,
      state: capability.state as ServiceState,
    })),
  }));
}

function assertServiceState(value: unknown): ServiceState {
  if (typeof value !== "string" || !(SERVICE_STATES as readonly string[]).includes(value)) {
    throw new HttpError(
      422,
      "INVALID_SERVICE_STATE",
      `حالة الخدمة يجب أن تكون إحدى: ${SERVICE_STATES.join("، ")}.`
    );
  }
  return value as ServiceState;
}

export async function updateServiceState(
  actor: PlatformActor,
  code: string,
  input: { state?: unknown; name?: unknown; description?: unknown }
) {
  const data: { state?: ServiceState; name?: string; description?: string } = {};
  if (input.state !== undefined) data.state = assertServiceState(input.state);
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80)
      throw new HttpError(422, "INVALID_SERVICE_NAME", "اسم الخدمة بين حرفٍ و80 حرفاً.");
    data.name = input.name.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > 300)
      throw new HttpError(422, "INVALID_SERVICE_DESCRIPTION", "وصف الخدمة حتى 300 حرف.");
    data.description = input.description.trim();
  }
  return prisma.$transaction(async (tx) => {
    const before = await tx.service.findUnique({
      where: { code },
      select: { id: true, name: true, state: true },
    });
    if (!before) throw new HttpError(404, "SERVICE_NOT_FOUND", "الخدمة المطلوبة غير موجودة.");
    const service = await tx.service.update({
      where: { id: before.id },
      data,
      select: serviceSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "service",
      entityId: service.id,
      entityLabel: service.name,
      action: "service_state_changed",
      actor,
      metadata: {
        code,
        before: { state: before.state, name: before.name },
        after: { state: service.state, name: service.name },
      },
    });
    return service;
  });
}

export async function updateCapabilityState(
  actor: PlatformActor,
  code: string,
  input: { state?: unknown }
) {
  const state = assertServiceState(input.state);
  return prisma.$transaction(async (tx) => {
    const before = await tx.capability.findUnique({
      where: { code },
      select: { id: true, name: true, state: true },
    });
    if (!before) throw new HttpError(404, "CAPABILITY_NOT_FOUND", "القدرة المطلوبة غير موجودة.");
    const capability = await tx.capability.update({
      where: { id: before.id },
      data: { state },
      select: capabilitySelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "capability",
      entityId: capability.id,
      entityLabel: capability.name,
      action: "capability_state_changed",
      actor,
      metadata: { code, before: before.state, after: state },
    });
    return capability;
  });
}

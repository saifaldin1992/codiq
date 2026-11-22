/**
 * Availability — overrides. Split verbatim from availability.service.ts
 * (review batch 4, ت-٨); availability.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../../auth/auth.errors.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";
import { prisma } from "../../db/prisma.js";
import { recordPlatformAuditEvent } from "../platform-audit.service.js";
import {
  parseListLimit,
  readListCursor,
  keysetWhere,
  pageOf,
  encodeListCursor,
} from "../list-page.js";
import { OVERRIDE_STATES, type OverrideState } from "./states.js";

// ─────────────────────────────────────────────────────────── overrides
export interface OverrideInput {
  scope?: unknown;
  merchantId?: string | null;
  storeId?: string | null;
  serviceCode?: unknown;
  capabilityCode?: unknown;
  state?: unknown;
  reason?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
}

export function parseInstant(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string")
    throw new HttpError(
      422,
      "INVALID_OVERRIDE_WINDOW",
      `${field} يجب أن يكون تاريخاً بصيغة ISO-8601.`
    );
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()))
    throw new HttpError(
      422,
      "INVALID_OVERRIDE_WINDOW",
      `${field} يجب أن يكون تاريخاً بصيغة ISO-8601.`
    );
  return parsed;
}

export async function setAvailabilityOverride(actor: PlatformActor, input: OverrideInput) {
  if (input.scope !== "platform" && input.scope !== "merchant" && input.scope !== "store")
    throw new HttpError(422, "INVALID_OVERRIDE_SCOPE", "النطاق: platform أو merchant أو store.");
  if (input.scope === "merchant" && !input.merchantId)
    throw new HttpError(422, "OVERRIDE_TARGET_REQUIRED", "تجاوزُ تاجرٍ يحتاج التاجر.");
  if (input.scope === "store" && !input.storeId)
    throw new HttpError(422, "OVERRIDE_TARGET_REQUIRED", "تجاوزُ متجرٍ يحتاج المتجر.");
  if (
    typeof input.state !== "string" ||
    !(OVERRIDE_STATES as readonly string[]).includes(input.state)
  )
    throw new HttpError(
      422,
      "INVALID_OVERRIDE_STATE",
      `الحالة يجب أن تكون إحدى: ${OVERRIDE_STATES.join("، ")}.`
    );
  if (
    typeof input.reason !== "string" ||
    input.reason.trim().length < 3 ||
    input.reason.trim().length > 300
  )
    throw new HttpError(
      422,
      "INVALID_OVERRIDE_REASON",
      "السبب بين 3 و300 حرفاً — سيقرؤه من يرفع التجاوز بعد شهور."
    );
  const hasService = typeof input.serviceCode === "string" && input.serviceCode.length > 0;
  const hasCapability = typeof input.capabilityCode === "string" && input.capabilityCode.length > 0;
  if (hasService === hasCapability)
    throw new HttpError(
      422,
      "INVALID_OVERRIDE_SUBJECT",
      "التجاوز على خدمةٍ أو على قدرةٍ — واحدة منهما."
    );
  const startsAt = parseInstant(input.startsAt, "startsAt");
  const endsAt = parseInstant(input.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt)
    throw new HttpError(422, "INVALID_OVERRIDE_WINDOW", "نهاية التجاوز بعد بدايته.");
  const state = input.state as OverrideState;
  const reason = input.reason.trim();
  return prisma.$transaction(async (tx) => {
    const service = hasService
      ? await tx.service.findUnique({
          where: { code: input.serviceCode as string },
          select: { id: true, name: true },
        })
      : null;
    const capability = hasCapability
      ? await tx.capability.findUnique({
          where: { code: input.capabilityCode as string },
          select: { id: true, name: true },
        })
      : null;
    if (hasService && !service)
      throw new HttpError(404, "SERVICE_NOT_FOUND", "الخدمة المطلوبة غير موجودة.");
    if (hasCapability && !capability)
      throw new HttpError(404, "CAPABILITY_NOT_FOUND", "القدرة المطلوبة غير موجودة.");
    const scope = input.scope as "platform" | "merchant" | "store";
    const merchantId = scope === "merchant" ? input.merchantId! : null;
    const storeId = scope === "store" ? input.storeId! : null;
    // One live override per (scope, target, subject): the newer replaces the older by revoking it.
    await tx.availabilityOverride.updateMany({
      where: {
        scope,
        merchantId,
        storeId,
        serviceId: service?.id ?? null,
        capabilityId: capability?.id ?? null,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedByKind: actor.kind, revokedById: actor.id },
    });
    const row = await tx.availabilityOverride.create({
      data: {
        scope,
        merchantId,
        storeId,
        serviceId: service?.id ?? null,
        capabilityId: capability?.id ?? null,
        state,
        reason,
        startsAt,
        endsAt,
        createdByKind: actor.kind,
        createdById: actor.id,
      },
      select: overrideSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "availability_override",
      entityId: row.id,
      entityLabel: `${service?.name ?? capability?.name} — ${state}`,
      action: "availability_override_set",
      actor,
      metadata: {
        scope,
        merchantId,
        storeId,
        serviceCode: hasService ? String(input.serviceCode) : null,
        capabilityCode: hasCapability ? String(input.capabilityCode) : null,
        state,
        reason,
        startsAt: startsAt?.toISOString() ?? null,
        endsAt: endsAt?.toISOString() ?? null,
      },
    });
    return overrideView(row);
  });
}

export async function revokeAvailabilityOverride(actor: PlatformActor, id: string) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.availabilityOverride.findUnique({ where: { id }, select: overrideSelect });
    if (!row) throw new HttpError(404, "OVERRIDE_NOT_FOUND", "التجاوز المطلوب غير موجود.");
    if (row.revokedAt) return overrideView(row);
    const revoked = await tx.availabilityOverride.update({
      where: { id },
      data: { revokedAt: new Date(), revokedByKind: actor.kind, revokedById: actor.id },
      select: overrideSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "availability_override",
      entityId: id,
      entityLabel: `${row.service?.name ?? row.capability?.name} — ${row.state}`,
      action: "availability_override_revoked",
      actor,
      metadata: { scope: row.scope, state: row.state },
    });
    return overrideView(revoked);
  });
}

const overrideSelect = {
  id: true,
  scope: true,
  state: true,
  reason: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  createdByKind: true,
  revokedAt: true,
  merchant: { select: { id: true, email: true, businessName: true } },
  store: { select: { id: true, slug: true, name: true } },
  service: { select: { code: true, name: true } },
  capability: { select: { code: true, name: true } },
} as const;

function overrideView(
  row: Prisma.AvailabilityOverrideGetPayload<{ select: typeof overrideSelect }>
) {
  return {
    id: row.id,
    scope: row.scope,
    state: row.state,
    reason: row.reason,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdByKind: row.createdByKind,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    merchant: row.merchant
      ? { id: row.merchant.id, email: row.merchant.email, businessName: row.merchant.businessName }
      : null,
    store: row.store ? { id: row.store.id, slug: row.store.slug, name: row.store.name } : null,
    subject: row.capability
      ? { kind: "capability" as const, code: row.capability.code, name: row.capability.name }
      : { kind: "service" as const, code: row.service!.code, name: row.service!.name },
  };
}

export async function listAvailabilityOverrides(
  rawLimit?: unknown,
  rawCursor?: unknown,
  rawLive?: unknown
) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor("availability_overrides", rawCursor);
  const liveOnly = rawLive === undefined || rawLive === "" || rawLive === "true" || rawLive === "1";
  const rows = await prisma.availabilityOverride.findMany({
    where: {
      ...(liveOnly ? { revokedAt: null } : {}),
      ...keysetWhere("createdAt", "desc", cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: overrideSelect,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor("availability_overrides", last.createdAt, last.id)
  );
  return { overrides: page.map(overrideView), nextCursor };
}

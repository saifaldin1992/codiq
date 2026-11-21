/**
 * ق-250 (المرحلة 29-2) — الحوادث بحالاتها.
 *
 * An incident is a sentence the platform says out loud while something is wrong:
 * a title for the owner, a public message for merchants (and, when it blocks, for
 * shoppers), what it affects, and a state machine that only moves forward to
 * «resolved» — investigating → identified → monitoring → resolved. Every step is
 * an append-only update row; the incident's history is never edited.
 *
 * `blocks` is the one decision: true closes the affected capabilities (423 with
 * the public message) while the incident is open; false only tells. Most
 * incidents inform; a data-corrupting one blocks.
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { prisma } from "../db/prisma.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "./list-page.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_SEVERITIES = ["minor", "major", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUS_LABELS_AR: Record<IncidentStatus, string> = {
  investigating: "قيد التحقيق",
  identified: "حُدّد السبب",
  monitoring: "قيد المراقبة",
  resolved: "حُلّ",
};
export const INCIDENT_SEVERITY_LABELS_AR: Record<IncidentSeverity, string> = {
  minor: "طفيف",
  major: "كبير",
  critical: "حرج",
};
export const INCIDENT_TITLE_MAX_LENGTH = 160;
export const INCIDENT_MESSAGE_MAX_LENGTH = 1000;

// ─────────────────────────────────────────────────────────── parsing
function parseStatus(value: unknown): IncidentStatus {
  if (typeof value !== "string" || !(INCIDENT_STATUSES as readonly string[]).includes(value))
    throw new HttpError(
      422,
      "INVALID_INCIDENT",
      `حالة الحادث إحدى: ${INCIDENT_STATUSES.join("، ")}.`
    );
  return value as IncidentStatus;
}
function parseSeverity(value: unknown): IncidentSeverity {
  if (value === undefined || value === null || value === "") return "minor";
  if (typeof value !== "string" || !(INCIDENT_SEVERITIES as readonly string[]).includes(value))
    throw new HttpError(
      422,
      "INVALID_INCIDENT",
      `شدّة الحادث إحدى: ${INCIDENT_SEVERITIES.join("، ")}.`
    );
  return value as IncidentSeverity;
}
function parseText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 3 || value.trim().length > max)
    throw new HttpError(422, "INVALID_INCIDENT", `${field} بين 3 و${max} حرفاً.`);
  return value.trim();
}
function parseBlocks(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new HttpError(422, "INVALID_INCIDENT", "«يحجب» نعم أو لا.");
  return value;
}
async function parseAffects(value: unknown, client: DbClient): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string"))
    throw new HttpError(422, "INVALID_INCIDENT", "«يؤثّر في» قائمةُ رموز خدماتٍ أو قدرات.");
  const codes = Array.from(
    new Set((value as string[]).map((code) => code.trim().toLowerCase()).filter(Boolean))
  );
  if (codes.length > 50) throw new HttpError(422, "INVALID_INCIDENT", "حتى خمسين رمزاً.");
  if (codes.length === 0) return [];
  const [services, capabilities] = await Promise.all([
    client.service.findMany({ where: { code: { in: codes } }, select: { code: true } }),
    client.capability.findMany({ where: { code: { in: codes } }, select: { code: true } }),
  ]);
  const known = new Set([
    ...services.map((row) => row.code),
    ...capabilities.map((row) => row.code),
  ]);
  const unknown = codes.filter((code) => !known.has(code));
  if (unknown.length)
    throw new HttpError(422, "INVALID_INCIDENT", `رموزٌ ليست في الكتالوج: ${unknown.join("، ")}.`);
  return codes;
}
function affectsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((code): code is string => typeof code === "string")
    : [];
}

// ─────────────────────────────────────────────────────────── the row and its view
const incidentSelect = {
  id: true,
  status: true,
  severity: true,
  title: true,
  publicMessage: true,
  affects: true,
  blocks: true,
  startedAt: true,
  resolvedAt: true,
  createdByKind: true,
  createdAt: true,
  updates: {
    select: { id: true, status: true, message: true, createdByKind: true, createdAt: true },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.IncidentSelect;
type IncidentRow = Prisma.IncidentGetPayload<{ select: typeof incidentSelect }>;

export function incidentView(row: IncidentRow) {
  return {
    id: row.id,
    status: row.status as IncidentStatus,
    statusLabel: INCIDENT_STATUS_LABELS_AR[row.status as IncidentStatus],
    severity: row.severity as IncidentSeverity,
    severityLabel: INCIDENT_SEVERITY_LABELS_AR[row.severity as IncidentSeverity],
    title: row.title,
    publicMessage: row.publicMessage,
    affects: affectsOf(row.affects),
    blocks: row.blocks,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdByKind: row.createdByKind,
    createdAt: row.createdAt.toISOString(),
    updates: row.updates.map((update) => ({
      id: update.id,
      status: update.status as IncidentStatus,
      statusLabel: INCIDENT_STATUS_LABELS_AR[update.status as IncidentStatus],
      message: update.message,
      createdByKind: update.createdByKind,
      createdAt: update.createdAt.toISOString(),
    })),
  };
}
export type IncidentView = ReturnType<typeof incidentView>;

// ─────────────────────────────────────────────────────────── writes
export async function openIncident(
  actor: PlatformActor,
  input: {
    title?: unknown;
    severity?: unknown;
    publicMessage?: unknown;
    affects?: unknown;
    blocks?: unknown;
  }
): Promise<IncidentView> {
  const title = parseText(input.title, "عنوان الحادث", INCIDENT_TITLE_MAX_LENGTH);
  const publicMessage = parseText(
    input.publicMessage,
    "الرسالة العامّة",
    INCIDENT_MESSAGE_MAX_LENGTH
  );
  const severity = parseSeverity(input.severity);
  const blocks = parseBlocks(input.blocks);
  const affects = await parseAffects(input.affects, prisma);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.incident.create({
      data: {
        status: "investigating",
        severity,
        title,
        publicMessage,
        affects,
        blocks,
        createdByKind: actor.kind,
        createdById: actor.id,
        updates: {
          create: {
            status: "investigating",
            message: publicMessage,
            createdByKind: actor.kind,
            createdById: actor.id,
          },
        },
      },
      select: incidentSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "incident",
      entityId: created.id,
      entityLabel: title,
      action: "incident_opened",
      actor,
      metadata: { severity, blocks, affects, publicMessage },
    });
    return created;
  });
  return incidentView(row);
}

export async function addIncidentUpdate(
  actor: PlatformActor,
  id: string,
  input: { status?: unknown; message?: unknown; publicMessage?: unknown; blocks?: unknown }
): Promise<IncidentView> {
  const existing = await prisma.incident.findUnique({
    where: { id },
    select: { id: true, status: true, title: true },
  });
  if (!existing) throw new HttpError(404, "INCIDENT_NOT_FOUND", "لا حادث بهذا المعرّف.");
  if (existing.status === "resolved")
    throw new HttpError(409, "INCIDENT_RESOLVED", "الحادث حُلّ — افتح حادثاً جديداً إن عاد.");
  const status = parseStatus(input.status);
  const message = parseText(input.message, "نصّ التحديث", INCIDENT_MESSAGE_MAX_LENGTH);
  const publicMessage =
    input.publicMessage === undefined || input.publicMessage === null || input.publicMessage === ""
      ? undefined
      : parseText(input.publicMessage, "الرسالة العامّة", INCIDENT_MESSAGE_MAX_LENGTH);
  const blocks =
    input.blocks === undefined || input.blocks === null ? undefined : parseBlocks(input.blocks);
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.incident.update({
      where: { id },
      data: {
        status,
        ...(status === "resolved" ? { resolvedAt: now } : {}),
        ...(publicMessage !== undefined ? { publicMessage } : {}),
        ...(blocks !== undefined ? { blocks } : {}),
        updates: { create: { status, message, createdByKind: actor.kind, createdById: actor.id } },
      },
      select: incidentSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "incident",
      entityId: updated.id,
      entityLabel: existing.title,
      action: status === "resolved" ? "incident_resolved" : "incident_updated",
      actor,
      metadata: {
        from: existing.status,
        to: status,
        message,
        ...(blocks !== undefined ? { blocks } : {}),
      },
    });
    return updated;
  });
  return incidentView(row);
}

// ─────────────────────────────────────────────────────────── reads
export async function listIncidents(
  rawLimit: unknown,
  rawCursor: unknown,
  filter: { open?: boolean } = {}
) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor("incidents", rawCursor);
  const rows = await prisma.incident.findMany({
    where: {
      ...(filter.open ? { status: { not: "resolved" } } : {}),
      ...keysetWhere("createdAt", "desc", cursor),
    },
    select: incidentSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor("incidents", last.createdAt, last.id)
  );
  return { incidents: page.map(incidentView), nextCursor };
}

export interface OpenIncident {
  id: string;
  title: string;
  publicMessage: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affects: string[];
  blocks: boolean;
}

/** Every open incident — a handful at most; one query, then `pickIncidentFor` per capability. */
export async function loadOpenIncidents(client: DbClient = prisma): Promise<OpenIncident[]> {
  const rows = await client.incident.findMany({
    where: { status: { not: "resolved" } },
    select: {
      id: true,
      title: true,
      publicMessage: true,
      severity: true,
      status: true,
      affects: true,
      blocks: true,
    },
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  return rows.map((row) => ({
    ...row,
    severity: row.severity as IncidentSeverity,
    status: row.status as IncidentStatus,
    affects: affectsOf(row.affects),
  }));
}

/** Pure: the open incident that touches this capability — a blocking one first, else the newest. */
export function pickIncidentFor(
  incidents: OpenIncident[],
  subject: { serviceCode: string; capabilityCode: string }
): OpenIncident | null {
  const touching = incidents.filter(
    (incident) =>
      incident.affects.length === 0 ||
      incident.affects.includes(subject.capabilityCode) ||
      incident.affects.includes(subject.serviceCode)
  );
  return touching.find((incident) => incident.blocks) ?? touching[0] ?? null;
}

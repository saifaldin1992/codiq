/**
 * PG-2 — the store audit log (plan §1.هـ).
 *
 * ONE table, not four: the read surface is a single timeline, so four tables
 * would mean a four-way UNION on every read and four migrations per field.
 *
 * `recordAuditEvent` is always called BEFORE the row is stamped, because
 * `deleted_event_id` is a foreign key to the event it returns. The event is
 * append-only in the database (`store_audit_events_immutable`), so nothing here
 * updates or deletes one.
 *
 * `actorLabel` / `entityLabel` / `entitySecondary` are TEXT SNAPSHOTS, not
 * joins: the staff member may leave and the product will be purged, and a line
 * reading «deleted by staff:8f2c…» is worthless a year later.
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../../auth/auth.errors.js";
import { prisma } from "../../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "../list-page.js";
import type { StoreActor } from "../../auth/staff-permissions.js";
import type { AuditAction, AuditEntityType } from "./constants.js";

export type AuditActor = StoreActor | { kind: "platform_owner"; id: string } | { kind: "system" };

export interface RecordAuditEventInput {
  storeId: string;
  entityType: AuditEntityType;
  entityId: string;
  entityLabel: string;
  entitySecondary?: string | null;
  action: AuditAction;
  actor: AuditActor;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Resolves the human-readable snapshot for an actor. The kinds map onto the
 * three identity tables plus `system` (the purge worker), which has no id at
 * all — the `store_audit_events_actor_pair` CHECK enforces exactly that pairing.
 */
export async function actorLabelFor(client: Prisma.TransactionClient | typeof prisma, actor: AuditActor): Promise<string> {
  if (actor.kind === "system") return "النظام";
  if (actor.kind === "merchant") {
    const merchant = await client.merchant.findUnique({ where: { id: actor.id }, select: { businessName: true, email: true } });
    return merchant?.businessName || merchant?.email || "التاجر";
  }
  if (actor.kind === "platform_owner") {
    const owner = await client.platformOwner.findUnique({ where: { id: actor.id }, select: { displayName: true, email: true } });
    return owner?.displayName || owner?.email || "إدارة المنصة";
  }
  const staff = await client.staff.findUnique({ where: { id: actor.id }, select: { displayName: true, email: true } });
  return staff?.displayName || staff?.email || "موظف";
}

/** Writes the event and returns its id — the value that becomes `deleted_event_id`. */
export async function recordAuditEvent(tx: Prisma.TransactionClient, input: RecordAuditEventInput): Promise<string> {
  const event = await tx.storeAuditEvent.create({
    data: {
      storeId: input.storeId,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      entitySecondary: input.entitySecondary ?? null,
      action: input.action,
      actorKind: input.actor.kind,
      actorId: input.actor.kind === "system" ? null : input.actor.id,
      actorLabel: await actorLabelFor(tx, input.actor),
      metadata: input.metadata ?? {},
    },
    select: { id: true },
  });
  return event.id;
}

export interface AuditEventView {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  entitySecondary: string | null;
  action: string;
  actorKind: string;
  actorLabel: string;
  metadata: unknown;
  createdAt: Date;
}

const AUDIT_PAGE_MAX = 100;

/**
 * Keyset pagination on (created_at DESC, id DESC) — the same shape as every
 * other paginated list on the platform. The cursor is an event id.
 */
/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const AUDIT_LOG_KIND = "merchant.audit-events";

export async function listAuditEvents(storeId: string, rawLimit: unknown, rawCursor: unknown, rawEntityType?: unknown) {
  const limit = parseListLimit(rawLimit, AUDIT_PAGE_MAX);
  // 20-2: the cursor now CARRIES `(createdAt, id)` instead of being an event id
  // the server must read back, so the anchor round trip on every page is gone.
  // What the anchor bought is kept and is the reason this list was never on
  // Prisma's `cursor` + `skip: 1` — ع-3: that combination is only correct when
  // the anchor row is itself inside the filter, and it is not when the merchant
  // narrows the log to «الكوبونات» while holding a cursor minted on the
  // unfiltered page. Prisma anchored on an excluded row and dropped the first
  // MATCHING row after it: a real audit event vanishing with nothing on screen
  // to say so, on the one surface that exists to be unarguable.
  //
  // `legacy:` is the one-time ramp for the bare event id this route minted
  // before this branch, resolved store-scoped exactly as the anchor read was.
  const cursor = await readListCursor(AUDIT_LOG_KIND, rawCursor, {
    legacy: async (id) => {
      const row = await prisma.storeAuditEvent.findFirst({ where: { id, storeId }, select: { createdAt: true } });
      return row ? { value: row.createdAt } : null;
    },
  });
  const entityType = typeof rawEntityType === "string" && rawEntityType ? rawEntityType : undefined;
  const rows = await prisma.storeAuditEvent.findMany({
    where: {
      storeId,
      ...(entityType ? { entityType } : {}),
      // `(createdAt, id) < (cursor.createdAt, cursor.id)` — evaluated by the
      // database against the same filter, so no row can fall between two pages.
      ...keysetWhere("createdAt", "desc", cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(AUDIT_LOG_KIND, last.createdAt, last.id));
  const events: AuditEventView[] = page.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    entitySecondary: row.entitySecondary,
    action: row.action,
    actorKind: row.actorKind,
    actorLabel: row.actorLabel,
    metadata: row.metadata,
    createdAt: row.createdAt,
  }));
  return { events, nextCursor };
}

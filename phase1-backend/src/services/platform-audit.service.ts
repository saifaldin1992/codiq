/**
 * 19-ب — the platform audit log («مَن فعل ماذا على مستوى المنصة»).
 *
 * ONE table, append-only in the database (`platform_audit_events_immutable`),
 * and NO purge ever: this is the record the owner reads when he asks what his
 * own staff did with his own platform — and what he himself did, because a log
 * that only watches the staff is a log the staff will not trust.
 *
 * `recordPlatformAuditEvent` takes the CALLER'S transaction on purpose: the
 * mutation and its record commit together or not at all. `actorLabel` and
 * `entityLabel` are TEXT SNAPSHOTS, not joins — the staff member may be
 * removed and the merchant purged, and «بواسطة 8f2c…» is worthless a year on.
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import type { PlatformActor } from "../auth/platform-permissions.js";

/** Mirrors the migration's CHECK lists — a typo here is a compile error, not a 23514. */
export const PLATFORM_AUDIT_ENTITY_TYPES = [
  "merchant",
  "plan",
  "subscription",
  "upgrade_request",
  "settlement",
  "ledger_adjustment",
  "registration_mode",
  "platform_staff",
  "brand",
  // PC-1: the platform's public contact details, and the owner's own account
  // row. Both are singletons in the owner's mind, but the account has a real id
  // to point at, so it carries one.
  "platform_contact",
  "platform_account",
  // ق-249 (المرحلة 29)
  "service",
  "capability",
  "availability_override",
  "feature_flag",
  "store",
  // ق-250
  "maintenance_window",
  "incident",
  // ق-251
  "setting",
  // Marketplace M7b: the owner's actions on a shopper's support ticket.
  "support_ticket",
  "platform_coupon",
] as const;
export type PlatformAuditEntityType = (typeof PLATFORM_AUDIT_ENTITY_TYPES)[number];

export const PLATFORM_AUDIT_ACTIONS = [
  "registration_decided",
  "registration_mode_changed",
  "merchant_created_manually",
  // ق-225: stopping and restarting an APPROVED merchant. The reason rides the
  // metadata — «لماذا أُوقف هذا التاجر» is answered from here months later, by
  // whoever is deciding whether to lift it, or it is not answered at all.
  "merchant_suspended",
  "merchant_resumed",
  "subscription_assigned",
  "plan_created",
  "plan_updated",
  "upgrade_request_decided",
  "settlement_created",
  "adjustment_created",
  "logo_changed",
  "logo_cleared",
  "staff_created",
  "staff_updated",
  "staff_overrides_changed",
  "staff_removed",
  "staff_totp_reset",
  // PC-1. `owner_email_changed` is the one act on this list that changes who can
  // sign in as the platform owner — it carries both addresses in its metadata.
  "contact_details_changed",
  "owner_email_changed",
  // ق-249 (المرحلة 29): the control layer — every switch the owner throws is a row here.
  "service_state_changed",
  "capability_state_changed",
  "availability_override_set",
  "availability_override_revoked",
  "feature_flag_changed",
  "store_status_changed",
  // ق-250
  "maintenance_window_scheduled",
  "maintenance_window_cancelled",
  "incident_opened",
  "incident_updated",
  "incident_resolved",
  // ق-251
  "setting_changed",
  // Marketplace M7b
  "support_ticket_replied",
  "support_ticket_escalated",
  "support_ticket_closed",
  "platform_coupon_created",
  "platform_coupon_updated",
  "platform_coupon_stores_changed",
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export interface RecordPlatformAuditEventInput {
  entityType: PlatformAuditEntityType;
  /** Null for singletons (registration mode, the brand logo) — nothing to point at. */
  entityId?: string | null;
  entityLabel: string;
  action: PlatformAuditAction;
  actor: PlatformActor;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Resolves the human-readable snapshot for a platform actor, mirroring
 * `actorLabelFor` in the store log. Both kinds have exactly one row to read.
 */
export async function platformActorLabelFor(client: Prisma.TransactionClient | typeof prisma, actor: PlatformActor): Promise<string> {
  if (actor.kind === "platform_owner") {
    const owner = await client.platformOwner.findUnique({ where: { id: actor.id }, select: { displayName: true, email: true } });
    return owner?.displayName || owner?.email || "إدارة المنصة";
  }
  const staff = await client.platformStaff.findUnique({ where: { id: actor.id }, select: { displayName: true, email: true } });
  return staff?.displayName || staff?.email || "طاقم المنصة";
}

/** Writes the event inside the caller's transaction and returns its id. */
export async function recordPlatformAuditEvent(tx: Prisma.TransactionClient, input: RecordPlatformAuditEventInput): Promise<string> {
  const event = await tx.platformAuditEvent.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityLabel: input.entityLabel,
      action: input.action,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      actorLabel: await platformActorLabelFor(tx, input.actor),
      metadata: input.metadata ?? {},
    },
    select: { id: true },
  });
  return event.id;
}

export interface PlatformAuditEventView {
  id: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  action: string;
  actorKind: string;
  actorLabel: string;
  metadata: unknown;
  createdAt: Date;
}

const AUDIT_PAGE_MAX = 100;

/**
 * Keyset pagination on (created_at DESC, id DESC), the platform's standard
 * shape. The cursor row is READ, not merely proved to exist, and the next page
 * is a keyset predicate rather than Prisma's cursor + skip:1 — the ع-3 fix
 * from the store log, applied from day one: an audit log that silently loses
 * an entry is worse than one that shows a few extra.
 */
/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const PLATFORM_AUDIT_KIND = "platform.audit-events";

export async function listPlatformAuditEvents(rawLimit: unknown, rawCursor: unknown) {
  const limit = parseListLimit(rawLimit, AUDIT_PAGE_MAX);
  // 20-2: the cursor carries `(createdAt, id)`, so the anchor round trip on
  // every page is gone while the keyset predicate it existed for stays.
  // `legacy:` is the ramp for the bare event id minted before this branch;
  // there is no tenant to scope it to — this list IS the platform's own log.
  const cursor = await readListCursor(PLATFORM_AUDIT_KIND, rawCursor, {
    legacy: async (id) => {
      const row = await prisma.platformAuditEvent.findFirst({ where: { id }, select: { createdAt: true } });
      return row ? { value: row.createdAt } : null;
    },
  });
  const rows = await prisma.platformAuditEvent.findMany({
    where: {
      // `(createdAt, id) < (cursor.createdAt, cursor.id)` — evaluated by the
      // database, so no row can fall between two pages.
      ...keysetWhere("createdAt", "desc", cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(PLATFORM_AUDIT_KIND, last.createdAt, last.id));
  const events: PlatformAuditEventView[] = page.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    action: row.action,
    actorKind: row.actorKind,
    actorLabel: row.actorLabel,
    metadata: row.metadata,
    createdAt: row.createdAt,
  }));
  return { events, nextCursor };
}

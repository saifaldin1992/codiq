/**
 * Availability — store-status. Split verbatim from availability.service.ts
 * (review batch 4, ت-٨); availability.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { liveStoreWindow, maintenanceNoticesFor } from "../maintenance.service.js";
import { HttpError } from "../../auth/auth.errors.js";
import type { PlatformActor } from "../../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "../platform-audit.service.js";
import { loadOpenIncidents } from "../incidents.service.js";
import {
  type StoreStatus,
  type DbClient,
  MERCHANT_STORE_STATUSES,
  STORE_STATUS_MESSAGE_MAX_LENGTH,
  CUSTOMER_MESSAGES,
} from "./states.js";
import { parseInstant } from "./overrides.js";

// ─────────────────────────────────────────────────────────── store status
export interface StoreStatusView {
  status: StoreStatus;
  message: string | null;
  maintenanceUntil: string | null;
  source?: EffectiveStoreState["source"];
}

/**
 * ق-250: the store's status as the CLOCK sees it. Three things can differ from the column:
 *   - `maintenance` whose «until» has passed → active (the merchant said until, and until came);
 *   - `active` / `paused` with a live store-scope window → maintenance, with the window's sentence and end;
 *   - anything else → the column, verbatim. Nothing here writes; the column is tidied by nobody and needs no tidying.
 */
export interface EffectiveStoreState {
  status: StoreStatus;
  message: string | null;
  until: Date | null;
  source: "status" | "clock" | "window";
}

export async function effectiveStoreState(
  store: {
    id: string;
    status: string;
    statusMessage: string | null;
    maintenanceUntil: Date | null;
  },
  now: Date = new Date(),
  client: DbClient = prisma
): Promise<EffectiveStoreState> {
  const status = store.status as StoreStatus;
  if (
    status === "maintenance" &&
    store.maintenanceUntil &&
    store.maintenanceUntil.valueOf() <= now.valueOf()
  )
    return { status: "active", message: null, until: null, source: "clock" };
  if (status === "active" || status === "paused") {
    const window = await liveStoreWindow(store.id, now, client);
    if (window)
      return {
        status: "maintenance",
        message: window.messageAr,
        until: window.endsAt,
        source: "window",
      };
  }
  return { status, message: store.statusMessage, until: store.maintenanceUntil, source: "status" };
}

export async function storeStatus(
  storeId: string,
  client: DbClient = prisma
): Promise<StoreStatusView> {
  const store = await client.store.findUnique({
    where: { id: storeId },
    select: { id: true, status: true, statusMessage: true, maintenanceUntil: true },
  });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر المطلوب غير موجود.");
  const effective = await effectiveStoreState(store, new Date(), client);
  return {
    status: effective.status,
    message: effective.message,
    maintenanceUntil: effective.until?.toISOString() ?? null,
    source: effective.source,
  };
}

/**
 * The merchant's own switch: active / paused (browsing open, checkout closed —
 * the MD-1 vacation) / maintenance (closed to shoppers, the dashboard stays) /
 * closed. `suspended` is the platform's word and is refused here; a store the
 * platform suspended cannot be talked out of it from this door either.
 */
export async function setStoreStatusByMerchant(
  storeId: string,
  input: { status?: unknown; message?: unknown; maintenanceUntil?: unknown }
): Promise<StoreStatusView> {
  if (
    typeof input.status !== "string" ||
    !(MERCHANT_STORE_STATUSES as readonly string[]).includes(input.status)
  ) {
    throw new HttpError(
      422,
      "INVALID_STORE_STATUS",
      `حالة المتجر يجب أن تكون إحدى: ${MERCHANT_STORE_STATUSES.join("، ")}.`
    );
  }
  const status = input.status as StoreStatus;
  const message = parseStatusMessage(input.message);
  const until = parseInstant(input.maintenanceUntil, "maintenanceUntil");
  if (until && status !== "maintenance")
    throw new HttpError(
      422,
      "INVALID_STORE_STATUS",
      "موعد انتهاء الصيانة يُرسل مع حالة الصيانة فقط."
    );
  if (until && until <= new Date())
    throw new HttpError(422, "INVALID_STORE_STATUS", "موعد انتهاء الصيانة في المستقبل.");
  return prisma.$transaction(async (tx) => {
    const current = await tx.store.findUnique({ where: { id: storeId }, select: { status: true } });
    if (!current) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر المطلوب غير موجود.");
    if (current.status === "suspended")
      throw new HttpError(409, "STORE_SUSPENDED", "المتجر موقوف من المنصّة — تواصل مع الدعم.");
    const data: Prisma.StoreUpdateInput = {
      status,
      maintenanceUntil: status === "maintenance" ? until : null,
    };
    if (message !== undefined) {
      data.statusMessage = message;
      data.vacationMessage = message;
    }
    const store = await tx.store.update({
      where: { id: storeId },
      data,
      select: { status: true, statusMessage: true, maintenanceUntil: true },
    });
    return {
      status: store.status as StoreStatus,
      message: store.statusMessage,
      maintenanceUntil: store.maintenanceUntil?.toISOString() ?? null,
    };
  });
}

/** The platform's switch: suspend a single store, or lift the suspension back to `active`. */
export async function setStoreStatusByPlatform(
  actor: PlatformActor,
  storeId: string,
  input: { status?: unknown; message?: unknown }
): Promise<StoreStatusView> {
  if (input.status !== "suspended" && input.status !== "active")
    throw new HttpError(
      422,
      "INVALID_STORE_STATUS",
      "المنصّة توقف المتجر (suspended) أو تعيده (active)."
    );
  const status = input.status as StoreStatus;
  const message = parseStatusMessage(input.message);
  return prisma.$transaction(async (tx) => {
    const before = await tx.store.findUnique({
      where: { id: storeId },
      select: { status: true, name: true, slug: true },
    });
    if (!before) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر المطلوب غير موجود.");
    // Owner decision 2026-11-22: «active» lifts the platform's OWN suspension and nothing else —
    // a store the merchant paused, closed or put in maintenance stays his decision.
    if (status === "active" && before.status !== "suspended")
      throw new HttpError(
        409,
        "STORE_NOT_SUSPENDED",
        "المتجر لم توقفه المنصّة — حالته قرار التاجر."
      );
    const store = await tx.store.update({
      where: { id: storeId },
      data: {
        status,
        maintenanceUntil: null,
        ...(message !== undefined ? { statusMessage: message } : {}),
      },
      select: { status: true, statusMessage: true, maintenanceUntil: true },
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "store",
      entityId: storeId,
      entityLabel: `${before.name} (${before.slug})`,
      action: "store_status_changed",
      actor,
      metadata: { before: before.status, after: store.status, message: message ?? null },
    });
    return {
      status: store.status as StoreStatus,
      message: store.statusMessage,
      maintenanceUntil: store.maintenanceUntil?.toISOString() ?? null,
    };
  });
}

function parseStatusMessage(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > STORE_STATUS_MESSAGE_MAX_LENGTH)
    throw new HttpError(
      422,
      "INVALID_STORE_STATUS",
      `رسالة الحالة حتى ${STORE_STATUS_MESSAGE_MAX_LENGTH} حرف.`
    );
  return value.trim() || null;
}

/** What the shopper's shell reads — always present, so the client never guesses. */
export interface PublicStoreAvailability {
  status: StoreStatus;
  message?: string;
  until?: string;
}

export function publicStoreAvailability(store: {
  status: string;
  statusMessage: string | null;
  maintenanceUntil: Date | null;
}): PublicStoreAvailability {
  const status = store.status as StoreStatus;
  if (status === "maintenance")
    return {
      status,
      message: store.statusMessage?.trim() || CUSTOMER_MESSAGES.STORE_MAINTENANCE.ar,
      ...(store.maintenanceUntil ? { until: store.maintenanceUntil.toISOString() } : {}),
    };
  if (status === "paused")
    return {
      status,
      message:
        store.statusMessage?.trim() ||
        "المتجر في إجازة مؤقتة — يمكنك التصفّح، وسنستأنف استقبال الطلبات قريباً.",
    };
  return { status };
}

/** ق-250: what the merchant's dashboard shows above everything — running and upcoming maintenance, and open incidents. */
export async function merchantAvailabilityNotices(merchantId: string, storeId: string) {
  const now = new Date();
  const [maintenance, incidents] = await Promise.all([
    maintenanceNoticesFor({ merchantId, storeId }, now),
    loadOpenIncidents(),
  ]);
  return {
    maintenance: maintenance.map((window) => ({
      id: window.id,
      phase: window.phase,
      scope: window.scope,
      subject: window.subject,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      startsAtLocal: window.startsAtLocal,
      endsAtLocal: window.endsAtLocal,
      messageAr: window.messageAr,
      affects: window.affects,
    })),
    incidents: incidents.map((incident) => ({
      id: incident.id,
      status: incident.status,
      severity: incident.severity,
      title: incident.title,
      publicMessage: incident.publicMessage,
      affects: incident.affects,
      blocks: incident.blocks,
    })),
  };
}

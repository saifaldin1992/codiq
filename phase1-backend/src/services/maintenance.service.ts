/**
 * ق-250 (المرحلة 29-2) — نوافذ الصيانة المجدولة.
 *
 * A window has a start, an end, a Baghdad clock, a sentence in Arabic (and one
 * in English if the owner wants it), and a scope: the whole platform, one
 * service, one capability, one merchant, or one store. It starts and ends BY
 * ITSELF because the resolver reads the clock at request time — no worker flips
 * a column at midnight and no restart can miss a boundary. The worker only
 * tidies: it stamps windows that have ended and mails «it is over».
 *
 * Who schedules what:
 *   - the platform (owner / staff holding availability.manage): any scope; the
 *     merchants it touches are mailed when it is scheduled and when it ends.
 *   - a merchant (or his staff with settings.manage): his own store only — the
 *     store closes to shoppers for that hour and reopens on its own; nobody is
 *     mailed about a window he scheduled himself.
 *
 * Every platform window is a platform audit row; a merchant's window is its own
 * record (created_by on the row).
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export const MAINTENANCE_SCOPES = ["platform", "service", "capability", "merchant", "store"] as const;
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];
export const MAINTENANCE_WINDOW_STATUSES = ["scheduled", "cancelled", "completed"] as const;
export const MAINTENANCE_TIMEZONE = "Asia/Baghdad";
export const MAINTENANCE_MESSAGE_MAX_LENGTH = 500;
/** A window longer than a week is not maintenance — it is a decision, and decisions are overrides with a reason. */
export const MAINTENANCE_MAX_SPAN_MS = 7 * 86_400_000;
/** Upcoming windows the merchant is told about — a week ahead, no further. */
export const MAINTENANCE_NOTICE_HORIZON_MS = 7 * 86_400_000;
/** The worker's cadence. It only stamps ended windows and mails «it is over»; the clock does the rest. */
export const MAINTENANCE_TICK_INTERVAL_MS = 5 * 60_000;
export const MAX_OPEN_STORE_WINDOWS = 10;
export const MAINTENANCE_SCOPE_LABELS_AR: Record<MaintenanceScope, string> = {
  platform: "المنصّة كلّها", service: "خدمة", capability: "قدرة", merchant: "تاجر بكلّ متاجره", store: "متجر واحد",
};

// ─────────────────────────────────────────────────────────── the clock
export type MaintenancePhase = "upcoming" | "active" | "ended" | "cancelled";

/** Pure: the phase a window is in at `now`. The column never says «active» — the clock does. */
export function windowPhase(window: { status: string; startsAt: Date; endsAt: Date }, now: Date = new Date()): MaintenancePhase {
  if (window.status === "cancelled") return "cancelled";
  if (window.status === "completed" || window.endsAt.valueOf() <= now.valueOf()) return "ended";
  if (window.startsAt.valueOf() <= now.valueOf()) return "active";
  return "upcoming";
}

const baghdadClock = new Intl.DateTimeFormat("en-GB", { timeZone: MAINTENANCE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** «2026-09-16 02:30» in Baghdad — what the merchant reads in the mail and on the screen. */
export function formatBaghdad(date: Date): string {
  const parts = Object.fromEntries(baghdadClock.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// ─────────────────────────────────────────────────────────── parsing (meaning lives here, shape in http/schemas)
function parseScope(value: unknown): MaintenanceScope {
  if (typeof value !== "string" || !(MAINTENANCE_SCOPES as readonly string[]).includes(value)) {
    throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", `نطاق النافذة يجب أن يكون إحدى: ${MAINTENANCE_SCOPES.join("، ")}.`);
  }
  return value as MaintenanceScope;
}

function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", `${field} مطلوب بصيغة ISO.`);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", `${field} ليس وقتاً صالحاً.`);
  return date;
}

/** Start may already be behind us (a window that begins now); the end may not. */
export function parseWindowSpan(startsAt: unknown, endsAt: unknown, now: Date = new Date()): { startsAt: Date; endsAt: Date } {
  const start = parseInstant(startsAt, "وقت البداية");
  const end = parseInstant(endsAt, "وقت النهاية");
  if (end.valueOf() <= start.valueOf()) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "نهاية النافذة يجب أن تكون بعد بدايتها.");
  if (end.valueOf() - start.valueOf() > MAINTENANCE_MAX_SPAN_MS) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "نافذة الصيانة حتى سبعة أيام؛ ما هو أطول قرارٌ يُسجَّل تجاوزاً بسبب.");
  if (end.valueOf() <= now.valueOf()) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "النافذة انتهت قبل أن تُسجَّل.");
  return { startsAt: start, endsAt: end };
}

function parseMessage(value: unknown, field: string, required: true): string;
function parseMessage(value: unknown, field: string, required: false): string | null;
function parseMessage(value: unknown, field: string, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", `${field} مطلوبة — الزبون والتاجر يقرآنها.`);
    return null;
  }
  if (typeof value !== "string") throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", `${field} نصّ.`);
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > MAINTENANCE_MESSAGE_MAX_LENGTH) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", `${field} بين 3 و${MAINTENANCE_MESSAGE_MAX_LENGTH} حرفاً.`);
  return trimmed;
}

/** Capability or service codes that narrow a platform / merchant / store window; each must exist in the catalogue. */
async function parseAffects(value: unknown, client: DbClient): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "«يؤثّر في» قائمةُ رموز خدماتٍ أو قدرات.");
  const codes = Array.from(new Set((value as string[]).map((code) => code.trim().toLowerCase()).filter(Boolean)));
  if (codes.length > 50) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "حتى خمسين رمزاً.");
  if (codes.length === 0) return [];
  const [services, capabilities] = await Promise.all([
    client.service.findMany({ where: { code: { in: codes } }, select: { code: true } }),
    client.capability.findMany({ where: { code: { in: codes } }, select: { code: true } }),
  ]);
  const known = new Set([...services.map((row) => row.code), ...capabilities.map((row) => row.code)]);
  const unknown = codes.filter((code) => !known.has(code));
  if (unknown.length) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", `رموزٌ ليست في الكتالوج: ${unknown.join("، ")}.`);
  return codes;
}

function affectsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((code): code is string => typeof code === "string") : [];
}

// ─────────────────────────────────────────────────────────── the row and its view
const windowSelect = {
  id: true, scope: true, serviceId: true, capabilityId: true, merchantId: true, storeId: true,
  startsAt: true, endsAt: true, timezone: true, messageAr: true, messageEn: true, affects: true, status: true,
  createdByKind: true, createdById: true, cancelledAt: true, completedAt: true, createdAt: true,
  service: { select: { code: true, name: true } },
  capability: { select: { code: true, name: true } },
  merchant: { select: { id: true, email: true, businessName: true } },
  store: { select: { id: true, slug: true, name: true } },
} satisfies Prisma.MaintenanceWindowSelect;
type WindowRow = Prisma.MaintenanceWindowGetPayload<{ select: typeof windowSelect }>;

/** What the window is about, in words a person reads off the list or the mail. */
export function windowSubjectLabel(row: Pick<WindowRow, "scope" | "service" | "capability" | "merchant" | "store">): string {
  if (row.scope === "service") return row.service?.name ?? "خدمة";
  if (row.scope === "capability") return row.capability?.name ?? "قدرة";
  if (row.scope === "merchant") return `التاجر ${row.merchant?.businessName ?? ""}`.trim();
  if (row.scope === "store") return `المتجر ${row.store?.name ?? ""}`.trim();
  return "المنصّة كلّها";
}

export function windowView(row: WindowRow, now: Date = new Date()) {
  return {
    id: row.id,
    scope: row.scope as MaintenanceScope,
    phase: windowPhase(row, now),
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    startsAtLocal: formatBaghdad(row.startsAt),
    endsAtLocal: formatBaghdad(row.endsAt),
    timezone: row.timezone,
    messageAr: row.messageAr,
    messageEn: row.messageEn,
    affects: affectsOf(row.affects),
    subject: windowSubjectLabel(row),
    service: row.service ? { code: row.service.code, name: row.service.name } : null,
    capability: row.capability ? { code: row.capability.code, name: row.capability.name } : null,
    merchant: row.merchant ? { email: row.merchant.email, businessName: row.merchant.businessName } : null,
    store: row.store ? { slug: row.store.slug, name: row.store.name } : null,
    createdByKind: row.createdByKind,
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}
export type MaintenanceWindowView = ReturnType<typeof windowView>;

// ─────────────────────────────────────────────────────────── scheduling (platform)
export interface ScheduleWindowInput {
  scope: unknown;
  serviceCode?: unknown;
  capabilityCode?: unknown;
  /** Resolved by the route from an email / a slug — never a uuid typed by hand. */
  merchantId?: string | null;
  storeId?: string | null;
  startsAt: unknown;
  endsAt: unknown;
  messageAr: unknown;
  messageEn?: unknown;
  affects?: unknown;
}

async function resolveTarget(scope: MaintenanceScope, input: ScheduleWindowInput, client: DbClient): Promise<{ serviceId?: string; capabilityId?: string; merchantId?: string; storeId?: string }> {
  if (scope === "service") {
    if (typeof input.serviceCode !== "string" || !input.serviceCode.trim()) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "نافذةُ خدمةٍ تحتاج رمز الخدمة.");
    const service = await client.service.findUnique({ where: { code: input.serviceCode.trim().toLowerCase() }, select: { id: true } });
    if (!service) throw new HttpError(404, "SERVICE_NOT_FOUND", "لا خدمة بهذا الرمز.");
    return { serviceId: service.id };
  }
  if (scope === "capability") {
    if (typeof input.capabilityCode !== "string" || !input.capabilityCode.trim()) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "نافذةُ قدرةٍ تحتاج رمز القدرة.");
    const capability = await client.capability.findUnique({ where: { code: input.capabilityCode.trim().toLowerCase() }, select: { id: true } });
    if (!capability) throw new HttpError(404, "CAPABILITY_NOT_FOUND", "لا قدرة بهذا الرمز.");
    return { capabilityId: capability.id };
  }
  if (scope === "merchant") {
    if (!input.merchantId) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "نافذةُ تاجرٍ تحتاج بريد التاجر.");
    return { merchantId: input.merchantId };
  }
  if (scope === "store") {
    if (!input.storeId) throw new HttpError(422, "INVALID_MAINTENANCE_WINDOW", "نافذةُ متجرٍ تحتاج رابط المتجر.");
    return { storeId: input.storeId };
  }
  return {};
}

export async function scheduleMaintenanceWindow(actor: PlatformActor, input: ScheduleWindowInput): Promise<MaintenanceWindowView> {
  const now = new Date();
  const scope = parseScope(input.scope);
  const span = parseWindowSpan(input.startsAt, input.endsAt, now);
  const messageAr = parseMessage(input.messageAr, "الرسالة العربيّة", true);
  const messageEn = parseMessage(input.messageEn, "الرسالة الإنكليزيّة", false);
  const affects = scope === "service" || scope === "capability" ? [] : await parseAffects(input.affects, prisma);
  const target = await resolveTarget(scope, input, prisma);
  const window = await prisma.$transaction(async (tx) => {
    const row = await tx.maintenanceWindow.create({
      data: { scope, ...target, startsAt: span.startsAt, endsAt: span.endsAt, timezone: MAINTENANCE_TIMEZONE, messageAr, messageEn, affects, createdByKind: actor.kind, createdById: actor.id },
      select: windowSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "maintenance_window", entityId: row.id, entityLabel: `${windowSubjectLabel(row)} — ${formatBaghdad(row.startsAt)} → ${formatBaghdad(row.endsAt)}`,
      action: "maintenance_window_scheduled", actor,
      metadata: { scope, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), affects, message: messageAr },
    });
    return row;
  });
  await enqueueMaintenanceNotices(window, "maintenance.scheduled");
  return windowView(window, now);
}

export async function cancelMaintenanceWindow(actor: PlatformActor, id: string): Promise<MaintenanceWindowView> {
  const now = new Date();
  const existing = await prisma.maintenanceWindow.findUnique({ where: { id }, select: windowSelect });
  if (!existing) throw new HttpError(404, "MAINTENANCE_WINDOW_NOT_FOUND", "لا نافذة بهذا المعرّف.");
  if (existing.status !== "scheduled" || existing.endsAt.valueOf() <= now.valueOf()) throw new HttpError(409, "MAINTENANCE_WINDOW_NOT_LIVE", "هذه النافذة انتهت أو أُلغيت من قبل.");
  const window = await prisma.$transaction(async (tx) => {
    const row = await tx.maintenanceWindow.update({ where: { id }, data: { status: "cancelled", cancelledAt: now, cancelledByKind: actor.kind, cancelledById: actor.id }, select: windowSelect });
    await recordPlatformAuditEvent(tx, {
      entityType: "maintenance_window", entityId: row.id, entityLabel: `${windowSubjectLabel(row)} — ${formatBaghdad(row.startsAt)} → ${formatBaghdad(row.endsAt)}`,
      action: "maintenance_window_cancelled", actor,
      metadata: { scope: row.scope, phaseAtCancel: windowPhase(existing, now) },
    });
    return row;
  });
  return windowView(window, now);
}

// ─────────────────────────────────────────────────────────── scheduling (the merchant's own store)
export interface StoreActorRef { kind: "merchant" | "staff"; id: string }

export async function scheduleStoreMaintenanceWindow(store: { id: string }, actor: StoreActorRef, input: { startsAt: unknown; endsAt: unknown; messageAr: unknown; messageEn?: unknown }): Promise<MaintenanceWindowView> {
  const now = new Date();
  const span = parseWindowSpan(input.startsAt, input.endsAt, now);
  const messageAr = parseMessage(input.messageAr, "رسالتك للزبائن", true);
  const messageEn = parseMessage(input.messageEn, "الرسالة الإنكليزيّة", false);
  const open = await prisma.maintenanceWindow.count({ where: { storeId: store.id, scope: "store", status: "scheduled", endsAt: { gt: now } } });
  if (open >= MAX_OPEN_STORE_WINDOWS) throw new HttpError(422, "TOO_MANY_MAINTENANCE_WINDOWS", `حتى ${MAX_OPEN_STORE_WINDOWS} نوافذ صيانةٍ قادمة لكلّ متجر.`);
  const row = await prisma.maintenanceWindow.create({
    data: { scope: "store", storeId: store.id, startsAt: span.startsAt, endsAt: span.endsAt, timezone: MAINTENANCE_TIMEZONE, messageAr, messageEn, affects: [], createdByKind: actor.kind, createdById: actor.id },
    select: windowSelect,
  });
  return windowView(row, now);
}

export async function cancelStoreMaintenanceWindow(storeId: string, actor: StoreActorRef, id: string): Promise<MaintenanceWindowView> {
  const now = new Date();
  const existing = await prisma.maintenanceWindow.findFirst({ where: { id, storeId, scope: "store" }, select: windowSelect });
  if (!existing) throw new HttpError(404, "MAINTENANCE_WINDOW_NOT_FOUND", "لا نافذة بهذا المعرّف في هذا المتجر.");
  // A window the PLATFORM placed on this store is the platform's to lift.
  if (existing.createdByKind === "platform_owner" || existing.createdByKind === "platform_staff") throw new HttpError(403, "MAINTENANCE_WINDOW_PLATFORM_OWNED", "هذه النافذة من المنصّة — تواصل مع الدعم لرفعها.");
  if (existing.status !== "scheduled" || existing.endsAt.valueOf() <= now.valueOf()) throw new HttpError(409, "MAINTENANCE_WINDOW_NOT_LIVE", "هذه النافذة انتهت أو أُلغيت من قبل.");
  const row = await prisma.maintenanceWindow.update({ where: { id }, data: { status: "cancelled", cancelledAt: now, cancelledByKind: actor.kind, cancelledById: actor.id }, select: windowSelect });
  return windowView(row, now);
}

// ─────────────────────────────────────────────────────────── lists
export async function listMaintenanceWindows(rawLimit: unknown, rawCursor: unknown, filter: { live?: boolean; storeId?: string } = {}) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor("maintenance_windows", rawCursor);
  const now = new Date();
  const rows = await prisma.maintenanceWindow.findMany({
    where: {
      ...(filter.live ? { status: "scheduled", endsAt: { gt: now } } : {}),
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...keysetWhere("createdAt", "desc", cursor),
    },
    select: windowSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor("maintenance_windows", last.createdAt, last.id));
  return { windows: page.map((row) => windowView(row, now)), nextCursor };
}

/** What a merchant's dashboard shows: what is running now and what comes within a week, over anything that touches him. */
export async function maintenanceNoticesFor(tenant: { merchantId: string; storeId: string }, now: Date = new Date()): Promise<MaintenanceWindowView[]> {
  const horizon = new Date(now.valueOf() + MAINTENANCE_NOTICE_HORIZON_MS);
  const rows = await prisma.maintenanceWindow.findMany({
    where: {
      status: "scheduled", endsAt: { gt: now }, startsAt: { lte: horizon },
      OR: [{ scope: "platform" }, { scope: "service" }, { scope: "capability" }, { scope: "merchant", merchantId: tenant.merchantId }, { scope: "store", storeId: tenant.storeId }],
    },
    select: windowSelect,
    orderBy: { startsAt: "asc" },
    take: 20,
  });
  return rows.map((row) => windowView(row, now));
}

// ─────────────────────────────────────────────────────────── what the resolver reads
export interface LiveWindow {
  id: string;
  scope: MaintenanceScope;
  serviceId: string | null;
  capabilityId: string | null;
  merchantId: string | null;
  storeId: string | null;
  affects: string[];
  messageAr: string;
  endsAt: Date;
}

/** Every window live right now that could touch this tenant — one query, then `pickWindowFor` per capability. */
export async function loadLiveWindows(tenant: { merchantId: string; storeId?: string | null }, now: Date = new Date(), client: DbClient = prisma): Promise<LiveWindow[]> {
  const rows = await client.maintenanceWindow.findMany({
    where: {
      status: "scheduled", startsAt: { lte: now }, endsAt: { gt: now },
      OR: [
        { scope: "platform" }, { scope: "service" }, { scope: "capability" },
        { scope: "merchant", merchantId: tenant.merchantId },
        ...(tenant.storeId ? [{ scope: "store", storeId: tenant.storeId }] : []),
      ],
    },
    select: { id: true, scope: true, serviceId: true, capabilityId: true, merchantId: true, storeId: true, affects: true, messageAr: true, endsAt: true },
    orderBy: { startsAt: "asc" },
  });
  return rows.map((row) => ({ ...row, scope: row.scope as MaintenanceScope, affects: affectsOf(row.affects) }));
}

/** Pure: the widest live window that covers this capability, platform first. */
export function pickWindowFor(windows: LiveWindow[], subject: { serviceId: string; serviceCode: string; capabilityId: string; capabilityCode: string }): LiveWindow | null {
  const touches = (window: LiveWindow) => window.affects.length === 0 || window.affects.includes(subject.capabilityCode) || window.affects.includes(subject.serviceCode);
  for (const scope of MAINTENANCE_SCOPES) {
    const hit = windows.find((window) => window.scope === scope && (
      scope === "service" ? window.serviceId === subject.serviceId
        : scope === "capability" ? window.capabilityId === subject.capabilityId
          : touches(window)));
    if (hit) return hit;
  }
  return null;
}

/** The store's own live window, if any — what closes the shop for the hour and reopens it. */
export async function liveStoreWindow(storeId: string, now: Date = new Date(), client: DbClient = prisma): Promise<{ id: string; messageAr: string; endsAt: Date } | null> {
  return client.maintenanceWindow.findFirst({
    where: { scope: "store", storeId, status: "scheduled", startsAt: { lte: now }, endsAt: { gt: now } },
    select: { id: true, messageAr: true, endsAt: true },
    orderBy: { endsAt: "desc" },
  });
}

/** A platform-wide window (no narrowing) — the shopper's shell shows it as a strip. */
export async function livePlatformWideWindow(now: Date = new Date(), client: DbClient = prisma): Promise<{ messageAr: string; endsAt: Date } | null> {
  const rows = await client.maintenanceWindow.findMany({
    where: { scope: "platform", status: "scheduled", startsAt: { lte: now }, endsAt: { gt: now } },
    select: { affects: true, messageAr: true, endsAt: true },
    orderBy: { endsAt: "desc" },
    take: 10,
  });
  const wide = rows.find((row) => affectsOf(row.affects).length === 0);
  return wide ? { messageAr: wide.messageAr, endsAt: wide.endsAt } : null;
}

// ─────────────────────────────────────────────────────────── notices
type NoticeEvent = "maintenance.scheduled" | "maintenance.ended";
type Recipient = { id: string; email: string; businessName: string };

async function windowAudience(window: WindowRow): Promise<Recipient[]> {
  if (window.scope === "merchant") return window.merchant ? [window.merchant] : [];
  if (window.scope === "store") {
    if (!window.storeId) return [];
    const store = await prisma.store.findUnique({ where: { id: window.storeId }, select: { merchant: { select: { id: true, email: true, businessName: true } } } });
    return store ? [store.merchant] : [];
  }
  // platform / service / capability: every merchant who can be affected, in pages — never one unbounded read.
  const audience: Recipient[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Recipient[] = await prisma.merchant.findMany({
      where: { isActive: true, approvalStatus: "approved", ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, email: true, businessName: true },
      orderBy: { id: "asc" },
      take: 500,
    });
    audience.push(...page);
    if (page.length < 500) break;
    after = page[page.length - 1].id;
  }
  return audience;
}

/**
 * One outbox row per merchant per event — storeless, because the notice is about
 * the platform and a two-store merchant must not get two. A window a merchant
 * scheduled for his own store tells nobody: he knows.
 */
export async function enqueueMaintenanceNotices(window: WindowRow, eventType: NoticeEvent): Promise<number> {
  if (window.scope === "store" && (window.createdByKind === "merchant" || window.createdByKind === "staff")) return 0;
  const audience = await windowAudience(window);
  if (audience.length === 0) return 0;
  const keyFor = (merchantId: string) => `${eventType}:${window.id}:${merchantId}`;
  // `notification_outbox_dedupe` is (store_id, dedupe_key) and NULL store ids never collide, so the check is explicit.
  const existing = new Set((await prisma.notificationOutbox.findMany({
    where: { storeId: null, eventType, dedupeKey: { in: audience.map((merchant) => keyFor(merchant.id)) } },
    select: { dedupeKey: true },
  })).map((row) => row.dedupeKey));
  const payloadBase = {
    windowId: window.id, scope: window.scope, subject: windowSubjectLabel(window),
    startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString(),
    startsAtLocal: formatBaghdad(window.startsAt), endsAtLocal: formatBaghdad(window.endsAt), timezone: window.timezone,
    messageAr: window.messageAr, messageEn: window.messageEn ?? null, affects: affectsOf(window.affects),
  };
  const rows = audience
    .filter((merchant) => !existing.has(keyFor(merchant.id)))
    .map((merchant) => ({
      storeId: null, eventType, recipientKind: "account", channel: "email", recipient: merchant.email,
      dedupeKey: keyFor(merchant.id), payload: { ...payloadBase, businessName: merchant.businessName },
    }));
  if (rows.length) await prisma.notificationOutbox.createMany({ data: rows });
  return rows.length;
}

/** The worker's whole job: stamp what the clock already ended, and say so. Idempotent — a second pass finds nothing. */
export async function tickMaintenanceWindows(now: Date = new Date()): Promise<{ completed: number; notified: number }> {
  const ended = await prisma.maintenanceWindow.findMany({ where: { status: "scheduled", endsAt: { lte: now } }, select: windowSelect, orderBy: { endsAt: "asc" }, take: 200 });
  let completed = 0;
  let notified = 0;
  for (const window of ended) {
    const stamped = await prisma.maintenanceWindow.updateMany({ where: { id: window.id, status: "scheduled" }, data: { status: "completed", completedAt: now } });
    if (stamped.count === 0) continue;
    completed += 1;
    notified += await enqueueMaintenanceNotices(window, "maintenance.ended");
  }
  return { completed, notified };
}

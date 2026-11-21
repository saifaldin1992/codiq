/**
 * codiq PG-3 — messaging compliance.
 *
 * The thing being protected here is not the marketing channel. It is the
 * OPERATIONAL one. A domain that sends unsolicited mail with no way out gets
 * listed as a spam source, and when that happens the order confirmations and
 * courier notices stop arriving too. Losing reminders is a marketing problem;
 * losing order confirmations is an outage the merchant blames on the platform.
 *
 * Four rules, all enforced in the worker before a byte leaves:
 *   1. every event type is classified marketing/operational IN THE DATABASE, by
 *      a foreign key — an unclassified type cannot be enqueued at all;
 *   2. a marketing message with no working unsubscribe link FAILS rather than
 *      going out incomplete;
 *   3. an unsubscribe stops marketing for that store and touches nothing else —
 *      a customer who muted reminders still learns their order shipped;
 *   4. over the store's daily cap the message is DEFERRED to tomorrow, never
 *      dropped. A cap that silently discards is worse than no cap, because the
 *      merchant sees a send that did not happen.
 */
import crypto from "node:crypto";
import { resolveSetting } from "../services/config.service.js";
import { HttpError } from "../auth/auth.errors.js";
import { buildKeys } from "../auth/keys.js";
import { config } from "../config.js";
import { prisma } from "../db/prisma.js";

export type NotificationKind = "marketing" | "operational";

/** Unsubscribe reaches the recipient as a link, so the token rides a URL path. */
const TOKEN_SEPARATOR = ".";

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Classification is read from the database, not from a constant here — that is
 * the whole point of the lookup table. It is cached for the life of the process
 * because the set changes only by migration, and the worker asks on every row.
 */
let classificationCache: Map<string, NotificationKind> | null = null;

export async function notificationKind(eventType: string): Promise<NotificationKind> {
  if (!classificationCache) {
    const rows = await prisma.notificationEventKind.findMany({
      select: { eventType: true, kind: true },
    });
    classificationCache = new Map(rows.map((row) => [row.eventType, row.kind as NotificationKind]));
  }
  const kind = classificationCache.get(eventType);
  // Unreachable through the foreign key. If it ever fires, something wrote to
  // the table out of band, and the safe reading of an unknown message is the
  // strict one: treat it as marketing so every guard below applies.
  return kind ?? "marketing";
}

/** Test seam: the classification set only changes by migration. */
export function resetNotificationKindCache(): void {
  classificationCache = null;
}

/**
 * The unsubscribe token is an HMAC over (storeId, email) rather than a stored
 * row, so no write is needed before the first marketing send and a link stays
 * valid for as long as the secret does. It carries no session and grants
 * nothing except the right to stop this store's marketing to this address.
 */
const UNSUBSCRIBE_KEYS = buildKeys(
  config.sessionJwtSecret,
  config.sessionJwtSecretPrevious
).unsubscribe;

/**
 * D-62: signed with a key DERIVED for unsubscribing, no longer the raw session
 * secret. Sharing one key meant that rotating it because a session token leaked
 * would silently invalidate every unsubscribe link already sitting in an inbox —
 * a person clicking "unsubscribe" in an old email told the link is invalid, as a
 * side effect of an unrelated security action.
 */
function signUnsubscribe(storeId: string, emailNormalized: string, key: Buffer): string {
  return crypto
    .createHmac("sha256", key)
    .update(`pg3-unsubscribe:${storeId}:${emailNormalized}`)
    .digest("base64url");
}

export function unsubscribeToken(storeId: string, email: string): string {
  const emailNormalized = normalizeEmail(email);
  const claim = Buffer.from(JSON.stringify({ s: storeId, e: emailNormalized }), "utf8").toString(
    "base64url"
  );
  return `${claim}${TOKEN_SEPARATOR}${signUnsubscribe(storeId, emailNormalized, UNSUBSCRIBE_KEYS.signing)}`;
}

export function verifyUnsubscribeToken(token: unknown): {
  storeId: string;
  emailNormalized: string;
} {
  const invalid = () =>
    new HttpError(400, "INVALID_UNSUBSCRIBE_TOKEN", "رابط إلغاء الاشتراك غير صالح أو منتهٍ.");
  if (typeof token !== "string" || !token.includes(TOKEN_SEPARATOR)) throw invalid();
  const [claim, signature] = token.split(TOKEN_SEPARATOR);
  if (!claim || !signature) throw invalid();
  let parsed: { s?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(claim, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof parsed.s !== "string" || typeof parsed.e !== "string") throw invalid();
  // Every key in the rotation window, so a link already sitting in somebody's
  // inbox keeps working across a rotation — and across the move to derived keys.
  // Unsubscribing is the one action that must never fail: a broken unsubscribe
  // link is a person who cannot stop marketing he did not ask for.
  const given = Buffer.from(signature, "utf8");
  const matches = UNSUBSCRIBE_KEYS.verifying.some((key) => {
    const want = Buffer.from(signUnsubscribe(parsed.s as string, parsed.e as string, key), "utf8");
    // Constant-time: a length-independent compare would leak the signature one
    // byte at a time to anyone willing to time the endpoint.
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  });
  if (!matches) throw invalid();
  return { storeId: parsed.s, emailNormalized: parsed.e };
}

/**
 * Absolute links, because a relative path in an email is not a link at all.
 * Payloads keep storing relative paths — they are a durable snapshot of WHICH
 * page, and they survive a domain change — and the renderer decides WHERE.
 */
export function publicUrl(relativePath: string): string | null {
  const base = process.env.CODIQ_PUBLIC_BASE_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}`;
}

export function unsubscribeUrl(storeId: string, email: string): string | null {
  return publicUrl(`/unsubscribe/${unsubscribeToken(storeId, email)}`);
}

export async function isUnsubscribed(storeId: string, email: string): Promise<boolean> {
  const row = await prisma.notificationUnsubscribe.findUnique({
    where: { storeId_emailNormalized: { storeId, emailNormalized: normalizeEmail(email) } },
    select: { id: true },
  });
  return row !== null;
}

export async function recordUnsubscribe(
  storeId: string,
  email: string,
  source: "link" | "complaint" | "owner"
): Promise<void> {
  const emailNormalized = normalizeEmail(email);
  // Idempotent: pressing the link twice is the same intent, not an error.
  await prisma.notificationUnsubscribe.upsert({
    where: { storeId_emailNormalized: { storeId, emailNormalized } },
    update: {},
    create: { storeId, emailNormalized, source },
  });
}

export const DEFAULT_MARKETING_DAILY_CAP = 200;

function startOfDayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextDayUtc(now: Date): Date {
  const start = startOfDayUtc(now);
  return new Date(start.valueOf() + 24 * 60 * 60 * 1000);
}

/** Deferrals land somewhere inside this window after midnight, not all on it. */
export const MARKETING_DEFER_SPREAD_MINUTES = 6 * 60;

/**
 * Where a capped message lands tomorrow.
 *
 * Scheduling every deferral on the same instant rebuilds, at 00:00 sharp, the
 * exact pile-up the cap exists to prevent — and a store that switches recovery
 * on for the first time can defer thousands at once.
 *
 * The offset is derived from the row id rather than drawn at random: the spread
 * is what matters, and a deterministic one can be asserted in a test while a
 * random one cannot.
 */
export function deferredUntil(now: Date, outboxId: string): Date {
  const digest = crypto.createHash("sha256").update(outboxId).digest();
  const minutes = digest.readUInt32BE(0) % MARKETING_DEFER_SPREAD_MINUTES;
  return new Date(nextDayUtc(now).valueOf() + minutes * 60 * 1000);
}

/**
 * Counts what this store has ALREADY SENT today, marketing only. Deferred and
 * failed rows do not count against the cap — the cap limits what lands in
 * inboxes, not what the queue attempted.
 */
export async function marketingSentToday(storeId: string, now: Date): Promise<number> {
  return prisma.notificationOutbox.count({
    where: {
      storeId,
      status: "sent",
      sentAt: { gte: startOfDayUtc(now), lt: nextDayUtc(now) },
      eventKind: { kind: "marketing" },
    },
  });
}

export async function marketingDailyCap(storeId: string): Promise<number> {
  // ق-251: the one function — the platform's ceiling and the merchant's restraint sit above the store's column.
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { merchantId: true },
  });
  if (!store) return DEFAULT_MARKETING_DAILY_CAP;
  return Number(
    (await resolveSetting("marketing.daily_cap", { merchantId: store.merchantId, storeId })).value
  );
}

/**
 * ق-207 — a per-RECIPIENT ceiling on the marketing channel, platform-wide.
 *
 * The store cap bounds what one store does to the shared sending domain; it
 * says nothing about what reaches one address. A hostile merchant needed one
 * self-registered store, one customer row carrying the victim's unverified
 * email, and up to 200 armed wishlist rows: every restock became a message
 * whose subject he chose (the product and store names are interpolated
 * verbatim), up to the STORE cap — 200 a day to one stranger — and a second
 * store reset both the cap and the unsubscribe scope. The operational channel
 * got its per-recipient ceiling in 19-د for exactly this reason; marketing got
 * nothing.
 *
 * Counted across ALL stores, because the exploit's escape hatch is a second
 * store. Over the ceiling the row is SKIPPED with a named outcome, not
 * deferred: no honest shopper wants a fourth marketing email in one day, and
 * deferring two hundred restock alerts would drip them at him for weeks — the
 * one case where «never dropped» would serve the attacker and not the merchant.
 */
export const MARKETING_RECIPIENT_DAILY_CAP = 3;

export async function marketingSentTodayToRecipient(recipient: string, now: Date): Promise<number> {
  return prisma.notificationOutbox.count({
    where: {
      recipient,
      status: "sent",
      sentAt: { gte: startOfDayUtc(now), lt: nextDayUtc(now) },
      eventKind: { kind: "marketing" },
    },
  });
}

/**
 * 19-د (ATTACK-SURFACE) — the operational channel needed ceilings too.
 *
 * EVERY consent control in this module lived inside `kind === "marketing"`, and
 * that is a deliberate, correct design: a shopper who muted reminders must still
 * be told his order shipped. What nobody wrote down is that it also left the
 * operational channel with NO ceiling of any kind, while the recipient address
 * is never proven to belong to the recipient — customer registration takes any
 * email and stores it unverified, and `enqueueOrderCreated` mails whatever
 * address is on the order.
 *
 * So: self-register a merchant, name the store 120 characters of phishing text
 * (it is interpolated verbatim into «استلمنا طلبك من …»), register a customer at
 * victim@example.com on that store, then check out and walk each order through
 * the status machine. Seven customer emails per order, checkout capped at 12 per
 * ten minutes and the status route capped at nothing — roughly 84 messages per
 * ten minutes to one address, from the platform's own CODIQ_SMTP_FROM identity,
 * with no unsubscribe line and no cap. That is precisely the deliverability
 * catastrophe this module's header says it exists to prevent, arriving through
 * the door the header left open.
 *
 * TWO DIMENSIONS, DOING TWO DIFFERENT JOBS.
 *
 *   · PER RECIPIENT is the one that closes the finding, and it is surgical: no
 *     honest shopper receives twenty operational messages from one store in one
 *     day. Seven per order means roughly three orders a day before it bites, and
 *     over it the message is DEFERRED, never dropped — the module's own rule 4.
 *
 *   · PER STORE is a circuit breaker, not a throttle, and the default is set so
 *     it does not bite an honest store: a merchant on the growth plan may place
 *     5,000 orders a month (~166/day), which is ~1,160 customer messages plus
 *     the merchant's own copies. Five thousand a day leaves that well clear
 *     while still bounding what ONE hostile or compromised store can do to the
 *     shared sending domain before anybody notices.
 *
 * Both are columns rather than constants so the platform owner can tighten a
 * particular store without a deploy — the same shape `marketingDailyCap` has.
 */
export const DEFAULT_OPERATIONAL_DAILY_CAP = 5000;
export const DEFAULT_OPERATIONAL_RECIPIENT_DAILY_CAP = 20;

export async function operationalCaps(
  storeId: string
): Promise<{ store: number; recipient: number }> {
  const settings = await prisma.notificationSettings.findUnique({
    where: { storeId },
    select: { operationalDailyCap: true, operationalRecipientDailyCap: true },
  });
  return {
    store: settings?.operationalDailyCap ?? DEFAULT_OPERATIONAL_DAILY_CAP,
    recipient: settings?.operationalRecipientDailyCap ?? DEFAULT_OPERATIONAL_RECIPIENT_DAILY_CAP,
  };
}

/**
 * What this store has ALREADY SENT today on the operational channel — in total,
 * and to one address. Mirrors `marketingSentToday`: deferred and failed rows do
 * not count, because the cap limits what lands in inboxes rather than what the
 * queue attempted.
 */
export async function operationalSentToday(
  storeId: string,
  recipient: string,
  now: Date
): Promise<{ store: number; recipient: number }> {
  const window = { gte: startOfDayUtc(now), lt: nextDayUtc(now) };
  const [store, toRecipient] = await Promise.all([
    prisma.notificationOutbox.count({
      where: { storeId, status: "sent", sentAt: window, eventKind: { kind: "operational" } },
    }),
    prisma.notificationOutbox.count({
      where: {
        storeId,
        recipient,
        status: "sent",
        sentAt: window,
        eventKind: { kind: "operational" },
      },
    }),
  ]);
  return { store, recipient: toRecipient };
}

/**
 * ق-188 — the platform wakes its owner when something is silently broken.
 *
 * ============================================================================
 * WHAT WAS ACTUALLY MISSING
 * ============================================================================
 *
 * Phase 24-أ shipped real observability: structured JSON logs, a correlation id
 * on every request and every job pass, actor and store stamped into the context,
 * one `request.failed` line per unmapped 5xx, and a `/ready` that checks the
 * database, the search engine, the mail provider and six config groups.
 *
 * Every one of those is READ BY A HUMAN WHO ALREADY SUSPECTS A PROBLEM. Nothing
 * in the platform ever reached out. A message that dead-lettered — a password
 * reset, an order confirmation, a trial-ending notice — was abandoned in a table
 * nobody opens, and the first news of it was a merchant asking why his shopper
 * never heard from him. `docs/DISASTER_RECOVERY.md` says this in as many words:
 * nothing alerts on a backup that stops running.
 *
 * ============================================================================
 * WHAT THIS CAN AND CANNOT SEE — STATED, NOT IMPLIED
 * ============================================================================
 *
 * This watcher is a NINTH interval inside the existing worker process, which
 * makes one limitation structural and worth naming rather than discovering:
 *
 *   IT CANNOT DETECT ITS OWN PROCESS BEING DEAD.
 *
 * If the worker crashes and `server/index.ts` fails to respawn it, no check
 * here runs and no mail goes out — silence looks exactly like health. Closing
 * that needs a prober OUTSIDE this process (a Railway cron, or an uptime
 * service hitting `/ready`), which is recorded as debt rather than pretended
 * away here. What this DOES close is the larger everyday gap: the queue that
 * quietly stops draining, and the messages that quietly give up.
 *
 * The alert channel is email, and email is part of what can fail. So the checks
 * below are deliberately ones whose failure still leaves mail deliverable: a
 * dead-lettered row means the provider answered and refused, not that the
 * transport is gone. A watcher that tried to email about email being down would
 * be theatre.
 *
 * ============================================================================
 * WHY THE ROW IS THE STATE
 * ============================================================================
 *
 * One row per open alert, and its EXISTENCE is the condition being live. That
 * makes repetition impossible by construction: a condition that persists for a
 * week is one email, because the second pass finds the row already there and
 * says nothing. The fastest way to make an alert channel worthless is to let it
 * repeat until the reader filters it away.
 *
 * The recovery notice matters as much as the alert. An owner told that his
 * queue stalled and never told it recovered will either assume the worst or
 * learn to ignore the channel; both end with him not reading it.
 *
 * Delivery goes DIRECTLY through the provider, never through the outbox. That
 * is not an optimisation — the outbox is one of the things being watched, and
 * an alert about a stalled queue that is itself enqueued in that queue would be
 * delivered exactly when it is no longer needed.
 */
import { prisma } from "../db/prisma.js";
import { logger } from "../logging/logger.js";
import type { NotificationProvider } from "../notifications/notification-provider.js";
import { supportReplyTo } from "../notifications/notification-provider.js";

/** Mirrored by the CHECK constraint on `platform_health_alerts.kind`. */
export const HEALTH_ALERT_KINDS = ["outbox_dead_letters", "outbox_stalled"] as const;
export type HealthAlertKind = (typeof HEALTH_ALERT_KINDS)[number];

/**
 * Five minutes. Short enough that a stalled queue is caught inside one delivery
 * window, long enough that the two counting queries are invisible.
 */
export const HEALTH_WATCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How far past its due time a row must sit before the queue counts as stalled.
 * The outbox loop polls every five seconds, so fifteen minutes is not a tight
 * deadline being missed — it is a loop that has stopped running or is failing
 * every pass.
 */
const STALLED_AFTER_MS = 15 * 60 * 1000;

/** Dead letters are counted over a day, so one bad hour does not alert forever. */
const DEAD_LETTER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface HealthCheck {
  kind: HealthAlertKind;
  failing: boolean;
  /** Arabic, and written for the person woken by it: what, how much, what next. */
  detail: string;
}

export async function evaluateHealth(now = new Date()): Promise<HealthCheck[]> {
  const [deadLetters, stalled] = await Promise.all([
    prisma.notificationOutbox.count({
      where: { status: "dead_letter", updatedAt: { gte: new Date(now.valueOf() - DEAD_LETTER_WINDOW_MS) } },
    }),
    prisma.notificationOutbox.count({
      where: { status: { in: ["pending", "retry_scheduled"] }, nextAttemptAt: { lt: new Date(now.valueOf() - STALLED_AFTER_MS) } },
    }),
  ]);

  return [
    {
      kind: "outbox_dead_letters",
      failing: deadLetters > 0,
      detail: `${deadLetters} رسالة استسلمت نهائياً خلال آخر ٢٤ ساعة. كلّ واحدة منها شخصٌ لم تصله رسالته — تأكيد طلب، أو رابط استعادة كلمة سرّ. افحص notification_outbox حيث status = 'dead_letter' واقرأ عمود last_outcome: هو يسمّي سبب الرفض.`,
    },
    {
      kind: "outbox_stalled",
      failing: stalled > 0,
      detail: `${stalled} رسالة تجاوز موعد إرسالها بأكثر من ١٥ دقيقة. حلقة الإرسال تعمل كلّ خمس ثوانٍ، فتأخّرٌ بهذا الحجم يعني أنّها متوقّفة أو تفشل في كلّ مرور. افحص سجلّ العامل بحثاً عن job.failed للمهمّة outbox.`,
    },
  ];
}

/** Every platform owner who can still sign in. */
async function alertRecipients(): Promise<string[]> {
  const owners = await prisma.platformOwner.findMany({ where: { isActive: true }, select: { email: true } });
  return owners.map((owner) => owner.email);
}

/**
 * NOT named `send`. `tests/list-envelope.guard.mjs` indexes every function in
 * `services/` BY NAME and concatenates same-named bodies, so a private helper
 * called `send` here merged into the guard's view of `response.send(...)` in the
 * prescription routes and made two of them look like unpaginated collections.
 * The guard was right to be naive and this name was wrong to be generic.
 */
async function mailOwners(provider: NotificationProvider, subject: string, body: string): Promise<number> {
  const recipients = await alertRecipients();
  if (!recipients.length) {
    // Not an error: a platform with no active owner has nobody to wake. Said
    // out loud so a silent channel is never mistaken for a healthy one.
    logger.warn("health.no_recipients", { job: "health-watch" });
    return 0;
  }
  let delivered = 0;
  for (const to of recipients) {
    const outcome = await provider.sendEmail({ to, subject, body, replyTo: supportReplyTo("account") });
    if (outcome.ok) delivered += 1;
    else logger.error("health.alert_undelivered", { job: "health-watch", outcome: outcome.outcome });
  }
  return delivered;
}

export interface HealthWatchResult {
  opened: HealthAlertKind[];
  resolved: HealthAlertKind[];
  stillOpen: HealthAlertKind[];
  notified: number;
}

/**
 * One pass: evaluate, then reconcile the alert table against reality. Opening
 * and resolving both notify; an unchanged condition says nothing at all.
 */
export async function runHealthWatch(provider: NotificationProvider | null, now = new Date()): Promise<HealthWatchResult> {
  const result: HealthWatchResult = { opened: [], resolved: [], stillOpen: [], notified: 0 };
  const checks = await evaluateHealth(now);
  const open = new Set((await prisma.platformHealthAlert.findMany({ select: { kind: true } })).map((row) => row.kind));

  for (const check of checks) {
    if (check.failing && !open.has(check.kind)) {
      // The row is written FIRST. If the mail then fails, the alert is still
      // recorded and will not re-fire every five minutes against a provider
      // that is refusing — the undelivered line in the log is the trail.
      await prisma.platformHealthAlert.create({ data: { kind: check.kind, openedAt: now, lastNotifiedAt: now, detail: check.detail } });
      result.opened.push(check.kind);
      logger.error("health.alert_opened", { job: "health-watch", kind: check.kind, detail: check.detail });
      if (provider) result.notified += await mailOwners(provider, `تنبيه من Codiq: ${ALERT_TITLES[check.kind]}`, `${check.detail}\n\nهذه رسالة آليّة من مراقب صحّة المنصّة. سيصلك إشعارٌ آخر حين تنتهي الحالة.`);
    } else if (check.failing) {
      result.stillOpen.push(check.kind);
    } else if (open.has(check.kind)) {
      await prisma.platformHealthAlert.delete({ where: { kind: check.kind } });
      result.resolved.push(check.kind);
      logger.info("health.alert_resolved", { job: "health-watch", kind: check.kind });
      if (provider) result.notified += await mailOwners(provider, `انتهت: ${ALERT_TITLES[check.kind]}`, `الحالة التي نبّهناك إليها لم تعد قائمة. لا إجراء مطلوب.`);
    }
  }

  return result;
}

const ALERT_TITLES: Record<HealthAlertKind, string> = {
  outbox_dead_letters: "رسائل استسلمت نهائياً",
  outbox_stalled: "طابور الرسائل متوقّف",
};

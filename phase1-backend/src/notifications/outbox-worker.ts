/**
 * codiq phase 15 — outbox worker (ADR-004).
 * Claims due rows with an atomic, token-stamped update so two workers can never
 * send the same row twice, delivers through the provider abstraction, and applies
 * exponential backoff with a dead-letter terminal state. The worker is
 * deterministic and database-driven; tests call processOutboxBatch directly.
 */
import { stockForecastFor } from "../services/stock-forecast.service.js";
import crypto from "node:crypto";
import { openSecret } from "../auth/secret-box.js";
import { prisma } from "../db/prisma.js";
import {
  deferredUntil,
  marketingDailyCap,
  marketingSentToday,
  marketingSentTodayToRecipient,
  MARKETING_RECIPIENT_DAILY_CAP,
  isUnsubscribed,
  notificationKind,
  operationalCaps,
  operationalSentToday,
  publicUrl,
  unsubscribeUrl,
} from "./messaging-compliance.service.js";
import type { NotificationProvider, ProviderResult } from "./notification-provider.js";
import { supportReplyTo, supportReplyToFromEnv } from "./notification-provider.js";
import { storeSupportReplyTo } from "../services/storefront-config.service.js";
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";
import { courierDispatchedMessage } from "./courier-message.js";
import { MAINTENANCE_NOTICE_EVENTS, maintenanceMessage } from "./maintenance-message.js";

/**
 * ق-184 + ق-199: who a reply to this message should reach. The platform's own
 * audiences answer to the platform; a store's customer answers to the store,
 * when the store has a support address — and to nobody otherwise, which is the
 * deliberate «no path is better than the wrong path» of ق-184.
 */
async function replyToFor(row: {
  recipientKind: string;
  storeId: string | null;
}): Promise<string | undefined> {
  if (row.recipientKind === "customer")
    return row.storeId ? storeSupportReplyTo(row.storeId) : undefined;
  return supportReplyTo(row.recipientKind);
}

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BASE_RETRY_SECONDS = 30;
export const STALE_CLAIM_RECOVERY_MS = 5 * 60 * 1000;
const CLAIMABLE_STATUSES = ["pending", "retry_scheduled"] as const;

export interface OutboxBatchResult {
  claimed: number;
  sent: number;
  retried: number;
  deadLettered: number;
  skipped: number;
  /** PG-3: held for the store's next daily window. Late, not lost. */
  deferred: number;
}

interface RenderedMessage {
  subject: string;
  body: string;
}

/**
 * PG-3: a relative path is not a link in an email.
 *
 * Payloads store relative paths on purpose — they are a durable snapshot of
 * WHICH page and they survive a domain change — so the renderer is where they
 * become absolute. Before this, «تابع طلبك من هنا: /store/x/track» went out
 * verbatim: an unclickable string in a customer's inbox.
 *
 * When no public base URL is configured the whole line is dropped rather than
 * shipping the broken path. Operational mail is still worth sending without its
 * link; a marketing message without its unsubscribe link is not, and the send
 * guard below refuses it.
 */
function linkLine(prefix: string, relativePath: unknown): string {
  const path = typeof relativePath === "string" && relativePath ? relativePath : null;
  const absolute = path ? publicUrl(path) : null;
  return absolute ? `\n${prefix} ${absolute}` : "";
}

export function renderMessage(row: {
  eventType: string;
  recipientKind: string;
  payload: unknown;
}): RenderedMessage {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const storeName = String(payload.storeName ?? "متجرك");
  if (row.eventType === "order.created") {
    const orderNumber = String(payload.orderNumber ?? "");
    if (row.recipientKind === "merchant") {
      return {
        subject: `طلب جديد ${orderNumber}`,
        body: `وصل طلب جديد إلى ${storeName}.\nرقم الطلب: ${orderNumber}\nالزبون: ${String(payload.customerName ?? "")}\nالإجمالي: ${String(payload.totalIqd ?? "")} د.ع`,
      };
    }
    return {
      subject: `تأكيد طلبك ${orderNumber}`,
      body: `استلمنا طلبك من ${storeName}.\nرقم الطلب: ${orderNumber}\nالإجمالي: ${String(payload.totalIqd ?? "")} د.ع\nسنعلمك عند تغير حالة الطلب.`,
    };
  }
  if (row.eventType === "order.status_changed") {
    const orderNumber = String(payload.orderNumber ?? "");
    return {
      subject: `تحديث حالة الطلب ${orderNumber}`,
      body: `تغيرت حالة الطلب ${orderNumber} في ${storeName} من ${String(payload.fromStatus ?? "")} إلى ${String(payload.toStatus ?? "")}.`,
    };
  }
  // CD-1b: «مندوبك في الطريق» — the courier-dispatched notice, customers only.
  if (row.eventType === "order.courier_dispatched")
    return courierDispatchedMessage(storeName, payload, linkLine);
  // Phase 20B-2: abandoned-cart recovery message (customers with email only).
  if (row.eventType === "cart.abandoned") {
    const couponCode =
      typeof payload.couponCode === "string" && payload.couponCode ? payload.couponCode : null;
    return {
      subject: `سلتك في ${storeName} بانتظارك`,
      body:
        `تركت ${String(payload.itemCount ?? "")} من المنتجات في سلتك لدى ${storeName} بقيمة ${String(payload.totalIqd ?? "")} د.ع.` +
        linkLine("أكمل طلبك من هنا:", payload.cartUrl) +
        (couponCode ? `\nاستخدم الكوبون ${couponCode} عند إتمام الطلب للحصول على خصمك.` : ""),
    };
  }
  // PR-1: «استعادة كلمة السر». Above the fallback for the same reason every
  // other branch is — an unmatched event type renders as a LOW-STOCK ALERT, and
  // a person recovering his account would be told his stock is running out.
  //
  // The link arrives SEALED (secret-box, purpose `password-reset-link`) because
  // `password_reset_tokens` stores only a hash and a plaintext link in
  // `payload` would put that same secret back into the database. It is opened
  // HERE, at send time, and the plaintext exists only for the length of this
  // function. A row whose envelope will not open is a row that was tampered
  // with or sealed under a withdrawn key: `openSecret` throws, the worker's
  // catch turns that into a retry and then a dead letter, which is the correct
  // ending — a reset mail that cannot be built must never go out half-written.
  if (row.eventType === "auth.password_reset") {
    const minutes = String(payload.expiresInMinutes ?? 45);
    const link = openSecret("password-reset-link", String(payload.resetUrlSealed ?? ""));
    return {
      subject: "استعادة كلمة السر في Codiq",
      body:
        `وصلنا طلب لإعادة تعيين كلمة السر لحسابك.` +
        `\n\nافتح الرابط التالي واختر كلمة سر جديدة:\n${link}` +
        `\n\nالرابط صالح لمدة ${minutes} دقيقة، ولمرة واحدة فقط.` +
        `\nعند استخدامه ستُنهى كل الجلسات المفتوحة على حسابك، ويلزمك تسجيل الدخول من جديد.` +
        // Said plainly, because the person who did NOT ask is the one who most
        // needs to know what to do: nothing. No account changes until the link
        // is opened, so ignoring the message is a complete answer.
        `\n\nإن لم تطلب هذا، فلا حاجة لأي إجراء — لم يتغير شيء في حسابك، والرابط ينتهي وحده.`,
    };
  }
  // ق-250: a maintenance window that touches this merchant (scheduled, ended, cancelled).
  if ((MAINTENANCE_NOTICE_EVENTS as readonly string[]).includes(row.eventType))
    return maintenanceMessage(row.eventType, payload);
  // ق-186 (D-90): the trial is ending. The one message that turns a silent
  // downgrade into a decision he was actually offered.
  //
  // It names the date, the days left and the plan he lands on, and it says
  // plainly that nothing is deleted and no shop closes — because the fear this
  // message creates ("do I lose my shop?") is worse than the fact, and a
  // merchant who is frightened by his own platform does not come back to read
  // the second paragraph. ق-128's job guarantees the landing is real: he moves
  // to the free plan, he is never left without a subscription.
  if (row.eventType === "trial.ending") {
    const days = Number(payload.daysLeft ?? 3);
    const endsAt = payload.endsAt ? new Date(String(payload.endsAt)) : null;
    const date = endsAt ? endsAt.toISOString().slice(0, 10) : null;
    const remaining = days === 1 ? "غداً" : days === 2 ? "بعد يومين" : `بعد ${days} أيام`;
    // The closing invitation is conditional on ق-184's reply address actually
    // existing. Telling a merchant to «reply to this message» when the platform
    // set no Reply-To would send him at `no-reply@` and bounce — a promise the
    // deployment cannot keep is worse than no invitation at all.
    const replyTo = supportReplyToFromEnv();
    return {
      subject: `تجربتك المجانية في Codiq تنتهي ${remaining}`,
      body:
        `تنتهي تجربتك المجانية ${remaining}${date ? ` (${date})` : ""}.` +
        `\n\nبعدها ينتقل حسابك تلقائياً إلى الخطة المجانية. متجرك يبقى مفتوحاً، وطلباتك وزبائنك ومنتجاتك كما هي — لا يُحذف شيء ولا يتوقف بيع.` +
        `\nالذي يتغير هو حدود الخطة فقط.` +
        (replyTo
          ? `\n\nإن أردت البقاء على خطتك الحالية، راسلنا بالرد على هذه الرسالة قبل انتهاء المدة.`
          : ``),
    };
  }
  // MD-3: the merchant's own daily summary. This sits ABOVE the fallback below,
  // which renders ANY unmatched event type as a low-stock alert — a digest
  // landing there would reach him dressed as a stock warning.
  if (row.eventType === "merchant.daily_digest") {
    const waiting = Number(payload.ordersWaiting ?? 0);
    return {
      subject: `ملخص يومك في ${storeName} — ${String(payload.date ?? "")}`,
      body:
        `طلبات اليوم: ${String(payload.ordersToday ?? 0)}` +
        `\nمبيعات اليوم: ${String(payload.revenueTodayIqd ?? 0)} د.ع` +
        // Said only when there is something to act on. A line reading «0 بانتظارك»
        // every evening is how a merchant learns to skim past the evening it says 12.
        (waiting > 0 ? `\n\n${waiting} طلباً ينتظر تجهيزك.` : ""),
    };
  }
  // CD-2: back in stock. Above the fallback below for the same reason every
  // other branch is — an unmatched event type renders as a LOW-STOCK ALERT, so
  // a shopper would be told his shirt is running out at the shop he does not own.
  if (row.eventType === "stock.back_in_stock") {
    const productName = String(payload.productName ?? "");
    return {
      subject: `${productName} عاد للتوفر في ${storeName}`,
      body:
        `طلبت أن نُنبّهك عندما يعود «${productName}» — وقد عاد الآن إلى ${storeName}.` +
        `\nالسعر: ${String(payload.priceIqd ?? "")} د.ع` +
        linkLine("اطلبه من هنا:", payload.productUrl) +
        // Said plainly: this is a one-time answer to one request, not a
        // subscription he now has to escape from.
        `\n\nهذا تنبيه لمرة واحدة عن طلبك. إن أردت تنبيهاً آخر لاحقاً، أعد طلبه من قائمة رغباتك.`,
    };
  }
  return {
    subject: `تنبيه مخزون منخفض — ${String(payload.productName ?? "")}`,
    body:
      `انخفض مخزون المنتج ${String(payload.productName ?? "")} (SKU: ${String(payload.sku ?? "")}) في ${storeName} إلى ${String(payload.stockQuantity ?? "")} قطعة.` +
      // MD-3: the forecast is attached by the worker at SEND time, not at enqueue
      // time — he may have restocked since — and is absent entirely when the
      // product has not sold enough for a rate to mean anything.
      (typeof payload.daysRemaining === "number"
        ? `\nبمعدل بيعك في آخر ${String(payload.forecastWindowDays ?? 14)} يوماً، يكفي هذا المخزون ~${String(payload.daysRemaining)} يوماً.`
        : ""),
  };
}

/**
 * MD-3: attaches «سينفد خلال ~N أيام» to a low-stock alert, at SEND time.
 *
 * Not at enqueue time: that write happens inside the stock transaction on the
 * checkout path, and a forecast query there would put two extra reads in front
 * of every sale. Here the worker is already out of the request path, and the
 * figure is also fresher — the merchant may have restocked since the alert was
 * queued, in which case the estimate that goes out is the one that is true when
 * it is read.
 *
 * A failure adds nothing and loses nothing: the alert itself is the message, and
 * the forecast is a courtesy on top of it.
 */
// Generic on the row type, not narrowed to the three fields this function reads:
// a concrete parameter type would hand `renderMessage` back a row stripped of
// `recipientKind`, which it needs to tell a merchant's copy from a customer's.
async function withStockForecast<
  T extends { eventType: string; storeId: string | null; payload: unknown },
>(row: T): Promise<T> {
  // PR-1: `storeId` is nullable now. A low-stock alert always has one — the
  // CHECK constraint sees to that — so this is a type narrowing rather than a
  // new case, and a forecast is a courtesy that adds nothing when it cannot run.
  if (row.eventType !== "low_stock" || !row.storeId) return row;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const variantId = typeof payload.variantId === "string" ? payload.variantId : null;
  if (!variantId) return row;
  try {
    const forecast = await stockForecastFor(row.storeId, variantId);
    if (!forecast) return row;
    return {
      ...row,
      payload: {
        ...payload,
        daysRemaining: forecast.daysRemaining,
        forecastWindowDays: forecast.windowDays,
      },
    };
  } catch {
    return row;
  }
}

export function retryDelaySeconds(attemptCount: number): number {
  return OUTBOX_BASE_RETRY_SECONDS * 2 ** Math.max(0, attemptCount - 1);
}

export async function processOutboxBatch(
  provider: NotificationProvider | null,
  options: { batchSize?: number; now?: Date } = {}
): Promise<OutboxBatchResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 20;
  const result: OutboxBatchResult = {
    claimed: 0,
    sent: 0,
    retried: 0,
    deadLettered: 0,
    skipped: 0,
    deferred: 0,
  };

  // A deploy or crash strands claimed rows in "processing" forever; anything held
  // past the stale window is returned to the queue before this batch claims.
  await prisma.notificationOutbox.updateMany({
    where: {
      status: "processing",
      claimedAt: { lt: new Date(now.valueOf() - STALE_CLAIM_RECOVERY_MS) },
    },
    data: {
      status: "retry_scheduled",
      nextAttemptAt: now,
      claimToken: null,
      claimedAt: null,
      lastOutcome: "stale_claim_recovered",
    },
  });

  // PG-3: operational mail outranks marketing, always and across every store.
  //
  // Without this, a single store that switches on abandoned-cart recovery piles
  // up a backlog of deferred marketing rows, and because a deferred row carries
  // an EARLIER nextAttemptAt than a newly created one, that backlog sits at the
  // head of the queue. A shopper in an entirely different store then waits for
  // the whole pile before her order confirmation goes out — measured at 8.3
  // minutes for 2000 deferred rows, and it recurs every night.
  //
  // The priority column makes the rule explicit rather than relying on the
  // accident that «marketing» sorts before «operational».
  const due = await prisma.notificationOutbox.findMany({
    where: { status: { in: [...CLAIMABLE_STATUSES] }, nextAttemptAt: { lte: now } },
    orderBy: [{ eventKind: { priority: "asc" } }, { nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: batchSize,
    select: { id: true },
  });
  if (!due.length) return result;

  // The claim re-checks status, so rows grabbed by a competing worker are skipped here.
  const claimToken = crypto.randomUUID();
  await prisma.notificationOutbox.updateMany({
    where: {
      id: { in: due.map((row) => row.id) },
      status: { in: [...CLAIMABLE_STATUSES] },
      nextAttemptAt: { lte: now },
    },
    data: { status: "processing", claimToken, claimedAt: now },
  });
  const claimed = await prisma.notificationOutbox.findMany({
    where: { claimToken, status: "processing" },
  });
  result.claimed = claimed.length;

  for (const row of claimed) {
    if (!provider) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: "skipped",
          lastOutcome: "no_provider_configured",
          claimToken: null,
          claimedAt: null,
        },
      });
      result.skipped += 1;
      continue;
    }
    if (!row.recipient) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: "skipped",
          lastOutcome: "no_recipient_address",
          claimToken: null,
          claimedAt: null,
        },
      });
      result.skipped += 1;
      continue;
    }
    // ---------------------------------------------------- PG-3 compliance gate
    // Everything below runs BEFORE the provider is touched, so a message that
    // must not go out never reaches it.
    const message = renderMessage(await withStockForecast(row));
    const kind = await notificationKind(row.eventType);
    // PR-1: `storeId` is nullable now, and every gate below this line is
    // per-store. A storeless message has no store whose cap could apply and no
    // store whose suppression list could speak for it, so both blocks are
    // skipped — not as an exemption granted to account-recovery mail, but
    // because there is genuinely nothing to ask.
    //
    // That this is also the RIGHT answer for a reset link is not a coincidence:
    // the caps DEFER over-cap mail to tomorrow, and a token that dies in 45
    // minutes cannot be deferred to tomorrow. The migration argues the same
    // point from the other side — this event's ceiling lives at the request
    // door, before a row is written, which is where a public endpoint's ceiling
    // belongs anyway.
    if (kind === "operational" && row.storeId) {
      // 19-د (ATTACK-SURFACE): the operational channel has ceilings now.
      //
      // Every gate below the `marketing` branch used to be the WHOLE compliance
      // story, and operational rows walked from the claim straight to the
      // provider — no cap, no opt-out, and a recipient address the platform had
      // never proven belongs to the recipient. A hostile merchant needed one
      // self-registered store and one customer row carrying the victim's email
      // to point the platform's own sending identity at a stranger, indefinitely.
      //
      // DEFERRED, NEVER DROPPED — the same rule the marketing cap follows, and
      // it matters more here: an order confirmation that arrives late is an
      // inconvenience, one silently discarded is the outage this module's header
      // says a merchant blames on the platform. Over the cap something is wrong
      // regardless; tomorrow is the safe side to err on. attemptCount is left
      // alone deliberately — waiting is not a failed attempt.
      //
      // ق-214 — THE PER-RECIPIENT CEILING IS THE SHOPPER'S, NOT THE MERCHANT'S.
      //
      // Everything the 19-د comment above reasons about is a message the store
      // causes to be sent to a THIRD PARTY at an address the platform never
      // proved belongs to him. The merchant's own address is not that: it is the
      // login identity of the account that owns the store, and mail to it is the
      // account telling its owner about itself. Counting both in one bucket meant
      // a merchant's routine day — seven statuses on three orders — spent the
      // twenty, after which «طلب جديد» (the trigger for the COD confirmation
      // call, and the most expensive message on this platform to lose) was
      // deferred to tomorrow. The STORE ceiling still bounds him, which is the
      // dimension that actually protects the sending domain.
      const [caps, sentToday] = await Promise.all([
        operationalCaps(row.storeId),
        operationalSentToday(row.storeId, row.recipient, now),
      ]);
      const exceeded =
        row.recipientKind !== "merchant" && sentToday.recipient >= caps.recipient
          ? `recipient_daily_cap_deferred:${caps.recipient}`
          : sentToday.store >= caps.store
            ? `store_daily_cap_deferred:${caps.store}`
            : null;
      if (exceeded) {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          // Spread like the marketing deferral, for the same reason: landing
          // every held message on the same instant rebuilds tomorrow the pile-up
          // the cap exists to prevent.
          data: {
            status: "retry_scheduled",
            nextAttemptAt: deferredUntil(now, row.id),
            lastOutcome: exceeded,
            claimToken: null,
            claimedAt: null,
          },
        });
        result.deferred += 1;
        continue;
      }
    }
    // PR-1: a MARKETING row with no store is refused outright rather than
    // waved through. Every marketing guard below — the suppression list, the
    // cap, the unsubscribe link — is scoped to a store, so a storeless
    // marketing message would skip all three and go out with no way to opt out
    // of it. `notification_outbox_store_scope` makes such a row unwritable
    // today; this is the second line, because the day someone widens that CHECK
    // the failure would otherwise be silent and pointed at the platform's
    // sending reputation.
    if (kind === "marketing" && !row.storeId) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: "dead_letter",
          lastOutcome: "marketing_without_store",
          claimToken: null,
          claimedAt: null,
        },
      });
      result.deadLettered += 1;
      continue;
    }
    if (kind === "marketing" && row.storeId) {
      if (await isUnsubscribed(row.storeId, row.recipient)) {
        // Terminal, not a retry: consent does not come back on its own.
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: "skipped",
            lastOutcome: "recipient_unsubscribed",
            claimToken: null,
            claimedAt: null,
          },
        });
        result.skipped += 1;
        continue;
      }

      // ق-207: the per-recipient ceiling, checked BEFORE the store cap so a
      // flood aimed at one address is refused whatever store it rides on.
      // Terminal, with the reason on the row — see MARKETING_RECIPIENT_DAILY_CAP.
      if (
        (await marketingSentTodayToRecipient(row.recipient, now)) >= MARKETING_RECIPIENT_DAILY_CAP
      ) {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: "skipped",
            lastOutcome: `recipient_daily_cap:${MARKETING_RECIPIENT_DAILY_CAP}`,
            claimToken: null,
            claimedAt: null,
          },
        });
        result.skipped += 1;
        continue;
      }

      const [cap, sentToday] = await Promise.all([
        marketingDailyCap(row.storeId),
        marketingSentToday(row.storeId, now),
      ]);
      if (cap === 0) {
        // A cap of zero means the store does not send marketing at all, so this
        // is terminal, not a deferral. Deferring it would schedule the row for
        // tomorrow, and tomorrow, forever — a queue that grows and never drains
        // is the opposite of «disabled». The scanner already refuses to enqueue
        // for such a store; this is the second line for rows created elsewhere.
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: "skipped",
            lastOutcome: "marketing_disabled_for_store",
            claimToken: null,
            claimedAt: null,
          },
        });
        result.skipped += 1;
        continue;
      }
      if (sentToday >= cap) {
        // DEFERRED, never dropped. A cap that silently discards is worse than
        // no cap: the merchant sees a send that never happened. attemptCount is
        // deliberately untouched — waiting for tomorrow is not a failed attempt
        // and must not consume the retry budget or reach the dead letter.
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          // Spread, not stacked: scheduling every deferral on the same instant
          // rebuilds tomorrow the exact pile-up the cap exists to prevent.
          data: {
            status: "retry_scheduled",
            nextAttemptAt: deferredUntil(now, row.id),
            lastOutcome: `daily_cap_deferred:${cap}`,
            claimToken: null,
            claimedAt: null,
          },
        });
        result.deferred += 1;
        continue;
      }

      const optOut = unsubscribeUrl(row.storeId, row.recipient);
      if (!optOut) {
        // No public base URL configured means no working unsubscribe link. The
        // acceptance rule is explicit: a marketing message without one FAILS
        // rather than going out incomplete. Terminal, because retrying cannot
        // fix a missing configuration and each retry would be another attempt
        // to send a non-compliant message.
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: "dead_letter",
            lastOutcome: "missing_unsubscribe_link",
            claimToken: null,
            claimedAt: null,
          },
        });
        result.deadLettered += 1;
        continue;
      }
      message.body +=
        `\n\n———\nلا ترغب بهذه التذكيرات؟ ألغِ اشتراكك بضغطة: ${optOut}` +
        `\nهذا يوقف الرسائل التسويقية من هذا المتجر فقط — وتبقى إشعارات طلباتك تصلك.`;
      // Belt and braces: the line above is the only writer, but the invariant
      // that matters is «no marketing message leaves without a link», and an
      // invariant is worth asserting where it is relied upon.
      if (!message.body.includes(optOut)) {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: "dead_letter",
            lastOutcome: "missing_unsubscribe_link",
            claimToken: null,
            claimedAt: null,
          },
        });
        result.deadLettered += 1;
        continue;
      }
    }

    let outcome: ProviderResult;
    try {
      outcome =
        row.channel === "sms"
          ? await provider.sendSms({ to: row.recipient, body: message.body })
          : // ق-184: the reply path is per-audience, decided by `supportReplyTo` —
            // the platform's own mail (merchant, account) carries the platform's
            // address. ق-199 supplies the other half: a SHOPPER's mail carries the
            // STORE's support address, when the merchant has written one, so a
            // reply to an order confirmation reaches the shop and not the platform.
            // This is the ONE place a message becomes an email, so it is the one
            // place the decision can be made once.
            await provider.sendEmail({
              to: row.recipient,
              subject: message.subject,
              body: message.body,
              replyTo: await replyToFor(row),
            });
    } catch (error) {
      outcome = {
        ok: false,
        outcome: error instanceof Error ? `provider_threw:${error.name}` : "provider_threw",
      };
    }

    if (outcome.ok) {
      // `now`, not `new Date()`. The daily cap counts rows whose sentAt falls in
      // the window derived from `now`, so stamping the send from a different
      // clock means a send need not land in the window it was counted against —
      // and the cap stops being a cap. It also makes the cap testable without
      // the suite having to rewrite sentAt by hand afterwards, which is what it
      // was doing: the assertion passed because of the fixture, not the code.
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: "sent",
          sentAt: now,
          lastOutcome: outcome.outcome,
          attemptCount: { increment: 1 },
          claimToken: null,
          claimedAt: null,
        },
      });
      result.sent += 1;
      continue;
    }

    const attemptCount = row.attemptCount + 1;
    if (attemptCount >= OUTBOX_MAX_ATTEMPTS) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: "dead_letter",
          attemptCount,
          lastOutcome: outcome.outcome,
          claimToken: null,
          claimedAt: null,
        },
      });
      result.deadLettered += 1;
    } else {
      const nextAttemptAt = new Date(now.valueOf() + retryDelaySeconds(attemptCount) * 1000);
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: "retry_scheduled",
          attemptCount,
          nextAttemptAt,
          lastOutcome: outcome.outcome,
          claimToken: null,
          claimedAt: null,
        },
      });
      result.retried += 1;
    }
  }
  return result;
}

/**
 * Continuous loop for the standalone worker process; guarded against overlap.
 *
 * D-41 (phase 24-أ): every PASS runs inside its own correlation id, so a
 * notification that failed to send is traceable to the run that tried — which
 * is the only way «this message never arrived» becomes a line to read rather
 * than a guess about which of the last few hundred passes it was in.
 */
export interface OutboxWorkerOptions {
  /** While there is work to drain. */
  fastMs?: number;
  /** The ceiling the idle backoff climbs to. Pass the scheduler's tick: it is the floor under every message. */
  idleMaxMs?: number;
  /** How long one signal keeps the loop in fast mode. */
  fastWindowMs?: number;
  /**
   * The pass itself. Production never passes it — the default is exactly what
   * this worker has always done. It exists so the BACKOFF can be tested without
   * a database: the loop's decisions are pure arithmetic over a batch result,
   * and making them reachable only through Postgres would mean the one thing
   * worth pinning here is the one thing nothing pins.
   */
  runPass?: () => Promise<OutboxBatchResult>;
}

export interface OutboxWorker {
  stop: () => void;
  /** «There is work.» Resets to fast and holds it for `fastWindowMs`. Idempotent and free to call often. */
  wake: () => void;
}

const OUTBOX_FAST_MS = 1_000;
const OUTBOX_FAST_WINDOW_MS = 60_000;

/**
 * ق-239 — IT ASKS FAST WHEN THERE IS WORK, AND ALMOST NEVER WHEN THERE IS NOT.
 *
 * A fixed five-second interval is 17,280 questions a day whose answer is «no
 * rows», and — because Neon suspends only after five minutes of silence — it is
 * also a guarantee the database never sleeps. That was measured, not guessed:
 * `production` 54.3 CU-h + `staging` 56.3 = 110.6 against a 100 CU-h quota, with
 * three test merchants and no customers. The bill was 100% empty wake-ups.
 *
 * Three rules replace the one interval:
 *
 *   DRAIN FAST. A pass that did anything schedules the next in a second. A queue
 *   that is moving must not be throttled — the old five seconds was slower here
 *   than this is.
 *
 *   BACK OFF WHEN IDLE. A pass that found nothing doubles its wait, up to
 *   `idleMaxMs`. Within a few minutes of quiet the gap exceeds Neon's suspend
 *   window and the compute is allowed to sleep, which is the entire point.
 *
 *   WAKE ON A SIGNAL, NOT ON A GUESS. `wake()` is called by the process that
 *   just WROTE an outbox row — which means the database is awake at that instant
 *   because that same transaction woke it. The signal therefore costs nothing at
 *   all, and the shopper's confirmation goes out in about a second instead of
 *   waiting out a backoff.
 *
 * AND WHY `LISTEN/NOTIFY` IS NOT USED, since it is the obvious answer and it is
 * wrong here: Neon severs the listening session when the compute suspends, and a
 * NOTIFY delivered while nobody is listening is gone — notifications are not
 * durable. Re-establishing the listener is itself a query, so holding one open
 * would keep the database awake: precisely the cost being removed. On a
 * scale-to-zero database the channel has to live OUTSIDE the database.
 *
 * The poll is the floor under all of it. If every signal were lost forever,
 * nothing would be stranded longer than `idleMaxMs`.
 */
export function startOutboxWorker(
  provider: NotificationProvider | null,
  options: OutboxWorkerOptions = {}
): OutboxWorker {
  const fastMs = options.fastMs ?? OUTBOX_FAST_MS;
  const idleMaxMs = Math.max(fastMs, options.idleMaxMs ?? 30 * 60 * 1000);
  const fastWindowMs = options.fastWindowMs ?? OUTBOX_FAST_WINDOW_MS;
  const runPass = options.runPass ?? (() => processOutboxBatch(provider));

  let running = false;
  let stopped = false;
  let delayMs = fastMs;
  let fastUntil = 0;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    // `unref` so a worker with nothing to do never holds the process open on its
    // own — shutdown is decided by SIGTERM, not by a pending timer.
    timer = setTimeout(() => {
      void pass();
    }, ms);
    timer.unref?.();
  };

  async function pass(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runJobPass("outbox", runPass);
      if (result.sent > 0 || result.deadLettered > 0 || result.retried > 0) {
        logger.info("job.pass", { job: "outbox", ...result });
      }
      // `claimed`, not `sent`: a pass that claimed rows and skipped every one of
      // them (no provider, no recipient) still DID work, and the next row may be
      // sendable. Keying the reset on `sent` alone would back off in exactly the
      // situation where a queue is being worked through.
      if (result.claimed > 0) delayMs = fastMs;
      else if (Date.now() < fastUntil) delayMs = fastMs;
      else delayMs = Math.min(delayMs * 2, idleMaxMs);
    } catch (error) {
      logger.error("job.failed", { job: "outbox", err: error });
      // A failing pass backs off too. Hammering a database that just refused a
      // query is how a transient fault becomes an outage.
      delayMs = Math.min(Math.max(delayMs * 2, fastMs), idleMaxMs);
    } finally {
      running = false;
      schedule(delayMs);
    }
  }

  schedule(fastMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    wake: () => {
      if (stopped) return;
      fastUntil = Date.now() + fastWindowMs;
      delayMs = fastMs;
      // Not «run now»: the signal fires from inside the enqueueing TRANSACTION,
      // so the row may not be committed yet. A single immediate poll could miss
      // it and then back off for a full window. The fast window polls until it
      // appears, and costs nothing — that transaction has the database awake.
      if (!running) schedule(fastMs);
    },
  };
}

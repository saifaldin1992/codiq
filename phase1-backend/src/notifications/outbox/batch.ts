/**
 * Outbox worker — batch. Split verbatim from outbox-worker.ts
 * (review batch 5, ت-١); outbox-worker.ts re-exports what it always exported.
 */
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { storeSupportReplyTo } from "../../services/storefront-config.service.js";
import {
  supportReplyTo,
  type NotificationProvider,
  type ProviderResult,
} from "../notification-provider.js";
import { prisma } from "../../db/prisma.js";
import {
  notificationKind,
  operationalCaps,
  operationalSentToday,
  deferredUntil,
  isUnsubscribed,
  marketingSentTodayToRecipient,
  MARKETING_RECIPIENT_DAILY_CAP,
  marketingDailyCap,
  marketingSentToday,
  unsubscribeUrl,
} from "../messaging-compliance.service.js";
import { renderMessage, withStockForecast } from "./render.js";

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

/** Ends this worker's hold on a row — only while the hold is still this worker's (ت-٢). */
async function settle(
  id: string,
  claimToken: string,
  data: Prisma.NotificationOutboxUpdateManyMutationInput
) {
  await prisma.notificationOutbox.updateMany({
    where: { id, claimToken },
    data: { ...data, claimToken: null, claimedAt: null },
  });
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
      await settle(row.id, claimToken, {
        status: "skipped",
        lastOutcome: "no_provider_configured",
      });
      result.skipped += 1;
      continue;
    }
    if (!row.recipient) {
      await settle(row.id, claimToken, {
        status: "skipped",
        lastOutcome: "no_recipient_address",
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
        // Spread like the marketing deferral, for the same reason: landing
        // every held message on the same instant rebuilds tomorrow the pile-up
        // the cap exists to prevent.
        await settle(row.id, claimToken, {
          status: "retry_scheduled",
          nextAttemptAt: deferredUntil(now, row.id),
          lastOutcome: exceeded,
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
      await settle(row.id, claimToken, {
        status: "dead_letter",
        lastOutcome: "marketing_without_store",
      });
      result.deadLettered += 1;
      continue;
    }
    if (kind === "marketing" && row.storeId) {
      if (await isUnsubscribed(row.storeId, row.recipient)) {
        // Terminal, not a retry: consent does not come back on its own.
        await settle(row.id, claimToken, {
          status: "skipped",
          lastOutcome: "recipient_unsubscribed",
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
        await settle(row.id, claimToken, {
          status: "skipped",
          lastOutcome: `recipient_daily_cap:${MARKETING_RECIPIENT_DAILY_CAP}`,
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
        await settle(row.id, claimToken, {
          status: "skipped",
          lastOutcome: "marketing_disabled_for_store",
        });
        result.skipped += 1;
        continue;
      }
      if (sentToday >= cap) {
        // DEFERRED, never dropped. A cap that silently discards is worse than
        // no cap: the merchant sees a send that never happened. attemptCount is
        // deliberately untouched — waiting for tomorrow is not a failed attempt
        // and must not consume the retry budget or reach the dead letter.
        // Spread, not stacked: scheduling every deferral on the same instant
        // rebuilds tomorrow the exact pile-up the cap exists to prevent.
        await settle(row.id, claimToken, {
          status: "retry_scheduled",
          nextAttemptAt: deferredUntil(now, row.id),
          lastOutcome: `daily_cap_deferred:${cap}`,
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
        await settle(row.id, claimToken, {
          status: "dead_letter",
          lastOutcome: "missing_unsubscribe_link",
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
        await settle(row.id, claimToken, {
          status: "dead_letter",
          lastOutcome: "missing_unsubscribe_link",
        });
        result.deadLettered += 1;
        continue;
      }
    }

    // Review batch 5, ت-٢: still ours? Two instances run a worker each, and a batch can outlive
    // STALE_CLAIM_RECOVERY_MS (20 rows × a 20-second provider timeout). Rows this batch has not
    // reached yet may have been recovered and sent by the other worker; re-claiming here refuses
    // them, and refreshing `claimedAt` keeps the row about to go out from being recovered while
    // it is in flight. Every write after this carries the token for the same reason.
    const stillOurs = await prisma.notificationOutbox.updateMany({
      where: { id: row.id, claimToken, status: "processing" },
      data: { claimedAt: new Date() },
    });
    if (stillOurs.count !== 1) continue;
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
      await settle(row.id, claimToken, {
        status: "sent",
        sentAt: now,
        lastOutcome: outcome.outcome,
        attemptCount: { increment: 1 },
      });
      result.sent += 1;
      continue;
    }

    const attemptCount = row.attemptCount + 1;
    if (attemptCount >= OUTBOX_MAX_ATTEMPTS) {
      await settle(row.id, claimToken, {
        status: "dead_letter",
        attemptCount,
        lastOutcome: outcome.outcome,
      });
      result.deadLettered += 1;
    } else {
      const nextAttemptAt = new Date(now.valueOf() + retryDelaySeconds(attemptCount) * 1000);
      await settle(row.id, claimToken, {
        status: "retry_scheduled",
        attemptCount,
        nextAttemptAt,
        lastOutcome: outcome.outcome,
      });
      result.retried += 1;
    }
  }
  return result;
}

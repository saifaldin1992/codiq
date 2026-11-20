/**
 * MD-3 «الرسائل الذكية» — the merchant's daily digest.
 *
 * A FOURTH overlap-guarded interval in the standalone worker process, beside the
 * outbox loop, the abandoned-cart scanner and the trash purger (ADR-004). It
 * only enqueues; delivery stays with the untouched outbox worker.
 *
 * ONE MESSAGE PER STORE PER DAY, STRUCTURALLY. The dedupe key is
 * `merchant_digest:{storeId}:{baghdadDate}` and notification_outbox carries
 * UNIQUE(store_id, dedupe_key), so a scan that runs twice — or two workers, or a
 * retry — collides in the database rather than in a flag someone has to
 * remember to check. That is the same guarantee the abandoned-cart scanner
 * relies on, and it is why the digest can be scanned every fifteen minutes
 * without anyone tracking what was already sent.
 *
 * THE DAY IS A BAGHDAD DAY. A merchant in Baghdad who reads «مبيعات اليوم» at
 * 20:00 means the day he has just worked, not a UTC window that ended at 03:00
 * that morning. Iraq is UTC+3 all year — no daylight saving — so the offset is a
 * constant and not a timezone table.
 *
 * THE DIGEST IS SENT AT HIS HOUR, NOT AT MIDNIGHT. The default is 20:00 Baghdad
 * and the window it reports is the whole calendar day, so an evening digest
 * covers a day with a few hours still left in it. That is deliberate — a summary
 * that arrives at 00:01 is a summary nobody reads — but it means the figures are
 * "the day so far", and the day it names is the one still running.
 *
 * A store with nothing to report is skipped: an email saying «0 طلبات» every
 * evening trains him to ignore the one that matters.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { runJobPass } from "../logging/context.js";
import { logger } from "../logging/logger.js";

export const MERCHANT_DIGEST_SCAN_INTERVAL_MS = 15 * 60 * 1000;
/** Iraq is UTC+3 all year. */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
/**
 * Stores read per database round trip. This is a PAGE SIZE, not a ceiling: the
 * pass keeps paging until the opted-in set is exhausted.
 *
 * That distinction is the whole point. The abandoned-cart scanner can take a
 * fixed page because its candidate set DRAINS — every cart it enqueues stops
 * matching. This set does not: a store stays opted in forever, so a single
 * unordered page would re-read the same arbitrary stores every fifteen minutes,
 * collide on the unique key, and leave every store outside that page without a
 * digest for good. The unique key makes repeats harmless; it does nothing for
 * coverage.
 */
const SCAN_PAGE_SIZE = 200;
/** Orders in these statuses are waiting on the merchant, not on the courier. */
const WAITING_STATUSES = ["new", "processing", "preparation"];

export interface MerchantDigestScanResult {
  eligibleStores: number;
  skippedTooEarly: number;
  skippedNothingToSay: number;
  enqueued: number;
  duplicates: number;
}

/** The Baghdad wall-clock hour and calendar date for an instant. */
export function baghdadClock(at: Date): { hour: number; date: string; dayStartUtc: Date; dayEndUtc: Date } {
  const shifted = new Date(at.getTime() + BAGHDAD_OFFSET_MS);
  const date = shifted.toISOString().slice(0, 10);
  const dayStartUtc = new Date(Date.parse(`${date}T00:00:00.000Z`) - BAGHDAD_OFFSET_MS);
  return { hour: shifted.getUTCHours(), date, dayStartUtc, dayEndUtc: new Date(dayStartUtc.getTime() + 86_400_000 - 1) };
}

export async function scanMerchantDigests(options: { now?: Date } = {}): Promise<MerchantDigestScanResult> {
  const now = options.now ?? new Date();
  const result: MerchantDigestScanResult = { eligibleStores: 0, skippedTooEarly: 0, skippedNothingToSay: 0, enqueued: 0, duplicates: 0 };
  const clock = baghdadClock(now);

  // Keyset pagination on storeId: a stable total order, so no store is read
  // twice in a pass and none is skipped between pages.
  let cursor: string | undefined;
  for (;;) {
    const settingsRows = await prisma.notificationSettings.findMany({
      where: { isEnabled: true, dailyDigestEnabled: true, ...(cursor ? { storeId: { gt: cursor } } : {}) },
      select: {
        storeId: true,
        dailyDigestHour: true,
        store: { select: { slug: true, name: true, isActive: true, merchant: { select: { email: true } } } },
      },
      orderBy: { storeId: "asc" },
      take: SCAN_PAGE_SIZE,
    });
    if (settingsRows.length === 0) break;
    cursor = settingsRows[settingsRows.length - 1]!.storeId;

    for (const settings of settingsRows) {
      if (!settings.store.isActive) continue;
      result.eligibleStores += 1;
      // His clock, his chosen hour. Not "the day is over" — see the header.
      if (clock.hour < settings.dailyDigestHour) { result.skippedTooEarly += 1; continue; }

      const range = { gte: clock.dayStartUtc, lte: clock.dayEndUtc };
      const [ordersToday, revenueToday, waiting] = await Promise.all([
        prisma.storeOrder.count({ where: { storeId: settings.storeId, createdAt: range } }),
        prisma.storeOrder.aggregate({
          where: { storeId: settings.storeId, createdAt: range, status: { notIn: ["cancelled", "rejected"] } },
          _sum: { totalIqd: true },
        }),
        // Waiting is a LIVE figure, not a figure about today: an order from
        // Tuesday still sitting in `new` on Thursday is exactly what he needs to
        // be told about.
        prisma.storeOrder.count({ where: { storeId: settings.storeId, status: { in: WAITING_STATUSES } } }),
      ]);

      if (ordersToday === 0 && waiting === 0) { result.skippedNothingToSay += 1; continue; }

      try {
        await prisma.notificationOutbox.create({
          data: {
            storeId: settings.storeId,
            eventType: "merchant.daily_digest",
            recipientKind: "merchant",
            channel: "email",
            recipient: settings.store.merchant.email,
            dedupeKey: `merchant_digest:${settings.storeId}:${clock.date}`,
            payload: {
              storeName: settings.store.name,
              storeSlug: settings.store.slug,
              date: clock.date,
              ordersToday,
              revenueTodayIqd: revenueToday._sum.totalIqd ?? 0,
              ordersWaiting: waiting,
            },
          },
        });
        result.enqueued += 1;
      } catch (error) {
        // The unique constraint IS the once-per-day rule; hitting it means the
        // digest for this Baghdad day already exists, which is success.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") result.duplicates += 1;
        else throw error;
      }
    }
  }

  return result;
}

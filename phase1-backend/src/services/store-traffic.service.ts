/**
 * ق-202 — how many people came, and what they looked at.
 *
 * The smallest honest counter behind «الزوار» and «معدل التحويل»: daily totals
 * per store and per product, on Baghdad calendar days, with no identity, no
 * IP and no path history anywhere (D-100). «visitors» is deduplicated by a
 * first-party cookie that holds only the day it was last counted on — an
 * approximation, labelled as one on the screen that shows it.
 *
 * Raw SQL throughout: the DATE columns must never pass through a JS Date's
 * timezone, and the upserts are one statement each on a hot path.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/** Asia/Baghdad has no daylight saving: a fixed +03:00 IS the timezone. */
export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Baghdad calendar day an instant falls on, as YYYY-MM-DD. */
export function baghdadDay(now: Date = new Date()): string {
  return new Date(now.valueOf() + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instants a Baghdad day starts and ends at (end exclusive). */
export function baghdadDayBounds(day: string): { from: Date; to: Date } {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const from = new Date(Date.UTC(year, month - 1, date) - BAGHDAD_OFFSET_MS);
  return { from, to: new Date(from.valueOf() + DAY_MS) };
}

export function daysBefore(day: string, count: number): string {
  const { from } = baghdadDayBounds(day);
  return baghdadDay(new Date(from.valueOf() - count * DAY_MS + BAGHDAD_OFFSET_MS));
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
function assertDay(day: string): string {
  if (!DAY_SHAPE.test(day)) throw new Error(`not a calendar day: ${day}`);
  return day;
}

/**
 * SCALE — one page view used to be one or two upserts on the SAME row per store
 * per day. A store running an ad then serialised every shopper on one row lock,
 * and every visit cost the database a write. Views are now summed in memory and
 * written as ONE upsert per (store, day) and per (store, product, day) every
 * `CODIQ_VISIT_FLUSH_MS` (default 5s). Losing at most one window of an
 * approximate counter on a crash is the accepted price; `flushVisits()` runs at
 * shutdown. `CODIQ_VISIT_FLUSH_MS=0` restores write-through (tests, debugging).
 */
const FLUSH_MS = (() => {
  const raw = Number(process.env.CODIQ_VISIT_FLUSH_MS ?? 5000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
})();
/** Hard cap on distinct buffered keys, so a flood of junk product ids cannot grow memory without bound. */
const MAX_BUFFERED_KEYS = 50_000;

type VisitBucket = { storeId: string; day: string; visits: number; visitors: number };
type ViewBucket = { storeId: string; productId: string; day: string; views: number };
let visitBuffer = new Map<string, VisitBucket>();
let viewBuffer = new Map<string, ViewBucket>();
let flushTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One page view. `newVisitor` is what the cookie said; `productId` when the page was a product's. */
export async function recordVisit(storeId: string, input: { day: string; newVisitor: boolean; productId?: string | null }): Promise<void> {
  const day = assertDay(input.day);
  if (visitBuffer.size + viewBuffer.size >= MAX_BUFFERED_KEYS) await flushVisits();
  const visitKey = `${storeId}|${day}`;
  const bucket = visitBuffer.get(visitKey) ?? { storeId, day, visits: 0, visitors: 0 };
  bucket.visits += 1;
  if (input.newVisitor) bucket.visitors += 1;
  visitBuffer.set(visitKey, bucket);
  if (input.productId && UUID_SHAPE.test(input.productId)) {
    const viewKey = `${storeId}|${input.productId}|${day}`;
    const view = viewBuffer.get(viewKey) ?? { storeId, productId: input.productId, day, views: 0 };
    view.views += 1;
    viewBuffer.set(viewKey, view);
  }
  if (FLUSH_MS === 0) return flushVisits();
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; void flushVisits().catch(() => undefined); }, FLUSH_MS);
    flushTimer.unref();
  }
}

/** Writes everything buffered so far. Safe to call concurrently; a failed write puts its counts back. */
export async function flushVisits(): Promise<void> {
  if (flushing) await flushing;
  if (!visitBuffer.size && !viewBuffer.size) return;
  const visits = Array.from(visitBuffer.values());
  const views = Array.from(viewBuffer.values());
  visitBuffer = new Map();
  viewBuffer = new Map();
  flushing = (async () => {
    try {
      if (visits.length) {
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO store_visits_daily (store_id, day, visits, visitors)
          SELECT v.store_id::uuid, v.day::date, v.visits, v.visitors
            FROM jsonb_to_recordset(${JSON.stringify(visits.map((b) => ({ store_id: b.storeId, day: b.day, visits: b.visits, visitors: b.visitors })))}::jsonb)
                 AS v(store_id text, day text, visits int, visitors int)
          ON CONFLICT (store_id, day) DO UPDATE
            SET visits = store_visits_daily.visits + EXCLUDED.visits,
                visitors = store_visits_daily.visitors + EXCLUDED.visitors`);
      }
      if (views.length) {
        // Only a live product of THIS store counts — the FK would refuse a foreign
        // id, but a trashed or switched-off product is a row the FK still accepts.
        // The join does that check for the whole batch in one statement.
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO product_views_daily (store_id, product_id, day, views)
          SELECT p.store_id, p.id, v.day::date, v.views
            FROM jsonb_to_recordset(${JSON.stringify(views.map((b) => ({ store_id: b.storeId, product_id: b.productId, day: b.day, views: b.views })))}::jsonb)
                 AS v(store_id text, product_id text, day text, views int)
            JOIN products p ON p.id = v.product_id::uuid AND p.store_id = v.store_id::uuid
                           AND p.is_active AND p.deleted_at IS NULL
          ON CONFLICT (store_id, product_id, day) DO UPDATE SET views = product_views_daily.views + EXCLUDED.views`);
      }
    } catch (error) {
      for (const b of visits) {
        const key = `${b.storeId}|${b.day}`;
        const cur = visitBuffer.get(key);
        visitBuffer.set(key, cur ? { ...cur, visits: cur.visits + b.visits, visitors: cur.visitors + b.visitors } : b);
      }
      for (const b of views) {
        const key = `${b.storeId}|${b.productId}|${b.day}`;
        const cur = viewBuffer.get(key);
        viewBuffer.set(key, cur ? { ...cur, views: cur.views + b.views } : b);
      }
      throw error;
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export interface DayTraffic { visits: number; visitors: number }

/** Visit totals for a set of days; a day nobody came is zeros, not absent. */
export async function trafficByDay(storeId: string, days: readonly string[]): Promise<Map<string, DayTraffic>> {
  const out = new Map<string, DayTraffic>(days.map((day) => [assertDay(day), { visits: 0, visitors: 0 }]));
  if (!days.length) return out;
  const rows = await prisma.$queryRaw<Array<{ day: string; visits: number; visitors: number }>>(Prisma.sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, visits, visitors
      FROM store_visits_daily
     WHERE store_id = ${storeId}::uuid AND day IN (${Prisma.join(days.map((day) => Prisma.sql`${day}::date`))})`);
  for (const row of rows) out.set(row.day, { visits: Number(row.visits), visitors: Number(row.visitors) });
  return out;
}

/** Totals across a span of days, inclusive. */
export async function trafficBetween(storeId: string, fromDay: string, toDay: string): Promise<DayTraffic> {
  const [row] = await prisma.$queryRaw<Array<{ visits: bigint | number | null; visitors: bigint | number | null }>>(Prisma.sql`
    SELECT SUM(visits) AS visits, SUM(visitors) AS visitors
      FROM store_visits_daily
     WHERE store_id = ${storeId}::uuid AND day BETWEEN ${assertDay(fromDay)}::date AND ${assertDay(toDay)}::date`);
  return { visits: Number(row?.visits ?? 0), visitors: Number(row?.visitors ?? 0) };
}

export interface MostViewedProduct { productId: string; name: string; views: number }

/** «الأكثر زيارة» — live products only, summed over the span. */
export async function mostViewed(storeId: string, fromDay: string, toDay: string, limit = 5): Promise<MostViewedProduct[]> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string; name: string; views: bigint | number }>>(Prisma.sql`
    SELECT v.product_id, MAX(p.name) AS name, SUM(v.views) AS views
      FROM product_views_daily v
      JOIN products p ON p.id = v.product_id AND p.store_id = v.store_id
     WHERE v.store_id = ${storeId}::uuid
       AND v.day BETWEEN ${assertDay(fromDay)}::date AND ${assertDay(toDay)}::date
       AND p.is_active = true AND p.deleted_at IS NULL
     GROUP BY v.product_id
     ORDER BY views DESC, name ASC
     LIMIT ${Math.min(Math.max(limit, 1), 20)}`);
  return rows.map((row) => ({ productId: row.product_id, name: row.name, views: Number(row.views) }));
}

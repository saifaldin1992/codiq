/**
 * MD-7 «شهرك في CODIQ» — one month of a merchant's shop, in a page he can print
 * or send to someone.
 *
 * THIS SERVICE COMPUTES ALMOST NOTHING. `analyticsSummary` and `topProducts`
 * already own the arithmetic and already carry the ledger's sign rule; a second
 * implementation here would be a second answer to the same question, and the two
 * would disagree the first time either changed. What this adds is the framing:
 * a calendar month, the month before it for comparison, and the handful of facts
 * that are worth saying out loud.
 *
 * THE COMPARISON IS THE POINT. «بعت 40 طلباً» means nothing on its own. «بعت 40
 * طلباً، مقابل 31 الشهر الماضي» is the sentence a merchant repeats to someone.
 * So every headline figure carries its previous-month counterpart and the change
 * between them — and where the previous month is empty, the change is reported
 * as null rather than as a fabricated +100%.
 *
 * NO ACHIEVEMENT IS INVENTED. The «إنجازات» are statements about figures that
 * are actually in the data — a best day, a first sale, a growing month. If none
 * of them holds, the list is empty and the page says so plainly. A congratulation
 * a merchant knows he did not earn devalues the ones he did (ق-10).
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { analyticsSummary, topProducts } from "./analytics.service.js";
import { BAGHDAD_OFFSET_MS } from "./store-traffic.service.js";

export interface MonthlyReport {
  store: { slug: string; name: string };
  month: { key: string; from: Date; to: Date };
  previous: { key: string; from: Date; to: Date };
  headline: {
    revenueIqd: Change;
    completedOrders: Change;
    averageOrderValueIqd: Change;
    newCustomers: Change;
  };
  bestDay: { date: string; orders: number; revenueIqd: number } | null;
  topProducts: { productId: string | null; variantId: string | null; productName: string; variantName: string | null; sku: string | null; units: number; revenueIqd: number }[];
  achievements: { code: string; text: string }[];
  /** True when the month holds nothing at all — the page then says so. */
  empty: boolean;
}

interface Change {
  value: number;
  previous: number;
  /** Percent change, or null when the previous month was zero and there is no ratio to state. */
  changePercent: number | null;
}

function change(value: number, previous: number): Change {
  return { value, previous, changePercent: previous === 0 ? null : Math.round(((value - previous) / previous) * 100) };
}

/**
 * `2026-08` → the month it names IN BAGHDAD. Rejected rather than defaulted: a
 * report headed «آب» that quietly shows July is worse than an error.
 *
 * Baghdad, not UTC: the month starts at 00:00 on the 1st where the shop is. On a
 * UTC calendar every order placed between midnight and 03:00 on the 1st was
 * counted in the PREVIOUS month — the merchant's own report disagreeing with the
 * date on his receipts.
 */
export function parseMonthKey(raw: unknown, now = new Date()): { key: string; from: Date; to: Date } {
  const local = new Date(now.valueOf() + BAGHDAD_OFFSET_MS);
  const text = typeof raw === "string" && raw ? raw : `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
  const match = /^(\d{4})-(\d{2})$/.exec(text);
  if (!match) throw new HttpError(400, "INVALID_MONTH", "The month must be written as YYYY-MM.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new HttpError(400, "INVALID_MONTH", "The month must be between 01 and 12.");
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - BAGHDAD_OFFSET_MS);
  // The last millisecond of the month: the ranges below are inclusive at both
  // ends, so day 1 of the next month at 00:00 would count one order twice.
  const to = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - BAGHDAD_OFFSET_MS - 1);
  return { key: text, from, to };
}

/** From the KEY, not from `from`: `from` is now 21:00 UTC on the previous month's last day. */
function previousMonth(month: { key: string }): { key: string; from: Date; to: Date } {
  const [year, monthNumber] = month.key.split("-").map(Number) as [number, number];
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1));
  return parseMonthKey(`${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`);
}

export async function merchantMonthlyReport(storeId: string, rawMonth: unknown, now = new Date()): Promise<MonthlyReport> {
  const month = parseMonthKey(rawMonth, now);
  const previous = previousMonth(month);

  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { slug: true, name: true } });
  if (!store) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The store was not found.");

  const range = { from: month.from.toISOString(), to: month.to.toISOString() };
  const [current, prior, top, days, firstEverOrder] = await Promise.all([
    analyticsSummary(storeId, range),
    analyticsSummary(storeId, { from: previous.from.toISOString(), to: previous.to.toISOString() }),
    topProducts(storeId, { ...range, limit: "5" }),
    // The best day is asked of the database rather than assembled here: pulling
    // a month of orders into memory to group them would be the same answer at a
    // worse cost, and would drift as the month gets busier.
    //
    // COMPLETED ONLY, to match the headline. `analyticsSummary` sums the
    // append-only ledger, and the ledger is written on completion alone — so
    // counting pending or out-for-delivery orders here would put a "best day"
    // revenue on the page that the month's own total does not contain, and the
    // merchant could not reconcile two figures printed side by side.
    prisma.$queryRaw<{ day: Date; orders: bigint; revenue: bigint }[]>`
      SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Baghdad') AS day,
             count(*)::bigint AS orders,
             coalesce(sum(total_iqd), 0)::bigint AS revenue
        FROM store_orders
       WHERE store_id = ${storeId}::uuid
         AND created_at BETWEEN ${month.from} AND ${month.to}
         AND status = 'completed'
         -- ق-136: the headline revenue above this figure is ledger-derived and
         -- cannot contain counter cash, so «أفضل يوم» must not either — the
         -- comment above this query exists precisely so the two reconcile.
         AND source <> 'pos'
       GROUP BY 1
       ORDER BY orders DESC, revenue DESC
       LIMIT 1`,
    prisma.storeOrder.findFirst({ where: { storeId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  const headline = {
    revenueIqd: change(current.revenue.revenueIqd, prior.revenue.revenueIqd),
    completedOrders: change(current.revenue.completedOrders, prior.revenue.completedOrders),
    averageOrderValueIqd: change(current.averageOrderValueIqd, prior.averageOrderValueIqd),
    newCustomers: change(current.newCustomers, prior.newCustomers),
  };

  const best = days[0];
  const bestDay = best
    ? { date: best.day.toISOString().slice(0, 10), orders: Number(best.orders), revenueIqd: Number(best.revenue) }
    : null;

  // Each of these is a fact in the figures above. Nothing is added for warmth.
  const achievements: { code: string; text: string }[] = [];
  if (firstEverOrder && firstEverOrder.createdAt >= month.from && firstEverOrder.createdAt <= month.to) {
    achievements.push({ code: "first_sale", text: "أول عملية بيع لك على Codiq سُجّلت هذا الشهر." });
  }
  if (headline.revenueIqd.previous > 0 && headline.revenueIqd.value > headline.revenueIqd.previous) {
    achievements.push({ code: "revenue_up", text: `مبيعاتك نمت ${headline.revenueIqd.changePercent}٪ عن الشهر الماضي.` });
  }
  if (headline.newCustomers.value > 0) {
    achievements.push({ code: "new_customers", text: `${headline.newCustomers.value} زبوناً جديداً تعرّف على متجرك هذا الشهر.` });
  }
  if (bestDay && bestDay.orders > 1) {
    achievements.push({ code: "best_day", text: `أفضل يوم لديك كان ${bestDay.date} بـ${bestDay.orders} طلبات.` });
  }
  if (current.revenue.reversedOrders === 0 && current.revenue.completedOrders > 0) {
    achievements.push({ code: "no_returns", text: "لا إرجاعات هذا الشهر — كل طلب مكتمل بقي مكتملاً." });
  }

  return {
    store,
    month,
    previous,
    headline,
    bestDay,
    topProducts: top.products,
    achievements,
    empty: current.ordersCount === 0 && current.revenue.revenueIqd === 0,
  };
}

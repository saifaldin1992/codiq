/**
 * PG-7 (ق-75) — the business-health numbers the owner runs the platform on.
 *
 * THE DEFINITION, decided and written here so the interface can state it out
 * loud rather than leave the owner to guess (ق-10):
 *
 *   **نشط = باع.** Not «signed in». A merchant who opens his dashboard every
 *   morning and sells nothing is not an active merchant — he is a merchant about
 *   to leave, and folding him into «active» hides exactly the number that
 *   predicts it. So «signed in but did not sell» is reported as its OWN figure
 *   beside it, because that is the early warning, not a footnote.
 *
 *   **متوقف** = sold before, and has sold nothing for the window. A merchant who
 *   has NEVER sold is not stalled, he is not started — a different problem with a
 *   different fix (PG-8 onboarding), so he is counted separately.
 *
 * EVERY figure is a database aggregate. D-16's lesson is explicit about this:
 * pulling rows into memory to count them is what made an earlier screen slow,
 * and D-17's is that a read must never be paid for on a write path — nothing
 * here touches one.
 *
 * Each number is answerable: the same service returns the merchants BEHIND a
 * figure, so «who are they exactly» is one click and not a mystery.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, pageOf, parseListLimit, readListCursor } from "./list-page.js";

/** Orders that consumed nothing are not sales, here as everywhere else. */
const NON_CONSUMING = ["cancelled", "rejected"];

export interface PlatformPulse {
  windowDays: number;
  definitions: { active: string; stalled: string; neverSold: string };
  active: number;
  stalledCount: number;
  neverSoldCount: number;
  /** Signed in during the window and sold nothing — the early warning. */
  signedInWithoutSelling: number;
  conversion: { registered: number; reachedFirstOrder: number };
  fastestGrowing: {
    storeId: string;
    storeName: string;
    merchantId: string;
    current: number;
    previous: number;
  }[];
}

const DEFINITIONS = {
  active:
    "التاجر النشط = مَن له طلب واحد على الأقل لم يُلغَ خلال المدة. الدخول إلى اللوحة وحده لا يجعله نشطاً.",
  stalled: "المتوقف = باع من قبل، ولم يبع شيئاً خلال المدة. وهو أهم رقم لأنه إنذار مغادرة مبكر.",
  neverSold: "لم يبدأ = لم يبع قط. ليس متوقفاً — مشكلته مختلفة وعلاجها مسار البداية (PG-8).",
} as const;

export async function platformPulse(rawDays: unknown, now = new Date()): Promise<PlatformPulse> {
  const windowDays = Math.min(Math.max(Number(rawDays) || 7, 1), 90);
  const from = new Date(now.valueOf() - windowDays * 24 * 60 * 60 * 1000);
  const previousFrom = new Date(from.valueOf() - windowDays * 24 * 60 * 60 * 1000);

  // One grouped query per question, all in the database. `merchant_id` is
  // reached through the store, so these ride the store index rather than
  // loading orders into memory to bucket them (D-16).
  const [activeRows, everSoldRows, signedInRows, registeredInWindow, growth] = await Promise.all([
    prisma.$queryRaw<{ merchant_id: string }[]>`
      SELECT DISTINCT s.merchant_id FROM store_orders o
      JOIN stores s ON s.id = o.store_id
      WHERE o.created_at >= ${from} AND o.status <> ALL(${NON_CONSUMING}::text[])`,
    prisma.$queryRaw<{ merchant_id: string }[]>`
      SELECT DISTINCT s.merchant_id FROM store_orders o
      JOIN stores s ON s.id = o.store_id
      WHERE o.status <> ALL(${NON_CONSUMING}::text[])`,
    prisma.$queryRaw<{ merchant_id: string }[]>`
      SELECT DISTINCT merchant_id FROM merchant_sessions WHERE created_at >= ${from}`,
    prisma.merchant.count({ where: { createdAt: { gte: from } } }),
    prisma.$queryRaw<
      {
        store_id: string;
        store_name: string;
        merchant_id: string;
        current: bigint;
        previous: bigint;
      }[]
    >`
      SELECT s.id AS store_id, s.name AS store_name, s.merchant_id,
             COUNT(*) FILTER (WHERE o.created_at >= ${from}) AS current,
             COUNT(*) FILTER (WHERE o.created_at >= ${previousFrom} AND o.created_at < ${from}) AS previous
      FROM store_orders o JOIN stores s ON s.id = o.store_id
      WHERE o.created_at >= ${previousFrom} AND o.status <> ALL(${NON_CONSUMING}::text[])
      GROUP BY s.id, s.name, s.merchant_id
      HAVING COUNT(*) FILTER (WHERE o.created_at >= ${from}) > COUNT(*) FILTER (WHERE o.created_at >= ${previousFrom} AND o.created_at < ${from})
      ORDER BY (COUNT(*) FILTER (WHERE o.created_at >= ${from}) - COUNT(*) FILTER (WHERE o.created_at >= ${previousFrom} AND o.created_at < ${from})) DESC
      LIMIT 5`,
  ]);

  const activeIds = new Set(activeRows.map((row) => row.merchant_id));
  const everSoldIds = new Set(everSoldRows.map((row) => row.merchant_id));
  const signedInIds = new Set(signedInRows.map((row) => row.merchant_id));

  // Stalled: has sold at some point, but not inside the window.
  const stalledIds = Array.from(everSoldIds).filter((id) => !activeIds.has(id));
  const totalMerchants = await prisma.merchant.count({ where: { approvalStatus: "approved" } });

  return {
    windowDays,
    definitions: DEFINITIONS,
    active: activeIds.size,
    stalledCount: stalledIds.length,
    neverSoldCount: Math.max(0, totalMerchants - everSoldIds.size),
    signedInWithoutSelling: Array.from(signedInIds).filter((id) => !activeIds.has(id)).length,
    conversion: {
      registered: registeredInWindow,
      // Of those who registered in the window, how many reached a first order.
      reachedFirstOrder: await prisma.merchant.count({
        where: {
          createdAt: { gte: from },
          stores: { some: { orders: { some: { status: { notIn: NON_CONSUMING } } } } },
        },
      }),
    },
    fastestGrowing: growth.map((row) => ({
      storeId: row.store_id,
      storeName: row.store_name,
      merchantId: row.merchant_id,
      current: Number(row.current),
      previous: Number(row.previous),
    })),
  };
}

/**
 * «Who are they exactly?» — the merchants behind one figure, which is the
 * acceptance criterion for this item. A number the owner cannot open is a number
 * he cannot act on.
 */
/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const PULSE_COHORT_KIND = "platform.pulse.cohort";

/**
 * D-18: each cohort was `ORDER BY business_name LIMIT 100` with no page 2, so
 * «مَن هم هؤلاء التجار تحديداً» — the PG-7 acceptance criterion, a number the
 * owner must be able to open — answered with the first hundred names and no
 * sign that there were more. The cohort is the whole point; a truncated one is
 * a different answer to the same question.
 *
 * The keyset is `(business_name, id)` ASCENDING, expressed as a Postgres
 * row-wise comparison so the predicate is one expression rather than a
 * hand-unrolled OR chain. `business_name` is not unique — two merchants may
 * share a name — which is exactly why the id rides in the tuple.
 *
 * Every statement below already filters `merchants` by subquery; the cursor
 * predicate is appended to that WHERE, never to the subqueries, so the cohort's
 * definition is untouched by paging through it.
 */
export async function pulseCohort(
  kind: "active" | "stalled" | "never_sold",
  rawDays: unknown,
  rawLimit?: unknown,
  rawCursor?: unknown,
  now = new Date()
) {
  const windowDays = Math.min(Math.max(Number(rawDays) || 7, 1), 90);
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(PULSE_COHORT_KIND, rawCursor);
  const from = new Date(now.valueOf() - windowDays * 24 * 60 * 60 * 1000);
  const soldInWindow = Prisma.sql`
    SELECT DISTINCT s.merchant_id FROM store_orders o JOIN stores s ON s.id = o.store_id
    WHERE o.created_at >= ${from} AND o.status <> ALL(${NON_CONSUMING}::text[])`;
  const soldEver = Prisma.sql`
    SELECT DISTINCT s.merchant_id FROM store_orders o JOIN stores s ON s.id = o.store_id
    WHERE o.status <> ALL(${NON_CONSUMING}::text[])`;
  const after = cursor
    ? Prisma.sql`AND (m.business_name, m.id) > (${cursor.value}, ${cursor.id}::uuid)`
    : Prisma.empty;
  const take = limit + 1;

  const rows =
    kind === "active"
      ? await prisma.$queryRaw<{ id: string; business_name: string; email: string }[]>`
        SELECT m.id, m.business_name, m.email FROM merchants m
        WHERE m.id IN (${soldInWindow}) ${after} ORDER BY m.business_name, m.id LIMIT ${take}`
      : kind === "stalled"
        ? await prisma.$queryRaw<{ id: string; business_name: string; email: string }[]>`
          SELECT m.id, m.business_name, m.email FROM merchants m
          WHERE m.id IN (${soldEver}) AND m.id NOT IN (${soldInWindow}) ${after} ORDER BY m.business_name, m.id LIMIT ${take}`
        : await prisma.$queryRaw<{ id: string; business_name: string; email: string }[]>`
          SELECT m.id, m.business_name, m.email FROM merchants m
          WHERE m.approval_status = 'approved' AND m.id NOT IN (${soldEver}) ${after} ORDER BY m.business_name, m.id LIMIT ${take}`;

  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(PULSE_COHORT_KIND, last.business_name, last.id)
  );
  return {
    kind,
    windowDays,
    merchants: page.map((row) => ({
      id: row.id,
      businessName: row.business_name,
      email: row.email,
    })),
    nextCursor,
  };
}

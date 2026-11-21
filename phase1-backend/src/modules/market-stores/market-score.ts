/**
 * A store's market reputation — the score, its tier and the badges earned by
 * numbers (docs/MARKETPLACE_PLAN.md D5, D6). PURE: facts in, verdict out, so the
 * whole rule is testable without a database (market-score.unit.mjs) and the
 * job that feeds it stays a thin SQL read.
 *
 * Seven criteria, each scored 0..1, weighted to 100:
 *
 *   sales           20  completed orders (log scale; 200 is full marks)
 *   rating          20  shoppers' stars, pulled toward 4.0 until there are enough of them
 *   speed           15  median minutes from «new» to the merchant's first move
 *   cancellations   15  cancelled or rejected share of settled orders
 *   stock accuracy  10  share of active products that can actually be bought
 *   after-sales     10  share of customers who came back for a second completed order
 *   discounts       10  the deepest current discount (neutral until discounts exist)
 *
 * A criterion with no evidence yet scores a neutral 0.5 — a new store is neither
 * punished nor flattered for what nobody has measured.
 */

export const MIN_ORDERS_FOR_SCORE = 5;

export type MarketTier = "bronze" | "silver" | "gold" | "platinum";
export const MARKET_TIERS: readonly MarketTier[] = ["bronze", "silver", "gold", "platinum"];

export type StoreFacts = {
  completedOrders: number;
  completedOrders30d: number;
  /** completed + cancelled + rejected + returned — orders whose fate is known. */
  settledOrders: number;
  cancelledOrders: number;
  medianResponseMinutes: number | null;
  /** Customers with at least one completed order. */
  customers: number;
  repeatCustomers: number;
  ratingAvg: number | null;
  ratingCount: number;
  productCount: number;
  inStockProducts: number;
  /** 0–100, null while products carry no discount. */
  maxDiscountPercent: number | null;
};

export type MetricBadgeCode =
  | "fast_response"
  | "low_cancellation"
  | "high_rating"
  | "repeat_customers"
  | "top_seller";
export type EarnedBadge = { code: MetricBadgeCode; level: MarketTier };

export type MarketVerdict = {
  score: number | null;
  tier: MarketTier | null;
  cancelRate: number | null;
  repeatRate: number | null;
  inStockRate: number | null;
  badges: EarnedBadge[];
  criteria: Record<CriterionCode, number>;
};

export type CriterionCode =
  | "sales"
  | "rating"
  | "speed"
  | "cancellations"
  | "stock"
  | "after_sales"
  | "discounts";

export const CRITERIA: readonly { code: CriterionCode; weight: number; title: string }[] = [
  { code: "sales", weight: 20, title: "المبيعات المكتملة بنجاح" },
  { code: "rating", weight: 20, title: "تقييمات الزبائن" },
  { code: "speed", weight: 15, title: "سرعة قبول الطلبات وتجهيزها" },
  { code: "cancellations", weight: 15, title: "قلّة الإلغاءات والرفض" },
  { code: "stock", weight: 10, title: "دقّة المخزون والأسعار" },
  { code: "after_sales", weight: 10, title: "رضا ما بعد البيع (الزبائن العائدون)" },
  { code: "discounts", weight: 10, title: "خصومات مناسبة للزبائن" },
];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const NEUTRAL = 0.5;
const RATING_PRIOR = 4;
const RATING_PRIOR_WEIGHT = 5;

/** The star average pulled toward 4.0 by five imaginary reviews — three 5★ reviews are not a 5.0 store. */
export function shrunkRating(avg: number | null, count: number): number | null {
  if (avg === null || count <= 0) return null;
  return (avg * count + RATING_PRIOR * RATING_PRIOR_WEIGHT) / (count + RATING_PRIOR_WEIGHT);
}

function criteria(
  facts: StoreFacts,
  rates: { cancelRate: number | null; repeatRate: number | null; inStockRate: number | null }
): Record<CriterionCode, number> {
  const rating = shrunkRating(facts.ratingAvg, facts.ratingCount);
  const minutes = facts.medianResponseMinutes;
  return {
    sales: clamp01(Math.log10(1 + facts.completedOrders) / Math.log10(1 + 200)),
    rating: rating === null ? NEUTRAL : clamp01((rating - 1) / 4),
    // ≤10 minutes is full marks; four hours or more is none.
    speed: minutes === null ? NEUTRAL : clamp01(1 - (minutes - 10) / 230),
    // A 20% cancellation rate is already zero.
    cancellations: rates.cancelRate === null ? NEUTRAL : clamp01(1 - rates.cancelRate / 0.2),
    stock: rates.inStockRate ?? NEUTRAL,
    // 40% returning customers is full marks.
    after_sales: rates.repeatRate === null ? NEUTRAL : clamp01(rates.repeatRate / 0.4),
    discounts: facts.maxDiscountPercent === null ? NEUTRAL : clamp01(facts.maxDiscountPercent / 50),
  };
}

export function tierFor(score: number): MarketTier | null {
  if (score >= 85) return "platinum";
  if (score >= 70) return "gold";
  if (score >= 55) return "silver";
  if (score >= 40) return "bronze";
  return null;
}

/** Highest level whose test passes, or null. Tests are listed bronze → platinum. */
function level(tests: readonly boolean[]): MarketTier | null {
  let earned: MarketTier | null = null;
  tests.forEach((passed, index) => {
    if (passed) earned = MARKET_TIERS[index] ?? earned;
  });
  return earned;
}

function earnedBadges(
  facts: StoreFacts,
  rates: { cancelRate: number | null; repeatRate: number | null }
): EarnedBadge[] {
  const out: EarnedBadge[] = [];
  const push = (code: MetricBadgeCode, earned: MarketTier | null) => {
    if (earned) out.push({ code, level: earned });
  };
  const minutes = facts.medianResponseMinutes;
  if (minutes !== null && facts.settledOrders >= 5)
    push("fast_response", level([minutes <= 60, minutes <= 30, minutes <= 15, minutes <= 5]));
  if (rates.cancelRate !== null && facts.settledOrders >= 10) {
    const rate = rates.cancelRate;
    push(
      "low_cancellation",
      level([rate <= 0.1, rate <= 0.05, rate <= 0.02, rate === 0 && facts.settledOrders >= 50])
    );
  }
  if (facts.ratingAvg !== null && facts.ratingCount >= 5) {
    const avg = facts.ratingAvg;
    push(
      "high_rating",
      level([avg >= 4, avg >= 4.3, avg >= 4.6, avg >= 4.8 && facts.ratingCount >= 50])
    );
  }
  if (rates.repeatRate !== null && facts.customers >= 10) {
    const rate = rates.repeatRate;
    push("repeat_customers", level([rate >= 0.1, rate >= 0.2, rate >= 0.3, rate >= 0.4]));
  }
  const sold = facts.completedOrders30d;
  push("top_seller", level([sold >= 10, sold >= 50, sold >= 200, sold >= 1000]));
  return out;
}

export function judgeStore(facts: StoreFacts): MarketVerdict {
  const rates = {
    cancelRate: facts.settledOrders > 0 ? facts.cancelledOrders / facts.settledOrders : null,
    repeatRate: facts.customers > 0 ? facts.repeatCustomers / facts.customers : null,
    inStockRate: facts.productCount > 0 ? facts.inStockProducts / facts.productCount : null,
  };
  const parts = criteria(facts, rates);
  const weighted = CRITERIA.reduce(
    (sum, criterion) => sum + parts[criterion.code] * criterion.weight,
    0
  );
  const score =
    facts.completedOrders >= MIN_ORDERS_FOR_SCORE ? Math.round(weighted * 100) / 100 : null;
  return {
    score,
    tier: score === null ? null : tierFor(score),
    ...rates,
    badges: earnedBadges(facts, rates),
    criteria: parts,
  };
}

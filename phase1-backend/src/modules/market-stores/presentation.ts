/**
 * How a store looks to a shopper in the market: its marks, its badges, its
 * hours and image URLs. Shared by the directory, the store page and the
 * merchant's own preview so the three can never describe a store differently.
 */
import type { EarnedBadge, MarketTier, MetricBadgeCode } from "./market-score.js";

export type GrantedMarkCode = "verified" | "brand" | "ambassador" | "boosted" | "new_store";
export type BadgeCode = MetricBadgeCode | GrantedMarkCode;

/** Every badge a store can hold, in display order. «X من Y شارة» counts against this list. */
export const BADGE_CATALOG: readonly {
  code: BadgeCode;
  title: string;
  description: string;
  leveled: boolean;
}[] = [
  {
    code: "verified",
    title: "متجر موثّق",
    description: "راجعت المنصّة هويّة هذا المتجر وبياناته.",
    leveled: false,
  },
  {
    code: "fast_response",
    title: "ردّ سريع",
    description: "يقبل الطلبات ويجيب بسرعة، فلا تنتظر طويلاً.",
    leveled: true,
  },
  {
    code: "low_cancellation",
    title: "إلغاء قليل",
    description: "نادراً ما يُلغي أو يرفض طلباً بعد وصوله.",
    leveled: true,
  },
  {
    code: "high_rating",
    title: "تقييم عالٍ",
    description: "يمنحه الزبائن تقييمات مرتفعة باستمرار.",
    leveled: true,
  },
  {
    code: "repeat_customers",
    title: "زبائن يعودون",
    description: "كثير من زبائنه يشترون منه أكثر من مرّة.",
    leveled: true,
  },
  {
    code: "top_seller",
    title: "الأكثر مبيعاً",
    description: "من أكثر المتاجر طلبات مكتملة هذا الشهر.",
    leveled: true,
  },
  {
    code: "ambassador",
    title: "سفير السوق",
    description: "اختاره فريق المنصّة ضمن متاجر الشهر.",
    leveled: false,
  },
  {
    code: "brand",
    title: "علامة تجاريّة",
    description: "متجر رسميّ لعلامة تجاريّة.",
    leveled: false,
  },
  {
    code: "boosted",
    title: "متجر مُروَّج",
    description: "يظهر في مقدّمة النتائج ضمن حملة ترويج.",
    leveled: false,
  },
  {
    code: "new_store",
    title: "متجر جديد",
    description: "انضمّ إلى السوق خلال آخر ثلاثين يوماً.",
    leveled: false,
  },
];

export const TIER_LABELS: Record<MarketTier, string> = {
  bronze: "برونزي",
  silver: "فضّي",
  gold: "ذهبي",
  platinum: "بلاتيني",
};

const NEW_STORE_DAYS = 30;

export type StoreMarkFacts = {
  verifiedAt: Date | null;
  isBrand: boolean;
  ambassadorUntil: Date | null;
  boostedUntil: Date | null;
  marketListedAt: Date | null;
};

export function grantedMarks(store: StoreMarkFacts, now = new Date()): GrantedMarkCode[] {
  const marks: GrantedMarkCode[] = [];
  if (store.verifiedAt) marks.push("verified");
  if (store.isBrand) marks.push("brand");
  if (store.ambassadorUntil && store.ambassadorUntil > now) marks.push("ambassador");
  if (store.boostedUntil && store.boostedUntil > now) marks.push("boosted");
  if (
    store.marketListedAt &&
    now.getTime() - store.marketListedAt.getTime() < NEW_STORE_DAYS * 86_400_000
  )
    marks.push("new_store");
  return marks;
}

export type BadgeView = {
  code: BadgeCode;
  title: string;
  description: string;
  earned: boolean;
  level: MarketTier | null;
};

/** The full catalog, each row marked earned or not — the store page's «شارات المتجر» sheet. */
export function badgeViews(
  earned: readonly EarnedBadge[],
  marks: readonly GrantedMarkCode[]
): BadgeView[] {
  const levels = new Map(earned.map((badge) => [badge.code as BadgeCode, badge.level]));
  return BADGE_CATALOG.map((entry) => {
    const level = levels.get(entry.code) ?? null;
    const isEarned = level !== null || (marks as readonly string[]).includes(entry.code);
    return {
      code: entry.code,
      title: entry.title,
      description: entry.description,
      earned: isEarned,
      level,
    };
  });
}

export function parseEarnedBadges(value: unknown): EarnedBadge[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is EarnedBadge => typeof row?.code === "string" && typeof row?.level === "string"
  );
}

// ── hours ────────────────────────────────────────────────────────────────────

/** Iraq keeps UTC+3 all year (no daylight saving since 2008). */
const BAGHDAD_OFFSET_MINUTES = 180;

export type OpeningRow = { weekday: number; opensAt: Date; closesAt: Date };
export type HoursView = {
  days: { weekday: number; opensAt: string | null; closesAt: string | null }[];
  openNow: boolean | null;
};

/** `TIME` columns arrive as 1970-01-01T..Z dates; this is their wall-clock HH:MM. */
export function timeOfDay(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function minutesOf(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

/** Open right now in Baghdad? `null` when the store has published no hours at all. */
export function isOpenAt(rows: readonly OpeningRow[], now: Date): boolean | null {
  if (rows.length === 0) return null;
  const local = new Date(now.getTime() + BAGHDAD_OFFSET_MINUTES * 60_000);
  const weekday = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const byDay = new Map(rows.map((row) => [row.weekday, row]));
  const today = byDay.get(weekday);
  if (today) {
    const opens = minutesOf(today.opensAt);
    const closes = minutesOf(today.closesAt);
    if (opens < closes ? minute >= opens && minute < closes : minute >= opens) return true;
  }
  // Yesterday's shift may run past midnight into this morning.
  const yesterday = byDay.get((weekday + 6) % 7);
  if (yesterday) {
    const opens = minutesOf(yesterday.opensAt);
    const closes = minutesOf(yesterday.closesAt);
    if (closes < opens && minute < closes) return true;
  }
  return false;
}

export function hoursView(rows: readonly OpeningRow[], now = new Date()): HoursView {
  const byDay = new Map(rows.map((row) => [row.weekday, row]));
  return {
    days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
      const row = byDay.get(weekday);
      return {
        weekday,
        opensAt: row ? timeOfDay(row.opensAt) : null,
        closesAt: row ? timeOfDay(row.closesAt) : null,
      };
    }),
    openNow: isOpenAt(rows, now),
  };
}

// ── images ───────────────────────────────────────────────────────────────────

function versionOf(objectKey: string): string {
  return objectKey.split("/").pop()?.split(".")[0] ?? "0";
}

export function storeLogoUrl(slug: string, objectKey: string | null): string | null {
  return objectKey
    ? `/api/store/${encodeURIComponent(slug)}/logo?v=${encodeURIComponent(versionOf(objectKey))}`
    : null;
}

export function storeCoverUrl(slug: string, objectKey: string | null): string | null {
  return objectKey
    ? `/api/market/stores/${encodeURIComponent(slug)}/cover?v=${encodeURIComponent(versionOf(objectKey))}`
    : null;
}

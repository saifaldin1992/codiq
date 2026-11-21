/**
 * Marketplace M1 — the reputation rule and the opening-hours clock, without a
 * database. Each case states the shopper-visible outcome it protects.
 */
import assert from "node:assert/strict";

const { judgeStore, tierFor, shrunkRating, CRITERIA, MIN_ORDERS_FOR_SCORE } = await import(
  "../src/modules/market-stores/market-score.ts"
);
const { isOpenAt, hoursView, grantedMarks, badgeViews, BADGE_CATALOG } = await import(
  "../src/modules/market-stores/presentation.ts"
);

const base = {
  completedOrders: 0,
  completedOrders30d: 0,
  settledOrders: 0,
  cancelledOrders: 0,
  medianResponseMinutes: null,
  customers: 0,
  repeatCustomers: 0,
  ratingAvg: null,
  ratingCount: 0,
  productCount: 0,
  inStockProducts: 0,
  maxDiscountPercent: null,
};

// The weights are the published explanation; they must add up to 100.
assert.equal(
  CRITERIA.reduce((sum, c) => sum + c.weight, 0),
  100
);

// A brand-new store is not scored at all («لم تُحتسب بعد»), and is not punished either.
const fresh = judgeStore(base);
assert.equal(fresh.score, null);
assert.equal(fresh.tier, null);
assert.deepEqual(fresh.badges, []);
assert.equal(
  judgeStore({ ...base, completedOrders: MIN_ORDERS_FOR_SCORE - 1 }).score,
  null,
  "below the minimum: no score"
);

// An excellent store reaches platinum with every metric badge at its top level.
const excellent = judgeStore({
  ...base,
  completedOrders: 400,
  completedOrders30d: 1200,
  settledOrders: 400,
  cancelledOrders: 0,
  medianResponseMinutes: 4,
  customers: 200,
  repeatCustomers: 100,
  ratingAvg: 4.9,
  ratingCount: 300,
  productCount: 50,
  inStockProducts: 50,
  maxDiscountPercent: 50,
});
assert.ok(excellent.score >= 95, `excellent store scores high (${excellent.score})`);
assert.equal(excellent.tier, "platinum");
assert.deepEqual(excellent.badges.map((b) => `${b.code}:${b.level}`).sort(), [
  "fast_response:platinum",
  "high_rating:platinum",
  "low_cancellation:platinum",
  "repeat_customers:platinum",
  "top_seller:platinum",
]);

// A store that cancels a third of its orders and answers after a day is not tiered.
const poor = judgeStore({
  ...base,
  completedOrders: 20,
  settledOrders: 30,
  cancelledOrders: 10,
  medianResponseMinutes: 1440,
  ratingAvg: 2,
  ratingCount: 20,
  productCount: 10,
  inStockProducts: 2,
  customers: 15,
});
assert.ok(poor.score !== null && poor.score < 40, `poor store scores low (${poor.score})`);
assert.equal(poor.tier, null);
assert.ok(
  !poor.badges.some(
    (b) => b.code === "low_cancellation" || b.code === "fast_response" || b.code === "high_rating"
  )
);

// Rating shrinkage: three 5★ reviews do not outrank three hundred 4.8★ ones.
assert.ok(shrunkRating(5, 3) < shrunkRating(4.8, 300));
assert.equal(shrunkRating(null, 0), null);

// Badge evidence floors: one fast reply is not «ردّ سريع».
assert.ok(
  !judgeStore({
    ...base,
    completedOrders: 5,
    settledOrders: 4,
    medianResponseMinutes: 1,
  }).badges.some((b) => b.code === "fast_response")
);
assert.ok(
  judgeStore({
    ...base,
    completedOrders: 5,
    settledOrders: 5,
    medianResponseMinutes: 1,
  }).badges.some((b) => b.code === "fast_response" && b.level === "platinum")
);

// Tier edges.
assert.equal(tierFor(85), "platinum");
assert.equal(tierFor(84.99), "gold");
assert.equal(tierFor(55), "silver");
assert.equal(tierFor(40), "bronze");
assert.equal(tierFor(39.99), null);

// ── opening hours, Baghdad time (UTC+3) ─────────────────────────────────────
// Instants are built from the NEXT Sunday at 00:00Z, never written as dates (ق-169).
const DAY = 86_400_000;
const HOUR = 3_600_000;
const today = new Date(Date.now());
const sunday0 = Date.UTC(
  today.getUTCFullYear(),
  today.getUTCMonth(),
  today.getUTCDate() + (7 - today.getUTCDay())
);
const at = (dayOffset, utcHours) => new Date(sunday0 + dayOffset * DAY + utcHours * HOUR);
const t = (hhmm) =>
  new Date(Date.UTC(1970, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5))));
const hours = [
  { weekday: 0, opensAt: t("09:00"), closesAt: t("17:00") }, // Sunday day shift
  { weekday: 4, opensAt: t("18:00"), closesAt: t("02:00") }, // Thursday night across midnight
];
assert.equal(at(0, 0).getUTCDay(), 0, "the anchor is a Sunday");
assert.equal(isOpenAt(hours, at(0, 7)), true, "Sunday 10:00 Baghdad (07:00Z) open");
assert.equal(isOpenAt(hours, at(0, 14)), false, "Sunday 17:00 Baghdad closed (end exclusive)");
assert.equal(isOpenAt(hours, at(0, 5.99)), false, "Sunday 08:59 Baghdad closed");
assert.equal(isOpenAt(hours, at(4, 20)), true, "Thursday 23:00 Baghdad open");
assert.equal(
  isOpenAt(hours, at(4, 22.5)),
  true,
  "Friday 01:30 Baghdad still open from Thursday's shift"
);
assert.equal(isOpenAt(hours, at(4, 23.5)), false, "Friday 02:30 Baghdad closed");
assert.equal(isOpenAt([], new Date()), null, "no published hours: unknown, not closed");
const view = hoursView(hours, at(0, 7));
assert.equal(view.days.length, 7);
assert.deepEqual(view.days[4], { weekday: 4, opensAt: "18:00", closesAt: "02:00" });
assert.deepEqual(view.days[1], { weekday: 1, opensAt: null, closesAt: null });

// ── granted marks and the badge sheet ───────────────────────────────────────
const now = new Date(sunday0);
const marks = grantedMarks(
  {
    verifiedAt: now,
    isBrand: false,
    ambassadorUntil: new Date(sunday0 + 9 * DAY),
    boostedUntil: new Date(sunday0 - 21 * DAY),
    marketListedAt: new Date(sunday0 - 12 * DAY),
  },
  now
);
assert.deepEqual(marks, ["verified", "ambassador", "new_store"], "an expired boost is not shown");
const sheet = badgeViews([{ code: "fast_response", level: "gold" }], marks);
assert.equal(sheet.length, BADGE_CATALOG.length);
assert.equal(sheet.filter((b) => b.earned).length, 4);
assert.equal(sheet.find((b) => b.code === "fast_response").level, "gold");

console.log(
  JSON.stringify(
    {
      suite: "market-score",
      status: "passed",
      summary: { excellentScore: excellent.score, poorScore: poor.score },
    },
    null,
    2
  )
);

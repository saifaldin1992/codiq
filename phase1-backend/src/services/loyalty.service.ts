/**
 * CD-5 «نقاط الولاء» — earned on completion, spent as a discount.
 *
 * THE BALANCE IS A SUM, NOT A COLUMN. There is no `customers.points` anywhere.
 * `loyaltyBalance` adds the signed entries every time it is asked, exactly as
 * the merchant's wallet reads the finance ledger. A stored balance that drifts
 * from its own history is the defining loyalty bug — the shopper sees one
 * number, the statement shows another, and nobody can say which is wrong.
 *
 * THE SIGN LIVES IN `kind`. Every `points` value is positive, and this file is
 * the ONE place that decides what each kind does to a total. A query elsewhere
 * that forgets the rule produces an obviously wrong number rather than a
 * plausible one.
 *
 * EARNING IS IDEMPOTENT BY INDEX, not by a check-then-insert. Completion can be
 * retried, and `loyalty_entries_one_per_order_kind_uq` makes the second attempt
 * collide instead of minting a second award.
 *
 * A RETURN REVERSES BOTH SIDES. Without the earn clawback, buy → return is a
 * points printer. Without the spend refund, a shopper who paid half a returned
 * order in points is refunded in money for the cash half and nothing for the
 * points half — which is keeping part of his payment.
 *
 * A POINT CARRIES THE VALUE IT WAS EARNED AT (LOY-1). Each `earned` row is a
 * LOT that knows its own rate, and redemption prices every lot at that rate, not
 * at whatever the settings screen says today. The lots are a FOLD of this same
 * append-only log — `foldLoyaltyLots` — so there is still no second place where
 * a balance could drift from its own history. See the fold for the rules it
 * obeys, and why each one is the reading most generous to the shopper.
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "./list-page.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

/** How each kind moves a balance. The single source of the sign. */
const SIGN: Record<string, number> = { earned: 1, refunded_spend: 1, spent: -1, reversed_earn: -1 };

/**
 * Programme bounds, owned here and imported by the HTTP schema. They mirror
 * `stores_loyalty_rates_ck` in the CD-5 migration — the database is still the
 * authority; these exist so a merchant gets a message he can read instead of
 * a constraint violation.
 */
export const LOYALTY_EARN_PER_1000_MAX = 1000;
export const LOYALTY_POINT_VALUE_MIN = 1;
export const LOYALTY_POINT_VALUE_MAX = 10000;

/**
 * 19-د — THE SOLVENCY BOUND, and the reason it is 1000 and not a taste.
 *
 * The two bounds above are independent, so their PRODUCT was not bounded at
 * all: earnPer1000 = 1000 with pointValueIqd = 10000 means every 1,000 IQD of
 * goods mints points redeemable for 10,000,000 IQD — a 10,000× multiplier that
 * a merchant can set on his own store with `settings.manage` and no review.
 *
 * `earnPer1000 × pointValueIqd ≤ 1000` says: a sale may never award points
 * worth more than the sale itself. That is not a marketing opinion about how
 * generous a programme should be — it is the line past which the programme
 * prints redemption capacity out of nothing, whatever anyone intended. The
 * default rate (10 × 10 = 100) is a 10% programme and sits an order of
 * magnitude inside it, so no reachable programme design is refused.
 *
 * WHAT THIS USED NOT TO CLOSE — and LOY-1 now does. A balance used to be stored
 * in POINTS and priced at redemption time, so changing `pointValueIqd` re-priced
 * every point already earned; LOWERING it confiscated value a customer had
 * already been promised. That was raised for the owner rather than invented
 * here, and the answer is the rule below: a rate change applies to points earned
 * from that moment ON. Each lot keeps the rate it was earned at, so the only
 * direction a merchant can still move an outstanding balance is UPWARDS, by
 * being more generous on what he awards next.
 */
export const LOYALTY_MAX_AWARD_IQD_PER_1000 = 1000;

export interface LoyaltySettings {
  enabled: boolean;
  earnPer1000: number;
  pointValueIqd: number;
}

export async function loyaltySettings(tx: DbClient, storeId: string): Promise<LoyaltySettings> {
  const store = await tx.store.findUnique({
    where: { id: storeId },
    select: { loyaltyEnabled: true, loyaltyEarnPer1000: true, loyaltyPointValueIqd: true },
  });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر غير موجود.");
  return {
    enabled: store.loyaltyEnabled,
    earnPer1000: store.loyaltyEarnPer1000,
    pointValueIqd: store.loyaltyPointValueIqd,
  };
}

export async function loyaltyBalance(
  tx: DbClient,
  storeId: string,
  customerId: string
): Promise<number> {
  const groups = await tx.loyaltyEntry.groupBy({
    by: ["kind"],
    where: { storeId, customerId },
    _sum: { points: true },
  });
  return groups.reduce(
    (total, group) => total + (SIGN[group.kind] ?? 0) * (group._sum.points ?? 0),
    0
  );
}

/**
 * LOY-1 — a LOT: points earned together, at the rate they were earned at.
 *
 * `points` is what is LEFT of the lot, not what it started as.
 */
export interface LoyaltyLot {
  earnEntryId: string;
  orderId: string;
  pointValueIqd: number;
  points: number;
  earnedAt: Date;
}

export interface LoyaltyHolding {
  /** Oldest first — the order redemption spends them in. Empty lots are dropped. */
  lots: LoyaltyLot[];
  /** The same number `loyaltyBalance` reports, arrived at a second way. */
  points: number;
  /** EXACT, not an estimate: every remaining point priced at its own rate. */
  valueIqd: number;
}

type FoldableEntry = {
  id: string;
  orderId: string;
  kind: string;
  points: number;
  pointValueIqd: number | null;
  createdAt: Date;
};

/**
 * THE FOLD. The one place that turns the append-only log into what the shopper
 * is actually holding. Pure, so it can be reasoned about without a database.
 *
 * OLDEST FIRST when he spends. Two reasons, and the first is the one that
 * matters: it is the most generous reading available to him, because his oldest
 * points are the ones a merchant has had the longest to devalue — spending them
 * first is the only order under which a rate cut can never strand the balance it
 * was aimed at. The second is that FIFO is the order a person already expects
 * from a queue, so the statement matches his intuition without a footnote.
 *
 * NEWEST FIRST when points are taken BACK. A clawback is the inverse of an
 * award, so it undoes the most recent award first; the stack that survives is
 * always «the oldest points he still has», which is the same story the spending
 * rule tells. A `reversed_earn` takes from its OWN lot before any other, since
 * those are literally the points the returned order minted.
 *
 * A REFUND RESTORES THE LOTS IT CAME FROM. The pass remembers what each spend
 * consumed, so returning an order that was paid in points puts those exact
 * points back at their own rates — not at today's, and not as one flat lot.
 *
 * `deficit` is points owed rather than held: a clawback can outrun everything
 * the shopper has left (earn 100, spend 100, then return the earning order). The
 * old code let that show up as a negative total and nothing more; here it is
 * named, settled out of the next award before it becomes spendable, and it keeps
 * `points` below equal to the signed sum the ledger reports — which is what the
 * cd5 suite checks a second, independent way.
 */
export function foldLoyaltyLots(
  entries: readonly FoldableEntry[],
  currentPointValueIqd: number
): LoyaltyHolding {
  type Working = LoyaltyLot & { earnedPoints: number };
  const lots: Working[] = [];
  /** What each order's spend actually consumed, so its refund can undo exactly that. */
  const consumedBySpend = new Map<string, Array<{ lot: Working; points: number }>>();
  let deficit = 0;

  /** Pay down what he owes out of what he holds, newest first. */
  const settleDeficit = () => {
    for (let index = lots.length - 1; index >= 0 && deficit > 0; index -= 1) {
      const taken = Math.min(lots[index].points, deficit);
      lots[index].points -= taken;
      deficit -= taken;
    }
  };

  for (const entry of entries) {
    if (entry.kind === "earned") {
      lots.push({
        earnEntryId: entry.id,
        orderId: entry.orderId,
        // A pre-LOY-1 row cannot exist (the migration stamps every one and the
        // check constraint refuses new ones), so this only keeps the fold total.
        pointValueIqd: entry.pointValueIqd ?? currentPointValueIqd,
        points: entry.points,
        earnedPoints: entry.points,
        earnedAt: entry.createdAt,
      });
      settleDeficit();
      continue;
    }

    if (entry.kind === "spent") {
      const consumed: Array<{ lot: Working; points: number }> = [];
      let left = entry.points;
      for (const lot of lots) {
        if (left <= 0) break;
        const taken = Math.min(lot.points, left);
        if (taken <= 0) continue;
        lot.points -= taken;
        left -= taken;
        consumed.push({ lot, points: taken });
      }
      deficit += left;
      consumedBySpend.set(entry.orderId, consumed);
      continue;
    }

    if (entry.kind === "reversed_earn") {
      let left = entry.points;
      const own = lots.find((lot) => lot.orderId === entry.orderId);
      if (own) {
        const taken = Math.min(own.points, left);
        own.points -= taken;
        left -= taken;
      }
      for (let index = lots.length - 1; index >= 0 && left > 0; index -= 1) {
        const taken = Math.min(lots[index].points, left);
        lots[index].points -= taken;
        left -= taken;
      }
      deficit += left;
      continue;
    }

    if (entry.kind === "refunded_spend") {
      const consumed = consumedBySpend.get(entry.orderId);
      if (consumed) {
        for (const part of consumed) part.lot.points += part.points;
        consumedBySpend.delete(entry.orderId);
      } else {
        // Only reachable if the spend this refund mirrors is missing from the
        // log, which the return path cannot produce — a refund is written from
        // the spend row it is refunding. Restoring oldest-first up to each lot's
        // original size keeps the TOTAL exact and invents no rate; the residue
        // (none, in any reachable history) rides on `deficit` so the total still
        // matches the signed sum.
        let left = entry.points;
        for (const lot of lots) {
          if (left <= 0) break;
          const restored = Math.min(lot.earnedPoints - lot.points, left);
          lot.points += restored;
          left -= restored;
        }
        deficit -= left;
      }
      settleDeficit();
      continue;
    }
  }

  settleDeficit();
  const held = lots.filter((lot) => lot.points > 0);
  return {
    lots: held.map(({ earnEntryId, orderId, pointValueIqd, points, earnedAt }) => ({
      earnEntryId,
      orderId,
      pointValueIqd,
      points,
      earnedAt,
    })),
    points: held.reduce((total, lot) => total + lot.points, 0) - deficit,
    valueIqd:
      held.reduce((total, lot) => total + lot.points * lot.pointValueIqd, 0) -
      deficit * currentPointValueIqd,
  };
}

/** What the shopper is holding, lot by lot, oldest first. */
export async function loyaltyHolding(
  tx: DbClient,
  storeId: string,
  customerId: string,
  settings: LoyaltySettings
): Promise<LoyaltyHolding> {
  const entries = await tx.loyaltyEntry.findMany({
    where: { storeId, customerId },
    // The fold replays history, so the order is the history's own. `id` breaks a
    // timestamp tie deterministically — two rows written in one transaction share
    // `now()`, and a balance that depends on which one Postgres returns first is
    // not a balance.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      orderId: true,
      kind: true,
      points: true,
      pointValueIqd: true,
      createdAt: true,
    },
  });
  return foldLoyaltyLots(entries, settings.pointValueIqd);
}

/** Points awarded for a given commissionable subtotal, at the store's rate. */
export function pointsForSubtotal(subtotalIqd: number, settings: LoyaltySettings): number {
  if (!settings.enabled || settings.earnPer1000 <= 0 || subtotalIqd <= 0) return 0;
  // Floor: a shopper who spent 1,999 earns one thousand's worth, not two. Being
  // generous by rounding up would make the number impossible to predict.
  return Math.floor((subtotalIqd / 1000) * settings.earnPer1000);
}

/**
 * Awards points for a completed order. Called from the same transaction as the
 * finance completion entry, so points and money are decided together.
 *
 * Earns on the DISCOUNTED subtotal — the amount the shopper actually paid for
 * goods. Earning on the pre-discount figure would pay him points for money he
 * never spent, and pay them again on the coupon he already benefited from.
 */
export async function awardLoyaltyPoints(
  tx: Prisma.TransactionClient,
  input: { storeId: string; orderId: string; customerId: string | null; subtotalIqd: number }
): Promise<number> {
  if (!input.customerId) return 0; // A guest has no account to hold points in.
  const settings = await loyaltySettings(tx, input.storeId);
  const points = pointsForSubtotal(input.subtotalIqd, settings);
  if (points <= 0) return 0;
  // `skipDuplicates`, NOT a try/catch on P2002. Catching a unique violation
  // inside a PostgreSQL transaction does not work: the failed statement aborts
  // the whole transaction, and every statement after it dies with 25P02. This
  // runs inside the order-transition transaction, so a swallowed collision would
  // have taken the entire completion down with it — the exact opposite of the
  // idempotency it was meant to provide.
  const written = await tx.loyaltyEntry.createMany({
    // LOY-1: the rate is stamped ON the award. This row is the LOT, and what it
    // is worth is settled here, once, at the moment it is earned — not looked up
    // again months later from a settings screen the merchant has edited since.
    data: [
      {
        storeId: input.storeId,
        customerId: input.customerId,
        orderId: input.orderId,
        kind: "earned",
        points,
        pointValueIqd: settings.pointValueIqd,
      },
    ],
    skipDuplicates: true,
  });
  return written.count > 0 ? points : 0;
}

/**
 * Reverses both sides of a returned order: the award is taken back, and any
 * points the shopper spent on it are returned to him.
 *
 * Deliberately tolerant of missing halves — an order may have earned without
 * spending, or (with the programme switched on mid-life) neither.
 */
export async function reverseLoyaltyForReturn(
  tx: Prisma.TransactionClient,
  input: { storeId: string; orderId: string }
): Promise<{ clawedBack: number; refunded: number }> {
  const entries = await tx.loyaltyEntry.findMany({
    where: { storeId: input.storeId, orderId: input.orderId, kind: { in: ["earned", "spent"] } },
    select: { kind: true, points: true, valueIqd: true, customerId: true },
  });
  const rows = entries.map((entry) => ({
    storeId: input.storeId,
    customerId: entry.customerId,
    orderId: input.orderId,
    kind: entry.kind === "earned" ? "reversed_earn" : "refunded_spend",
    points: entry.points,
    // A refund is worth what it was worth when SPENT, not what the rate says
    // today: the merchant may have changed it since.
    valueIqd: entry.kind === "earned" ? null : (entry.valueIqd ?? 0),
  }));
  if (rows.length === 0) return { clawedBack: 0, refunded: 0 };

  const before = await tx.loyaltyEntry.findMany({
    where: {
      storeId: input.storeId,
      orderId: input.orderId,
      kind: { in: ["reversed_earn", "refunded_spend"] },
    },
    select: { kind: true },
  });
  const alreadyDone = new Set(before.map((row) => row.kind));
  // One statement, `skipDuplicates` — see awardLoyaltyPoints for why this must
  // not be a try/catch. Reversing twice writes nothing the second time.
  await tx.loyaltyEntry.createMany({ data: rows, skipDuplicates: true });

  let clawedBack = 0;
  let refunded = 0;
  for (const row of rows) {
    if (alreadyDone.has(row.kind)) continue;
    if (row.kind === "reversed_earn") clawedBack += row.points;
    else refunded += row.points;
  }
  return { clawedBack, refunded };
}

export interface LoyaltyRedemption {
  points: number;
  discountIqd: number;
}

/**
 * Prices a redemption INSIDE the checkout transaction, without writing.
 *
 * Split from the commit below because the order id does not exist yet when the
 * total has to be computed — and because the two must not be reordered: the
 * price is what the shopper is charged, and the row is what he is charged
 * against.
 *
 * The balance is read here under the transaction. Checkout runs at serializable
 * isolation, so two simultaneous redemptions of the same points do not both
 * succeed — the second is retried and sees the first.
 *
 * CAPPED at what is left to pay for GOODS after any coupon. Uncapped, a large
 * balance could drive the goods total to zero or below. The delivery fee sits
 * outside the cap on purpose: a courier is paid in money whatever is redeemed.
 *
 * LOY-1: PRICED LOT BY LOT, oldest first, each at the rate it was earned at.
 * There is no single «point value» in this function any more, because there is
 * no single answer — a shopper who earned before a rate cut is holding points
 * worth more than the ones he earned after it, and both are his.
 *
 * The lots taken are always a PREFIX of his oldest-first queue, whether the walk
 * stops because he asked for fewer points or because the order ran out of goods
 * to discount. That is what makes the money exact rather than indicative: the
 * value of N points is the value of the first N in the queue, and every screen
 * that shows him a figure computes exactly that.
 */
export async function previewLoyaltyRedemption(
  tx: Prisma.TransactionClient,
  input: {
    storeId: string;
    customerId: string;
    requestedPoints: unknown;
    subtotalIqd: number;
    couponDiscountIqd: number;
  }
): Promise<LoyaltyRedemption> {
  const none: LoyaltyRedemption = { points: 0, discountIqd: 0 };
  if (input.requestedPoints === undefined || input.requestedPoints === null) return none;
  const requested = Number(input.requestedPoints);
  if (!Number.isInteger(requested) || requested < 0) {
    throw new HttpError(
      422,
      "INVALID_LOYALTY_POINTS",
      "عدد النقاط يجب أن يكون رقماً صحيحاً موجباً."
    );
  }
  if (requested === 0) return none;

  const settings = await loyaltySettings(tx, input.storeId);
  if (!settings.enabled)
    throw new HttpError(422, "LOYALTY_DISABLED", "برنامج النقاط غير مفعّل في هذا المتجر.");

  const holding = await loyaltyHolding(tx, input.storeId, input.customerId, settings);
  if (requested > holding.points) {
    throw new HttpError(
      422,
      "INSUFFICIENT_LOYALTY_POINTS",
      `رصيدك ${holding.points} نقطة، ولا يكفي لصرف ${requested}.`
    );
  }

  // Spend what is useful rather than refusing: a shopper who offers his whole
  // balance on a small order should get the small discount and keep the rest,
  // not an error asking him to do the arithmetic himself.
  let payableLeft = Math.max(0, input.subtotalIqd - input.couponDiscountIqd);
  let points = 0;
  let discountIqd = 0;
  for (const lot of holding.lots) {
    if (points >= requested) break;
    // The queue STOPS here rather than skipping ahead to a cheaper lot. Skipping
    // would strand his oldest points behind a single expensive one for good,
    // which is the exact thing spending oldest-first exists to prevent — and it
    // only ever costs him on an order whose whole goods total is worth less than
    // one of his points, where saving that point is the better outcome anyway.
    const affordable = Math.floor(payableLeft / lot.pointValueIqd);
    if (affordable <= 0) break;
    const taken = Math.min(lot.points, requested - points, affordable);
    points += taken;
    discountIqd += taken * lot.pointValueIqd;
    payableLeft -= taken * lot.pointValueIqd;
  }
  if (points <= 0) return none;
  return { points, discountIqd };
}

/** Writes the spend row, once the order it belongs to exists. */
export async function commitLoyaltyRedemption(
  tx: Prisma.TransactionClient,
  input: { storeId: string; customerId: string; orderId: string; redemption: LoyaltyRedemption }
): Promise<void> {
  if (input.redemption.points <= 0) return;
  await tx.loyaltyEntry.create({
    data: {
      storeId: input.storeId,
      customerId: input.customerId,
      orderId: input.orderId,
      kind: "spent",
      points: input.redemption.points,
      valueIqd: input.redemption.discountIqd,
    },
  });
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const LOYALTY_ENTRIES_KIND = "storefront.account.loyalty";

/**
 * The shopper's own statement: his balance and where it came from.
 * D-18: `entries` was a fixed 50 rows with no page 2, so a shopper who has been
 * earning points for a year could not see where the older ones came from —
 * which is the only question this statement answers.
 */
export async function loyaltyStatement(
  storeId: string,
  customerId: string,
  rawLimit?: unknown,
  rawCursor?: unknown
) {
  const limit = parseListLimit(rawLimit, 100, 50);
  const cursor = await readListCursor(LOYALTY_ENTRIES_KIND, rawCursor);
  const settings = await loyaltySettings(prisma, storeId);
  const [balance, holding, entries] = await Promise.all([
    loyaltyBalance(prisma, storeId, customerId),
    loyaltyHolding(prisma, storeId, customerId, settings),
    prisma.loyaltyEntry.findMany({
      where: { storeId, customerId, ...keysetWhere("createdAt", "desc", cursor) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        kind: true,
        points: true,
        valueIqd: true,
        pointValueIqd: true,
        createdAt: true,
        order: { select: { id: true, orderNumber: true } },
      },
    }),
  ]);
  return {
    enabled: settings.enabled,
    pointValueIqd: settings.pointValueIqd,
    earnPer1000: settings.earnPer1000,
    // Two computations of the same number: the signed sum of the log, and the
    // fold that produces the lots. They are asserted equal in cd5 rather than
    // trusted, because the day they disagree the shopper is being shown a lie
    // and only one of them can be the reason.
    balance,
    // LOY-1: EXACT, not an estimate. Every remaining point priced at the rate it
    // was earned at, so this is the figure redemption will actually give him —
    // it used to be `balance × today's rate`, which a rate cut made a promise
    // the checkout would then break.
    balanceValueIqd: holding.valueIqd,
    // The lots themselves travel, oldest first, so a screen can price ANY
    // redemption he is considering without asking the server to guess for him.
    lots: holding.lots.map((lot) => ({
      points: lot.points,
      pointValueIqd: lot.pointValueIqd,
      earnedAt: lot.earnedAt,
    })),
    ...(() => {
      const { page, nextCursor } = pageOf(entries, limit, (last) =>
        encodeListCursor(LOYALTY_ENTRIES_KIND, last.createdAt, last.id)
      );
      return {
        entries: page.map((entry) => ({
          ...entry,
          signedPoints: (SIGN[entry.kind] ?? 0) * entry.points,
        })),
        nextCursor,
      };
    })(),
  };
}

/**
 * The merchant's programme settings.
 *
 * Changing a rate never touches history: every spend row snapshots what its
 * points were worth, so an old order still explains its own total after the
 * merchant doubles the value tomorrow.
 *
 * LOY-1: nor does it touch the points a shopper is already HOLDING. A new rate
 * applies to what is earned from here on; every outstanding lot keeps the rate
 * it was earned at. That is why lowering the value needs no guard of its own —
 * there is no longer anything to confiscate. Raising it is left free, because a
 * merchant may always choose to be more generous with what he awards next.
 */
export async function updateLoyaltySettings(
  storeId: string,
  body: Record<string, unknown>
): Promise<LoyaltySettings> {
  const data: {
    loyaltyEnabled?: boolean;
    loyaltyEarnPer1000?: number;
    loyaltyPointValueIqd?: number;
  } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean")
      throw new HttpError(422, "INVALID_INPUT", "enabled يجب أن يكون true أو false.");
    data.loyaltyEnabled = body.enabled;
  }
  if (body.earnPer1000 !== undefined) {
    const value = Number(body.earnPer1000);
    if (!Number.isInteger(value) || value < 0 || value > LOYALTY_EARN_PER_1000_MAX)
      throw new HttpError(422, "INVALID_INPUT", "نقاط كل 1000 دينار: رقم صحيح بين 0 و1000.");
    data.loyaltyEarnPer1000 = value;
  }
  if (body.pointValueIqd !== undefined) {
    const value = Number(body.pointValueIqd);
    if (
      !Number.isInteger(value) ||
      value < LOYALTY_POINT_VALUE_MIN ||
      value > LOYALTY_POINT_VALUE_MAX
    )
      throw new HttpError(422, "INVALID_INPUT", "قيمة النقطة: رقم صحيح بين 1 و10000 دينار.");
    data.loyaltyPointValueIqd = value;
  }
  // 19-د: the two rates are only dangerous TOGETHER, so the rule is checked on
  // the pair that would result — a PUT carrying one field is merged with what
  // is stored, or a merchant reaches the same place in two requests. The
  // cross-field rule lives here rather than in the schema for the reason
  // `updateDeliveryRate` gives: the next person to add a field reads this file.
  const current = await loyaltySettings(prisma, storeId);
  const nextEarnPer1000 = data.loyaltyEarnPer1000 ?? current.earnPer1000;
  const nextPointValueIqd = data.loyaltyPointValueIqd ?? current.pointValueIqd;
  if (nextEarnPer1000 * nextPointValueIqd > LOYALTY_MAX_AWARD_IQD_PER_1000) {
    throw new HttpError(
      422,
      "INVALID_LOYALTY_RATES",
      `النقاط الممنوحة عن كل 1000 دينار لا يجوز أن تساوي أكثر من ${LOYALTY_MAX_AWARD_IQD_PER_1000} دينار عند الصرف. خفّض نقاط كل 1000 دينار أو قيمة النقطة.`
    );
  }
  await prisma.store.update({ where: { id: storeId }, data });
  return loyaltySettings(prisma, storeId);
}

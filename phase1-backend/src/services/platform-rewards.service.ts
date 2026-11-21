/**
 * Marketplace M8b — the platform's coupons and points, at the points where they
 * touch an order. Called from INSIDE the checkout and order-lifecycle
 * transactions, so a coupon is spent, returned, and points are earned or clawed
 * back with the order or not at all.
 *
 * WHO PAYS. A platform coupon lowers what the shopper pays and nothing the
 * store is owed: it is `store_orders.platform_discount_iqd`, NOT `discount_iqd`,
 * so it never shrinks the commission base nor the payout. The platform carries
 * it (owner default, docs/MARKETPLACE_PLAN.md §4). Platform points are earned on
 * what the shopper paid in money for goods, and are the platform's to give.
 */
import type { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";

type Tx = Prisma.TransactionClient;

// ── tiers ──────────────────────────────────────────────────────────────────

/** Points earned in the last year decide the tier; the tier multiplies what an order earns. */
export const POINT_TIERS = [
  { code: "bronze", label: "برونزي", minPoints: 0, multiplierPct: 100 },
  { code: "silver", label: "فضّي", minPoints: 2000, multiplierPct: 125 },
  { code: "gold", label: "ذهبي", minPoints: 5000, multiplierPct: 150 },
  { code: "diamond", label: "ماسي", minPoints: 15000, multiplierPct: 200 },
] as const;
/** One point per this many dinars paid for goods, before the tier multiplier. */
export const IQD_PER_POINT = 1000;
const YEAR_MS = 365 * 86_400_000;

export function tierFor(yearPoints: number) {
  let tier: (typeof POINT_TIERS)[number] = POINT_TIERS[0];
  for (const candidate of POINT_TIERS) if (yearPoints >= candidate.minPoints) tier = candidate;
  const next = POINT_TIERS.find((candidate) => candidate.minPoints > yearPoints) ?? null;
  return { tier, next, toNext: next ? next.minPoints - yearPoints : 0 };
}

/** Net points earned in the last year (earned less clawed back) — the tier's measure. */
export async function yearPoints(db: Tx, shopperId: string, now = new Date()) {
  const rows = await db.shopperPointsEntry.aggregate({
    where: {
      shopperId,
      reason: { in: ["earned", "clawback"] },
      createdAt: { gte: new Date(now.valueOf() - YEAR_MS) },
    },
    _sum: { delta: true },
  });
  return Math.max(0, rows._sum.delta ?? 0);
}

export async function pointsBalance(db: Tx, shopperId: string) {
  const rows = await db.shopperPointsEntry.aggregate({
    where: { shopperId },
    _sum: { delta: true },
  });
  return rows._sum.delta ?? 0;
}

// ── the coupon at checkout ─────────────────────────────────────────────────

type CouponRow = {
  id: string;
  kind: string;
  percentOff: number | null;
  amountOffIqd: number | null;
  maxDiscountIqd: number | null;
  minSubtotalIqd: number;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
  allStores: boolean;
};

export function platformDiscountFor(
  coupon: Pick<CouponRow, "kind" | "percentOff" | "amountOffIqd" | "maxDiscountIqd">,
  baseIqd: number
): number {
  if (baseIqd <= 0) return 0;
  const raw =
    coupon.kind === "percent"
      ? Math.floor((baseIqd * (coupon.percentOff ?? 0)) / 100)
      : (coupon.amountOffIqd ?? 0);
  return Math.max(0, Math.min(raw, coupon.maxDiscountIqd ?? raw, baseIqd));
}

/** Why a held coupon cannot be used on this store's order now, or null. */
export function platformCouponRefusal(
  coupon: CouponRow,
  storeAllowed: boolean,
  baseIqd: number,
  now: Date
): string | null {
  if (!coupon.isActive || now < coupon.startsAt) return "هذا الكوبون غير مفعّل بعد.";
  if (now >= coupon.endsAt) return "انتهت صلاحية هذا الكوبون.";
  if (!storeAllowed) return "هذا الكوبون لا يعمل في هذا المتجر.";
  if (baseIqd < coupon.minSubtotalIqd)
    return `هذا الكوبون لطلبات بقيمة ${coupon.minSubtotalIqd.toLocaleString("en-US")} د.ع فأكثر.`;
  return null;
}

/**
 * Locks the shopper's held coupon for this checkout (FOR UPDATE on its wallet
 * row), so two checkouts racing with the same coupon cannot both spend it: the
 * second waits, then reads it used.
 */
export async function lockPlatformCouponForCheckout(
  tx: Tx,
  input: { walletId: string; shopperId: string | null; storeId: string; baseIqd: number; now: Date }
) {
  if (!input.shopperId)
    throw new HttpError(422, "PLATFORM_COUPON_NOT_HELD", "كوبونات السوق لحسابات السوق فقط.");
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM shopper_coupons WHERE id = ${input.walletId}::uuid AND shopper_id = ${input.shopperId}::uuid FOR UPDATE`;
  if (!locked.length)
    throw new HttpError(404, "PLATFORM_COUPON_NOT_HELD", "هذا الكوبون ليس في كوبوناتك.");
  const held = await tx.shopperCoupon.findUniqueOrThrow({
    where: { id: input.walletId },
    include: { coupon: true },
  });
  if (held.usedOrderId)
    throw new HttpError(409, "PLATFORM_COUPON_USED", "استُخدم هذا الكوبون في طلب آخر.");
  const storeAllowed =
    held.coupon.allStores ||
    Boolean(
      await tx.platformCouponStore.findUnique({
        where: { couponId_storeId: { couponId: held.couponId, storeId: input.storeId } },
        select: { storeId: true },
      })
    );
  const refusal = platformCouponRefusal(held.coupon, storeAllowed, input.baseIqd, input.now);
  if (refusal) throw new HttpError(422, "PLATFORM_COUPON_NOT_APPLICABLE", refusal);
  return {
    walletId: held.id,
    coupon: held.coupon,
    discountIqd: platformDiscountFor(held.coupon, input.baseIqd),
  };
}

export async function markPlatformCouponUsed(tx: Tx, walletId: string, orderId: string, now: Date) {
  const used = await tx.shopperCoupon.updateMany({
    where: { id: walletId, usedOrderId: null },
    data: { usedOrderId: orderId, usedAt: now },
  });
  if (used.count !== 1)
    throw new HttpError(409, "PLATFORM_COUPON_USED", "استُخدم هذا الكوبون في طلب آخر.");
}

// ── the order's life ───────────────────────────────────────────────────────

/** Cancelled or refused before it was paid: the coupon goes back to his wallet. */
export async function releasePlatformCoupon(tx: Tx, orderId: string) {
  await tx.shopperCoupon.updateMany({
    where: { usedOrderId: orderId },
    data: { usedOrderId: null, usedAt: null },
  });
}

/**
 * Completed: platform points on what he paid IN MONEY for the goods (every
 * discount — the store's coupon and points, the platform's coupon — taken off),
 * multiplied by his tier. Once per order (unique index), so a re-entered
 * transition cannot pay twice.
 */
export async function awardPlatformPoints(
  tx: Tx,
  input: { orderId: string; customerId: string | null; paidGoodsIqd: number; now?: Date }
) {
  if (!input.customerId || input.paidGoodsIqd <= 0) return 0;
  const customer = await tx.customer.findUnique({
    where: { id: input.customerId },
    select: { shopperId: true },
  });
  if (!customer?.shopperId) return 0;
  const { tier } = tierFor(await yearPoints(tx, customer.shopperId, input.now));
  const points = Math.floor(
    (Math.floor(input.paidGoodsIqd / IQD_PER_POINT) * tier.multiplierPct) / 100
  );
  if (points <= 0) return 0;
  const written = await tx.shopperPointsEntry.createMany({
    data: [
      { shopperId: customer.shopperId, delta: points, reason: "earned", orderId: input.orderId },
    ],
    skipDuplicates: true,
  });
  return written.count ? points : 0;
}

/** Returned: the points it earned come back off. His balance may go below zero; he earns it back. */
export async function clawbackPlatformPoints(tx: Tx, orderId: string) {
  const earned = await tx.shopperPointsEntry.findFirst({
    where: { orderId, reason: "earned" },
    select: { shopperId: true, delta: true },
  });
  if (!earned) return;
  await tx.shopperPointsEntry.createMany({
    data: [{ shopperId: earned.shopperId, delta: -earned.delta, reason: "clawback", orderId }],
    skipDuplicates: true,
  });
}

// ── wheel spins earned by orders (M9) ──────────────────────────────────────

/**
 * Completed: extra spins on the open wheel, one per `iqd_per_extra_spin` paid in
 * money for goods, capped per order. Once per order per wheel (unique), inside
 * the completion transaction.
 */
export async function grantWheelSpins(
  tx: Tx,
  input: { orderId: string; customerId: string | null; paidGoodsIqd: number; now?: Date }
) {
  if (!input.customerId || input.paidGoodsIqd <= 0) return 0;
  const now = input.now ?? new Date();
  const customer = await tx.customer.findUnique({
    where: { id: input.customerId },
    select: { shopperId: true },
  });
  if (!customer?.shopperId) return 0;
  const wheel = await tx.marketWheel.findFirst({
    where: { isOpen: true, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: "desc" },
    select: { id: true, iqdPerExtraSpin: true, maxExtraSpinsPerOrder: true },
  });
  if (!wheel) return 0;
  const spins = Math.min(
    wheel.maxExtraSpinsPerOrder,
    Math.floor(input.paidGoodsIqd / wheel.iqdPerExtraSpin)
  );
  if (spins <= 0) return 0;
  const written = await tx.wheelSpinGrant.createMany({
    data: [{ wheelId: wheel.id, shopperId: customer.shopperId, orderId: input.orderId, spins }],
    skipDuplicates: true,
  });
  return written.count ? spins : 0;
}

/** Returned: the spins it earned are withdrawn. Spins already used stay used; the balance floors at zero. */
export async function revokeWheelSpins(tx: Tx, orderId: string) {
  await tx.wheelSpinGrant.deleteMany({ where: { orderId } });
}

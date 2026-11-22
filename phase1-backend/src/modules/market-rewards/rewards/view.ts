/**
 * Market rewards — view. Split verbatim from rewards.service.ts (review batch 2, ت-١٣);
 * rewards.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";

export const COUPON_VIEW = {
  id: true,
  code: true,
  title: true,
  description: true,
  kind: true,
  percentOff: true,
  amountOffIqd: true,
  maxDiscountIqd: true,
  minSubtotalIqd: true,
  startsAt: true,
  endsAt: true,
  totalLimit: true,
  issuedCount: true,
  pointsCost: true,
  allStores: true,
  isActive: true,
} as const;

type CouponView = Prisma.PlatformCouponGetPayload<{ select: typeof COUPON_VIEW }>;

export function present(coupon: CouponView) {
  return {
    id: coupon.id,
    code: coupon.code,
    title: coupon.title,
    description: coupon.description,
    kind: coupon.kind,
    percentOff: coupon.percentOff,
    amountOffIqd: coupon.amountOffIqd,
    maxDiscountIqd: coupon.maxDiscountIqd,
    minSubtotalIqd: coupon.minSubtotalIqd,
    startsAt: coupon.startsAt,
    endsAt: coupon.endsAt,
    pointsCost: coupon.pointsCost,
    allStores: coupon.allStores,
    remaining:
      coupon.totalLimit === null ? null : Math.max(0, coupon.totalLimit - coupon.issuedCount),
  };
}

export const offered = (now: Date) => ({
  isActive: true,
  startsAt: { lte: now },
  endsAt: { gt: now },
});

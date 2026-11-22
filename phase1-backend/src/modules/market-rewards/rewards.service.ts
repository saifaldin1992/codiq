/**
 * Marketplace M8b — the shopper's side of the platform's coupons and points:
 * the coupons page and one coupon's page (with the stores it works in),
 * «كوبوناتي», claiming a free coupon, «نقاطي» with the tier, and buying a
 * coupon with points. Plus the owner's side.
 *
 * TWO RACES, BOTH CLOSED IN THE DATABASE:
 *   · a coupon with a total limit is handed out under a FOR UPDATE lock on its
 *     row, and `issued_count <= total_limit` is a CHECK — the last one cannot be
 *     handed out twice;
 *   · buying with points locks the SHOPPER's row first, then reads the balance:
 *     two purchases at once run one after the other, so points cannot be spent
 *     twice (docs/MARKETPLACE_PLAN.md M8 acceptance).
 */
/**
 * Market rewards — split by job into ./rewards/*.ts (review batch 2, ت-١٣).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  couponsPage,
  couponPage,
  issueCoupon,
  claimCoupon,
  redeemPoints,
  wallet,
  applicableCoupons,
} from "./rewards/coupons.js";
export { pointsPage } from "./rewards/points.js";
export {
  ownerCoupons,
  createCoupon,
  updateCoupon,
  setCouponStores,
  rewardsReport,
} from "./rewards/owner.js";

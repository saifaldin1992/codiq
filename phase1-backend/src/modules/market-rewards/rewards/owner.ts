/**
 * Market rewards — owner. Split verbatim from rewards.service.ts (review batch 2, ت-١٣);
 * rewards.service.ts re-exports what it always exported.
 */
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { COUPON_VIEW } from "./view.js";

// ── the owner ──────────────────────────────────────────────────────────────

type CouponInput = {
  code: string;
  title: string;
  description?: string | null;
  kind: "percent" | "fixed";
  percentOff?: number | null;
  amountOffIqd?: number | null;
  maxDiscountIqd?: number | null;
  minSubtotalIqd: number;
  startsAt: Date;
  endsAt: Date;
  totalLimit?: number | null;
  pointsCost: number;
  allStores: boolean;
  isActive: boolean;
};

function couponData(input: CouponInput) {
  return {
    code: input.code.toUpperCase(),
    title: input.title,
    description: input.description ?? null,
    kind: input.kind,
    percentOff: input.kind === "percent" ? (input.percentOff ?? null) : null,
    amountOffIqd: input.kind === "fixed" ? (input.amountOffIqd ?? null) : null,
    maxDiscountIqd: input.maxDiscountIqd ?? null,
    minSubtotalIqd: input.minSubtotalIqd,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    totalLimit: input.totalLimit ?? null,
    pointsCost: input.pointsCost,
    allStores: input.allStores,
    isActive: input.isActive,
  };
}

export async function ownerCoupons() {
  const rows = await prisma.platformCoupon.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { ...COUPON_VIEW, _count: { select: { stores: true } } },
  });
  const used = await prisma.shopperCoupon.groupBy({
    by: ["couponId"],
    where: { usedOrderId: { not: null }, couponId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  });
  return {
    coupons: rows.map(({ _count, ...row }) => ({
      ...row,
      stores: _count.stores,
      used: used.find((entry) => entry.couponId === row.id)?._count._all ?? 0,
    })),
  };
}

export async function createCoupon(input: CouponInput) {
  if (
    await prisma.platformCoupon.findUnique({
      where: { code: input.code.toUpperCase() },
      select: { id: true },
    })
  )
    throw new HttpError(409, "COUPON_CODE_TAKEN", "يوجد كوبون بهذا الرمز.");
  return {
    coupon: await prisma.platformCoupon.create({ data: couponData(input), select: COUPON_VIEW }),
  };
}

/** Once handed out, what a coupon is worth no longer changes — only its dates, its limit upward, and whether it is offered. */
export async function updateCoupon(id: string, input: CouponInput) {
  const coupon = await prisma.platformCoupon.findUnique({ where: { id } });
  if (!coupon) throw new HttpError(404, "COUPON_NOT_FOUND", "الكوبون غير موجود.");
  const data = couponData(input);
  if (coupon.issuedCount > 0) {
    const worth = [
      "code",
      "kind",
      "percentOff",
      "amountOffIqd",
      "maxDiscountIqd",
      "minSubtotalIqd",
      "pointsCost",
      "allStores",
    ] as const;
    const changed = worth.find(
      (field) =>
        (data as Record<string, unknown>)[field] !== (coupon as Record<string, unknown>)[field]
    );
    if (changed)
      throw new HttpError(
        409,
        "COUPON_ALREADY_ISSUED",
        "وُزّع هذا الكوبون؛ لا تتغيّر قيمته ولا شروطه. أنشئ كوبوناً جديداً."
      );
    if (data.totalLimit !== null && data.totalLimit < coupon.issuedCount)
      throw new HttpError(
        422,
        "COUPON_LIMIT_BELOW_ISSUED",
        `وُزّع ${coupon.issuedCount} منه بالفعل.`
      );
  }
  return {
    coupon: await prisma.platformCoupon.update({ where: { id }, data, select: COUPON_VIEW }),
  };
}

export async function setCouponStores(id: string, storeSlugs: string[]) {
  const coupon = await prisma.platformCoupon.findUnique({
    where: { id },
    select: { id: true, issuedCount: true },
  });
  if (!coupon) throw new HttpError(404, "COUPON_NOT_FOUND", "الكوبون غير موجود.");
  const stores = await prisma.store.findMany({
    where: { slug: { in: storeSlugs } },
    select: { id: true, slug: true },
  });
  const missing = storeSlugs.filter((slug) => !stores.some((store) => store.slug === slug));
  if (missing.length)
    throw new HttpError(422, "STORE_NOT_FOUND", "متاجر غير موجودة.", { storeSlugs: missing });
  await prisma.$transaction([
    prisma.platformCouponStore.deleteMany({ where: { couponId: id } }),
    prisma.platformCouponStore.createMany({
      data: stores.map((store) => ({ couponId: id, storeId: store.id })),
    }),
  ]);
  return { couponId: id, storeSlugs: stores.map((store) => store.slug) };
}

/** What the programme costs the platform: the platform discounts on completed orders, net of returns. */
export async function rewardsReport() {
  const [ledger, outstanding, issued, used] = await Promise.all([
    prisma.ledgerEntry.groupBy({ by: ["entryType"], _sum: { platformDiscountIqd: true } }),
    prisma.shopperPointsEntry.aggregate({ _sum: { delta: true } }),
    prisma.shopperCoupon.count(),
    prisma.shopperCoupon.count({ where: { usedOrderId: { not: null } } }),
  ]);
  const cost = ledger.reduce(
    (sum, row) =>
      sum + (row.entryType === "order_completed" ? 1 : -1) * (row._sum.platformDiscountIqd ?? 0),
    0
  );
  return {
    platformDiscountIqd: cost,
    pointsOutstanding: Math.max(0, outstanding._sum.delta ?? 0),
    couponsIssued: issued,
    couponsUsed: used,
  };
}

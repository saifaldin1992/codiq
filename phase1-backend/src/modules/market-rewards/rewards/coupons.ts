/**
 * Market rewards — coupons. Split verbatim from rewards.service.ts (review batch 2, ت-١٣);
 * rewards.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../db/prisma.js";
import { HttpError } from "../../../auth/auth.errors.js";
import { marketStoreCardsByIds } from "../../market-stores/directory.service.js";
import {
  pointsBalance,
  platformCouponRefusal,
  platformDiscountFor,
} from "../../../services/platform-rewards.service.js";
import {
  parseListLimit,
  decodeListCursor,
  pageOf,
  encodeListCursor,
} from "../../../services/list-page.js";
import { offered, COUPON_VIEW, present } from "./view.js";

// ── the coupons page ───────────────────────────────────────────────────────

export async function couponsPage(shopperId: string | null, now = new Date()) {
  const rows = await prisma.platformCoupon.findMany({
    where: offered(now),
    orderBy: [{ pointsCost: "asc" }, { endsAt: "asc" }, { id: "asc" }],
    take: 100,
    select: COUPON_VIEW,
  });
  const live = rows.filter((row) => row.totalLimit === null || row.issuedCount < row.totalLimit);
  const claimed = shopperId
    ? new Set(
        (
          await prisma.shopperCoupon.findMany({
            where: { shopperId, couponId: { in: live.map((row) => row.id) }, source: "claimed" },
            select: { couponId: true },
          })
        ).map((row) => row.couponId)
      )
    : new Set<string>();
  return {
    free: live
      .filter((row) => row.pointsCost === 0)
      .map((row) => ({ ...present(row), claimed: claimed.has(row.id) })),
    forPoints: live.filter((row) => row.pointsCost > 0).map(present),
  };
}

export async function couponPage(code: string, shopperId: string | null, now = new Date()) {
  const coupon = await prisma.platformCoupon.findUnique({
    where: { code: code.toUpperCase() },
    select: COUPON_VIEW,
  });
  if (!coupon || !coupon.isActive)
    throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون غير موجود.");
  const storeIds = coupon.allStores
    ? []
    : (
        await prisma.platformCouponStore.findMany({
          where: { couponId: coupon.id },
          take: 60,
          select: { storeId: true },
        })
      ).map((row) => row.storeId);
  const claimed =
    shopperId && coupon.pointsCost === 0
      ? Boolean(
          await prisma.shopperCoupon.findFirst({
            where: { shopperId, couponId: coupon.id, source: "claimed" },
            select: { id: true },
          })
        )
      : false;
  return {
    coupon: { ...present(coupon), claimed, running: coupon.startsAt <= now && coupon.endsAt > now },
    stores: coupon.allStores ? null : await marketStoreCardsByIds(storeIds),
  };
}

/** Hands one coupon out, under a lock on its row; the CHECK on issued_count is the last word. */
export async function issueCoupon(tx: Prisma.TransactionClient, couponId: string, now: Date) {
  const [row] = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM platform_coupons WHERE id = ${couponId}::uuid FOR UPDATE`;
  if (!row) throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون غير موجود.");
  const coupon = await tx.platformCoupon.findUniqueOrThrow({ where: { id: couponId } });
  if (!coupon.isActive || coupon.startsAt > now || coupon.endsAt <= now)
    throw new HttpError(409, "COUPON_NOT_OFFERED", "هذا الكوبون غير متاح الآن.");
  if (coupon.totalLimit !== null && coupon.issuedCount >= coupon.totalLimit)
    throw new HttpError(409, "COUPON_EXHAUSTED", "نفدت كمّيّة هذا الكوبون.");
  await tx.platformCoupon.update({
    where: { id: couponId },
    data: { issuedCount: { increment: 1 } },
  });
  return coupon;
}

export async function claimCoupon(shopperId: string, code: string, now = new Date()) {
  const found = await prisma.platformCoupon.findUnique({
    where: { code: code.toUpperCase() },
    select: { id: true, pointsCost: true },
  });
  if (!found) throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون غير موجود.");
  if (found.pointsCost > 0)
    throw new HttpError(409, "COUPON_COSTS_POINTS", "هذا الكوبون يُستبدل بالنقاط.");
  try {
    const held = await prisma.$transaction(async (tx) => {
      if (
        await tx.shopperCoupon.findFirst({
          where: { shopperId, couponId: found.id, source: "claimed" },
          select: { id: true },
        })
      )
        throw new HttpError(409, "COUPON_ALREADY_CLAIMED", "هذا الكوبون في كوبوناتك بالفعل.");
      await issueCoupon(tx, found.id, now);
      return tx.shopperCoupon.create({
        data: { shopperId, couponId: found.id, source: "claimed" },
        select: { id: true },
      });
    });
    return { walletId: held.id };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002")
      throw new HttpError(409, "COUPON_ALREADY_CLAIMED", "هذا الكوبون في كوبوناتك بالفعل.");
    throw error;
  }
}

export async function redeemPoints(shopperId: string, couponId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    // The shopper's row first: two purchases at once wait for each other here.
    await tx.$queryRaw`SELECT id FROM shoppers WHERE id = ${shopperId}::uuid FOR UPDATE`;
    const coupon = await tx.platformCoupon.findUnique({
      where: { id: couponId },
      select: { id: true, pointsCost: true },
    });
    if (!coupon || coupon.pointsCost <= 0)
      throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون لا يُستبدل بالنقاط.");
    const balance = await pointsBalance(tx, shopperId);
    if (balance < coupon.pointsCost)
      throw new HttpError(
        409,
        "POINTS_NOT_ENOUGH",
        `تحتاج ${coupon.pointsCost.toLocaleString("en-US")} نقطة، ورصيدك ${Math.max(0, balance).toLocaleString("en-US")}.`
      );
    await issueCoupon(tx, coupon.id, now);
    await tx.shopperPointsEntry.create({
      data: { shopperId, delta: -coupon.pointsCost, reason: "spent", couponId: coupon.id },
    });
    const held = await tx.shopperCoupon.create({
      data: { shopperId, couponId: coupon.id, source: "points" },
      select: { id: true },
    });
    return { walletId: held.id, balance: balance - coupon.pointsCost };
  });
}

// ── «كوبوناتي» ─────────────────────────────────────────────────────────────

const WALLET_KIND = "market-coupon-wallet";

export async function wallet(
  shopperId: string,
  tab: unknown,
  rawCursor: unknown,
  rawLimit: unknown,
  now = new Date()
) {
  const which = tab === "used" ? "used" : tab === "expired" ? "expired" : "active";
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(`${WALLET_KIND}.${which}`, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const where: Prisma.ShopperCouponWhereInput = {
    shopperId,
    ...(which === "used"
      ? { usedOrderId: { not: null } }
      : which === "expired"
        ? { usedOrderId: null, coupon: { OR: [{ endsAt: { lte: now } }, { isActive: false }] } }
        : { usedOrderId: null, coupon: { endsAt: { gt: now }, isActive: true } }),
    ...(cursor && at
      ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] }
      : {}),
  };
  const rows = await prisma.shopperCoupon.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      source: true,
      usedAt: true,
      usedOrderId: true,
      createdAt: true,
      coupon: { select: COUPON_VIEW },
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(`${WALLET_KIND}.${which}`, last.createdAt, last.id)
  );
  return {
    coupons: page.map((row) => ({
      walletId: row.id,
      source: row.source,
      usedAt: row.usedAt,
      usedOrderId: row.usedOrderId,
      heldSince: row.createdAt,
      coupon: present(row.coupon),
    })),
    nextCursor,
  };
}

/** The coupons he holds that work on this store's order now, with what each would take off. */
export async function applicableCoupons(
  shopperId: string,
  storeId: string,
  baseIqd: number,
  now = new Date()
) {
  const rows = await prisma.shopperCoupon.findMany({
    where: { shopperId, usedOrderId: null, coupon: { isActive: true, endsAt: { gt: now } } },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: {
      id: true,
      coupon: {
        select: { ...COUPON_VIEW, stores: { where: { storeId }, select: { storeId: true } } },
      },
    },
  });
  return rows.map((row) => {
    const refusal = platformCouponRefusal(
      row.coupon,
      row.coupon.allStores || row.coupon.stores.length > 0,
      baseIqd,
      now
    );
    return {
      walletId: row.id,
      code: row.coupon.code,
      title: row.coupon.title,
      usable: !refusal,
      reason: refusal,
      discountIqd: refusal ? 0 : platformDiscountFor(row.coupon, baseIqd),
    };
  });
}

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
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { decodeListCursor, encodeListCursor, pageOf, parseListLimit } from "../../services/list-page.js";
import { IQD_PER_POINT, POINT_TIERS, platformCouponRefusal, platformDiscountFor, pointsBalance, tierFor, yearPoints } from "../../services/platform-rewards.service.js";
import { marketStoreCardsByIds } from "../market-stores/directory.service.js";

const COUPON_VIEW = {
  id: true, code: true, title: true, description: true, kind: true, percentOff: true, amountOffIqd: true, maxDiscountIqd: true, minSubtotalIqd: true,
  startsAt: true, endsAt: true, totalLimit: true, issuedCount: true, pointsCost: true, allStores: true, isActive: true,
} as const;
type CouponView = Prisma.PlatformCouponGetPayload<{ select: typeof COUPON_VIEW }>;

function present(coupon: CouponView) {
  return {
    id: coupon.id, code: coupon.code, title: coupon.title, description: coupon.description,
    kind: coupon.kind, percentOff: coupon.percentOff, amountOffIqd: coupon.amountOffIqd, maxDiscountIqd: coupon.maxDiscountIqd, minSubtotalIqd: coupon.minSubtotalIqd,
    startsAt: coupon.startsAt, endsAt: coupon.endsAt, pointsCost: coupon.pointsCost, allStores: coupon.allStores,
    remaining: coupon.totalLimit === null ? null : Math.max(0, coupon.totalLimit - coupon.issuedCount),
  };
}

const offered = (now: Date) => ({ isActive: true, startsAt: { lte: now }, endsAt: { gt: now } });

// ── the coupons page ───────────────────────────────────────────────────────

export async function couponsPage(shopperId: string | null, now = new Date()) {
  const rows = await prisma.platformCoupon.findMany({ where: offered(now), orderBy: [{ pointsCost: "asc" }, { endsAt: "asc" }, { id: "asc" }], take: 100, select: COUPON_VIEW });
  const live = rows.filter((row) => row.totalLimit === null || row.issuedCount < row.totalLimit);
  const claimed = shopperId ? new Set((await prisma.shopperCoupon.findMany({ where: { shopperId, couponId: { in: live.map((row) => row.id) }, source: "claimed" }, select: { couponId: true } })).map((row) => row.couponId)) : new Set<string>();
  return {
    free: live.filter((row) => row.pointsCost === 0).map((row) => ({ ...present(row), claimed: claimed.has(row.id) })),
    forPoints: live.filter((row) => row.pointsCost > 0).map(present),
  };
}

export async function couponPage(code: string, shopperId: string | null, now = new Date()) {
  const coupon = await prisma.platformCoupon.findUnique({ where: { code: code.toUpperCase() }, select: COUPON_VIEW });
  if (!coupon || !coupon.isActive) throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون غير موجود.");
  const storeIds = coupon.allStores ? [] : (await prisma.platformCouponStore.findMany({ where: { couponId: coupon.id }, take: 60, select: { storeId: true } })).map((row) => row.storeId);
  const claimed = shopperId && coupon.pointsCost === 0 ? Boolean(await prisma.shopperCoupon.findFirst({ where: { shopperId, couponId: coupon.id, source: "claimed" }, select: { id: true } })) : false;
  return {
    coupon: { ...present(coupon), claimed, running: coupon.startsAt <= now && coupon.endsAt > now },
    stores: coupon.allStores ? null : await marketStoreCardsByIds(storeIds),
  };
}

/** Hands one coupon out, under a lock on its row; the CHECK on issued_count is the last word. */
export async function issueCoupon(tx: Prisma.TransactionClient, couponId: string, now: Date) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM platform_coupons WHERE id = ${couponId}::uuid FOR UPDATE`;
  if (!row) throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون غير موجود.");
  const coupon = await tx.platformCoupon.findUniqueOrThrow({ where: { id: couponId } });
  if (!coupon.isActive || coupon.startsAt > now || coupon.endsAt <= now) throw new HttpError(409, "COUPON_NOT_OFFERED", "هذا الكوبون غير متاح الآن.");
  if (coupon.totalLimit !== null && coupon.issuedCount >= coupon.totalLimit) throw new HttpError(409, "COUPON_EXHAUSTED", "نفدت كمّيّة هذا الكوبون.");
  await tx.platformCoupon.update({ where: { id: couponId }, data: { issuedCount: { increment: 1 } } });
  return coupon;
}

export async function claimCoupon(shopperId: string, code: string, now = new Date()) {
  const found = await prisma.platformCoupon.findUnique({ where: { code: code.toUpperCase() }, select: { id: true, pointsCost: true } });
  if (!found) throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون غير موجود.");
  if (found.pointsCost > 0) throw new HttpError(409, "COUPON_COSTS_POINTS", "هذا الكوبون يُستبدل بالنقاط.");
  try {
    const held = await prisma.$transaction(async (tx) => {
      if (await tx.shopperCoupon.findFirst({ where: { shopperId, couponId: found.id, source: "claimed" }, select: { id: true } })) throw new HttpError(409, "COUPON_ALREADY_CLAIMED", "هذا الكوبون في كوبوناتك بالفعل.");
      await issueCoupon(tx, found.id, now);
      return tx.shopperCoupon.create({ data: { shopperId, couponId: found.id, source: "claimed" }, select: { id: true } });
    });
    return { walletId: held.id };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new HttpError(409, "COUPON_ALREADY_CLAIMED", "هذا الكوبون في كوبوناتك بالفعل.");
    throw error;
  }
}

export async function redeemPoints(shopperId: string, couponId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    // The shopper's row first: two purchases at once wait for each other here.
    await tx.$queryRaw`SELECT id FROM shoppers WHERE id = ${shopperId}::uuid FOR UPDATE`;
    const coupon = await tx.platformCoupon.findUnique({ where: { id: couponId }, select: { id: true, pointsCost: true } });
    if (!coupon || coupon.pointsCost <= 0) throw new HttpError(404, "COUPON_NOT_FOUND", "هذا الكوبون لا يُستبدل بالنقاط.");
    const balance = await pointsBalance(tx, shopperId);
    if (balance < coupon.pointsCost) throw new HttpError(409, "POINTS_NOT_ENOUGH", `تحتاج ${coupon.pointsCost.toLocaleString("en-US")} نقطة، ورصيدك ${Math.max(0, balance).toLocaleString("en-US")}.`);
    await issueCoupon(tx, coupon.id, now);
    await tx.shopperPointsEntry.create({ data: { shopperId, delta: -coupon.pointsCost, reason: "spent", couponId: coupon.id } });
    const held = await tx.shopperCoupon.create({ data: { shopperId, couponId: coupon.id, source: "points" }, select: { id: true } });
    return { walletId: held.id, balance: balance - coupon.pointsCost };
  });
}

// ── «كوبوناتي» ─────────────────────────────────────────────────────────────

const WALLET_KIND = "market-coupon-wallet";
export async function wallet(shopperId: string, tab: unknown, rawCursor: unknown, rawLimit: unknown, now = new Date()) {
  const which = tab === "used" ? "used" : tab === "expired" ? "expired" : "active";
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(`${WALLET_KIND}.${which}`, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const where: Prisma.ShopperCouponWhereInput = {
    shopperId,
    ...(which === "used" ? { usedOrderId: { not: null } } : which === "expired" ? { usedOrderId: null, coupon: { OR: [{ endsAt: { lte: now } }, { isActive: false }] } } : { usedOrderId: null, coupon: { endsAt: { gt: now }, isActive: true } }),
    ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}),
  };
  const rows = await prisma.shopperCoupon.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, select: { id: true, source: true, usedAt: true, usedOrderId: true, createdAt: true, coupon: { select: COUPON_VIEW } } });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(`${WALLET_KIND}.${which}`, last.createdAt, last.id));
  return { coupons: page.map((row) => ({ walletId: row.id, source: row.source, usedAt: row.usedAt, usedOrderId: row.usedOrderId, heldSince: row.createdAt, coupon: present(row.coupon) })), nextCursor };
}

/** The coupons he holds that work on this store's order now, with what each would take off. */
export async function applicableCoupons(shopperId: string, storeId: string, baseIqd: number, now = new Date()) {
  const rows = await prisma.shopperCoupon.findMany({ where: { shopperId, usedOrderId: null, coupon: { isActive: true, endsAt: { gt: now } } }, orderBy: { createdAt: "asc" }, take: 50, select: { id: true, coupon: { select: { ...COUPON_VIEW, stores: { where: { storeId }, select: { storeId: true } } } } } });
  return rows.map((row) => {
    const refusal = platformCouponRefusal(row.coupon, row.coupon.allStores || row.coupon.stores.length > 0, baseIqd, now);
    return { walletId: row.id, code: row.coupon.code, title: row.coupon.title, usable: !refusal, reason: refusal, discountIqd: refusal ? 0 : platformDiscountFor(row.coupon, baseIqd) };
  });
}

// ── «نقاطي» ────────────────────────────────────────────────────────────────

const POINTS_KIND = "market-points-history";
const REASON_LABEL: Record<string, string> = { earned: "نقاط طلب", clawback: "خصم نقاط طلب مُرجع", spent: "استبدال بكوبون", granted: "هديّة من السوق" };

export async function pointsPage(shopperId: string, rawCursor: unknown, rawLimit: unknown) {
  const limit = parseListLimit(rawLimit, 50, 20);
  const cursor = decodeListCursor(POINTS_KIND, rawCursor);
  const at = cursor ? new Date(cursor.value) : null;
  const [balance, year, rows] = await Promise.all([
    pointsBalance(prisma, shopperId),
    yearPoints(prisma, shopperId),
    prisma.shopperPointsEntry.findMany({
      where: { shopperId, ...(cursor && at ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, delta: true, reason: true, orderId: true, createdAt: true, coupon: { select: { title: true } } },
    }),
  ]);
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(POINTS_KIND, last.createdAt, last.id));
  const { tier, next, toNext } = tierFor(year);
  return {
    balance: Math.max(0, balance),
    owed: balance < 0 ? -balance : 0,
    tier: { code: tier.code, label: tier.label, multiplierPct: tier.multiplierPct },
    next: next ? { code: next.code, label: next.label, minPoints: next.minPoints, toNext } : null,
    yearPoints: year,
    tiers: POINT_TIERS,
    earnRule: { iqdPerPoint: IQD_PER_POINT },
    history: page.map((row) => ({ ...row, label: row.coupon ? `${REASON_LABEL[row.reason]}: ${row.coupon.title}` : REASON_LABEL[row.reason] ?? row.reason })),
    nextCursor,
  };
}

// ── the owner ──────────────────────────────────────────────────────────────

type CouponInput = { code: string; title: string; description?: string | null; kind: "percent" | "fixed"; percentOff?: number | null; amountOffIqd?: number | null; maxDiscountIqd?: number | null; minSubtotalIqd: number; startsAt: Date; endsAt: Date; totalLimit?: number | null; pointsCost: number; allStores: boolean; isActive: boolean };

function couponData(input: CouponInput) {
  return {
    code: input.code.toUpperCase(), title: input.title, description: input.description ?? null, kind: input.kind,
    percentOff: input.kind === "percent" ? input.percentOff ?? null : null, amountOffIqd: input.kind === "fixed" ? input.amountOffIqd ?? null : null,
    maxDiscountIqd: input.maxDiscountIqd ?? null, minSubtotalIqd: input.minSubtotalIqd, startsAt: input.startsAt, endsAt: input.endsAt,
    totalLimit: input.totalLimit ?? null, pointsCost: input.pointsCost, allStores: input.allStores, isActive: input.isActive,
  };
}

export async function ownerCoupons() {
  const rows = await prisma.platformCoupon.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { ...COUPON_VIEW, _count: { select: { stores: true } } } });
  const used = await prisma.shopperCoupon.groupBy({ by: ["couponId"], where: { usedOrderId: { not: null }, couponId: { in: rows.map((row) => row.id) } }, _count: { _all: true } });
  return { coupons: rows.map(({ _count, ...row }) => ({ ...row, stores: _count.stores, used: used.find((entry) => entry.couponId === row.id)?._count._all ?? 0 })) };
}

export async function createCoupon(input: CouponInput) {
  if (await prisma.platformCoupon.findUnique({ where: { code: input.code.toUpperCase() }, select: { id: true } })) throw new HttpError(409, "COUPON_CODE_TAKEN", "يوجد كوبون بهذا الرمز.");
  return { coupon: await prisma.platformCoupon.create({ data: couponData(input), select: COUPON_VIEW }) };
}

/** Once handed out, what a coupon is worth no longer changes — only its dates, its limit upward, and whether it is offered. */
export async function updateCoupon(id: string, input: CouponInput) {
  const coupon = await prisma.platformCoupon.findUnique({ where: { id } });
  if (!coupon) throw new HttpError(404, "COUPON_NOT_FOUND", "الكوبون غير موجود.");
  const data = couponData(input);
  if (coupon.issuedCount > 0) {
    const worth = ["code", "kind", "percentOff", "amountOffIqd", "maxDiscountIqd", "minSubtotalIqd", "pointsCost", "allStores"] as const;
    const changed = worth.find((field) => (data as Record<string, unknown>)[field] !== (coupon as Record<string, unknown>)[field]);
    if (changed) throw new HttpError(409, "COUPON_ALREADY_ISSUED", "وُزّع هذا الكوبون؛ لا تتغيّر قيمته ولا شروطه. أنشئ كوبوناً جديداً.");
    if (data.totalLimit !== null && data.totalLimit < coupon.issuedCount) throw new HttpError(422, "COUPON_LIMIT_BELOW_ISSUED", `وُزّع ${coupon.issuedCount} منه بالفعل.`);
  }
  return { coupon: await prisma.platformCoupon.update({ where: { id }, data, select: COUPON_VIEW }) };
}

export async function setCouponStores(id: string, storeSlugs: string[]) {
  const coupon = await prisma.platformCoupon.findUnique({ where: { id }, select: { id: true, issuedCount: true } });
  if (!coupon) throw new HttpError(404, "COUPON_NOT_FOUND", "الكوبون غير موجود.");
  const stores = await prisma.store.findMany({ where: { slug: { in: storeSlugs } }, select: { id: true, slug: true } });
  const missing = storeSlugs.filter((slug) => !stores.some((store) => store.slug === slug));
  if (missing.length) throw new HttpError(422, "STORE_NOT_FOUND", "متاجر غير موجودة.", { storeSlugs: missing });
  await prisma.$transaction([
    prisma.platformCouponStore.deleteMany({ where: { couponId: id } }),
    prisma.platformCouponStore.createMany({ data: stores.map((store) => ({ couponId: id, storeId: store.id })) }),
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
  const cost = ledger.reduce((sum, row) => sum + (row.entryType === "order_completed" ? 1 : -1) * (row._sum.platformDiscountIqd ?? 0), 0);
  return { platformDiscountIqd: cost, pointsOutstanding: Math.max(0, outstanding._sum.delta ?? 0), couponsIssued: issued, couponsUsed: used };
}

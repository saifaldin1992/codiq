/**
 * codiq phase 20B-1 — coupons engine (D-08).
 *
 * Merchant management (settings.manage, decision §8.5) + the checkout-side
 * helpers. The ONLY authority on whether a coupon applies is the checkout
 * transaction: `lockCouponForCheckout` takes the coupon row FOR UPDATE — and the
 * caller MUST invoke it BEFORE the ordered variant locks (fixed global lock
 * order: coupon -> variants, so no deadlock and the usage count is
 * deterministic under the lock). The public preview endpoint is advisory only.
 *
 * PG-2 replaced «there is no DELETE anywhere» with a SOFT delete: a coupon can
 * be moved to the trash bin (`deleted_at`) and restored within 30 days, while
 * redemptions and orders keep referencing it forever — the purge is refused by
 * the foreign-key wall for any coupon that was ever redeemed. Every read below
 * therefore carries `LIVE`.
 */
import { Prisma, type Coupon } from "@prisma/client";
import { fieldLabel } from "./field-labels.js";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { encodeListCursor, keysetWhere, pageOf, parseListLimit, readListCursor } from "./list-page.js";
import type { AuditActor } from "./soft-delete/audit-log.service.js";
import { LIVE } from "./soft-delete/constants.js";
import { restore, softDelete } from "./soft-delete/soft-delete.service.js";

export const COUPON_KINDS = ["percent", "fixed", "free_shipping"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

// Runtime-constructed so the root (frontend) tsconfig's ES5 target does not
// reject the `u` flag literal; the backend runs on Node 22 where this is native.
const CODE_PATTERN = new RegExp("^[\\p{L}\\p{N}_-]{2,40}$", "u");

/** Uppercased trimmed form — the identity used by UNIQUE(store_id, code_normalized). */
export function normalizeCouponCode(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "INVALID_COUPON_CODE", "رمز الكوبون نص.");
  const normalized = value.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) throw new HttpError(400, "INVALID_COUPON_CODE", "رمز الكوبون من 2 إلى 40 حرفاً إنجليزياً أو رقماً أو - أو _.");
  return normalized;
}

export type CouponRow = {
  id: string;
  kind: CouponKind;
  code: string;
  percentOff: number | null;
  amountOffIqd: number | null;
  minSubtotalIqd: number;
  maxUsesTotal: number | null;
  maxUsesPerCustomer: number | null;
};

function assertCouponWindowAndActive(coupon: { isActive: boolean; startsAt: Date | null; endsAt: Date | null }, now: Date) {
  if (!coupon.isActive) throw new HttpError(422, "COUPON_INVALID", "هذا الكوبون غير صالح في هذا المتجر.");
  if ((coupon.startsAt && coupon.startsAt > now) || (coupon.endsAt && coupon.endsAt < now)) {
    throw new HttpError(422, "COUPON_EXPIRED", "هذا الكوبون خارج مدة صلاحيته.");
  }
}

async function assertCouponUsageWithinLimits(
  tx: Prisma.TransactionClient | typeof prisma,
  coupon: { id: string; storeId: string; maxUsesTotal: number | null; maxUsesPerCustomer: number | null },
  customerId: string | undefined,
  recipientPhone?: string,
) {
  // Owner policy: cancelled/rejected orders never shipped, so their redemptions
  // do not consume uses (rows stay append-only; counting is status-filtered).
  // Returned orders DID ship — those keep consuming.
  const consumingOrder: Prisma.StoreOrderWhereInput = { status: { notIn: ["cancelled", "rejected"] } };
  if (coupon.maxUsesTotal !== null) {
    const total = await tx.couponRedemption.count({ where: { couponId: coupon.id, order: consumingOrder } });
    if (total >= coupon.maxUsesTotal) throw new HttpError(422, "COUPON_EXHAUSTED", "نفدت مرات استعمال هذا الكوبون.");
  }
  if (coupon.maxUsesPerCustomer !== null && customerId) {
    // «PER CUSTOMER» MEANS PER PERSON, AND THE ROW IS NOT THE PERSON.
    //
    // A customer row is one phone number at this store, and a guest checkout
    // mints a new row for every new number typed. So «one use per customer»
    // was one use per number a shopper was willing to type: a «first order»
    // coupon, used again and again under made-up numbers.
    //
    // The number a cash-on-delivery order cannot fake is the one the courier
    // CALLS — the delivery phone, stamped on the order as `recipientPhone`. A
    // redemption counts against this checkout when it is this customer's, OR
    // when its order was delivered to the same phone. Someone who changes the
    // delivery number as well is ordering to a different person's phone, which
    // is a cost the coupon's limit can live with.
    const used = await tx.couponRedemption.count({
      where: {
        storeId: coupon.storeId,
        couponId: coupon.id,
        order: consumingOrder,
        ...(recipientPhone ? { OR: [{ customerId }, { order: { recipientPhone } }] } : { customerId }),
      },
    });
    if (used >= coupon.maxUsesPerCustomer) throw new HttpError(422, "COUPON_CUSTOMER_LIMIT_REACHED", "استعملت هذا الكوبون الحد الأقصى من المرات.");
  }
}

/**
 * Checkout step 1 (INSIDE the serializable transaction, BEFORE the ordered
 * variant locks): lock the coupon row FOR UPDATE, then validate activity,
 * window, and usage limits under that lock. Two competing checkouts serialize
 * on this row, so the last-use race resolves to exactly one redemption.
 *
 * ⚠ PG-2 — THE MOST DANGEROUS LINE IN THIS FILE is the `AND deleted_at IS NULL`
 * in the query below, and it must NEVER be removed. Once
 * `coupons_store_code_live_key` became a PARTIAL unique index, a store may hold
 * a live SUMMER and one or more trashed SUMMERs at the same time. Without that
 * predicate this query returns several rows, `rows[0]` picks one at random with
 * no ORDER BY, and a perfectly valid coupon is refused with 422 on the payment
 * path — intermittently, which is the worst way to fail.
 */
export async function lockCouponForCheckout(tx: Prisma.TransactionClient, storeId: string, customerId: string, codeNormalized: string, recipientPhone?: string): Promise<CouponRow> {
  const rows = await tx.$queryRaw<Array<{ id: string; code: string; kind: string; percent_off: number | null; amount_off_iqd: number | null; min_subtotal_iqd: number; max_uses_total: number | null; max_uses_per_customer: number | null; starts_at: Date | null; ends_at: Date | null; is_active: boolean }>>(Prisma.sql`
    SELECT id, code, kind, percent_off, amount_off_iqd, min_subtotal_iqd, max_uses_total, max_uses_per_customer, starts_at, ends_at, is_active
    FROM coupons
    WHERE store_id = ${storeId}::uuid AND code_normalized = ${codeNormalized} AND deleted_at IS NULL
    FOR UPDATE
  `);
  const row = rows[0];
  if (!row) throw new HttpError(422, "COUPON_INVALID", "هذا الكوبون غير صالح في هذا المتجر.");
  assertCouponWindowAndActive({ isActive: row.is_active, startsAt: row.starts_at, endsAt: row.ends_at }, new Date());
  const coupon: CouponRow = {
    id: row.id,
    kind: row.kind as CouponKind,
    code: row.code,
    percentOff: row.percent_off,
    amountOffIqd: row.amount_off_iqd,
    minSubtotalIqd: row.min_subtotal_iqd,
    maxUsesTotal: row.max_uses_total,
    maxUsesPerCustomer: row.max_uses_per_customer,
  };
  await assertCouponUsageWithinLimits(tx, { id: coupon.id, storeId, maxUsesTotal: coupon.maxUsesTotal, maxUsesPerCustomer: coupon.maxUsesPerCustomer }, customerId, recipientPhone);
  return coupon;
}

/**
 * Checkout step 2 (once the cart subtotal is known): the approved discount math
 * — floor(subtotal*p/100) | min(amount, subtotal) | 0 — and the free-shipping
 * flag. free_shipping zeroes the delivery fee ONLY and never touches
 * discount_iqd (decision §8.3).
 */
export function computeCouponDiscount(coupon: CouponRow, subtotalIqd: number): { discountIqd: number; freeShipping: boolean } {
  if (subtotalIqd < coupon.minSubtotalIqd) throw new HttpError(422, "COUPON_MIN_SUBTOTAL_NOT_MET", "قيمة السلة أقل من الحد الأدنى لهذا الكوبون.");
  if (coupon.kind === "percent") return { discountIqd: Math.floor((subtotalIqd * (coupon.percentOff ?? 0)) / 100), freeShipping: false };
  if (coupon.kind === "fixed") return { discountIqd: Math.min(coupon.amountOffIqd ?? 0, subtotalIqd), freeShipping: false };
  return { discountIqd: 0, freeShipping: true };
}

/**
 * Advisory public preview (rate-limited by the route). Plain reads, no lock —
 * a positive preview can still lose the in-transaction re-validation, which
 * remains the sole authority.
 */
/**
 * `recipientPhone`, when the caller knows the delivery number, applies the same
 * per-PERSON count checkout applies — so the preview does not accept a coupon
 * the checkout will then refuse for that phone.
 */
export async function previewCoupon(storeId: string, customerId: string | undefined, rawCode: unknown, subtotalIqd: number, recipientPhone?: string | null) {
  const codeNormalized = normalizeCouponCode(rawCode);
  if (!codeNormalized) throw new HttpError(400, "INVALID_COUPON_CODE", "رمز الكوبون مطلوب.");
  // PG-2: findUnique({ storeId_codeNormalized }) no longer exists — the full
  // unique constraint became the partial index coupons_store_code_live_key, and
  // the compiler forced this into a LIVE-filtered findFirst.
  const coupon = await prisma.coupon.findFirst({ where: { storeId, codeNormalized, ...LIVE } });
  if (!coupon) throw new HttpError(422, "COUPON_INVALID", "هذا الكوبون غير صالح في هذا المتجر.");
  assertCouponWindowAndActive(coupon, new Date());
  await assertCouponUsageWithinLimits(prisma, coupon, customerId, recipientPhone ?? undefined);
  const { discountIqd, freeShipping } = computeCouponDiscount(
    { id: coupon.id, kind: coupon.kind as CouponKind, code: coupon.code, percentOff: coupon.percentOff, amountOffIqd: coupon.amountOffIqd, minSubtotalIqd: coupon.minSubtotalIqd, maxUsesTotal: coupon.maxUsesTotal, maxUsesPerCustomer: coupon.maxUsesPerCustomer },
    subtotalIqd,
  );
  return { code: coupon.code, kind: coupon.kind as CouponKind, discountIqd, freeShipping };
}

// ---------- merchant management (settings.manage; PG-2 soft delete + restore) ----------

function couponPayload(coupon: Coupon & { _count?: { redemptions: number } }) {
  return {
    id: coupon.id, code: coupon.code, kind: coupon.kind as CouponKind,
    percentOff: coupon.percentOff, amountOffIqd: coupon.amountOffIqd, minSubtotalIqd: coupon.minSubtotalIqd,
    maxUsesTotal: coupon.maxUsesTotal, maxUsesPerCustomer: coupon.maxUsesPerCustomer,
    startsAt: coupon.startsAt, endsAt: coupon.endsAt, isActive: coupon.isActive,
    redemptionCount: coupon._count?.redemptions ?? 0, createdAt: coupon.createdAt,
  };
}

function positiveInteger(value: unknown, field: string, max = 1_000_000_000) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new HttpError(422, "INVALID_INPUT", `${fieldLabel(field)}: عدد صحيح موجب.`);
  return parsed;
}

function optionalPositiveInteger(value: unknown, field: string, max?: number) {
  if (value === undefined || value === null || value === "") return null;
  return positiveInteger(value, field, max);
}

function nonNegativeInteger(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000_000) throw new HttpError(422, "INVALID_INPUT", `${fieldLabel(field)}: عدد صحيح غير سالب حتى مليار.`);
  return parsed;
}

function optionalDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(422, "INVALID_INPUT", `${fieldLabel(field)}: تاريخ غير صالح.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new HttpError(422, "INVALID_INPUT", `${fieldLabel(field)}: تاريخ غير صالح.`);
  return parsed;
}

function couponKind(value: unknown): CouponKind {
  if (typeof value !== "string" || !COUPON_KINDS.includes(value as CouponKind)) throw new HttpError(422, "INVALID_INPUT", "نوع الكوبون: نسبة أو مبلغ ثابت أو توصيل مجاني.");
  return value as CouponKind;
}

/** Validates the kind-specific payload; returns the exclusive value columns. */
function kindValues(kind: CouponKind, body: Record<string, unknown>) {
  if (kind === "percent") return { percentOff: positiveInteger(body.percentOff, "percentOff", 100), amountOffIqd: null };
  if (kind === "fixed") return { percentOff: null, amountOffIqd: positiveInteger(body.amountOffIqd, "amountOffIqd") };
  return { percentOff: null, amountOffIqd: null };
}

/** The cursor's list kind. One per list, so a cursor cannot cross lists. */
const COUPONS_KIND = "merchant.coupons";

/**
 * D-18: this returned EVERY live coupon in the store, forever. A merchant who
 * runs a code per campaign accumulates them monotonically — nothing here
 * expires a row — so the query grew without a ceiling and the screen rendered
 * all of it.
 */
export async function listCoupons(storeId: string, rawLimit?: unknown, rawCursor?: unknown) {
  const limit = parseListLimit(rawLimit);
  const cursor = await readListCursor(COUPONS_KIND, rawCursor);
  const rows = await prisma.coupon.findMany({
    where: { storeId, ...LIVE, ...keysetWhere("createdAt", "desc", cursor) },
    include: { _count: { select: { redemptions: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(COUPONS_KIND, last.createdAt, last.id));
  return { coupons: page.map(couponPayload), nextCursor };
}

/**
 * PG-2: retiring a coupon to the trash bin. No guard — a redeemed coupon enters
 * the bin like any other and is stopped only at PURGE time by
 * `coupon_redemptions_coupon_store_fk`, where it keeps the «محفوظ لسجلاتك»
 * badge. The redemption ledger is never touched: `max_uses_total` keeps
 * counting redemptions of a deleted coupon, because they really happened.
 */
export async function deleteCoupon(storeId: string, couponId: string, actor: AuditActor) {
  return softDelete("coupon", storeId, couponId, actor);
}

export async function restoreCoupon(storeId: string, couponId: string, actor: AuditActor, overrides: Record<string, unknown>) {
  return restore("coupon", storeId, couponId, actor, { code: overrides.code });
}

export async function createCoupon(storeId: string, body: Record<string, unknown>) {
  if (typeof body.code !== "string") throw new HttpError(422, "INVALID_INPUT", "الرمز مطلوب.");
  const codeNormalized = normalizeCouponCode(body.code);
  if (!codeNormalized) throw new HttpError(422, "INVALID_INPUT", "الرمز مطلوب.");
  const kind = couponKind(body.kind);
  const startsAt = optionalDate(body.startsAt, "startsAt");
  const endsAt = optionalDate(body.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt) throw new HttpError(422, "INVALID_INPUT", "تاريخ النهاية بعد تاريخ البداية.");
  // PG-2: LIVE only — a code held by a trashed coupon is free to reuse, exactly
  // as the partial unique index coupons_store_code_live_key allows.
  const existing = await prisma.coupon.findFirst({ where: { storeId, codeNormalized, ...LIVE }, select: { id: true } });
  if (existing) throw new HttpError(409, "DUPLICATE_COUPON_CODE", "يوجد كوبون بهذا الرمز في المتجر.");
  const coupon = await prisma.coupon.create({
    data: {
      storeId,
      code: body.code.trim(),
      codeNormalized,
      kind,
      ...kindValues(kind, body),
      minSubtotalIqd: body.minSubtotalIqd === undefined ? 0 : nonNegativeInteger(body.minSubtotalIqd, "minSubtotalIqd"),
      maxUsesTotal: optionalPositiveInteger(body.maxUsesTotal, "maxUsesTotal"),
      maxUsesPerCustomer: optionalPositiveInteger(body.maxUsesPerCustomer, "maxUsesPerCustomer"),
      startsAt,
      endsAt,
      isActive: body.isActive === undefined ? true : body.isActive === true,
    },
  });
  return couponPayload(coupon);
}

export async function updateCoupon(storeId: string, couponId: string, body: Record<string, unknown>) {
  const existing = await prisma.coupon.findFirst({ where: { id: couponId, storeId, ...LIVE } });
  if (!existing) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الكوبون غير موجود في هذا المتجر.");
  const data: Prisma.CouponUncheckedUpdateInput = {};
  if (body.code !== undefined) {
    if (typeof body.code !== "string") throw new HttpError(422, "INVALID_INPUT", "الرمز نص.");
    const codeNormalized = normalizeCouponCode(body.code)!;
    if (codeNormalized !== existing.codeNormalized) {
      const duplicate = await prisma.coupon.findFirst({ where: { storeId, codeNormalized, ...LIVE }, select: { id: true } });
      if (duplicate) throw new HttpError(409, "DUPLICATE_COUPON_CODE", "يوجد كوبون بهذا الرمز في المتجر.");
    }
    data.code = body.code.trim();
    data.codeNormalized = codeNormalized;
  }
  // The kind and its payload always move together so the exclusive CHECK holds.
  if (body.kind !== undefined) {
    const kind = couponKind(body.kind);
    data.kind = kind;
    Object.assign(data, kindValues(kind, body));
  } else if (body.percentOff !== undefined || body.amountOffIqd !== undefined) {
    Object.assign(data, kindValues(existing.kind as CouponKind, body));
  }
  if (body.minSubtotalIqd !== undefined) data.minSubtotalIqd = nonNegativeInteger(body.minSubtotalIqd, "minSubtotalIqd");
  if (body.maxUsesTotal !== undefined) data.maxUsesTotal = optionalPositiveInteger(body.maxUsesTotal, "maxUsesTotal");
  if (body.maxUsesPerCustomer !== undefined) data.maxUsesPerCustomer = optionalPositiveInteger(body.maxUsesPerCustomer, "maxUsesPerCustomer");
  if (body.startsAt !== undefined) data.startsAt = optionalDate(body.startsAt, "startsAt");
  if (body.endsAt !== undefined) data.endsAt = optionalDate(body.endsAt, "endsAt");
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw new HttpError(422, "INVALID_INPUT", "الحالة نعم أو لا.");
    data.isActive = body.isActive;
  }
  const nextStartsAt = body.startsAt !== undefined ? (data.startsAt as Date | null) : existing.startsAt;
  const nextEndsAt = body.endsAt !== undefined ? (data.endsAt as Date | null) : existing.endsAt;
  if (nextStartsAt && nextEndsAt && nextEndsAt <= nextStartsAt) throw new HttpError(422, "INVALID_INPUT", "تاريخ النهاية بعد تاريخ البداية.");
  const coupon = await prisma.coupon.update({ where: { id: existing.id }, data, include: { _count: { select: { redemptions: true } } } });
  return couponPayload(coupon);
}

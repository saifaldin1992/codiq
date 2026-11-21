/**
 * Phase 19-ج — schemas for the marketing surface (coupons D-08, abandoned carts
 * D-24, ad pixels D-26).
 *
 * WHERE THE LINE FALLS, and why it is not the same line on every field.
 *
 * `validate.ts` states the rule — shape here, meaning in the service — and this
 * file applies a second rule that the pixel routes make unavoidable: a refusal
 * that ALREADY has a named code and its own Arabic sentence is already at the
 * destination ق-49 is walking towards, and dragging it into zod would trade
 * «صيغة معرّف Meta Pixel غير صالحة» for zod's English `invalid_string`. So:
 *
 *  · The anonymous `INVALID_INPUT` refusals — the ones 19-ج exists to retire —
 *    move here and become `VALIDATION_FAILED` with a per-field code: the coupon
 *    kind, its numbers, its dates, its active flag, the two boolean switches.
 *  · The NAMED refusals stay in the service, and the field stays `unknown` here:
 *    `INVALID_PIXEL_FORMAT` (the injection wall, and 20B-3 asserts the code on
 *    eight attack shapes), `INVALID_RECOVERY_COUPON` (asserted on two),
 *    `INVALID_ABANDONED_CART_WINDOW`, `INVALID_COUPON_CODE`, and the 409
 *    duplicate answers, which need the database anyway.
 *
 * COERCION IS PRESERVED, NOT CLEANED UP. `coupon.service.ts` reads its numbers
 * through `Number(value)`, so `percentOff: "33"` has always been accepted; the
 * preprocess below keeps accepting it. Tightening that is a decision about the
 * dashboard's contract, not a side effect of moving a check between two files.
 */
import { z } from "zod";
import { COUPON_KINDS } from "../../services/coupon.service.js";

/**
 * `positiveInteger`/`nonNegativeInteger` in `coupon.service.ts`, expressed as a
 * schema: a number, or anything `Number()` turns into one. The bounds are that
 * function's bounds — restated per call site because they differ per field, not
 * because there is a second rule.
 */
const couponInteger = (min: number, max: number) =>
  z.preprocess(
    (value) => (typeof value === "number" ? value : Number(value)),
    z.number().int().min(min).max(max)
  );

/**
 * A cap the merchant can CLEAR. `optionalPositiveInteger` reads `null` and `""`
 * as «no cap» and stores null, and the dashboard sends exactly that for an empty
 * field (`CouponsManager.tsx:57`) — so `null` must survive parsing as `null`.
 * Turning it into `undefined` here would make «امسح الحد» silently do nothing.
 */
const optionalCouponCap = z
  .preprocess(
    (value) => (value === "" ? null : value),
    z.union([z.null(), couponInteger(1, 1_000_000_000)])
  )
  .optional();

/** `optionalDate`: absent, null and "" all mean «no date»; anything else must parse. */
const optionalCouponDate = z
  .preprocess(
    (value) => (value === "" ? null : value),
    z.union([
      z.null(),
      z
        .string()
        .refine(
          (value) => !Number.isNaN(new Date(value).valueOf()),
          "التاريخ يجب أن يكون بصيغة ISO."
        ),
    ])
  )
  .optional();

/**
 * The coupon's identity is a plain string here on purpose: `normalizeCouponCode`
 * owns the 2–40 letter/digit/dash pattern and answers `400 INVALID_COUPON_CODE`,
 * a status this layer cannot reproduce (`parseOrThrow` is always 422). Asserting
 * the pattern in both places would give the same bad code two different answers
 * depending on which check ran first.
 */
const couponCode = z.string();

/**
 * ⚠ ONE DELIBERATE TIGHTENING, stated rather than slipped in. `createCoupon` read
 * `isActive` as `body.isActive === true`, so a form that posted the STRING
 * "true" — the shape an HTML checkbox actually produces — created a coupon that
 * was silently INACTIVE and sold nothing, with no refusal anywhere. A boolean is
 * now required, and the merchant is told. Nothing in the dashboard sends the
 * field on create, so no live caller changes.
 */
const couponActive = z.boolean().optional();

export const createCouponSchema = z.object({
  code: couponCode,
  kind: z.enum(COUPON_KINDS),
  // Bounded per kind, and validated whenever present — `kindValues` still owns
  // «a percent coupon needs a percentOff», because on the PATCH below that
  // question is answered against the stored row and not against the body.
  percentOff: couponInteger(1, 100).optional(),
  amountOffIqd: couponInteger(1, 1_000_000_000).optional(),
  minSubtotalIqd: couponInteger(0, 1_000_000_000).optional(),
  maxUsesTotal: optionalCouponCap,
  maxUsesPerCustomer: optionalCouponCap,
  startsAt: optionalCouponDate,
  endsAt: optionalCouponDate,
  isActive: couponActive,
});
export type CreateCouponInput = z.infer<typeof createCouponSchema>;

/**
 * Every field optional — a PATCH says what changes and stays silent about the
 * rest, and the service tells absent from `null` to decide between «leave it»
 * and «clear it». `endsAt > startsAt` is NOT restated here: on an update the
 * other end of the window may live in the database, so one copy of that rule in
 * `updateCoupon` beats two copies that will disagree.
 */
export const updateCouponSchema = z.object({
  code: couponCode.optional(),
  kind: z.enum(COUPON_KINDS).optional(),
  percentOff: couponInteger(1, 100).optional(),
  amountOffIqd: couponInteger(1, 1_000_000_000).optional(),
  minSubtotalIqd: couponInteger(0, 1_000_000_000).optional(),
  maxUsesTotal: optionalCouponCap,
  maxUsesPerCustomer: optionalCouponCap,
  startsAt: optionalCouponDate,
  endsAt: optionalCouponDate,
  isActive: couponActive,
});
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;

/**
 * PG-2 restore. The body carries at most a replacement code, for the case where
 * a live coupon has taken the trashed one's code in the meantime; `COUPON_CODE_TAKEN`
 * and its conflict list stay in the soft-delete service, which is where the
 * database answer lives.
 */
export const restoreCouponSchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
});

/**
 * The public advisory preview — UNAUTHENTICATED and rate-limited, so the only
 * thing worth asserting is that a body arrived at all. `couponCode` stays
 * `unknown` because `normalizeCouponCode` answers `400 INVALID_COUPON_CODE` for
 * every wrong shape including the missing one, and a shopper mid-checkout must
 * keep getting the answer his storefront already knows how to read.
 */
export const couponPreviewSchema = z.object({
  couponCode: z.unknown().optional(),
});

/**
 * D-24 configuration. `enabled` is the opt-in switch and is the only anonymous
 * refusal on this route, so it is the only one that moves. The window keeps
 * `INVALID_ABANDONED_CART_WINDOW` and the recovery coupon keeps
 * `INVALID_RECOVERY_COUPON` — the second of those is a database question (is
 * this coupon live, active, and of THIS store) that no schema can answer.
 */
export const abandonedCartSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  windowHours: z.unknown().optional(),
  recoveryCouponId: z.unknown().optional(),
});

/**
 * D-26 ad pixels. The three ids stay `unknown` deliberately: their exact official
 * formats are the injection wall, they refuse with `INVALID_PIXEL_FORMAT` and a
 * hint naming the shape expected, and 20B-3 asserts that code against eight
 * script-fragment payloads. What this schema adds is the CLOSED key set — the
 * body reaching `updateMarketingSettings` now carries these four keys and
 * nothing else.
 */
export const marketingIntegrationsSchema = z.object({
  metaPixelId: z.unknown().optional(),
  tiktokPixelId: z.unknown().optional(),
  ga4MeasurementId: z.unknown().optional(),
  isEnabled: z.boolean().optional(),
});

/** zod shapes for the market cart and checkout. */
import { z } from "zod";

const addonIds = z.array(z.string().uuid()).max(20).transform((ids) => Array.from(new Set(ids)));

export const addItemSchema = z.object({
  productId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(99).default(1),
  addonIds: addonIds.default([]),
}).refine((value) => value.productId || value.variantId, { message: "اختر المنتج", path: ["productId"] });

export const updateItemSchema = z.object({
  quantity: z.number().int().min(1).max(99).optional(),
  variantId: z.string().uuid().optional(),
  addonIds: addonIds.optional(),
});

export const summaryQuerySchema = z.object({
  addressId: z.string().uuid().optional(),
  fulfilment: z.enum(["delivery", "pickup"]).optional().default("delivery"),
  coupon: z.string().trim().max(40).optional(),
  platformCoupon: z.string().uuid().optional(),
});

export const placeOrderSchema = z.object({
  addressId: z.string().uuid(),
  fulfilment: z.enum(["delivery", "pickup"]).default("delivery"),
  paymentMethodCode: z.string().trim().min(1).max(40).default("cod"),
  couponCode: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  platformCouponWalletId: z.string().uuid().nullable().optional(),
  /** Marketplace M13a: the plan the lender's code approves (market_instalments only). */
  instalmentPaymentId: z.string().uuid().nullable().optional(),
  instalmentCode: z.string().trim().regex(/^\d{6}$/, "الرمز ستة أرقام").nullable().optional(),
});

/** Marketplace M13a: open an instalment plan for this store's part of the cart. */
export const instalmentStartSchema = z.object({
  lender: z.string().trim().min(1).max(40),
  months: z.number().int().min(2).max(36),
  addressId: z.string().uuid().optional(),
  fulfilment: z.enum(["delivery", "pickup"]).default("delivery"),
  couponCode: z.string().trim().max(40).nullable().optional(),
  platformCouponWalletId: z.string().uuid().nullable().optional(),
});

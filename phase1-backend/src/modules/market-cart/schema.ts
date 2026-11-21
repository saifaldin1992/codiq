/** zod shapes for the market cart and checkout. */
import { z } from "zod";
import { CANCEL_REASON_CODES, ORDER_RATING_TAG_CODES, RATING_COMMENT_MAX, RATING_MAX, RATING_MIN } from "./after-sale.service.js";

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
});

export const placeOrderSchema = z.object({
  addressId: z.string().uuid(),
  fulfilment: z.enum(["delivery", "pickup"]).default("delivery"),
  paymentMethodCode: z.string().trim().min(1).max(40).default("cod"),
  couponCode: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const cancelOrderSchema = z.object({
  reasonCode: z.enum(CANCEL_REASON_CODES),
  note: z.string().trim().max(400).nullable().optional(),
});

const stars = z.number().int().min(RATING_MIN).max(RATING_MAX);
export const rateOrderSchema = z.object({
  products: z.array(z.object({ productId: z.string().uuid(), rating: stars, comment: z.string().trim().max(RATING_COMMENT_MAX).nullable().optional() })).max(50).default([]),
  deliveryRating: stars.nullable().optional(),
  tags: z.array(z.enum(ORDER_RATING_TAG_CODES)).max(12).default([]),
  note: z.string().trim().max(1000).nullable().optional(),
});

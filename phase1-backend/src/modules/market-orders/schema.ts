/** zod shapes for the market after-sales routes. */
import { z } from "zod";
import { CANCEL_REASONS, DELIVERY_STAGES, RATING_TAGS, RETURN_REASONS, codesOf } from "./reasons.js";

const details = z.string().trim().max(500).optional();

export const cancelSchema = z.object({ reasonCode: z.enum(codesOf(CANCEL_REASONS)), details });
export const returnSchema = z.object({ reasonCode: z.enum(codesOf(RETURN_REASONS)), details })
  .refine((value) => value.reasonCode !== "other" || Boolean(value.details), { message: "اكتب السبب", path: ["details"] });

export const ratingSchema = z.object({
  storeStars: z.number().int().min(1).max(5),
  deliveryStars: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.enum(codesOf(RATING_TAGS))).max(10).default([]).transform((tags) => Array.from(new Set(tags))),
  note: z.string().trim().max(1000).optional(),
  products: z.array(z.object({
    productId: z.string().uuid(),
    stars: z.number().int().min(1).max(5),
    body: z.string().trim().max(2000).optional(),
  })).max(50).default([]),
});

export const deliveryStageSchema = z.object({ stage: z.enum(codesOf(DELIVERY_STAGES)).nullable() });
export const handoverSchema = z.object({ code: z.string().trim().regex(/^[0-9]{4}$/, "أربعة أرقام") });

/**
 * Phase 19-ج — schemas for the CD-2 review surface.
 *
 * These carry SHAPE only. "Is the rating an integer from 1 to 5" lives here;
 * "has this customer a completed order containing this product" stays in
 * `product-review.service.ts`, where someone looking for the rule will find it.
 *
 * Written first for reviews because they were the newest hand-rolled validators
 * in the codebase, so the before/after is a fair measure of what the layer buys.
 */
import { z } from "zod";
import {
  REVIEW_BODY_MAX,
  REVIEW_HIDE_REASON_MAX,
  REVIEW_RATING_MAX,
  REVIEW_RATING_MIN,
} from "../../services/product-review.service.js";

export const reviewUpsertSchema = z.object({
  rating: z.number().int().min(REVIEW_RATING_MIN).max(REVIEW_RATING_MAX),
  // Trimmed then emptied-to-undefined, so "   " and "" mean what they meant when
  // this was hand-rolled: no body, not a body of spaces.
  body: z.string().trim().max(REVIEW_BODY_MAX).optional().transform((value) => (value ? value : undefined)),
});
export type ReviewUpsert = z.infer<typeof reviewUpsertSchema>;

export const reviewHiddenSchema = z
  .object({
    hidden: z.boolean(),
    reason: z.string().trim().min(1).max(REVIEW_HIDE_REASON_MAX).optional(),
  })
  // The dependency between the two fields is genuinely a SHAPE rule — hiding
  // without a reason is malformed, not merely disallowed — so it belongs here.
  // The path points at `reason`, which is the field the merchant has to fix.
  .refine((value) => !value.hidden || Boolean(value.reason), {
    path: ["reason"],
    message: "إخفاء مراجعة يحتاج سبباً مكتوباً — يُسجَّل ويطّلع عليه المالك.",
  });
export type ReviewHidden = z.infer<typeof reviewHiddenSchema>;

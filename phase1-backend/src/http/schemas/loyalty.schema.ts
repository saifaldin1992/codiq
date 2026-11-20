/**
 * Phase 19-ج — schemas for the CD-5 loyalty surface.
 *
 * Shape only. "Is this an integer between 0 and 1000" lives here; "does this
 * shopper hold that many points" stays in `loyalty.service.ts`, because that
 * question needs the database and belongs where someone will look for it.
 *
 * The bounds are imported from the domain rather than restated — the reason the
 * review schema does the same: two copies of a rule are two rules waiting to
 * disagree.
 */
import { z } from "zod";
import {
  LOYALTY_EARN_PER_1000_MAX,
  LOYALTY_POINT_VALUE_MAX,
  LOYALTY_POINT_VALUE_MIN,
} from "../../services/loyalty.service.js";

export const loyaltySettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    earnPer1000: z.number().int().min(0).max(LOYALTY_EARN_PER_1000_MAX).optional(),
    pointValueIqd: z.number().int().min(LOYALTY_POINT_VALUE_MIN).max(LOYALTY_POINT_VALUE_MAX).optional(),
  })
  // An empty body is a request that asks for nothing; answering 200 would tell
  // the merchant something was saved when nothing was.
  .refine((value) => Object.keys(value).length > 0, { message: "لا يوجد ما يُحفظ." });
export type LoyaltySettingsInput = z.infer<typeof loyaltySettingsSchema>;

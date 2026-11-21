/** zod shapes for online payments. */
import { z } from "zod";

export const testProviderSchema = z.object({ outcome: z.enum(["approve", "decline"]) });
export const ownerPaymentsQuerySchema = z.object({
  status: z.enum(["pending", "code_sent", "paid", "approved", "failed", "expired", "cancelled", "refunded", "adjusted"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.unknown().optional(),
});

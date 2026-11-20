/**
 * ق-179 — a merchant's decision about a shopper: may he still buy here?
 */
import { z } from "zod";

export const customerAccessSchema = z.object({
  isActive: z.boolean(),
  /** Why — kept on the audit event, never shown to the shopper. */
  reason: z.string().trim().min(1).max(200).optional(),
});

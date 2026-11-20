/**
 * ق-182 — the shape of a Resend (Svix) event, read only AFTER its signature
 * verified. Loose on purpose: the provider adds fields, and an event of a type
 * we do not handle is acknowledged, not rejected.
 */
import { z } from "zod";

export const resendEventSchema = z.object({
  type: z.string(),
  data: z.object({
    to: z.union([z.array(z.string()), z.string()]).optional(),
    subject: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

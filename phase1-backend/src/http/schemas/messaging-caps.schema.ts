/**
 * ق-180 — the owner's PUT on one store's daily ceilings. Every field optional,
 * at least one required: a PUT that names nothing changes nothing and must say
 * so rather than answer 200 to a typo.
 *
 * The operational floors are 1, never 0: an operational ceiling of zero would
 * silence order confirmations for a store, which is not a tightening but an
 * outage. Marketing may be 0 — PG-3 defined that as the off switch.
 */
import { z } from "zod";

export const messagingCapsSchema = z
  .object({
    marketingDailyCap: z.number().int().min(0).max(10_000).optional(),
    operationalDailyCap: z.number().int().min(1).max(100_000).optional(),
    operationalRecipientDailyCap: z.number().int().min(1).max(1_000).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "لم يُذكر أيّ سقف.",
  });

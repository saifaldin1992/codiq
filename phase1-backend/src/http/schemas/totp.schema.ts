/**
 * Phase 19-ج schemas for the second factor.
 *
 * Shape only: six digits, or a recovery code. Whether the code is CORRECT is a
 * question for the service, which needs the secret and the spent-step to answer
 * it — and a schema that pretended to answer it would be a security decision in
 * a place nobody looks for one.
 */
import { z } from "zod";

/** Six digits from the app, or a recovery code (letters, digits and dashes). */
export const secondFactorSchema = z.object({
  code: z.string().trim().min(6).max(32),
});

export const disableTotpSchema = z.object({
  // The current password, required to switch the factor off — see the service
  // for why a live session alone is not enough.
  password: z.string().min(1),
});

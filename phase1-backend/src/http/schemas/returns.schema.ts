/**
 * Phase 19-ج — the merchant's answer to a return request (CD-3).
 *
 * `approve` is the whole decision: true walks the order through
 * `transitionOrderStatus(..., "returned")`, which reverses the money. A body
 * that does not say plainly which way it went has no business reaching that
 * path, and «approve يجب أن يكون true أو false» was the generic INVALID_INPUT
 * saying so in the least translatable way available.
 *
 * WHAT STAYS IN THE SERVICE:
 *  - RETURN_REJECTION_NOTE_REQUIRED. Refusing a shopper without a reason he can
 *    read is a business rule with its own code and its own Arabic sentence, and
 *    CD-3 asserts it by name;
 *  - the note's trim-and-truncate. Silently shortening an over-long note is
 *    lenience the service chose on purpose, not a shape the edge should refuse.
 *
 * The ASKING side (`POST …/orders/:orderId/returns`) is deliberately NOT here:
 * its two refusals, RETURN_REASON_REQUIRED and INVALID_RETURN_REASON, are named
 * codes carrying the sentences the shopper actually reads, and CD-3 pins the
 * first. A schema that pre-empted them would trade a translatable code for a
 * generic one — backwards for the i18n phase this work exists to unblock.
 */
import { z } from "zod";

export const decideReturnRequestSchema = z.object({
  approve: z.boolean(),
  /**
   * The decision note. A non-string is DROPPED rather than refused, which is
   * what the hand-rolled version did — and it matters: a rejection whose note
   * arrived as a number must still hit RETURN_REJECTION_NOTE_REQUIRED, not a
   * shape error about the note's type.
   */
  note: z.preprocess(
    (value) => (typeof value === "string" ? value : undefined),
    z.string().optional()
  ),
});
export type DecideReturnRequestInput = z.infer<typeof decideReturnRequestSchema>;

/**
 * Phase 19-أ — changing your own password.
 *
 * The length rule is NOT restated here. It lives in `createPasswordHash`
 * and nowhere else; a copy in this schema would be a second definition of the
 * platform's password policy, and the two would part ways the first time one is
 * raised. The schema asserts only that something was actually sent.
 */
import { z } from "zod";

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

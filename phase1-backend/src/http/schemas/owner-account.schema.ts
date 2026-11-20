/**
 * PC-1 — the platform owner's own account.
 *
 * The email FORMAT rule is not restated here. It lives in `normalizeEmail` and
 * nowhere else, exactly as the password length rule lives in `createPasswordHash`
 * and not in `password.schema.ts` — a copy would be a second definition of the
 * same rule, and the two would part ways the first time one moved. The schema
 * asserts only that both fields were actually sent, which is the one thing the
 * service cannot tell apart from a typo.
 */
import { z } from "zod";

export const changeOwnerEmailSchema = z.object({
  currentPassword: z.string().min(1),
  email: z.string().min(1),
});

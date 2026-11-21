/**
 * 19-ب schemas — shape at the edge, meaning in the service (ق-49).
 *
 * Deliberately LOOSE where the service owns the refusal: roleCode is a plain
 * string so `assertPlatformStaffRoleCode` answers with its own 422, the
 * override effect stays a string so DUPLICATE_OVERRIDE / INVALID_OVERRIDE_EFFECT
 * keep their codes, and the email's format is `normalizeEmail`'s to judge. A
 * schema that pre-empted those answers would change refusals the client and
 * the tests already name.
 */
import { z } from "zod";

export const loginPlatformStaffSchema = z.object({
  email: z.string(),
  password: z.string(),
  totpCode: z.string().optional(),
});

export const createPlatformStaffSchema = z.object({
  email: z.string(),
  displayName: z.string(),
  temporaryPassword: z.string(),
  roleCode: z.string(),
});

export const updatePlatformStaffSchema = z.object({
  roleCode: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const platformStaffOverridesSchema = z.object({
  overrides: z.array(
    z.object({
      permissionCode: z.string(),
      effect: z.string(),
    })
  ),
});

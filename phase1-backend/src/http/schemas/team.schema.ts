/**
 * Phase 19-ج — the store's team: who is on it, what role he holds, and which
 * permissions are added to or taken from that role by hand (phase 14, D14-04).
 *
 * THE TWO ENUMS ARE DERIVED, NEVER RETYPED. `PERMISSION_CODES` and
 * `STAFF_ROLE_CODES` come from `auth/staff-permissions.ts`, which is also what
 * `staff_membership_permission_overrides_code` CHECKs in Postgres — the list has
 * been widened twice already (PG-2's trash codes, ق-132's pos.sell). A copy here
 * would be a third list to forget, and forgetting it has a precise cost: a code
 * this schema accepted and the CHECK refused would turn a clean 422 into a
 * 23514 the error handler answers with 500. Deriving makes that impossible.
 *
 * WHAT STAYS IN THE SERVICE, and why each one is not shape:
 *  - the email's format is `normalizeEmail`'s to judge, and the password's is
 *    `createPasswordHash`'s — the same division `platform-staff.schema.ts` drew;
 *  - `displayName` and `temporaryPassword` are REQUIRED only when the staff
 *    identity is new. Whether it is new is a question about the database, so it
 *    is answered there (D14-06: a second membership for someone who already
 *    works in another store needs neither);
 *  - a duplicated permission code is DUPLICATE_OVERRIDE, and an update that
 *    changes nothing is EMPTY_MEMBERSHIP_UPDATE. Both already have their own
 *    codes and both are still answered by `staff.service.ts` — replacing a
 *    named refusal with a generic one is not what this phase is for.
 */
import { z } from "zod";
import { PERMISSION_CODES, STAFF_ROLE_CODES } from "../../auth/staff-permissions.js";

/** The D14-04 role matrix's two roles, from the module that owns them. */
export const staffRoleCodeSchema = z.enum(STAFF_ROLE_CODES);

/** The approved permission matrix, and the exact set the DB CHECK accepts. */
export const permissionCodeSchema = z.enum(PERMISSION_CODES);

export const createStoreStaffSchema = z.object({
  email: z.string(),
  displayName: z.string().optional(),
  temporaryPassword: z.string().optional(),
  roleCode: staffRoleCodeSchema,
  /**
   * ق-228 — «نعم، هذا هو الشخص نفسه». An address that already belongs to a live
   * staff identity used to attach that person to this store SILENTLY; now the
   * merchant has to say he means it, and the service refuses with
   * `STAFF_EMAIL_ALREADY_REGISTERED` until he does. Optional because the ordinary
   * case — a brand-new employee — never sends it.
   */
  linkExisting: z.boolean().optional(),
});

export const updateStoreMembershipSchema = z.object({
  roleCode: staffRoleCodeSchema.optional(),
  isActive: z.boolean().optional(),
});

export const membershipOverridesSchema = z.object({
  overrides: z
    .array(
      z.object({
        permissionCode: permissionCodeSchema,
        // `allow` grants a code the role lacks, `deny` removes one it holds —
        // and these two strings are also the CHECK on the `effect` column.
        effect: z.enum(["allow", "deny"]),
      }),
    )
    // One entry per permission code is the most that can mean anything; the
    // service refuses the duplicate that would make two entries of one code.
    .max(PERMISSION_CODES.length),
});

export type CreateStoreStaffInput = z.infer<typeof createStoreStaffSchema>;
export type UpdateStoreMembershipInput = z.infer<typeof updateStoreMembershipSchema>;
export type MembershipOverridesInput = z.infer<typeof membershipOverridesSchema>;

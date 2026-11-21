/**
 * PG-2 — the one symbol that travels through every `where` in the backend.
 *
 * `LIVE` is spread into any read that must not see trashed rows; `TRASHED` into
 * the trash-bin reads. They are the ONLY sanctioned way to express the filter,
 * because `tests/pg2.no-deleted-leak.test.ts` recognises them by name: a read on
 * one of the five watched models that mentions neither `deletedAt` nor `LIVE`
 * nor `TRASHED` fails CI with a `file:line` unless it is allowlisted there with
 * a written reason.
 *
 * The public storefront does NOT depend on these constants. It is protected
 * structurally by the `*_deleted_implies_inactive` CHECK constraints (migration
 * 20260828090200), which make «deleted ⇒ is_active = false» impossible to
 * violate even from psql. See the plan §1.ب and §6.2.
 */
export const LIVE = { deletedAt: null } as const;

export const TRASHED = { deletedAt: { not: null } } as const;

/**
 * Retention window before the purge sweep hard-deletes a trashed row.
 * A code constant, not a per-store setting (plan §6.8) — the first merchant who
 * asks for 90 days needs a column on `stores` and a migration.
 */
export const TRASH_RETENTION_DAYS = 30;

export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** The moment a row trashed at `deletedAt` becomes eligible for the purge. */
export function purgeAtFor(deletedAt: Date): Date {
  return new Date(deletedAt.valueOf() + TRASH_RETENTION_MS);
}

export const TRASH_ENTITY_TYPES = [
  "product",
  "product_category",
  "coupon",
  "staff_membership",
] as const;
export type TrashEntityType = (typeof TRASH_ENTITY_TYPES)[number];

/**
 * `product_variant` is auditable but never trashed on its own (plan §6.3).
 * `store_verification` (MD-6) and `product_review` (CD-2) are auditable and
 * never trashed either. Neither is a row the merchant owns: one is an act of the
 * PLATFORM upon his store, the other an act of his upon someone else's words.
 * Both are here because the trail is what keeps those powers honest.
 *
 * These lists must stay in step with the CHECK constraints on
 * `store_audit_events`, which are recreated WHOLESALE by each migration that
 * touches them — so the newest such migration must always carry every value
 * already in use, and so must this union. The database is the authority; this is
 * what stops a typo reaching it.
 */
export const AUDIT_ENTITY_TYPES = [
  ...TRASH_ENTITY_TYPES,
  "product_variant",
  "store_verification",
  "product_review",
  "return_request",
  "customer",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = [
  "soft_deleted",
  "restored",
  "purged",
  "purge_blocked",
  "verification.granted",
  "verification.revoked",
  "review.hidden",
  "review.unhidden",
  "return.approved",
  "return.rejected",
  // ق-179: blocking a shopper is policy, and policy is logged.
  "customer.blocked",
  "customer.unblocked",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * codiq phase 1 identity contract: redirects are type-specific and never infer a role.
 */
export type IdentityKind = "platform_owner" | "merchant" | "customer" | "staff" | "platform_staff";

/**
 * PS-3 — what each identity is CALLED, for the one refusal a person reads about
 * himself: «you are signed in as X, this area is for Y».
 *
 * It lives beside IdentityKind rather than in an http/ file because the refusal
 * is thrown from three different layers (identity.ts, platform-permissions.ts,
 * staff-permissions.ts) and three copies of these five words would drift.
 */
export const IDENTITY_LABELS: Record<IdentityKind, string> = {
  platform_owner: "مالك المنصة",
  platform_staff: "طاقم المنصة",
  merchant: "تاجر",
  staff: "موظّف متجر",
  customer: "زبون",
};

/**
 * The 403 an identity gets for standing at another identity's door.
 *
 * WHY IT NAMES BOTH SIDES, AND WHY IT IS ARABIC. It read «This session type is
 * not allowed in this area.» from the day it shipped — English, on an
 * Arabic-first platform, saying nothing about which session or which area. The
 * owner met it on his own security page after signing into a merchant account
 * to test it: ONE cookie name, `codiq_session`, is shared by the owner, the
 * merchant and both staff kinds, so the newer sign-in silently overwrote the
 * older one. The session he lost was still alive in the database; only the
 * cookie was gone. Nothing on screen could have told him that.
 *
 * Naming the actual kind leaks nothing — the reader is holding that session
 * already — and it is the single fact that turns a dead end into an action.
 * The private-window sentence is the honest workaround while one cookie still
 * serves four identities (D-88 carries the design question that ends it: with
 * two identities signed in, which session does «sign out» end?).
 */
export function identityBoundaryMessage(actual: IdentityKind, expected: string): string {
  return `أنت داخل في هذا المتصفّح بحساب ${IDENTITY_LABELS[actual]}، وهذه الصفحة لحساب ${expected}. سجّل الخروج ثم ادخل بالحساب الصحيح — أو افتح الآخر في نافذة تصفّح خفيّ لتبقى الجلستان معاً.`;
}

export function platformOwnerDashboardPath(): "/platform/dashboard" {
  return "/platform/dashboard";
}

export function merchantDashboardPath(): "/merchant/dashboard" {
  return "/merchant/dashboard";
}

export function merchantStoreDashboardPath(storeSlug: string): string {
  return `/merchant/stores/${encodeURIComponent(storeSlug)}/dashboard`;
}

export function customerAccountPath(storeSlug: string): string {
  return `/stores/${encodeURIComponent(storeSlug)}/account`;
}

export function staffStoreDashboardPath(storeSlug: string): string {
  return `/staff/stores/${encodeURIComponent(storeSlug)}/dashboard`;
}

/** 19-ب: platform staff land on their own dashboard, never the owner's. */
export function platformStaffDashboardPath(): "/platform/staff/dashboard" {
  return "/platform/staff/dashboard";
}

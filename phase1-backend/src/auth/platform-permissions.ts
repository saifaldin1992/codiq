/**
 * codiq المرحلة 19-ب (ق-143) — server-side PLATFORM staff permission contract.
 *
 * Mirrors the phase-14 store contract (`staff-permissions.ts`) deliberately:
 * the resolver reads role + overrides from the database on every sensitive
 * request, and no role or permission coming from a request body is ever
 * trusted. One platform means there is no tenant boundary here — the staff row
 * IS the membership.
 */
import { touchSession } from "../services/session.service.js";
import type { Request } from "express";
import { prisma } from "../db/prisma.js";
import { HttpError } from "./auth.errors.js";
import { bearerToken, requirePlatformOwner } from "../http/shared.js";
import { readSessionClaims, verifyTypedSession, type SessionClaims } from "./identity.js";
import { identityBoundaryMessage } from "./redirects.js";

export const PLATFORM_PERMISSION_CODES = [
  "overview.view",
  "registrations.approve",
  "merchants.manage",
  "plans.manage",
  "finance.view",
  "finance.settle",
  "orders.oversee",
  "brand.manage",
  "audit.view",
  // ق-249 (المرحلة 29): what the platform offers and how it is rolled out …
  "services.manage",
  // … and the operational hand: what is switched off, where, and why.
  "availability.manage",
] as const;

export type PlatformPermissionCode = (typeof PLATFORM_PERMISSION_CODES)[number];

export const PLATFORM_STAFF_ROLE_CODES = ["registrations_admin", "accountant", "supervisor"] as const;
export type PlatformStaffRoleCode = (typeof PLATFORM_STAFF_ROLE_CODES)[number];

/**
 * The approved matrix: «مشرف تسجيلات» runs the front door and oversees the
 * day-to-day, «محاسب» sees and settles money and nothing else, «مشرف عام»
 * holds every code — but even he never holds what has NO code at all
 * (commission rates, plan archiving, the team itself, store verification).
 */
export const PLATFORM_ROLE_MATRIX: Record<PlatformStaffRoleCode, readonly PlatformPermissionCode[]> = {
  registrations_admin: ["overview.view", "registrations.approve", "merchants.manage", "orders.oversee"],
  accountant: ["overview.view", "finance.view", "finance.settle"],
  supervisor: PLATFORM_PERMISSION_CODES,
};

export function assertPlatformPermissionCode(value: unknown): PlatformPermissionCode {
  if (typeof value !== "string" || !PLATFORM_PERMISSION_CODES.includes(value as PlatformPermissionCode)) {
    throw new HttpError(422, "INVALID_PERMISSION_CODE", "رمز الصلاحية ليس ضمن مصفوفة صلاحيات المنصة المعتمدة.");
  }
  return value as PlatformPermissionCode;
}

export function assertPlatformStaffRoleCode(value: unknown): PlatformStaffRoleCode {
  if (typeof value !== "string" || !PLATFORM_STAFF_ROLE_CODES.includes(value as PlatformStaffRoleCode)) {
    throw new HttpError(422, "INVALID_PLATFORM_STAFF_ROLE", "أدوار طاقم المنصة هي: مشرف تسجيلات، محاسب، مشرف عام فقط.");
  }
  return value as PlatformStaffRoleCode;
}

/** Role matrix + per-staff overrides. One override per code: allow grants, deny removes. */
export function resolvePlatformPermissionSet(
  roleCode: string,
  overrides: readonly { permissionCode: string; effect: string }[],
): Set<PlatformPermissionCode> {
  const base = PLATFORM_ROLE_MATRIX[roleCode as PlatformStaffRoleCode] ?? [];
  const granted = new Set<PlatformPermissionCode>(base);
  for (const override of overrides) {
    const code = override.permissionCode as PlatformPermissionCode;
    if (!PLATFORM_PERMISSION_CODES.includes(code)) continue;
    if (override.effect === "allow") granted.add(code);
    else if (override.effect === "deny") granted.delete(code);
  }
  return granted;
}

export interface PlatformStaffContext {
  claims: SessionClaims;
  staff: { id: string; email: string; displayName: string };
  roleCode: string;
  permissionVersion: number;
  totpEnrolled: boolean;
  permissions: Set<PlatformPermissionCode>;
}

export type PlatformActor =
  | { kind: "platform_owner"; id: string }
  | { kind: "platform_staff"; id: string };

export interface PlatformActorContext {
  actor: PlatformActor;
  /** The FULL resolved set — the owner holds every code by construction. */
  permissions: Set<PlatformPermissionCode>;
}

/**
 * The live gate (the D14-07 mirror): a valid platform-staff session is not
 * enough — the row bound to it must still exist, be undeleted and be active on
 * EVERY request. And per ق-124 the second factor is mandatory: a session whose
 * account has not finished enrolment reaches only the enrolment routes, which
 * announce themselves through `allowUnenrolled`.
 */
export async function requirePlatformStaff(
  request: Request,
  options: { allowUnenrolled?: boolean } = {},
): Promise<PlatformStaffContext> {
  const claims = await verifyTypedSession(bearerToken(request), "platform_staff");
  const row = await prisma.platformStaff.findFirst({
    where: { id: claims.subjectId, deletedAt: null },
    select: {
      id: true,
      email: true,
      displayName: true,
      roleCode: true,
      isActive: true,
      permissionVersion: true,
      totpEnabledAt: true,
      permissionOverrides: { select: { permissionCode: true, effect: true } },
    },
  });
  if (!row || !row.isActive) {
    throw new HttpError(401, "PLATFORM_ACCESS_REVOKED", "أُوقف حساب طاقم المنصة هذا ولم تعد الجلسة صالحة للاستخدام.");
  }
  if (row.totpEnabledAt === null && !options.allowUnenrolled) {
    throw new HttpError(403, "SECOND_FACTOR_ENROLMENT_REQUIRED", "فعّل تطبيق المصادقة أولاً — الرمز الثنائي إلزامي لطاقم المنصة قبل الوصول لأي شاشة.");
  }
  // Phase 19: records that this session was used, and from what browser, so
  // its owner can recognise it in his own list. Fire-and-forget by design.
  touchSession(claims, request);
  return {
    claims,
    staff: { id: row.id, email: row.email, displayName: row.displayName },
    roleCode: row.roleCode,
    permissionVersion: row.permissionVersion,
    totpEnrolled: row.totpEnabledAt !== null,
    permissions: resolvePlatformPermissionSet(row.roleCode, row.permissionOverrides),
  };
}

/**
 * Platform authorization for endpoints shared by the owner and permitted staff.
 * The owner authorizes exactly as before 19-ب; staff authorize through the live
 * row + resolver, never through client input; any other identity is refused at
 * the boundary.
 */
export async function requirePlatformActor(request: Request, permission: PlatformPermissionCode): Promise<PlatformActorContext> {
  const kind = readSessionClaims(bearerToken(request)).identityKind;
  if (kind === "platform_owner") {
    const claims = await requirePlatformOwner(request);
    return { actor: { kind: "platform_owner", id: claims.subjectId }, permissions: new Set(PLATFORM_PERMISSION_CODES) };
  }
  if (kind === "platform_staff") {
    const context = await requirePlatformStaff(request);
    if (!context.permissions.has(permission)) {
      throw new HttpError(403, "PLATFORM_PERMISSION_DENIED", `هذا الحساب لا يحمل صلاحية ${permission}.`);
    }
    return { actor: { kind: "platform_staff", id: context.staff.id }, permissions: context.permissions };
  }
  // PS-3: this door takes two kinds, so it names both rather than one.
  throw new HttpError(403, "IDENTITY_BOUNDARY_DENIED", identityBoundaryMessage(kind, "مالك المنصة أو طاقم المنصة"));
}

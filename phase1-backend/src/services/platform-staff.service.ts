/**
 * 19-ب — managing the platform's own team (owner-only surface), and the staff
 * sign-in door.
 *
 * The phase-14 store-team mirror, collapsed for one platform: the staff row IS
 * the membership. Role changes and disables revoke the affected sessions in
 * the SAME transaction (the D14-07 rule); override changes deliberately do NOT
 * — permissions resolve live on every request, so the change lands on the very
 * next call without ending anyone's session.
 *
 * EVERY mutation here writes its platform-audit row inside the mutation
 * transaction: the act and its record commit together or not at all.
 */
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import {
  ABSENT_IDENTITY_HASH,
  createPasswordHash,
  createTypedSession,
  normalizeEmail,
  verifyPassword,
} from "../auth/identity.js";
import { platformStaffDashboardPath } from "../auth/redirects.js";
import {
  PLATFORM_PERMISSION_CODES,
  assertPlatformPermissionCode,
  assertPlatformStaffRoleCode,
  resolvePlatformPermissionSet,
  type PlatformActor,
} from "../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";
import { verifyPlatformStaffSecondFactor } from "./platform-staff-totp.service.js";

const memberSelect = {
  id: true,
  email: true,
  displayName: true,
  roleCode: true,
  isActive: true,
  permissionVersion: true,
  totpEnabledAt: true,
  createdAt: true,
  permissionOverrides: {
    select: { permissionCode: true, effect: true },
    orderBy: { permissionCode: "asc" as const },
  },
} as const;

function memberPayload(member: {
  id: string;
  email: string;
  displayName: string;
  roleCode: string;
  isActive: boolean;
  permissionVersion: number;
  totpEnabledAt: Date | null;
  createdAt: Date;
  permissionOverrides: { permissionCode: string; effect: string }[];
}) {
  return {
    id: member.id,
    email: member.email,
    displayName: member.displayName,
    roleCode: member.roleCode,
    isActive: member.isActive,
    permissionVersion: member.permissionVersion,
    totpEnrolled: member.totpEnabledAt !== null,
    createdAt: member.createdAt,
    overrides: member.permissionOverrides,
    permissions: Array.from(
      resolvePlatformPermissionSet(member.roleCode, member.permissionOverrides)
    ).sort(),
  };
}

export async function listPlatformTeam() {
  const members = await prisma.platformStaff.findMany({
    where: { deletedAt: null },
    select: memberSelect,
    orderBy: { createdAt: "asc" },
  });
  return members.map(memberPayload);
}

export async function createPlatformStaff(
  actor: PlatformActor,
  input: { email: unknown; displayName: unknown; temporaryPassword: unknown; roleCode: unknown }
) {
  const email = normalizeEmail(input.email);
  const roleCode = assertPlatformStaffRoleCode(input.roleCode);
  if (typeof input.displayName !== "string" || input.displayName.trim().length < 2) {
    throw new HttpError(400, "INVALID_DISPLAY_NAME", "اسم العرض يجب أن يتكون من حرفين على الأقل.");
  }
  const displayName = input.displayName.trim();
  const passwordHash = await createPasswordHash(input.temporaryPassword);
  const member = await prisma.$transaction(async (tx) => {
    const created = await tx.platformStaff.create({
      data: { email, passwordHash, displayName, roleCode },
      select: memberSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "platform_staff",
      entityId: created.id,
      entityLabel: displayName,
      action: "staff_created",
      actor,
      metadata: { email, roleCode },
    });
    return created;
  });
  return { member: memberPayload(member) };
}

async function requireLiveMember(staffId: string) {
  const member = await prisma.platformStaff.findFirst({
    where: { id: staffId, deletedAt: null },
    select: { id: true, email: true, displayName: true, roleCode: true, isActive: true },
  });
  if (!member) throw new HttpError(404, "RESOURCE_NOT_FOUND", "عضو طاقم المنصة المطلوب غير موجود.");
  return member;
}

export async function updatePlatformStaff(
  actor: PlatformActor,
  staffId: string,
  input: { roleCode?: unknown; isActive?: unknown }
) {
  const current = await requireLiveMember(staffId);
  const nextRole =
    input.roleCode === undefined ? undefined : assertPlatformStaffRoleCode(input.roleCode);
  const nextActive = input.isActive === undefined ? undefined : input.isActive === true;
  if (nextRole === undefined && nextActive === undefined) {
    throw new HttpError(400, "EMPTY_MEMBERSHIP_UPDATE", "roleCode أو isActive مطلوب.");
  }
  const roleChanged = nextRole !== undefined && nextRole !== current.roleCode;
  const activeChanged = nextActive !== undefined && nextActive !== current.isActive;

  const member = await prisma.$transaction(async (tx) => {
    const updated = await tx.platformStaff.update({
      where: { id: staffId },
      data: {
        ...(nextRole !== undefined ? { roleCode: nextRole } : {}),
        ...(nextActive !== undefined ? { isActive: nextActive } : {}),
        ...(roleChanged || activeChanged ? { permissionVersion: { increment: 1 } } : {}),
      },
      select: memberSelect,
    });
    if (roleChanged || (activeChanged && nextActive === false)) {
      // D14-07 mirror: the change takes effect immediately — open sessions die now.
      await tx.platformStaffSession.updateMany({
        where: { platformStaffId: staffId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await recordPlatformAuditEvent(tx, {
      entityType: "platform_staff",
      entityId: staffId,
      entityLabel: current.displayName,
      action: "staff_updated",
      actor,
      metadata: {
        ...(nextRole !== undefined ? { roleCode: nextRole } : {}),
        ...(nextActive !== undefined ? { isActive: nextActive } : {}),
      },
    });
    return updated;
  });
  return { member: memberPayload(member) };
}

export async function setPlatformStaffOverrides(
  actor: PlatformActor,
  staffId: string,
  input: { overrides: unknown }
) {
  const current = await requireLiveMember(staffId);
  if (
    !Array.isArray(input.overrides) ||
    input.overrides.length > PLATFORM_PERMISSION_CODES.length
  ) {
    throw new HttpError(
      400,
      "INVALID_OVERRIDES",
      "overrides يجب أن تكون مصفوفة بعنصر واحد على الأكثر لكل رمز صلاحية."
    );
  }
  const seen = new Set<string>();
  const entries = input.overrides.map((entry: { permissionCode?: unknown; effect?: unknown }) => {
    const permissionCode = assertPlatformPermissionCode(entry?.permissionCode);
    if (entry?.effect !== "allow" && entry?.effect !== "deny") {
      throw new HttpError(422, "INVALID_OVERRIDE_EFFECT", "أثر التجاوز يجب أن يكون allow أو deny.");
    }
    if (seen.has(permissionCode))
      throw new HttpError(422, "DUPLICATE_OVERRIDE", "كل رمز صلاحية يظهر مرة واحدة على الأكثر.");
    seen.add(permissionCode);
    return { permissionCode, effect: entry.effect as "allow" | "deny" };
  });

  // Deliberately NO session revoke here: permissions resolve on every request,
  // so the override lands on the very next call — the staff.service.ts mirror.
  const member = await prisma.$transaction(async (tx) => {
    await tx.platformStaffPermissionOverride.deleteMany({ where: { staffId } });
    if (entries.length) {
      await tx.platformStaffPermissionOverride.createMany({
        data: entries.map((entry) => ({ staffId, ...entry })),
      });
    }
    const updated = await tx.platformStaff.update({
      where: { id: staffId },
      data: { permissionVersion: { increment: 1 } },
      select: memberSelect,
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "platform_staff",
      entityId: staffId,
      entityLabel: current.displayName,
      action: "staff_overrides_changed",
      actor,
      metadata: { overrides: entries },
    });
    return updated;
  });
  return { member: memberPayload(member) };
}

/**
 * «إزالة من الطاقم» — a soft `deletedAt` WITHOUT the trash-bin machinery: no
 * restore surface exists, and the owner re-creates the account if he changes
 * his mind. The removal revokes every open session in the same transaction.
 */
export async function removePlatformStaff(actor: PlatformActor, staffId: string) {
  const current = await requireLiveMember(staffId);
  await prisma.$transaction(async (tx) => {
    await tx.platformStaff.update({
      where: { id: staffId },
      data: { deletedAt: new Date(), permissionVersion: { increment: 1 } },
    });
    await tx.platformStaffSession.updateMany({
      where: { platformStaffId: staffId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "platform_staff",
      entityId: staffId,
      entityLabel: current.displayName,
      action: "staff_removed",
      actor,
      metadata: { email: current.email },
    });
  });
  return { removed: true as const };
}

/**
 * The owner's answer to a lost phone: clears the factor entirely and revokes
 * every session, forcing a fresh sign-in and a fresh enrolment. There are no
 * recovery codes for staff by design — this reset IS the recovery path.
 */
export async function resetPlatformStaffTotp(actor: PlatformActor, staffId: string) {
  const current = await requireLiveMember(staffId);
  const member = await prisma.$transaction(async (tx) => {
    const updated = await tx.platformStaff.update({
      where: { id: staffId },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
      select: memberSelect,
    });
    await tx.platformStaffSession.updateMany({
      where: { platformStaffId: staffId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "platform_staff",
      entityId: staffId,
      entityLabel: current.displayName,
      action: "staff_totp_reset",
      actor,
      metadata: { email: current.email },
    });
    return updated;
  });
  return { member: memberPayload(member) };
}

/**
 * The staff sign-in door (the `loginStaff` mirror plus the owner's TOTP
 * branch). ONE generic 401 for unknown, wrong-password, disabled and removed
 * alike — the door must not say which. An account that has not finished
 * enrolment signs in on the password alone; the guard then admits it to the
 * enrolment routes and nothing else (ق-124).
 */
export async function loginPlatformStaff(input: {
  email: unknown;
  password: unknown;
  totpCode?: unknown;
}) {
  // findFirst, not findUnique: uniqueness moved to the LIVE partial index, so
  // the email is no longer a Prisma unique key. The deletedAt check below still
  // runs AFTER the read on purpose — refusing in one branch with one message
  // keeps a removed address indistinguishable from a wrong password.
  const staff = await prisma.platformStaff.findFirst({
    where: { email: normalizeEmail(input.email) },
    orderBy: { createdAt: "desc" },
  });
  // 19-د: the compare runs BEFORE the branch, unconditionally — see
  // ABSENT_IDENTITY_HASH. The comment above promises one generic 401 for
  // unknown, wrong-password, disabled and removed alike; until this line existed
  // the STATUS CODE kept that promise and the CLOCK broke it, answering in
  // ~30 ms for the first, third and fourth and ~800 ms for the second.
  const passwordOk = await verifyPassword(
    input.password,
    staff?.passwordHash ?? ABSENT_IDENTITY_HASH
  );
  if (!staff || staff.deletedAt !== null || !staff.isActive || !passwordOk) {
    throw new HttpError(
      401,
      "INVALID_PLATFORM_STAFF_CREDENTIALS",
      "بيانات الدخول غير صحيحة. تحقق من البريد وكلمة المرور."
    );
  }
  if (staff.totpEnabledAt) {
    // A distinct code, deliberately (the ق-123 shape): the client must know to
    // ASK for the second factor rather than repeat «كلمة مرور خاطئة» at someone
    // whose password was right.
    if (input.totpCode === undefined || input.totpCode === null || input.totpCode === "") {
      throw new HttpError(401, "SECOND_FACTOR_REQUIRED", "أدخل رمز تطبيق المصادقة.");
    }
    if (!(await verifyPlatformStaffSecondFactor(staff.id, input.totpCode))) {
      throw new HttpError(401, "INVALID_SECOND_FACTOR", "الرمز غير صحيح أو مستعمل مسبقاً.");
    }
  }
  return {
    accessToken: await createTypedSession("platform_staff", staff.id),
    redirectTo: platformStaffDashboardPath(),
  };
}

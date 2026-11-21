/**
 * codiq phase 14 — store team management (D14-05: direct creation with a temporary
 * password; email invitations stay out of scope until the notification phase).
 * Every mutation runs against a server-resolved storeId; membership disable and role
 * changes revoke the affected staff sessions immediately (D14-07).
 */
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import { createPasswordHash, normalizeEmail } from "../auth/identity.js";
import { assertDemoWritable } from "../demo/demo-mode.js";
import { assertPermissionCode, assertStaffRoleCode, resolvePermissionSet, PERMISSION_CODES, ROLE_PERMISSION_MATRIX, type PermissionCode, type StoreActorContext } from "../auth/staff-permissions.js";
import { assertWithinPlanLimit } from "./entitlement.service.js";
import type { AuditActor } from "./soft-delete/audit-log.service.js";
import { LIVE } from "./soft-delete/constants.js";
import { restore, softDelete } from "./soft-delete/soft-delete.service.js";

const membershipSelect = {
  id: true,
  roleCode: true,
  isActive: true,
  permissionVersion: true,
  createdAt: true,
  staff: { select: { id: true, email: true, displayName: true, isActive: true } },
  permissionOverrides: { select: { permissionCode: true, effect: true }, orderBy: { permissionCode: "asc" as const } },
} as const;

function membershipPayload(membership: {
  id: string;
  roleCode: string;
  isActive: boolean;
  permissionVersion: number;
  createdAt: Date;
  staff: { id: string; email: string; displayName: string; isActive: boolean };
  permissionOverrides: { permissionCode: string; effect: string }[];
}) {
  return {
    id: membership.id,
    roleCode: membership.roleCode,
    isActive: membership.isActive,
    permissionVersion: membership.permissionVersion,
    createdAt: membership.createdAt,
    staff: membership.staff,
    overrides: membership.permissionOverrides,
    permissions: Array.from(resolvePermissionSet(membership.roleCode, membership.permissionOverrides)).sort(),
  };
}

/**
 * WHO IS CHANGING THE TEAM — and the one rule that follows from it.
 *
 * The routes asked only «does the caller hold `team.manage`?». For the merchant
 * that is the whole question: he owns the store and holds every code. For an
 * EMPLOYEE it is not. A cashier the merchant trusted with `team.manage` alone
 * could grant himself every other permission through his own overrides, promote
 * himself to `store_manager`, or create a fresh manager account with a password
 * he chose — `team.manage` was, in effect, every permission there is.
 *
 * So an employee manages the team INSIDE his own authority:
 *   · he never changes his own membership (role, state, overrides, removal);
 *   · he grants no role and no permission he does not hold himself;
 *   · he does not touch a member whose permissions exceed his own.
 * A `store_manager` holds every code, so for him nothing changes; the merchant
 * is never constrained at all.
 */
export type TeamActor =
  | { kind: "merchant" }
  | { kind: "staff"; membershipId: string; permissions: ReadonlySet<PermissionCode> };

export function teamActorOf(context: Pick<StoreActorContext, "actor" | "permissions">): TeamActor {
  return context.actor.kind === "staff"
    ? { kind: "staff", membershipId: context.actor.membershipId, permissions: context.permissions }
    : { kind: "merchant" };
}

function assertGrantable(actor: TeamActor, codes: Iterable<string>) {
  if (actor.kind === "merchant") return;
  const beyond = Array.from(codes).filter((code) => !actor.permissions.has(code as PermissionCode));
  if (beyond.length) {
    throw new HttpError(403, "TEAM_GRANT_EXCEEDS_OWN", `لا يمكنك منح صلاحية لا تملكها: ${beyond.sort().join("، ")}.`);
  }
}

/** An employee may manage a member only if it is not himself and the member does not outrank him. */
async function assertMayManageMembership(actor: TeamActor, storeId: string, membershipId: string) {
  if (actor.kind === "merchant") return;
  if (membershipId === actor.membershipId) {
    throw new HttpError(403, "TEAM_SELF_CHANGE_DENIED", "لا يمكنك تعديل عضويتك أنت — يغيّرها صاحب المتجر أو مدير آخر.");
  }
  const target = await prisma.storeStaffMembership.findFirst({
    where: { id: membershipId, storeId, ...LIVE },
    select: { roleCode: true, permissionOverrides: { select: { permissionCode: true, effect: true } } },
  });
  if (!target) return; // the action's own lookup answers the 404
  const beyond = Array.from(resolvePermissionSet(target.roleCode, target.permissionOverrides)).filter((code) => !actor.permissions.has(code));
  if (beyond.length) {
    throw new HttpError(403, "TEAM_TARGET_OUTRANKS", "لهذا العضو صلاحيات لا تملكها، فلا يمكنك تعديله.");
  }
}

export async function listStoreTeam(storeId: string) {
  const memberships = await prisma.storeStaffMembership.findMany({
    where: { storeId, ...LIVE },
    select: membershipSelect,
    orderBy: { createdAt: "asc" },
  });
  return memberships.map(membershipPayload);
}

/**
 * PG-2: «إيقاف» (isActive = false, still on the roster) and «إزالة من الفريق»
 * (trash bin, off the roster) are now two different acts — plan §1.و
 * exception 6. What is deleted is the MEMBERSHIP, never the Staff identity: a
 * store does not get to delete a human being who may work in other stores.
 *
 * The new guard refuses to remove the LAST membership that can still manage the
 * team; the removal revokes that membership's sessions immediately (D14-07) and
 * bumps permissionVersion, exactly like a disable.
 */
export async function removeStoreMembership(storeId: string, membershipId: string, actor: AuditActor, teamActor: TeamActor) {
  await assertMayManageMembership(teamActor, storeId, membershipId);
  return softDelete("staff_membership", storeId, membershipId, actor);
}

/** Overrides come back with the membership; SESSIONS never do — the person signs in again. */
export async function restoreStoreMembership(storeId: string, membershipId: string, actor: AuditActor) {
  return restore("staff_membership", storeId, membershipId, actor);
}

/**
 * 19-ج: the HTTP edge parses these three bodies through `team.schema.ts`, whose
 * role and permission enums are DERIVED from staff-permissions.ts — the same
 * list the `staff_membership_permission_overrides_code` CHECK enforces. The
 * guards below stay: they are what answers when this function is called from
 * anywhere but that route, and `displayName` is genuinely conditional — a second
 * membership for an existing staff identity needs neither it nor a password
 * (D14-06), and only the database knows which case this is.
 */
export async function createStoreStaff(storeId: string, input: { email: unknown; displayName?: unknown; temporaryPassword?: unknown; roleCode: unknown; linkExisting?: unknown }, actor: TeamActor) {
  const email = normalizeEmail(input.email);
  const roleCode = assertStaffRoleCode(input.roleCode);
  // A new account whose password the employee chose IS the employee — so the
  // role he gives it is bounded by his own, like any other grant.
  assertGrantable(actor, ROLE_PERMISSION_MATRIX[roleCode]);
  // Phase 16: team size is a plan entitlement across the merchant's stores.
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { merchantId: true } });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
  await assertWithinPlanLimit(prisma, store.merchantId, "max_staff");
  // ق-227: the LIVING only. An identity whose last membership was removed has
  // released its address, and a new employee typing the same one is a NEW person
  // — with his own password, his own display name, and none of the departed
  // employee's memberships.
  const existingStaff = await prisma.staff.findFirst({ where: { email, deletedAt: null }, select: { id: true, isActive: true, displayName: true } });

  if (existingStaff) {
    /**
     * ق-228 — AN EXISTING IDENTITY IS ATTACHED ONLY WHEN THE MERCHANT SAYS SO.
     *
     * D14-06 allowed a second membership for an existing staff identity, and the
     * route did it SILENTLY: type any address that already belongs to a store
     * employee anywhere on the platform, and that person becomes an employee of
     * YOUR store — with a role you chose — without his knowledge, without his
     * consent, and without him typing a password. He signs in with the
     * credentials he already has and finds a second shop attached to his
     * account; the shop that attached him reads nothing of his other stores, but
     * he now works in it. Whoever plants an address FIRST wins the identity.
     *
     * The linking itself is legitimate — one person genuinely does work in two
     * shops, and the platform is right to model that with one identity. What was
     * missing is the merchant SAYING he means it. So: refused unless
     * `linkExisting` is true, and in that branch no password is accepted (his
     * password is his; it was never replaceable through this route, and now the
     * shape of the call says so).
     *
     * Residual, and deliberately accepted for now: a merchant with `team.manage`
     * can still learn whether an address belongs to a staff identity somewhere by
     * reading which refusal he gets. That is a far smaller harm than silent
     * attachment, and the invitation flow that removes it needs a channel the
     * shop's employees actually have — a WhatsApp OTP rather than email, which is
     * D-12's expansion and not this fix's scope.
     */
    if (input.linkExisting !== true) {
      throw new HttpError(
        409,
        "STAFF_EMAIL_ALREADY_REGISTERED",
        "هذا البريد مسجَّل لموظّف على المنصّة. إن كان الشخص نفسه فأكّد ربطه بمتجرك — سيدخل بكلمة مروره هو، ولن تتغيّر.",
      );
    }
    // The stored password is never replaced through the team endpoint, and this
    // branch does not even read one: sending it would be a merchant trying to set
    // another shop's employee's credentials.
    const membership = await prisma.storeStaffMembership.create({
      data: { staffId: existingStaff.id, storeId, roleCode },
      select: membershipSelect,
    });
    return { created: "membership" as const, membership: membershipPayload(membership) };
  }

  if (typeof input.displayName !== "string" || input.displayName.trim().length < 2) {
    throw new HttpError(400, "INVALID_DISPLAY_NAME", "Display name must contain at least 2 characters.");
  }
  const passwordHash = await createPasswordHash(input.temporaryPassword);
  const membership = await prisma.$transaction(async (tx) => {
    // Audit 14-ب: the merchant typed this password, so it is provisional until
    // the employee replaces it (staff counterpart of ق-218).
    const staff = await tx.staff.create({ data: { email, passwordHash, displayName: (input.displayName as string).trim(), passwordSetByProvisionerAt: new Date() }, select: { id: true } });
    return tx.storeStaffMembership.create({ data: { staffId: staff.id, storeId, roleCode }, select: membershipSelect });
  });
  return { created: "staff" as const, membership: membershipPayload(membership) };
}

async function requireMembershipInStore(storeId: string, membershipId: string) {
  const membership = await prisma.storeStaffMembership.findFirst({ where: { id: membershipId, storeId, ...LIVE }, select: { id: true, roleCode: true, isActive: true, staff: { select: { email: true } } } });
  if (!membership) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested team membership was not found in this store.");
  return membership;
}

export async function updateStoreMembership(storeId: string, membershipId: string, input: { roleCode?: unknown; isActive?: unknown }, actor: TeamActor) {
  const current = await requireMembershipInStore(storeId, membershipId);
  await assertMayManageMembership(actor, storeId, membershipId);
  // P27-7: disabling this membership revokes its sessions immediately (D14-07),
  // which would kill the demo staff login documented for prospects until the
  // nightly reseed. The seeded member is refused; members the visitor adds are not.
  assertDemoWritable("demo_staff", current.staff.email);
  const nextRole = input.roleCode === undefined ? undefined : assertStaffRoleCode(input.roleCode);
  if (nextRole !== undefined) assertGrantable(actor, ROLE_PERMISSION_MATRIX[nextRole]);
  const nextActive = input.isActive === undefined ? undefined : input.isActive === true;
  if (nextRole === undefined && nextActive === undefined) {
    throw new HttpError(400, "EMPTY_MEMBERSHIP_UPDATE", "roleCode or isActive is required.");
  }
  const roleChanged = nextRole !== undefined && nextRole !== current.roleCode;
  const activeChanged = nextActive !== undefined && nextActive !== current.isActive;

  const membership = await prisma.$transaction(async (tx) => {
    if (activeChanged && nextActive === true) {
      // Audit 16-ب: re-activating a suspended member adds a seat exactly like
      // inviting one does, so it spends the same `max_staff` quota. Without this
      // the limit was bypassed from the team screen: suspend, invite, reactivate.
      const store = await tx.store.findUniqueOrThrow({ where: { id: storeId }, select: { merchantId: true } });
      await assertWithinPlanLimit(tx, store.merchantId, "max_staff");
    }
    const updated = await tx.storeStaffMembership.update({
      where: { id: membershipId },
      data: {
        ...(nextRole !== undefined ? { roleCode: nextRole } : {}),
        ...(nextActive !== undefined ? { isActive: nextActive } : {}),
        ...(roleChanged || activeChanged ? { permissionVersion: { increment: 1 } } : {}),
      },
      select: membershipSelect,
    });
    if (roleChanged || (activeChanged && nextActive === false)) {
      // D14-07: the change takes effect immediately — open sessions on this membership die now.
      await tx.staffSession.updateMany({ where: { membershipId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return updated;
  });
  return membershipPayload(membership);
}

export async function setMembershipOverrides(storeId: string, membershipId: string, input: { overrides: unknown }, actor: TeamActor) {
  await requireMembershipInStore(storeId, membershipId);
  await assertMayManageMembership(actor, storeId, membershipId);
  if (!Array.isArray(input.overrides) || input.overrides.length > PERMISSION_CODES.length) {
    throw new HttpError(400, "INVALID_OVERRIDES", "overrides must be an array with at most one entry per permission code.");
  }
  const seen = new Set<string>();
  const entries = input.overrides.map((entry: any) => {
    const permissionCode = assertPermissionCode(entry?.permissionCode);
    if (entry?.effect !== "allow" && entry?.effect !== "deny") {
      throw new HttpError(422, "INVALID_OVERRIDE_EFFECT", "Override effect must be allow or deny.");
    }
    if (seen.has(permissionCode)) throw new HttpError(422, "DUPLICATE_OVERRIDE", "Each permission code may appear at most once.");
    seen.add(permissionCode);
    return { permissionCode, effect: entry.effect as "allow" | "deny" };
  });
  // A deny only ever narrows; an allow is a grant, bounded like any other.
  assertGrantable(actor, entries.filter((entry) => entry.effect === "allow").map((entry) => entry.permissionCode));

  const membership = await prisma.$transaction(async (tx) => {
    await tx.staffMembershipPermissionOverride.deleteMany({ where: { membershipId } });
    if (entries.length) {
      await tx.staffMembershipPermissionOverride.createMany({ data: entries.map((entry) => ({ membershipId, ...entry })) });
    }
    return tx.storeStaffMembership.update({
      where: { id: membershipId },
      data: { permissionVersion: { increment: 1 } },
      select: membershipSelect,
    });
  });
  return membershipPayload(membership);
}

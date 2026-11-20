/**
 * Phase 19-أ — changing your own password, for all four identities (ق-48).
 *
 * Until now NOBODY on this platform could change a password. Not the owner, not
 * a merchant, not a staff member, not a customer. A password that can never be
 * changed is a password that stays compromised forever once it leaks, and every
 * piece of advice anyone would give after a leak — "change it immediately" — had
 * no button behind it.
 *
 * ONE SERVICE FOR FOUR IDENTITIES. The four differ in where the hash lives and
 * in nothing else that matters here, so they share this code. Four copies of a
 * security routine is four places for the next fix to be applied to three of.
 *
 * THE CURRENT PASSWORD IS REQUIRED, not merely a live session. A borrowed
 * unlocked laptop must not be able to seize an account by setting a new
 * password — the person who walked away still knows the old one, and that is
 * what keeps the account his.
 *
 * THE REVOKE IS IN THE SAME TRANSACTION AS THE HASH. If the hash were written
 * and the revoke then failed, he would be told his password changed while
 * whoever else was signed in stayed signed in. That is not a partial success; it
 * is the failure he changed his password to prevent, reported to him as success.
 */
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { createPasswordHash, verifyPassword, type SessionClaims } from "../auth/identity.js";
import type { IdentityKind } from "../auth/redirects.js";
import { invalidateLiveResetTokens } from "./password-reset.service.js";
import { revokeOtherSessionsWithin } from "./session.service.js";
import { REAUTH_ATTEMPT_LIMIT, REAUTH_WINDOW_MS, consumeStorefrontRateLimit, refundStorefrontRateLimit } from "./storefront.service.js";

/**
 * Where each identity keeps its hash. The delegate is named as a string because
 * a transaction client cannot carry `prisma.x` across — the same reason
 * `tableFor` in the session service returns a name.
 */
function delegateNameFor(kind: IdentityKind): string {
  if (kind === "platform_owner") return "platformOwner";
  if (kind === "merchant") return "merchant";
  if (kind === "staff") return "staff";
  // 19-ب: explicit fifth entry — the customer fallback must never receive a
  // platform-staff password change.
  if (kind === "platform_staff") return "platformStaff";
  return "customer";
}

interface HashRow {
  passwordHash: string;
}

type Delegate = {
  findUnique: (args: unknown) => Promise<HashRow | null>;
  update: (args: unknown) => Promise<unknown>;
};

function delegate(client: unknown, name: string): Delegate {
  return (client as Record<string, Delegate>)[name]!;
}

export interface PasswordChangeResult {
  /** How many other sessions were ended. Shown so he sees the protection happen. */
  otherSessionsEnded: number;
}

export async function changeOwnPassword(
  claims: SessionClaims,
  input: { currentPassword: unknown; newPassword: unknown },
  now = new Date(),
): Promise<PasswordChangeResult> {
  const name = delegateNameFor(claims.identityKind);

  const row = await delegate(prisma, name).findUnique({
    where: { id: claims.subjectId },
    select: { passwordHash: true },
  });
  if (!row) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");

  // 19-د: the ceiling lives HERE, in the service, not on the route — an
  // unavoidable gate for any future caller, and ahead of the bcrypt compare so
  // a grinder is refused before he spends the CPU. See REAUTH_ATTEMPT_LIMIT.
  const reauthKey = { scope: "password_reverify", rawKey: `${claims.identityKind}:${claims.subjectId}` };
  await consumeStorefrontRateLimit({ ...reauthKey, limit: REAUTH_ATTEMPT_LIMIT, windowMs: REAUTH_WINDOW_MS });

  if (!(await verifyPassword(input.currentPassword, row.passwordHash))) {
    throw new HttpError(422, "INVALID_PASSWORD", "كلمة المرور الحالية غير صحيحة.");
  }
  // Refunded the moment he proves the password is his: the budget exists to slow
  // GUESSING, and a person who typed his own password must never be walking
  // toward a lockout on his own account.
  await refundStorefrontRateLimit(reauthKey);

  // Refused BEFORE hashing, so the message is about what he did rather than
  // about a policy he did not break. A "change" that changes nothing leaves a
  // leaked password live while telling him it is not.
  if (typeof input.newPassword === "string" && (await verifyPassword(input.newPassword, row.passwordHash))) {
    throw new HttpError(422, "PASSWORD_UNCHANGED", "كلمة المرور الجديدة مطابقة للحالية. اختر كلمة مختلفة.");
  }

  // Throws WEAK_PASSWORD on its own — the platform's single length rule (8) and its refusal of
  // applied here by calling it rather than by restating it.
  const passwordHash = await createPasswordHash(input.newPassword);

  const otherSessionsEnded = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await delegate(tx, name).update({ where: { id: claims.subjectId }, data: { passwordHash } });
    // ق-218: a merchant whose password was chosen FOR him by a platform actor is
    // gated out of every merchant surface until this moment. He has just replaced
    // that credential with one nobody else has ever seen, so the mark comes off
    // in the same transaction as the hash — if the write below rolled back while
    // the mark did not, he would be holding a password the platform still treats
    // as somebody else's.
    if (claims.identityKind === "merchant") {
      await tx.merchant.update({ where: { id: claims.subjectId }, data: { passwordSetByProvisionerAt: null } });
    }
    // PR-1: every outstanding RESET LINK dies here too, in the same transaction
    // as the hash. Without this line a person who asked for a link, then
    // remembered his password and changed it from inside the dashboard, would
    // leave a live account-takeover primitive sitting in his inbox for the rest
    // of its 45 minutes — pointed at the password he just replaced. Whoever can
    // read that mail could undo the change he made to be safe.
    await invalidateLiveResetTokens(tx, claims.identityKind, claims.subjectId, "password_changed", now);
    // Every other session goes. THIS one survives: logging him out of the device
    // he is holding, at the moment he did the right thing, teaches him not to do
    // it again — and he has just proven he holds the password.
    return revokeOtherSessionsWithin(tx, claims, now);
  });

  return { otherSessionsEnded };
}

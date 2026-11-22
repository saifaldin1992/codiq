/**
 * PC-1 — the platform owner changes his own SIGN-IN email.
 *
 * The owner asked for his login address to become a different one and, in the
 * same sentence, for a button that does it — «بدل الايميل الموجود لتسجيل دخول
 * مالك المنصه … اذا تم اضافه زر تغيير … الايميل». The button is the point: an
 * address changed by a migration is changed once by an engineer; an address
 * changed by a form is his to change forever. He also said, plainly, that his
 * PASSWORD must not change — so nothing here touches `passwordHash`.
 *
 * THE CURRENT PASSWORD IS REQUIRED. Changing the address a password-reset link
 * would be sent to IS the account takeover; a live session is not enough,
 * because a live session is what a borrowed unlocked laptop already has. This is
 * the same reasoning `password.service.ts` states for its own re-authentication,
 * applied to the act that would let somebody bypass it.
 *
 * THE SESSION SURVIVES, deliberately and unlike a password change. A password
 * change ends other sessions because the old secret may be in someone else's
 * hands; an email change reveals nothing and invalidates nothing, and signing a
 * man out of the screen he just used teaches him not to use it. The owner asked
 * for exactly this: «و لا حاجة لتغيير كلمة السر».
 *
 * THE CROSS-IDENTITY REFUSAL IS THE DATABASE'S. `codiq_guard_owner_merchant_staff_email`
 * raises 23505 when an address already belongs to a merchant, a staff member or
 * platform staff, and `http/errors.ts` already turns that into a 409 with a
 * sentence that names all four identities. Re-checking it here in TypeScript
 * would be a second, racy authority that disagrees with the first under
 * concurrency — so this service does not check, it lets the guard speak.
 */
import {
  REAUTH_ATTEMPT_LIMIT,
  REAUTH_WINDOW_MS,
  consumeStorefrontRateLimit,
  refundStorefrontRateLimit,
} from "./storefront.service.js";
import { HttpError } from "../auth/auth.errors.js";
import { normalizeEmail, verifyPassword } from "../auth/identity.js";
import { prisma } from "../db/prisma.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

export interface OwnerAccountView {
  email: string;
  displayName: string;
}

export async function ownerAccount(ownerId: string): Promise<OwnerAccountView> {
  const owner = await prisma.platformOwner.findUnique({
    where: { id: ownerId },
    select: { email: true, displayName: true },
  });
  if (!owner) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");
  return owner;
}

export interface ChangeOwnerEmailResult {
  email: string;
  previousEmail: string;
}

export async function changeOwnerEmail(
  ownerId: string,
  input: { currentPassword: unknown; email: unknown }
): Promise<ChangeOwnerEmailResult> {
  const owner = await prisma.platformOwner.findUnique({
    where: { id: ownerId },
    select: { email: true, passwordHash: true },
  });
  if (!owner) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");

  // The re-verification budget the password change and the 2FA switch-off already share: a
  // borrowed session must not be able to guess the password here (review batch 3, م-٣).
  const reauthKey = { scope: "password_reverify", rawKey: `platform_owner:${ownerId}` };
  await consumeStorefrontRateLimit({
    ...reauthKey,
    limit: REAUTH_ATTEMPT_LIMIT,
    windowMs: REAUTH_WINDOW_MS,
  });
  if (!(await verifyPassword(input.currentPassword, owner.passwordHash))) {
    // The same code and the same Arabic `password.service.ts` answers with, so a
    // mistyped password reads identically wherever it is typed.
    throw new HttpError(422, "INVALID_PASSWORD", "كلمة المرور الحالية غير صحيحة.");
  }
  await refundStorefrontRateLimit(reauthKey);

  const email = normalizeEmail(input.email);
  if (email === owner.email) {
    // Refused rather than accepted-as-a-no-op: an owner who typed his existing
    // address meant to type a different one, and «تم الحفظ» would hide the typo.
    throw new HttpError(
      422,
      "EMAIL_UNCHANGED",
      "هذا هو بريدك الحالي. اكتب البريد الجديد الذي تريد الدخول به."
    );
  }

  await prisma.$transaction(async (tx) => {
    // The `passwordHash` column is not in `data`, and that is the whole promise
    // of this route: the owner keeps the password he already has.
    await tx.platformOwner.update({ where: { id: ownerId }, data: { email } });
    await recordPlatformAuditEvent(tx, {
      entityType: "platform_account",
      entityId: ownerId,
      entityLabel: "حساب مالك المنصة",
      action: "owner_email_changed",
      actor: { kind: "platform_owner", id: ownerId },
      // Both addresses: an audit line reading «غُيّر البريد» without saying from
      // what is a line that cannot answer the question it was written for.
      metadata: { from: owner.email, to: email },
    });
  });

  return { email, previousEmail: owner.email };
}

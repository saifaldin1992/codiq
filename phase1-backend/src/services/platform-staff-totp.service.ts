/**
 * 19-ب — the platform staff member's MANDATORY second factor (ق-124).
 *
 * Built on the generic RFC-6238 primitives in `src/auth/totp.ts` — the same
 * forty verified lines the owner's factor uses; nothing here re-implements the
 * algorithm and nothing here touches `owner-totp.service.ts`.
 *
 * Two deliberate differences from the owner's surface:
 *  - NO recovery codes. A staff member who loses his phone asks the owner,
 *    who resets the factor from the team screen (revoking every session);
 *    a self-service bypass would be a bypass for whoever stole the phone too.
 *  - NO self-service disable. The factor is mandatory, so "off" is not a state
 *    a staff member may choose. Only the owner's reset clears it — and that
 *    forces re-enrolment before any screen opens again.
 *
 * Enrolment is still two steps for the same reason as the owner's: `begin`
 * enables NOTHING, and only a working code from the app switches the factor
 * on — a blurry QR must not lock a person out on day one.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { generateTotpSecret, totpEnrolmentUri, verifyTotp } from "../auth/totp.js";
import { openSecret, sealSecret } from "../auth/secret-box.js";

/**
 * 19-د (D-40): `platform_staff.totp_secret` holds an AEAD envelope now. Its own
 * purpose label, so a ciphertext copied out of this column and pasted into the
 * owner's fails its authentication tag instead of enrolling the wrong phone as
 * the platform owner's second factor.
 */
const PURPOSE = "platform-staff-totp" as const;

async function liveStaff(staffId: string) {
  const staff = await prisma.platformStaff.findFirst({
    where: { id: staffId, deletedAt: null },
    select: { id: true, email: true, totpSecret: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!staff) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");
  return staff;
}

/** Step one: a secret and a QR. Nothing is enabled yet. */
export async function beginPlatformStaffTotpEnrolment(
  staffId: string
): Promise<{ secret: string; uri: string }> {
  const staff = await liveStaff(staffId);
  if (staff.totpEnabledAt) {
    // Replacing a working factor silently would swap it for an unproven one.
    // The road to a new phone runs through the owner's reset.
    throw new HttpError(
      409,
      "TOTP_ALREADY_ENABLED",
      "العامل الثاني مفعّل بالفعل. اطلب من مالك المنصة إعادة تعيينه إن أردت ربط تطبيق آخر."
    );
  }
  const secret = generateTotpSecret();
  await prisma.platformStaff.update({
    where: { id: staffId },
    data: { totpSecret: sealSecret(PURPOSE, secret), totpLastStep: null },
  });
  return { secret, uri: totpEnrolmentUri(secret, staff.email) };
}

/** Step two: prove the app works, and only then switch the factor on. */
export async function confirmPlatformStaffTotpEnrolment(
  staffId: string,
  code: unknown,
  now = new Date()
): Promise<{ totpEnrolled: true }> {
  const staff = await liveStaff(staffId);
  if (!staff.totpSecret) throw new HttpError(409, "TOTP_NOT_STARTED", "ابدأ الربط أولاً.");
  if (staff.totpEnabledAt)
    throw new HttpError(409, "TOTP_ALREADY_ENABLED", "العامل الثاني مفعّل بالفعل.");

  const check = verifyTotp(openSecret(PURPOSE, staff.totpSecret), code, { now });
  if (!check.ok)
    throw new HttpError(
      422,
      "INVALID_TOTP_CODE",
      "الرمز غير صحيح. تأكد أن وقت هاتفك مضبوط تلقائياً."
    );

  await prisma.platformStaff.update({
    where: { id: staffId },
    data: { totpEnabledAt: now, totpLastStep: BigInt(check.step!) },
  });
  return { totpEnrolled: true };
}

/**
 * Checks the second factor at sign-in. The code is consumed on success by
 * advancing `totpLastStep` — a factor that can be replayed only delays an
 * attacker. No recovery-code branch, by design (see the header).
 */
export async function verifyPlatformStaffSecondFactor(
  staffId: string,
  code: unknown,
  now = new Date()
): Promise<boolean> {
  const staff = await prisma.platformStaff.findFirst({
    where: { id: staffId, deletedAt: null },
    select: { totpSecret: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!staff?.totpEnabledAt || !staff.totpSecret) return false;

  const check = verifyTotp(openSecret(PURPOSE, staff.totpSecret), code, {
    now,
    lastUsedStep: staff.totpLastStep === null ? null : Number(staff.totpLastStep),
  });
  if (!check.ok) return false;
  await prisma.platformStaff.update({
    where: { id: staffId },
    data: { totpLastStep: BigInt(check.step!) },
  });
  return true;
}

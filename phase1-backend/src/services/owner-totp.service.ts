/**
 * Phase 19-أ — enrolling, using and removing the owner's second factor (ق-123).
 *
 * ENROLMENT IS TWO STEPS, AND THAT IS THE WHOLE POINT. `begin` generates a secret
 * and hands back the QR URI but enables NOTHING; `confirm` requires a working
 * code from the app before the factor goes live. One step would let an owner
 * scan a blurry QR, miss it, and lock himself out of his own platform with a
 * secret no phone holds.
 *
 * The pending secret is written to the same column the live one uses, with
 * `totpEnabledAt` still null — which is exactly what the CHECK constraint
 * permits and forbids the reverse of: enabled with no secret is unreachable.
 *
 * A RECOVERY CODE IS A PASSWORD. It is the one thing that gets past the factor,
 * so it is bcrypt-hashed, single-use, and shown exactly once. Ten of them,
 * because this platform has one owner and nobody above him to restore access.
 */
import crypto from "node:crypto";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { createPasswordHash, verifyPassword } from "../auth/identity.js";
import { generateTotpSecret, totpEnrolmentUri, verifyTotp } from "../auth/totp.js";
import { openSecret, sealSecret } from "../auth/secret-box.js";
import { REAUTH_ATTEMPT_LIMIT, REAUTH_WINDOW_MS, consumeStorefrontRateLimit, refundStorefrontRateLimit } from "./storefront.service.js";

/**
 * 19-د (D-40): the column holds an AEAD envelope now, never the base32 secret.
 * `openSecret` still returns a value written before that change untouched, so an
 * owner already enrolled keeps signing in the moment this deploys — his row is
 * re-sealed by `pnpm secrets:encrypt`, or by his next enrolment.
 */
const PURPOSE = "platform-owner-totp" as const;

const RECOVERY_CODE_COUNT = 10;

/**
 * Crockford-ish base32 without I, L, O, U — a person reads these off a screen
 * and types them under stress, and those four are the ones he will get wrong.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/**
 * THREE blocks of five, not two.
 *
 * The original reason was that `createPasswordHash` enforced a 12-character
 * minimum and a ten-character code was refused by it. That floor is now 8, so
 * the constraint is gone — and the length STAYS, because the constraint was
 * never the real argument. 30^15 against 30^10 is roughly 73 bits against 49,
 * and this is the one secret that walks straight past the second factor. Five
 * more characters typed once, in the worst moment of the owner's year, is not a
 * cost worth optimising away.
 */
function newRecoveryCode(): string {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]!;
  const block = () => Array.from({ length: 5 }, pick).join("");
  return `${block()}-${block()}-${block()}`;
}

/** Normalised before hashing AND before comparing, so case and dashes never matter. */
function normaliseRecoveryCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface TotpStatus {
  enabled: boolean;
  enabledAt: Date | null;
  /** How many recovery codes remain unspent. Shown so nobody discovers zero at the worst moment. */
  recoveryCodesLeft: number;
}

export async function totpStatus(ownerId: string): Promise<TotpStatus> {
  const [owner, left] = await Promise.all([
    prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { totpEnabledAt: true } }),
    prisma.platformOwnerRecoveryCode.count({ where: { platformOwnerId: ownerId, usedAt: null } }),
  ]);
  if (!owner) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");
  return { enabled: owner.totpEnabledAt !== null, enabledAt: owner.totpEnabledAt, recoveryCodesLeft: left };
}

/** Step one: a secret and a QR. Nothing is enabled yet. */
export async function beginTotpEnrolment(ownerId: string): Promise<{ secret: string; uri: string }> {
  const owner = await prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { email: true, totpEnabledAt: true } });
  if (!owner) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");
  if (owner.totpEnabledAt) {
    // Re-enrolling silently would replace a working factor with an unproven one.
    throw new HttpError(409, "TOTP_ALREADY_ENABLED", "العامل الثاني مفعّل. عطّله أولاً إن أردت ربط تطبيق آخر.");
  }
  const secret = generateTotpSecret();
  await prisma.platformOwner.update({ where: { id: ownerId }, data: { totpSecret: sealSecret(PURPOSE, secret), totpLastStep: null } });
  return { secret, uri: totpEnrolmentUri(secret, owner.email) };
}

/**
 * Step two: prove the app works, and only then switch the factor on.
 *
 * Returns the recovery codes in the clear — the ONE time they are ever readable.
 * They are hashed before this function returns, so a second request cannot
 * retrieve them and neither can a database dump.
 */
export async function confirmTotpEnrolment(ownerId: string, code: unknown, now = new Date()): Promise<{ recoveryCodes: string[] }> {
  const owner = await prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { totpSecret: true, totpEnabledAt: true } });
  if (!owner?.totpSecret) throw new HttpError(409, "TOTP_NOT_STARTED", "ابدأ الربط أولاً.");
  if (owner.totpEnabledAt) throw new HttpError(409, "TOTP_ALREADY_ENABLED", "العامل الثاني مفعّل بالفعل.");

  const check = verifyTotp(openSecret(PURPOSE, owner.totpSecret), code, { now });
  if (!check.ok) throw new HttpError(422, "INVALID_TOTP_CODE", "الرمز غير صحيح. تأكد أن وقت هاتفك مضبوط تلقائياً.");

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const hashes = await Promise.all(codes.map((value) => createPasswordHash(normaliseRecoveryCode(value))));

  await prisma.$transaction(async (tx) => {
    // Any codes from an abandoned earlier enrolment go: they were minted against
    // a secret that is no longer the live one.
    await tx.platformOwnerRecoveryCode.deleteMany({ where: { platformOwnerId: ownerId } });
    await tx.platformOwnerRecoveryCode.createMany({
      data: hashes.map((codeHash) => ({ platformOwnerId: ownerId, codeHash })),
    });
    await tx.platformOwner.update({
      where: { id: ownerId },
      data: { totpEnabledAt: now, totpLastStep: BigInt(check.step!) },
    });
  });
  return { recoveryCodes: codes };
}

/**
 * Turning the factor off needs the CURRENT PASSWORD, not merely a live session.
 *
 * Otherwise a borrowed unlocked laptop removes the protection in two clicks —
 * and the second factor exists precisely for the case where someone else has
 * reached the account.
 */
export async function disableTotp(ownerId: string, password: unknown): Promise<void> {
  const owner = await prisma.platformOwner.findUnique({ where: { id: ownerId }, select: { passwordHash: true, totpEnabledAt: true } });
  if (!owner) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الحساب غير موجود.");
  if (!owner.totpEnabledAt) throw new HttpError(409, "TOTP_NOT_ENABLED", "العامل الثاني غير مفعّل.");
  // 19-د: an attempt ceiling, keyed on the owner and placed BEFORE the compare.
  // The comment above says the factor exists precisely for the case where
  // someone else has reached the account — and until this line, that someone
  // could grind the password with no ceiling and take the factor off. See
  // REAUTH_ATTEMPT_LIMIT for why ten, and why the key is the subject.
  const reverifyBucket = { scope: "password_reverify", rawKey: `platform_owner:${ownerId}` };
  await consumeStorefrontRateLimit({ ...reverifyBucket, limit: REAUTH_ATTEMPT_LIMIT, windowMs: REAUTH_WINDOW_MS });
  if (!(await verifyPassword(password, owner.passwordHash))) {
    throw new HttpError(422, "INVALID_PASSWORD", "كلمة المرور غير صحيحة.");
  }
  await refundStorefrontRateLimit(reverifyBucket);
  await prisma.$transaction(async (tx) => {
    await tx.platformOwnerRecoveryCode.deleteMany({ where: { platformOwnerId: ownerId } });
    await tx.platformOwner.update({
      where: { id: ownerId },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
    });
  });
}

export type SecondFactorOutcome = { ok: true; usedRecoveryCode: boolean } | { ok: false };

/**
 * Checks a second factor at sign-in: an app code, or a recovery code.
 *
 * The two are tried in that order and BOTH are consumed on success — the app
 * code by advancing `totpLastStep`, the recovery code by stamping `usedAt`.
 * A factor that can be replayed is a factor that only delays an attacker.
 */
export async function verifySecondFactor(ownerId: string, code: unknown, now = new Date()): Promise<SecondFactorOutcome> {
  const owner = await prisma.platformOwner.findUnique({
    where: { id: ownerId },
    select: { totpSecret: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!owner?.totpEnabledAt || !owner.totpSecret) return { ok: false };

  const check = verifyTotp(openSecret(PURPOSE, owner.totpSecret), code, {
    now,
    lastUsedStep: owner.totpLastStep === null ? null : Number(owner.totpLastStep),
  });
  if (check.ok) {
    await prisma.platformOwner.update({ where: { id: ownerId }, data: { totpLastStep: BigInt(check.step!) } });
    return { ok: true, usedRecoveryCode: false };
  }

  const attempt = normaliseRecoveryCode(code);
  if (attempt.length >= 8) {
    // Every unused code is compared, rather than looked up: a recovery code is
    // hashed with a salt, so there is nothing to index by. The list is ten rows.
    const candidates = await prisma.platformOwnerRecoveryCode.findMany({
      where: { platformOwnerId: ownerId, usedAt: null },
      select: { id: true, codeHash: true },
    });
    for (const candidate of candidates) {
      if (await verifyPassword(attempt, candidate.codeHash)) {
        await prisma.platformOwnerRecoveryCode.update({ where: { id: candidate.id }, data: { usedAt: now } });
        return { ok: true, usedRecoveryCode: true };
      }
    }
  }
  return { ok: false };
}

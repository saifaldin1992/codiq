/**
 * Password recovery — consume. Split verbatim from password-reset.service.ts (review batch 3, ت-٢);
 * password-reset.service.ts re-exports what it always exported.
 */
import type { IdentityKind } from "../../auth/redirects.js";
import { HttpError } from "../../auth/auth.errors.js";
import { consumeStorefrontRateLimit } from "../storefront.service.js";
import { prisma } from "../../db/prisma.js";
import { createPasswordHash } from "../../auth/identity.js";
import { revokeAllSessionsWithin } from "../session.service.js";
import {
  sha256,
  RESET_CONSUME_IP_LIMIT,
  RESET_CONSUME_WINDOW_MS,
  RESET_CONSUME_TOKEN_LIMIT,
  delegateNameFor,
  invalidateLiveResetTokens,
} from "./tokens.js";

export interface ResetConsumeResult {
  /** The door he signs in at next. He is NOT signed in here — see the header. */
  redirectTo: string;
  /** Sessions ended by the reset. Shown so he sees the protection happen. */
  sessionsEnded: number;
}

/** Where a recovered identity is sent to sign in. */
function loginPathFor(kind: IdentityKind, storeSlug: string | null): string {
  if (kind === "platform_owner") return "/platform/login";
  if (kind === "platform_staff") return "/platform/staff/login";
  if (kind === "merchant") return "/merchant/login";
  if (kind === "staff") return "/staff/login";
  return `/store/${encodeURIComponent(storeSlug ?? "")}/account/login`;
}

/**
 * Spend the link and set the new password.
 *
 * THE CLAIM IS A CONDITIONAL UPDATE, not a read followed by a write. Two
 * requests carrying the same token — a double-clicked button, or an attacker
 * racing the owner — would both pass a `SELECT … WHERE consumed_at IS NULL` and
 * both proceed. `updateMany … WHERE consumed_at IS NULL` returns a COUNT, and
 * exactly one of them gets 1.
 *
 * The claim, the hash and the session revoke are ONE transaction. If the hash
 * were written and the revoke then failed, he would be told his password was
 * reset while whoever stole his session stayed signed in — not a partial
 * success, but the precise failure he was recovering from, reported as success.
 */
export async function consumePasswordReset(input: {
  token: unknown;
  newPassword: unknown;
  ip: string;
  now?: Date;
}): Promise<ResetConsumeResult> {
  const now = input.now ?? new Date();
  const invalid = () =>
    new HttpError(
      422,
      "INVALID_RESET_TOKEN",
      "هذا الرابط لم يعد صالحاً. اطلب رابطاً جديداً لاستعادة كلمة السر."
    );
  if (typeof input.token !== "string" || !input.token) throw invalid();
  const tokenHash = sha256(input.token);

  // Per IP first — it is the bucket that actually holds, because the token is
  // attacker-supplied and a varied token mints a fresh per-token bucket.
  await consumeStorefrontRateLimit({
    scope: "password_reset_consume",
    rawKey: `ip:${input.ip}`,
    limit: RESET_CONSUME_IP_LIMIT,
    windowMs: RESET_CONSUME_WINDOW_MS,
  });
  // Keyed on the HASH: the raw token never reaches a rate-limit key.
  await consumeStorefrontRateLimit({
    scope: "password_reset_consume",
    rawKey: `token:${tokenHash}`,
    limit: RESET_CONSUME_TOKEN_LIMIT,
    windowMs: RESET_CONSUME_WINDOW_MS,
  });

  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      identityKind: true,
      subjectId: true,
      storeId: true,
      consumedAt: true,
      invalidatedAt: true,
      expiresAt: true,
    },
  });
  if (!row || row.consumedAt !== null || row.invalidatedAt !== null || row.expiresAt <= now)
    throw invalid();
  const kind = row.identityKind as IdentityKind;

  // Refused BEFORE the claim, so a password the policy rejects does not burn the
  // link and leave him with nothing. `createPasswordHash` throws WEAK_PASSWORD
  // on its own — the platform's single floor, applied by calling it rather than
  // by restating it here.
  const passwordHash = await createPasswordHash(input.newPassword);

  const storeSlug = row.storeId
    ? ((await prisma.store.findUnique({ where: { id: row.storeId }, select: { slug: true } }))
        ?.slug ?? null)
    : null;

  const sessionsEnded = await prisma.$transaction(async (tx) => {
    // THE CLAIM. Exactly one racing request can come away with count === 1.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) throw invalid();

    // ONLY passwordHash. Not totpSecret, not totpEnabledAt, not totpLastStep,
    // and no recovery code is spent or reissued — see the header. A reset must
    // not be a second factor bypass.
    const delegate = (
      tx as unknown as Record<string, { update: (args: unknown) => Promise<unknown> }>
    )[delegateNameFor(kind)]!;
    // A password he chose by reset is not one a provisioner knows: the «change it at first
    // sign-in» demand ends with it, as it does on a change (review batch 3, ت-١).
    const provisioned = kind === "merchant" || kind === "staff";
    await delegate.update({
      where: { id: row.subjectId },
      data: { passwordHash, ...(provisioned ? { passwordSetByProvisionerAt: null } : {}) },
    });

    // Every OTHER outstanding link for this identity dies with the one just
    // spent: an earlier mail still sitting in the inbox must not remain a way in.
    await invalidateLiveResetTokens(tx, kind, row.subjectId, "reset_consumed", now, row.id);

    // EVERY session, not «every other» — there is no current session here, he is
    // not signed in. A stolen session must not survive the recovery its owner
    // just performed; very often that theft is the reason he is recovering.
    return revokeAllSessionsWithin(tx, kind, row.subjectId, now);
  });

  return { redirectTo: loginPathFor(kind, storeSlug), sessionsEnded };
}

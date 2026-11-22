/**
 * Password recovery — tokens. Split verbatim from password-reset.service.ts (review batch 3, ت-٢);
 * password-reset.service.ts re-exports what it always exported.
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import type { IdentityKind } from "../../auth/redirects.js";
import { prisma } from "../../db/prisma.js";

export const PASSWORD_RESET_EVENT_TYPE = "auth.password_reset";

/**
 * FORTY-FIVE MINUTES, and the number is argued rather than copied.
 *
 * The window has to cover everything between «he pressed the button» and «he
 * reads his mail», and the platform's own queue owns a real slice of it: the
 * outbox worker polls every 5 s, and a transient SMTP failure retries on the
 * 30 s→60 s→120 s→240 s ladder in `outbox-worker.ts` — about 8 minutes of pure
 * machinery before a message that eventually succeeds has even left, plus
 * whatever the receiving provider adds. Thirty minutes would leave a person
 * roughly twenty, and a merchant who opens his mail on a phone between
 * customers loses that window often enough to ask support for a second link —
 * which is one more live takeover primitive in one more inbox.
 *
 * Sixty was the alternative and was refused: the cost of a longer window is
 * paid entirely by the person whose mailbox is compromised, and doubling the
 * time an intercepted link stays usable buys nothing the retry ladder needs.
 *
 * Forty-five leaves ~35 minutes of human time after the worst honest delivery
 * path, and keeps the primitive short.
 */
export const RESET_TOKEN_TTL_MS = 45 * 60 * 1000;

/**
 * THE REQUEST CEILING — two buckets, and BOTH are required.
 *
 * PER ADDRESS (5 per hour). This one bounds mailbox flooding: without it the
 * endpoint is an unauthenticated «send mail to this person from CODIQ's own
 * sending identity» button, repeatable forever, which is the deliverability
 * catastrophe PG-3 exists to prevent — reachable by a stranger who needs no
 * account at all.
 *
 * ⚠️ THE MERCHANT-LOGIN LESSON, AND WHY IT POINTS THE OTHER WAY HERE.
 * `/auth/merchant/login` had `storeSlug` in its rate-limit key, and because the
 * slug was attacker-controlled, changing one character minted a fresh bucket
 * and walked around the limit entirely. The rule that fixed it is not «never
 * key on input» — it is «never let the attacker vary the key while attacking
 * the SAME target». Here the address IS the target, so keying on it is what
 * makes the bucket bite. What matters is that the key is built from the
 * NORMALIZED address (and, for a customer, the resolved store id — never the
 * slug the caller typed), so `A@X.com `, `a@x.com` and `A@x.COM` share one
 * bucket instead of three.
 *
 * The cost, stated plainly: a stranger can burn a known address's five
 * requests and delay that person's own recovery until the hour turns. That is
 * accepted — the alternative is letting him send unlimited mail to the same
 * person — and the per-IP bucket below bites the attacker long before the
 * address bucket protects him.
 *
 * PER IP (20 per hour). This one bounds the SWEEP: without it, one host walks a
 * list of candidate addresses at whatever rate it likes. It is deliberately not
 * the only bucket, because an address bucket alone is trivially defeated by a
 * botnet and an IP bucket alone lets one host pick one victim.
 */
export const RESET_REQUEST_ADDRESS_LIMIT = 5;

export const RESET_REQUEST_IP_LIMIT = 20;

export const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;

/**
 * THE CONSUME CEILING — and this is where the merchant-login lesson bites for
 * real.
 *
 * PER TOKEN (10 per 10 minutes) is the obvious bucket and it is NOT sufficient
 * on its own: the token is entirely attacker-supplied, so a caller who varies
 * one character gets a brand-new bucket every single request. Keyed on the
 * token alone, this ceiling limits nothing but an honest person's retries.
 *
 * PER IP (30 per 10 minutes) is therefore the one doing the work. What it is
 * protecting is not the token — guessing 256 bits is not a threat model — it is
 * the CPU: every consume runs `createPasswordHash`, a cost-12 bcrypt hash of
 * roughly a quarter second of work (on the threadpool since D-36 — it used to
 * BLOCK the single-threaded event loop, which was worse, but it is CPU either
 * way). Left
 * unmetered on a public, session-less endpoint, that is a whole-platform denial
 * of service that costs the attacker one HTTP request, exactly the second
 * impact 19-د recorded for the re-authentication gates.
 *
 * The per-token bucket stays because it is the one that stops a stuck client
 * from grinding a REAL token, and it is keyed on the token's HASH — the raw
 * value never reaches a rate-limit key, a log line or an error message.
 */
export const RESET_CONSUME_TOKEN_LIMIT = 10;

export const RESET_CONSUME_IP_LIMIT = 30;

export const RESET_CONSUME_WINDOW_MS = 10 * 60 * 1000;

/** Kinds a dashboard door may ask for. The customer has his own store-scoped door. */
export type DashboardResetKind = Exclude<IdentityKind, "customer">;

/**
 * Why a reset link stopped being valid. Written to `invalidated_reason`, which
 * the migration makes mandatory whenever `invalidated_at` is set: an
 * invalidation nobody can explain is an incident nobody can read.
 */
type InvalidationReason = "superseded" | "password_changed" | "reset_consumed";

/** The same digest the session tables use for their own token hashes. */
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * 32 bytes from the CSPRNG. base64url so it survives a URL, an email client's
 * link detection and a `text` column untouched.
 */
export function mintToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Where each identity keeps its password hash — the same map the change service uses. */
export function delegateNameFor(kind: IdentityKind): string {
  if (kind === "platform_owner") return "platformOwner";
  if (kind === "merchant") return "merchant";
  if (kind === "staff") return "staff";
  if (kind === "platform_staff") return "platformStaff";
  return "customer";
}

/**
 * The one place that kills outstanding tokens, so «what invalidates a link» has
 * a single answer rather than four call sites that drift.
 *
 * Takes a writer rather than reaching for `prisma`: a password change must
 * invalidate in the SAME transaction that writes the new hash, or a crash
 * between the two leaves a live reset link for a password that just changed —
 * which is the whole point of invalidating it.
 */
export async function invalidateLiveResetTokens(
  writer: Prisma.TransactionClient | typeof prisma,
  kind: IdentityKind,
  subjectId: string,
  reason: InvalidationReason,
  now: Date,
  exceptId?: string
): Promise<number> {
  const result = await writer.passwordResetToken.updateMany({
    where: {
      identityKind: kind,
      subjectId,
      consumedAt: null,
      invalidatedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { invalidatedAt: now, invalidatedReason: reason },
  });
  return result.count;
}

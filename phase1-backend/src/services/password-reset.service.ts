/**
 * PR-1 (19-أ) — «استعادة كلمة السر»: the last open item of phase 19.
 *
 * ============================================================================
 * WHAT WAS MISSING
 * ============================================================================
 *
 * 19-أ gave every identity a way to CHANGE a password it still knows
 * (`password.service.ts`). A person who has FORGOTTEN his had nothing: the
 * platform's only recovery path was a manual UPDATE against production, run by
 * hand, with no audit and no proof that the person asking owns the account.
 * That was launch-blocking, and it was stuck only because no mail channel
 * existed. It does now.
 *
 * ============================================================================
 * A RESET LINK IS AN ACCOUNT TAKEOVER PRIMITIVE
 * ============================================================================
 *
 * Whoever holds a live link IS the account. Everything below follows from
 * treating it that way rather than as a convenience feature:
 *
 *   · only a HASH is stored — see the migration;
 *   · it lives 45 minutes (RESET_TOKEN_TTL_MS, argued there);
 *   · it is SINGLE USE, and the use is a conditional UPDATE so two racing
 *     requests cannot both win it;
 *   · issuing a new one kills every older one;
 *   · changing the password by ANY other route kills all of them;
 *   · spending one kills every OTHER outstanding one for that identity;
 *   · spending one REVOKES EVERY SESSION of that identity. A stolen session
 *     must not survive the recovery its owner just performed — that is very
 *     often the exact reason he is recovering.
 *
 * ============================================================================
 * THE SECOND FACTOR IS NOT RESET BY A PASSWORD RESET
 * ============================================================================
 *
 * The owner and every platform-staff member may hold a TOTP enrolment (ق-123,
 * ق-143). The question this feature is obliged to answer is what a reset does
 * to it, and the answer is: NOTHING, by construction rather than by promise.
 *
 *   1. `consumePasswordReset` writes exactly one column — `passwordHash`. It
 *      never touches totpSecret, totpEnabledAt, totpLastStep or the recovery
 *      codes. A «recovery» that clears the second factor is not a recovery, it
 *      is a documented 2FA bypass reachable from a mailbox.
 *
 *   2. A successful reset does NOT issue a session. He is sent back to the
 *      ordinary sign-in door and signs in there — where `loginPlatformOwner`
 *      and `loginPlatformStaff` demand the code exactly as they always do. So
 *      an attacker who owns the mailbox of an enrolled owner can set a new
 *      password and STILL cannot get in; he is missing the authenticator.
 *      This is also why not auto-signing-in is a security decision and not a
 *      UX oversight: minting a session from a mail link would hand that
 *      attacker precisely the thing the second factor exists to withhold.
 *
 *   3. The reset is NOT REFUSED for an enrolled account. Refusing would leave a
 *      person who lost his password and holds his phone with no path at all,
 *      and the refusal itself would disclose that the account is enrolled.
 *
 * The person who has lost BOTH his password and his authenticator uses his
 * recovery codes at the door, which is what they are for.
 *
 * ============================================================================
 * THE ANSWER IS THE SAME FOR AN ADDRESS THAT EXISTS AND ONE THAT DOES NOT
 * ============================================================================
 *
 * `requestPasswordReset` returns the same shape, the same status and the same
 * words either way, and it is written so it costs the same too. See the
 * comment on `constantWorkForMiss` — the platform closed a 25×–59× timing
 * oracle on its five sign-in doors this session (ABSENT_IDENTITY_HASH), and a
 * recovery door that reintroduces one hands back the same account list.
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import { createPasswordHash, normalizeEmail } from "../auth/identity.js";
import { sealSecret } from "../auth/secret-box.js";
import type { IdentityKind } from "../auth/redirects.js";
import { isEmailProviderConfigured } from "../notifications/notification-provider.js";
import { publicUrl } from "../notifications/messaging-compliance.service.js";
import { revokeAllSessionsWithin } from "./session.service.js";
import { consumeStorefrontRateLimit } from "./storefront.service.js";

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
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * 32 bytes from the CSPRNG. base64url so it survives a URL, an email client's
 * link detection and a `text` column untouched.
 */
function mintToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Where each identity keeps its password hash — the same map the change service uses. */
function delegateNameFor(kind: IdentityKind): string {
  if (kind === "platform_owner") return "platformOwner";
  if (kind === "merchant") return "merchant";
  if (kind === "staff") return "staff";
  if (kind === "platform_staff") return "platformStaff";
  return "customer";
}

interface ResolvedIdentity {
  kind: IdentityKind;
  subjectId: string;
  email: string;
  storeId: string | null;
}

/**
 * Finds the account an address names, or nothing — and the two outcomes must be
 * indistinguishable from outside.
 *
 * Every branch applies the same liveness rules the matching sign-in door
 * applies, because a reset that resurrects an account the door refuses is a way
 * in through the back:
 *
 *   · a rejected or unapproved merchant cannot sign in, so he cannot reset;
 *   · a removed platform-staff member (PG-2 soft delete, `deletedAt`) is gone —
 *     the partial unique index frees his address for re-use, so matching a
 *     removed row could hand his old account to whoever holds the address now;
 *   · an inactive account of any kind is refused.
 *
 * None of that changes what the caller is TOLD. It only changes whether a token
 * is minted.
 */
async function resolveIdentity(kind: IdentityKind, email: string, storeId: string | null): Promise<ResolvedIdentity | null> {
  const found = (subjectId: string): ResolvedIdentity => ({ kind, subjectId, email, storeId });

  if (kind === "platform_owner") {
    const row = await prisma.platformOwner.findUnique({ where: { email }, select: { id: true, isActive: true } });
    return row && row.isActive ? found(row.id) : null;
  }
  if (kind === "platform_staff") {
    // PG-2: `deleted_at` is filtered here on purpose. `platform_staff_email_
    // live_key` is a PARTIAL unique index over living rows only, so a removed
    // member's address becomes available again — matching his row would mail a
    // link for a dead account to whoever holds that address today.
    const row = await prisma.platformStaff.findFirst({ where: { email, deletedAt: null }, select: { id: true, isActive: true } });
    return row && row.isActive ? found(row.id) : null;
  }
  if (kind === "merchant") {
    const row = await prisma.merchant.findUnique({ where: { email }, select: { id: true, isActive: true, approvalStatus: true } });
    return row && row.isActive && row.approvalStatus === "approved" ? found(row.id) : null;
  }
  if (kind === "staff") {
    // ق-227: a released identity must not receive a reset link — the address may
    // be somebody else's now, and the row that remains is history, not a door.
    const row = await prisma.staff.findFirst({ where: { email, deletedAt: null }, select: { id: true, isActive: true } });
    return row && row.isActive ? found(row.id) : null;
  }
  // The customer, and the ONE identity that is scoped: `customers_store_email_
  // present_uq` is UNIQUE(store_id, email), so the same address is a different
  // person at a different shop. Resolving without the store would mail store A's
  // shopper a link into store B's account.
  const row = await prisma.customer.findFirst({ where: { storeId: storeId!, email, isActive: true }, select: { id: true } });
  return row ? found(row.id) : null;
}

/**
 * WHERE THE LINK LANDS — and getting this wrong sends store A's shopper to
 * store B's sign-in page.
 *
 * A dashboard identity has one home: the platform's own public base URL.
 *
 * A CUSTOMER does not. A storefront is reachable at three different origins —
 * the merchant's own `customDomain`, his `defaultSubdomain`, or a
 * `/store/{slug}` path on the platform domain — and a shopper who registered on
 * `شراء.com` must not be handed a link to a host he has never seen, on which he
 * has no session cookie (`codiq_customer_session_{slug}`, scoped by path) and no
 * reason to trust the form asking for his new password.
 *
 * So: the custom domain wins when the store has one, and otherwise the link is
 * the store's own path on the platform base. The SLUG is in the path either way,
 * which is the half that actually matters — the token itself is bound to one
 * customer of one store, so a link opened at the wrong origin cannot reset the
 * wrong account; the origin decides whether he RECOGNISES the page.
 *
 * `defaultSubdomain` is deliberately NOT used to build a host: the platform has
 * no configured storefront root domain to append it to, and inventing one
 * (`{sub}.codiqos.com`) would mail links to a host nobody has verified resolves.
 * The path form is always correct; a guessed host is silently broken.
 */
async function resetLinkFor(identity: ResolvedIdentity, token: string): Promise<string | null> {
  const query = `?token=${encodeURIComponent(token)}`;
  if (identity.kind !== "customer") return publicUrl(`/reset-password${query}`);

  const store = await prisma.store.findUnique({ where: { id: identity.storeId! }, select: { slug: true, customDomain: true } });
  if (!store) return null;
  const path = `/store/${encodeURIComponent(store.slug)}/account/reset-password${query}`;
  if (store.customDomain) return `https://${store.customDomain}${path}`;
  return publicUrl(path);
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
  exceptId?: string,
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

export interface ResetRequestResult {
  /**
   * What the platform can HONESTLY say happened. It never depends on whether
   * the address matched — only on whether the platform can send mail at all,
   * which is the same answer for every caller and therefore discloses nothing
   * about any account.
   */
  delivery: "queued" | "unavailable";
}

/**
 * CONSTANT WORK FOR A MISS.
 *
 * The hit branch does four things a miss does not: it hashes a token, it
 * invalidates older rows, it inserts a token row and it inserts an outbox row.
 * Left as-is that is two database round-trips of difference — not the 900 ms
 * chasm bcrypt opened on the login doors, but the same oracle in kind, and this
 * endpoint is public, unauthenticated and answers about ANY address.
 *
 * Rather than mint a decoy (which would leave junk rows in a security table) or
 * add a sleep (which is a number that has to be re-guessed on every machine),
 * the miss branch performs the SAME THREE WRITES — the invalidate, the token
 * row, the outbox row — inside a transaction that is then rolled back. Postgres
 * does the identical work, index maintenance and constraint checks and all, and
 * commits none of it.
 *
 * Two properties of the schema are what make this possible, and both are there
 * for their own reasons rather than for this one:
 *
 *   · `password_reset_tokens.subject_id` carries NO foreign key (a column
 *     cannot reference five identity tables), so a random uuid is insertable;
 *   · `notification_outbox.store_id` is nullable for exactly this event type,
 *     so the decoy mail row needs no store to point at.
 *
 * WHY NOT A CHEAPER IMITATION. The first version of this paid a `count()` over
 * the outbox instead of the third insert, and the suite measured the miss
 * branch answering 2.8× SLOWER than the hit. That is the same oracle read
 * backwards — «slow means nobody» is exactly as useful to an enumerator as
 * «fast means nobody» — which is why the suite asserts the band in BOTH
 * directions rather than only the one the login doors needed.
 */
async function constantWorkForMiss(tokenHash: string, email: string, expiresAt: Date, now: Date): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const decoySubject = crypto.randomUUID();
      await invalidateLiveResetTokens(tx, "merchant", decoySubject, "superseded", now);
      await tx.passwordResetToken.create({
        data: { identityKind: "merchant", subjectId: decoySubject, storeId: null, tokenHash, emailNormalized: email, expiresAt },
      });
      await tx.notificationOutbox.create({
        data: {
          storeId: null,
          eventType: PASSWORD_RESET_EVENT_TYPE,
          recipientKind: "account",
          channel: "email",
          recipient: email,
          payload: { resetUrlSealed: sealSecret("password-reset-link", "https://example.invalid/reset-password"), expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000) },
        },
      });
      // Nothing here is meant to survive. Throwing is how a Prisma interactive
      // transaction rolls back — and it is the ONLY exit from this block, so a
      // decoy row can never be committed by a later edit that forgets to.
      throw new RollbackTheDecoy();
    });
  } catch (error) {
    if (error instanceof RollbackTheDecoy) return;
    throw error;
  }
}

class RollbackTheDecoy extends Error {}

/**
 * Ask for a link.
 *
 * ALWAYS answers the same thing. The only variation is `delivery`, and it is a
 * property of the PLATFORM (is a mail provider configured, is a public base URL
 * configured) rather than of the account, so it is identical for every caller
 * and tells an attacker nothing he could not learn by asking about his own
 * address.
 *
 * HONEST DEGRADATION. With no provider — the state of production until
 * `CODIQ_SMTP_PASS` is pasted — nothing is minted and nothing is queued, and the
 * caller is told the channel is down. Queueing anyway would leave the outbox
 * marking rows `skipped/no_provider_configured` while the screen said «check
 * your inbox», which is the invented promise ق-10 forbids; and minting a token
 * nobody can receive is pure attack surface with no recipient.
 */
export async function requestPasswordReset(input: {
  kind: IdentityKind;
  email: unknown;
  storeId?: string | null;
  ip: string;
  now?: Date;
}): Promise<ResetRequestResult> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  const storeId = input.storeId ?? null;

  // Both ceilings, before any lookup. The address key is built from the
  // NORMALIZED address and the RESOLVED store id — never from anything the
  // caller typed verbatim, which is what made the old merchant-login key
  // bypassable one character at a time.
  await consumeStorefrontRateLimit({
    scope: "password_reset_request",
    rawKey: `ip:${input.ip}`,
    limit: RESET_REQUEST_IP_LIMIT,
    windowMs: RESET_REQUEST_WINDOW_MS,
  });
  await consumeStorefrontRateLimit({
    scope: "password_reset_request",
    rawKey: `${input.kind}:${storeId ?? "-"}:${email}`,
    limit: RESET_REQUEST_ADDRESS_LIMIT,
    windowMs: RESET_REQUEST_WINDOW_MS,
  });

  // Checked BEFORE the identity lookup so the answer costs the same whether or
  // not the address exists — and so a platform with no channel does no work at
  // all rather than minting takeover primitives into a void.
  if (!isEmailProviderConfigured()) return { delivery: "unavailable" };

  const identity = await resolveIdentity(input.kind, email, storeId);
  const token = mintToken();
  const tokenHash = sha256(token);
  const expiresAt = new Date(now.valueOf() + RESET_TOKEN_TTL_MS);

  if (!identity) {
    await constantWorkForMiss(tokenHash, email, expiresAt, now);
    return { delivery: "queued" };
  }

  const link = await resetLinkFor(identity, token);
  if (!link) {
    // No public base URL and no custom domain means no working link, and a
    // recovery mail without one is a dead letter. Terminal and honest — the same
    // call PG-3 makes for a marketing message with no unsubscribe link, except
    // that here it is made BEFORE anything is written rather than after.
    return { delivery: "unavailable" };
  }

  await prisma.$transaction(async (tx) => {
    // Issuing supersedes. A person who presses the button twice must not be left
    // holding two live takeover primitives, and the older mail is the one more
    // likely to have been intercepted.
    await invalidateLiveResetTokens(tx, identity.kind, identity.subjectId, "superseded", now);
    await tx.passwordResetToken.create({
      data: {
        identityKind: identity.kind,
        subjectId: identity.subjectId,
        storeId: identity.kind === "customer" ? identity.storeId : null,
        tokenHash,
        emailNormalized: email,
        expiresAt,
      },
    });
    await tx.notificationOutbox.create({
      data: {
        // NULL for every identity — see the migration. A security mail must not
        // be deferred to tomorrow by a store's daily cap.
        storeId: null,
        eventType: PASSWORD_RESET_EVENT_TYPE,
        recipientKind: "account",
        channel: "email",
        recipient: email,
        payload: {
          // SEALED, not the link. `password_reset_tokens` deliberately keeps only
          // a hash; a plaintext link in this jsonb column would put the exact
          // value that table refuses to store back into the same database for
          // every reset ever requested. The worker opens it at send time.
          resetUrlSealed: sealSecret("password-reset-link", link),
          expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
        },
      },
    });
  });

  return { delivery: "queued" };
}

/** Is this link still worth showing a form for? Nothing is spent by asking. */
export async function inspectPasswordReset(token: unknown, now = new Date()): Promise<{ valid: boolean }> {
  if (typeof token !== "string" || !token) return { valid: false };
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
    select: { consumedAt: true, invalidatedAt: true, expiresAt: true },
  });
  return { valid: row !== null && row.consumedAt === null && row.invalidatedAt === null && row.expiresAt > now };
}

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
  const invalid = () => new HttpError(422, "INVALID_RESET_TOKEN", "هذا الرابط لم يعد صالحاً. اطلب رابطاً جديداً لاستعادة كلمة السر.");
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
    select: { id: true, identityKind: true, subjectId: true, storeId: true, consumedAt: true, invalidatedAt: true, expiresAt: true },
  });
  if (!row || row.consumedAt !== null || row.invalidatedAt !== null || row.expiresAt <= now) throw invalid();
  const kind = row.identityKind as IdentityKind;

  // Refused BEFORE the claim, so a password the policy rejects does not burn the
  // link and leave him with nothing. `createPasswordHash` throws WEAK_PASSWORD
  // on its own — the platform's single floor, applied by calling it rather than
  // by restating it here.
  const passwordHash = await createPasswordHash(input.newPassword);

  const storeSlug = row.storeId
    ? (await prisma.store.findUnique({ where: { id: row.storeId }, select: { slug: true } }))?.slug ?? null
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
    const delegate = (tx as unknown as Record<string, { update: (args: unknown) => Promise<unknown> }>)[delegateNameFor(kind)]!;
    await delegate.update({ where: { id: row.subjectId }, data: { passwordHash } });

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

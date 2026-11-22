/**
 * Password recovery — request. Split verbatim from password-reset.service.ts (review batch 3, ت-٢);
 * password-reset.service.ts re-exports what it always exported.
 */
import crypto from "node:crypto";
import type { IdentityKind } from "../../auth/redirects.js";
import { prisma } from "../../db/prisma.js";
import { publicUrl } from "../../notifications/messaging-compliance.service.js";
import { sealSecret } from "../../auth/secret-box.js";
import { normalizeEmail } from "../../auth/identity.js";
import { consumeStorefrontRateLimit } from "../storefront.service.js";
import { isEmailProviderConfigured } from "../../notifications/notification-provider.js";
import {
  invalidateLiveResetTokens,
  PASSWORD_RESET_EVENT_TYPE,
  RESET_TOKEN_TTL_MS,
  RESET_REQUEST_IP_LIMIT,
  RESET_REQUEST_WINDOW_MS,
  RESET_REQUEST_ADDRESS_LIMIT,
  mintToken,
  sha256,
} from "./tokens.js";

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
async function resolveIdentity(
  kind: IdentityKind,
  email: string,
  storeId: string | null
): Promise<ResolvedIdentity | null> {
  const found = (subjectId: string): ResolvedIdentity => ({ kind, subjectId, email, storeId });

  if (kind === "platform_owner") {
    const row = await prisma.platformOwner.findUnique({
      where: { email },
      select: { id: true, isActive: true },
    });
    return row && row.isActive ? found(row.id) : null;
  }
  if (kind === "platform_staff") {
    // PG-2: `deleted_at` is filtered here on purpose. `platform_staff_email_
    // live_key` is a PARTIAL unique index over living rows only, so a removed
    // member's address becomes available again — matching his row would mail a
    // link for a dead account to whoever holds that address today.
    const row = await prisma.platformStaff.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, isActive: true },
    });
    return row && row.isActive ? found(row.id) : null;
  }
  if (kind === "merchant") {
    const row = await prisma.merchant.findUnique({
      where: { email },
      select: { id: true, isActive: true, approvalStatus: true },
    });
    return row && row.isActive && row.approvalStatus === "approved" ? found(row.id) : null;
  }
  if (kind === "staff") {
    // ق-227: a released identity must not receive a reset link — the address may
    // be somebody else's now, and the row that remains is history, not a door.
    const row = await prisma.staff.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, isActive: true },
    });
    return row && row.isActive ? found(row.id) : null;
  }
  // The customer, and the ONE identity that is scoped: `customers_store_email_
  // present_uq` is UNIQUE(store_id, email), so the same address is a different
  // person at a different shop. Resolving without the store would mail store A's
  // shopper a link into store B's account.
  const row = await prisma.customer.findFirst({
    where: { storeId: storeId!, email, isActive: true },
    select: { id: true },
  });
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

  const store = await prisma.store.findUnique({
    where: { id: identity.storeId! },
    select: { slug: true, customDomain: true },
  });
  if (!store) return null;
  const path = `/store/${encodeURIComponent(store.slug)}/account/reset-password${query}`;
  if (store.customDomain) return `https://${store.customDomain}${path}`;
  return publicUrl(path);
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
async function constantWorkForMiss(
  tokenHash: string,
  email: string,
  expiresAt: Date,
  now: Date
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const decoySubject = crypto.randomUUID();
      await invalidateLiveResetTokens(tx, "merchant", decoySubject, "superseded", now);
      await tx.passwordResetToken.create({
        data: {
          identityKind: "merchant",
          subjectId: decoySubject,
          storeId: null,
          tokenHash,
          emailNormalized: email,
          expiresAt,
        },
      });
      await tx.notificationOutbox.create({
        data: {
          storeId: null,
          eventType: PASSWORD_RESET_EVENT_TYPE,
          recipientKind: "account",
          channel: "email",
          recipient: email,
          payload: {
            resetUrlSealed: sealSecret(
              "password-reset-link",
              "https://example.invalid/reset-password"
            ),
            expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
          },
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
export async function inspectPasswordReset(
  token: unknown,
  now = new Date()
): Promise<{ valid: boolean }> {
  if (typeof token !== "string" || !token) return { valid: false };
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
    select: { consumedAt: true, invalidatedAt: true, expiresAt: true },
  });
  return {
    valid:
      row !== null && row.consumedAt === null && row.invalidatedAt === null && row.expiresAt > now,
  };
}

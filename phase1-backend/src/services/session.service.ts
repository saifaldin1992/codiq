/**
 * Phase 19-أ — logout, and the list of what is signed in as you.
 *
 * `revokedAt` has been on all four session tables since phase 1 and
 * `verifyTypedSession` has always honoured it, so ending a session has always
 * WORKED — there was simply no way to ask for it. An owner, a merchant and a
 * staff member could sign in and never sign out. This file is the missing verb.
 *
 * FOUR TABLES, ONE SHAPE. Each identity keeps its own session table, which is
 * what makes a customer's session structurally incapable of being a merchant's.
 * That separation is worth keeping, so this file maps over the four rather than
 * merging them — the delegate below is the only place that knows there are four,
 * and every operation goes through it.
 *
 * WHAT A LIST IS FOR. A person reads his sessions to answer one question: is
 * anything here not me? So each row carries the browser it was opened from, when
 * it was last used, and — most importantly — whether it is THIS one. A list in
 * which you cannot find yourself is a list you cannot act on, because ending the
 * wrong row logs you out and teaches you not to try again.
 */
import type { Request } from "express";
import { HttpError } from "../auth/auth.errors.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import type { SessionClaims } from "../auth/identity.js";
import type { IdentityKind } from "../auth/redirects.js";

/** A header is client-controlled; the column caps at 300 and so does this. */
export function userAgentOf(request: Request): string | null {
  const raw = request.header("user-agent");
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().slice(0, 300);
}

export interface SessionView {
  id: string;
  device: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  /** True for the session making this request. The row he must not end by accident. */
  current: boolean;
}

/**
 * The one place that knows there are four session tables. Everything else asks
 * this for "the table for this identity" and stops caring.
 */
function tableFor(kind: IdentityKind) {
  // `name` is the same delegate reached through a transaction client, which
  // cannot carry `prisma.x` across. It is returned from HERE rather than from a
  // second lookup so this really does stay the only place that knows there are
  // four tables — a second switch would drift the moment a fifth identity exists.
  if (kind === "platform_owner") return { model: prisma.platformOwnerSession, owner: "platformOwnerId" as const, name: "platformOwnerSession" as const };
  if (kind === "merchant") return { model: prisma.merchantSession, owner: "merchantId" as const, name: "merchantSession" as const };
  if (kind === "staff") return { model: prisma.staffSession, owner: "staffId" as const, name: "staffSession" as const };
  // 19-ب: the fifth identity, explicit — the customer fallback below must
  // never silently absorb a platform-staff session.
  if (kind === "platform_staff") return { model: prisma.platformStaffSession, owner: "platformStaffId" as const, name: "platformStaffSession" as const };
  // Marketplace M4: the sixth identity, explicit for the same reason.
  if (kind === "shopper") return { model: prisma.shopperSession, owner: "shopperId" as const, name: "shopperSession" as const };
  return { model: prisma.customerSession, owner: "customerId" as const, name: "customerSession" as const };
}

/** Live means: not revoked, and not expired. Both, because either alone lies. */
function liveWhere(claims: SessionClaims, now: Date) {
  const { owner } = tableFor(claims.identityKind);
  return { [owner]: claims.subjectId, revokedAt: null, expiresAt: { gt: now } } as Record<string, unknown>;
}

export async function listSessions(claims: SessionClaims, now = new Date()): Promise<{ sessions: SessionView[] }> {
  const { model } = tableFor(claims.identityKind);
  const rows = await (model as { findMany: (args: unknown) => Promise<Array<{ id: string; userAgent: string | null; createdAt: Date; lastSeenAt: Date | null; expiresAt: Date }>> }).findMany({
    where: liveWhere(claims, now),
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    take: 50,
    select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  return {
    sessions: rows.map((row) => ({
      id: row.id,
      device: row.userAgent,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      current: row.id === claims.sessionId,
    })),
  };
}

/** Ends the session making the request. Idempotent: signing out twice is fine. */
export async function endCurrentSession(claims: SessionClaims, now = new Date()): Promise<void> {
  const { model, owner } = tableFor(claims.identityKind);
  await (model as { updateMany: (args: unknown) => Promise<{ count: number }> }).updateMany({
    // Scoped to the SUBJECT as well as the id: a token cannot end a session that
    // is not its own even if the id were somehow guessed.
    where: { id: claims.sessionId, [owner]: claims.subjectId, revokedAt: null },
    data: { revokedAt: now },
  });
}

/**
 * Ends one OTHER session by id — the "that isn't me" button.
 *
 * Refuses the current one on purpose. Ending your own session from a device list
 * looks like a bug to the person doing it: the page he is reading logs itself
 * out mid-click. Signing out is a different, clearly-labelled action.
 */
export async function revokeSession(claims: SessionClaims, sessionId: string, now = new Date()): Promise<void> {
  if (sessionId === claims.sessionId) {
    throw new HttpError(422, "CANNOT_REVOKE_CURRENT_SESSION", "هذه جلستك الحالية. استخدم «تسجيل الخروج» لإنهائها.");
  }
  const { model, owner } = tableFor(claims.identityKind);
  const result = await (model as { updateMany: (args: unknown) => Promise<{ count: number }> }).updateMany({
    where: { id: sessionId, [owner]: claims.subjectId, revokedAt: null },
    data: { revokedAt: now },
  });
  // 404 rather than 403 for a session belonging to someone else: this endpoint
  // must not confirm that a given session id exists.
  if (result.count === 0) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الجلسة غير موجودة.");
}

/**
 * Ends every OTHER session — what a person reaches for when he suspects
 * something, and the reason it keeps the current one alive: he needs to still be
 * signed in to change his password immediately afterwards.
 */
export async function revokeOtherSessions(claims: SessionClaims, now = new Date()): Promise<{ revoked: number }> {
  const { model, owner } = tableFor(claims.identityKind);
  const result = await (model as { updateMany: (args: unknown) => Promise<{ count: number }> }).updateMany({
    where: { [owner]: claims.subjectId, revokedAt: null, id: { not: claims.sessionId } },
    data: { revokedAt: now },
  });
  return { revoked: result.count };
}

/**
 * The same thing, inside a caller's transaction.
 *
 * Exists so a password change can revoke and re-hash ATOMICALLY. If the hash
 * were written and the revoke then failed, the person would be told his password
 * changed while whoever else was signed in stayed signed in — the precise
 * outcome he changed it to prevent, reported to him as success.
 *
 * `tableFor` stays private: this file remains the only one that knows there are
 * four session tables, which is why the password service asks for this rather
 * than reaching for the tables itself.
 */
export async function revokeOtherSessionsWithin(
  tx: Prisma.TransactionClient,
  claims: SessionClaims,
  now: Date,
): Promise<number> {
  const { owner, name } = tableFor(claims.identityKind);
  const model = (tx as unknown as Record<string, { updateMany: (args: unknown) => Promise<{ count: number }> }>)[name]!;
  const result = await model.updateMany({
    where: { [owner]: claims.subjectId, revokedAt: null, id: { not: claims.sessionId } },
    data: { revokedAt: now },
  });
  return result.count;
}

/**
 * PR-1 — ends EVERY session of an identity, inside a caller's transaction.
 *
 * Deliberately not `revokeOtherSessionsWithin` with a null exception: this is a
 * different act with a different justification. That one keeps the caller's own
 * session because he is holding the device and just proved he knows the
 * password. A password RESET has no current session at all — the person is not
 * signed in — and the sessions that exist are exactly the ones that might not be
 * his. A stolen session must not survive the recovery its owner performed to
 * end it.
 *
 * Takes the identity as a pair rather than `SessionClaims` for the same reason:
 * there are no claims here, because nobody is authenticated.
 *
 * `tableFor` stays private, so this file remains the only one that knows there
 * are five session tables.
 */
export async function revokeAllSessionsWithin(
  tx: Prisma.TransactionClient,
  kind: IdentityKind,
  subjectId: string,
  now: Date,
): Promise<number> {
  const { owner, name } = tableFor(kind);
  const model = (tx as unknown as Record<string, { updateMany: (args: unknown) => Promise<{ count: number }> }>)[name]!;
  const result = await model.updateMany({
    where: { [owner]: subjectId, revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count;
}

/**
 * Stamps `lastSeenAt`, best-effort.
 *
 * NOT awaited by the request that triggers it and never allowed to fail one: a
 * session list is a convenience, and no read should break because a bookkeeping
 * write did. Written at most once a minute per session, because stamping on
 * every request would put a write behind every authenticated GET in the
 * platform.
 */
const TOUCH_INTERVAL_MS = 60_000;

export function touchSession(claims: SessionClaims, request: Request, now = new Date()): void {
  const { model, owner } = tableFor(claims.identityKind);
  void (model as { updateMany: (args: unknown) => Promise<unknown> })
    .updateMany({
      where: {
        id: claims.sessionId,
        [owner]: claims.subjectId,
        revokedAt: null,
        OR: [
          { lastSeenAt: null },
          { lastSeenAt: { lt: new Date(now.valueOf() - TOUCH_INTERVAL_MS) } },
          // A session with no device recorded is written IMMEDIATELY, outside
          // the throttle. `createTypedSession` stamps `lastSeenAt` at birth, so
          // without this the throttle suppresses the first touch and the device
          // stays unknown for a minute — which is exactly the minute after
          // signing in, when a person is most likely to look at the list.
          { userAgent: null },
        ],
      },
      data: { lastSeenAt: now, userAgent: userAgentOf(request) },
    })
    .catch(() => { /* deliberately silent — see the note above */ });
}

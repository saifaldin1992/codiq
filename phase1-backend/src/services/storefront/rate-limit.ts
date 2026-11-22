/**
 * Storefront — rate-limit. Split verbatim from storefront.service.ts (review batch 2, ت-٣);
 * storefront.service.ts re-exports what it always exported.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { HttpError } from "../../auth/auth.errors.js";
import { hash } from "./shared.js";

/**
 * Refunds one attempt to a bucket, down to a floor of ONE — the table carries a
 * CHECK that the count stays >= 1, which the database enforced the first time
 * this ran. That floor is harmless: thirty successful sign-ins leave the bucket
 * at 1 instead of 30, which is the whole point.
 *
 * Used when the guarded action SUCCEEDED: a budget meant to slow guessing must
 * not be spent by people who guessed right.
 * Without this, one shared address — the ordinary case on Iraqi mobile networks
 * and in a shopping centre — locks out an honest merchant after thirty of his
 * neighbours sign in correctly.
 */
export async function refundStorefrontRateLimit(input: { scope: string; rawKey: string }) {
  const keyHash = hash(input.rawKey);
  await prisma.$executeRaw`
    UPDATE storefront_rate_limits SET attempt_count = GREATEST(attempt_count - 1, 1), updated_at = NOW()
    WHERE scope = ${input.scope} AND key_hash = ${keyHash}`;
}

/**
 * 19-د (ATTACK-SURFACE) — the ceiling on the two «prove you know the current
 * password» gates: `POST /auth/password` and `POST /platform/security/totp/disable`.
 *
 * Both re-verify a password and NEITHER had any ceiling at all: 60 consecutive
 * wrong guesses on a live session returned zero 429s. That voids the platform's
 * own written safety argument for its 8-character floor — password-policy.ts
 * says guessing «is bounded by the rate limit already on every login route» —
 * on precisely the two routes that re-verify a password and are not login
 * routes. And the second gate removes the owner's TOTP, the compensating
 * control that same note names as the reason the floor is acceptable for him.
 *
 * KEYED ON THE SUBJECT, NOT THE ADDRESS. The attacker in both cases already
 * HOLDS the victim's session — a borrowed unlocked laptop, a lifted token — so
 * an IP-keyed bucket throttles the wrong thing entirely.
 *
 * TEN, WITH A REFUND ON SUCCESS. The consume/refund pair `/auth/merchant/login`
 * uses: a person who types his own password correctly never spends budget, so
 * ten is generous for the honest case and ruinous for a grinder. It also caps
 * the second impact the finding carried — unmetered cost-12 bcrypt is a
 * CPU-exhaustion DoS against every tenant at once, reachable from any one
 * session of any identity kind. (Until D-36 it also BLOCKED the event loop;
 * now it burns the threadpool. The limiter is the answer in both worlds.)
 */
export const REAUTH_ATTEMPT_LIMIT = 10;

export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export async function consumeStorefrontRateLimit(input: {
  scope: string;
  rawKey: string;
  limit: number;
  windowMs: number;
}) {
  const keyHash = hash(input.rawKey);
  const rows = await prisma.$queryRaw<Array<{ attempt_count: number }>>(Prisma.sql`
    INSERT INTO storefront_rate_limits (scope, key_hash, window_started_at, attempt_count, updated_at)
    VALUES (${input.scope}, ${keyHash}, NOW(), 1, NOW())
    ON CONFLICT (scope, key_hash) DO UPDATE
    SET window_started_at = CASE
          WHEN storefront_rate_limits.window_started_at <= NOW() - (${input.windowMs} * INTERVAL '1 millisecond') THEN NOW()
          ELSE storefront_rate_limits.window_started_at
        END,
        attempt_count = CASE
          WHEN storefront_rate_limits.window_started_at <= NOW() - (${input.windowMs} * INTERVAL '1 millisecond') THEN 1
          ELSE storefront_rate_limits.attempt_count + 1
        END,
        updated_at = NOW()
    RETURNING attempt_count
  `);
  if ((rows[0]?.attempt_count ?? input.limit + 1) > input.limit)
    throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please try again later.");
}

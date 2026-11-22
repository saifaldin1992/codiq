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
/**
 * Password recovery — split by job into ./password-reset/*.ts (review batch 3, ت-٢).
 * This file re-exports exactly what it exported before, so no importer changes.
 */
export {
  PASSWORD_RESET_EVENT_TYPE,
  RESET_TOKEN_TTL_MS,
  RESET_REQUEST_ADDRESS_LIMIT,
  RESET_REQUEST_IP_LIMIT,
  RESET_REQUEST_WINDOW_MS,
  RESET_CONSUME_TOKEN_LIMIT,
  RESET_CONSUME_IP_LIMIT,
  RESET_CONSUME_WINDOW_MS,
  invalidateLiveResetTokens,
} from "./password-reset/tokens.js";
export type { DashboardResetKind } from "./password-reset/tokens.js";
export { requestPasswordReset, inspectPasswordReset } from "./password-reset/request.js";
export type { ResetRequestResult } from "./password-reset/request.js";
export { consumePasswordReset } from "./password-reset/consume.js";
export type { ResetConsumeResult } from "./password-reset/consume.js";

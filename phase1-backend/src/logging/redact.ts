/**
 * D-41 (phase 24-أ) — WHAT MUST NEVER REACH A LOG LINE.
 * ---------------------------------------------------------------------------
 * A log line leaves the process. On Railway it is ingested, retained, and
 * readable by anyone with project access — including people who are not
 * permitted to read a single row of the database it describes. So the rule is
 * not «be careful what you pass»; the rule is that the LOGGER refuses to emit
 * these, whatever a caller hands it. Every item below is enforced by
 * `scrubValue` / `redactKey` in this file and asserted by
 * `tests/logging.guard.mjs`. Add to the list here, not at a call site.
 *
 *  1. Passwords, passphrases and their hashes — in any key spelling.
 *  2. Session tokens and JWTs of every identity kind, `Authorization` headers,
 *     bearer values, and raw `Cookie` / `Set-Cookie` strings. A session token
 *     in a log line IS the account: it is a bearer credential with an eight
 *     hour life and no second factor behind it.
 *  3. TOTP secrets, TOTP codes and recovery codes. The secret is the second
 *     factor; a code is one live use of it.
 *  4. `CODIQ_ENCRYPTION_KEY`, `SESSION_JWT_SECRET`, their `_PREVIOUS` twins,
 *     and ANY sealed envelope produced by `auth/secret-box.ts` (`codiq1.…`).
 *     A sealed value is not plaintext, but logging ciphertext beside its key id
 *     hands an attacker a corpus to work on and tells him which key sealed it.
 *  5. Full phone numbers and full email addresses. These are the customer's
 *     identity in a cash-on-delivery country where the phone IS the account.
 *     They are MASKED, not dropped: a phone keeps its last four digits — the
 *     same `••••1234` shape the merchant command palette shows (owner decision
 *     2, PG-6) and produced by the SAME function, `maskPhoneToLastFour` below,
 *     which `services/merchant-search.service.ts` now re-exports rather than
 *     owning a second copy of. An email keeps its domain and nothing else.
 *  6. R2 / S3 object keys. A key is not a name, it is an address: paired with
 *     the bucket it is what a presigned URL is minted from. Where a failure
 *     genuinely needs to be correlated across passes, log `fingerprint(key)` —
 *     eight hex characters of a salted digest, stable within the process and
 *     worthless outside it.
 *  7. Query strings. `?q=…` on the palette search is very often a customer's
 *     phone number (see `phoneNeedle`), and a reset link carries its token in
 *     the path. The request logger records the ROUTE PATTERN — `/orders/:id` —
 *     never the resolved URL.
 *  8. Request and response BODIES, whole. There is no allowlist that survives a
 *     new route; the fields worth having (ids, codes, counts) are passed
 *     explicitly.
 *
 * Nothing here is a substitute for not passing the value. It is the floor under
 * the mistake.
 */

import { createHash, randomBytes } from "node:crypto";

/** Shared with the merchant command palette; see item 5 above. */
export const PHONE_MASK_DIGITS = 4;

/**
 * Owner decision 2 (PG-6): the last four digits and nothing else. Four digits
 * is what a merchant needs to recognise the courier's caller ID.
 *
 * This is the ONE implementation on the platform. `merchant-search.service.ts`
 * re-exports it: a second copy would drift silently, and drift here means a
 * full phone number on stdout.
 */
export function maskPhoneToLastFour(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length <= PHONE_MASK_DIGITS) return digits || null;
  return `••••${digits.slice(-PHONE_MASK_DIGITS)}`;
}

/** The domain survives (a whole-domain bounce is an operational fact); the person does not. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `•••${value.slice(at)}`;
}

/**
 * A stable, non-reversible short handle for a value that must never be logged
 * in full — today only R2 object keys. Salted with a per-process random so it
 * cannot be matched against a precomputed table of known keys, which also means
 * it correlates only WITHIN one process lifetime. That is exactly the scope it
 * is for: «the same object failed to delete on five consecutive passes».
 */
const FINGERPRINT_SALT = randomBytes(16);
export function fingerprint(value: string): string {
  return createHash("sha256").update(FINGERPRINT_SALT).update(value).digest("hex").slice(0, 8);
}

/**
 * Context keys whose VALUE is never emitted, whatever it holds.
 *
 * Substring matching, deliberately: `passwordHash`, `hashedPassword` and
 * `password_hash` are all one rule. Over-redaction is a cosmetic loss; under-
 * redaction is a credential on stdout.
 *
 * `session` is NOT in the list and must not be added: `sessionId` is a database
 * row id, it is not the token, and it is half of what makes «this device, this
 * request» answerable. The token itself is caught by `token`/`cookie`/`authoriz`.
 */
const REDACT_KEY =
  /pass|secret|token|jwt|bearer|authoriz|cookie|totp|otp|mfa|recovery|credential|apikey|api_key|encryption|signature|objectkey|object_key|presign|privatekey|salt|hash/i;

export function redactKey(key: string): boolean {
  return REDACT_KEY.test(key);
}

/** A JWT — any of the five identity kinds, and any reset or verification token shaped like one. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
/** A sealed envelope from `auth/secret-box.ts`: `codiq1.<keyId>.<iv>.<tag>.<ciphertext>`. */
const SEALED = /\bcodiq1(?:\.[A-Za-z0-9_-]+){4}/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * Phone shapes ONLY — not «any long run of digits».
 *
 * An E.164 number always carries its `+`, and the Iraqi local form always
 * starts `07`. Matching bare digit runs instead would mangle an IQD total
 * (`12500000`) and an order number into `••••` and make money paths unreadable,
 * which is the opposite of the point of this phase.
 */
const PHONE = /(?:\+[1-9][0-9]{7,14}|\b07[0-9]{8,9}\b)/g;

/**
 * Free-text scrubbing: applied to every string the logger emits — messages,
 * error messages, stacks and context values alike — because the sensitive thing
 * is very often INSIDE a sentence the caller did not write ("duplicate key
 * value … (email)=(taif@example.com)" comes from Postgres, not from us).
 */
export function scrubText(value: string): string {
  return value
    .replace(JWT, "[redacted:jwt]")
    .replace(SEALED, "[redacted:sealed]")
    .replace(BEARER, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(EMAIL, (match) => maskEmail(match))
    .replace(PHONE, (match) => maskPhoneToLastFour(match) ?? "••••");
}

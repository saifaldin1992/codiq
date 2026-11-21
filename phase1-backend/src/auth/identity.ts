// D-36 (ق-244): the NATIVE bcrypt. `bcryptjs` ran the same algorithm in pure
// JavaScript, on the event loop — a cost-12 compare was ~300 ms during which
// this one process served nobody. The native build hashes on libuv's
// threadpool: same `$2b$` format, same cost, and the loop keeps turning. The
// package ships prebuilt binaries (linux-x64 glibc/musl, win32, darwin) that
// `node-gyp-build` picks at runtime, so nothing compiles on Railway and no
// install script needs approving under pnpm 10. `password-hash.unit.mjs` pins a
// hash minted by bcryptjs on the day of the swap: every stored password must
// still open.
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { prisma } from "../db/prisma.js";
import { HttpError } from "./auth.errors.js";
import { assertPasswordAcceptable } from "./password-policy.js";
import { IDENTITY_LABELS, identityBoundaryMessage } from "./redirects.js";
import { buildKeys } from "./keys.js";
import { setLogContext } from "../logging/context.js";

/** Derived ONCE per process: the root secret cannot change while it lives. */
const KEYS = buildKeys(config.sessionJwtSecret, config.sessionJwtSecretPrevious);
import type { IdentityKind } from "./redirects.js";
import { logger } from "../logging/logger.js";

export interface SessionClaims {
  identityKind: IdentityKind;
  subjectId: string;
  sessionId: string;
  storeId?: string;
  membershipId?: string;
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_EMAIL", "Email is required.");
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "INVALID_EMAIL", "Email format is invalid.");
  }
  return email;
}

export function normalizeOptionalEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return normalizeEmail(value);
}

/**
 * ق-160 — the shopper's number, in the shape a shopper actually types.
 *
 * This used to demand E.164 and refuse the local `07…` form, and it said so in
 * English: «Phone must use E.164 format.» Meanwhile the storefront's own signup
 * field carries the placeholder `07XXXXXXXXX` and sends what was typed
 * verbatim (`CustomerAuthPage.tsx`). So the form asked an Iraqi for the number
 * he writes on paper, and the server refused it — at the FIRST gate a shopper
 * ever meets, on an Arabic-first platform, in English.
 *
 * It was found by driving the commercial path against a live deployment. No
 * suite could see it: every test wrote E.164 because the function demanded it,
 * so the tests and the code agreed with each other and disagreed with the form.
 *
 * WIDENING IS STRICTLY ADDITIVE, which is what makes it safe to do here. The
 * comment on `normalizeIraqiMobile` was right to be careful — this helper backs
 * customer registration, customer sign-in AND every shipping address — but the
 * three move together and none of them loses anything:
 *
 *   · registration: `0770…` now stores the same `+9647…` E.164 it always stored;
 *   · sign-in: an input that used to be REFUSED now resolves to the row it was
 *     always going to match — nobody who could sign in before cannot now;
 *   · addresses: the stored value is unchanged in shape.
 *
 * Every input that used to succeed still normalises identically. Only the
 * refusals change, and they change to acceptance.
 */
export function normalizePhone(value: unknown): string {
  // BOTH refusals name the accepted shapes. A person reading either one is
  // looking at a field the form just rejected, and «مطلوب» alone answers «what
  // is wrong» without answering «what do I type».
  const SHAPES = "بصيغة 07XXXXXXXXX أو \u200E+9647XXXXXXXXX";
  if (typeof value !== "string") throw new HttpError(400, "INVALID_PHONE", `رقم الهاتف مطلوب — ${SHAPES}.`);
  const normalized = toE164(value);
  if (!normalized) throw new HttpError(400, "INVALID_PHONE", `اكتب رقم هاتفك ${SHAPES}.`);
  return normalized;
}

/**
 * The permissive core: any shape an Iraqi actually types, turned into E.164, or
 * `null` when it cannot be. It NEVER throws — the callers decide what a failure
 * means, and for one of them (public order tracking) the answer must stay a
 * generic miss rather than a distinguishable format error.
 *
 * `07…` is mapped to `+9647…` because that is the form people write on paper,
 * on shop signs and into forms; refusing it teaches nothing and loses the person.
 *
 * This was living privately inside `order-tracking.service.ts`, where a second
 * caller could not see it. Lifting it here is ق-06 applied to a function rather
 * than to a component: written once, used, never copied a third time.
 */
export function toE164(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[\s().-]/g, "");
  const withCountry = /^07[0-9]{8,9}$/.test(compact) ? `+964${compact.slice(1)}` : compact;
  const normalized = withCountry.startsWith("00") ? `+${withCountry.slice(2)}` : withCountry;
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

/** `+964` followed by 7 and nine digits — an Iraqi mobile and nothing else. */
export const IRAQI_MOBILE_E164 = /^\+9647[0-9]{9}$/;

/**
 * P27-12 — the merchant's own contact number, which becomes his sign-in identity
 * in P27-21 and therefore has to be exact.
 *
 * Deliberately NOT `normalizePhone`, and the reason CHANGED in ق-160 without the
 * separation losing its point. That helper used to refuse the local `07…` form;
 * it no longer does — a shopper types what the form's own placeholder asks for.
 * What it still does not do is insist the number be an Iraqi MOBILE, and that is
 * the whole distinction now: a shopper may hand over any reachable number, while
 * this one is a sign-in identity and a courier's calling channel.
 *
 * A landline is refused on purpose. This number is a cash-on-delivery channel —
 * a call before the courier arrives, a WhatsApp message about a return — and a
 * landline does not serve it. Widening the rule later is a two-line migration.
 */
export function normalizeIraqiMobile(value: unknown): string {
  const normalized = toE164(value);
  if (!normalized || !IRAQI_MOBILE_E164.test(normalized)) {
    throw new HttpError(422, "INVALID_MERCHANT_PHONE", "رقم الهاتف يجب أن يكون رقم موبايل عراقياً بصيغة 07XXXXXXXXX أو \u200E+9647XXXXXXXXX.");
  }
  return normalized;
}

/** The person behind the business name — «متجر النور» does not answer a phone. */
export function normalizeOwnerName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 120) {
    throw new HttpError(422, "INVALID_OWNER_NAME", "الاسم الشخصي يجب أن يتكون من حرفين على الأقل.");
  }
  return name;
}

/**
 * Still the ONE place a password becomes a hash, so the policy is applied by
 * being unavoidable rather than by being remembered. The rule itself moved to
 * `password-policy.ts` — the floor is now 8 (the owner's decision) plus a
 * refusal of the passwords people actually pick, which is the half that does
 * the work. See that file for why that is stricter than what it replaced.
 */
/**
 * ASVS 5.0 V6.2.8 — the password is verified EXACTLY as received.
 *
 * bcrypt reads only the first 72 BYTES of its input and ignores the rest
 * without error. Passwords up to 200 characters are accepted and an Arabic
 * letter is two bytes, so two different passwords sharing their first 36 Arabic
 * letters used to open the same account (measured 2026-11-20).
 *
 * A password of more than 72 bytes is therefore hashed as bcrypt(base64(
 * SHA-256(password))) — 44 bytes, every byte of the password counts, no NUL
 * byte for bcrypt to stop at — and stored with the `v2$` prefix. A password of
 * 72 bytes or fewer, which bcrypt never truncates, keeps the plain bcrypt format
 * byte for byte: the previous build reads it, so rolling a deploy back locks
 * nobody out (`password:hash` holds that), and the change touches only the
 * accounts that were exposed.
 *
 * There is deliberately NO re-hash at sign-in. For an old hash of a long
 * password the compare that just succeeded was itself truncated — the string
 * typed may share only the first 72 bytes with the real one — so writing a new
 * hash from it could hand the account to whoever typed it. Those few accounts
 * become exact when their owners next change the password.
 */
const PASSWORD_HASH_V2 = "v2$";
const BCRYPT_MAX_BYTES = 72;

function passwordDigest(password: string): string {
  return crypto.createHash("sha256").update(password, "utf8").digest("base64");
}

export async function createPasswordHash(password: unknown): Promise<string> {
  const accepted = assertPasswordAcceptable(password);
  if (Buffer.byteLength(accepted, "utf8") <= BCRYPT_MAX_BYTES) return bcrypt.hash(accepted, 12);
  return PASSWORD_HASH_V2 + (await bcrypt.hash(passwordDigest(accepted), 12));
}

export async function verifyPassword(password: unknown, passwordHash: string): Promise<boolean> {
  if (typeof password !== "string") return false;
  if (passwordHash.startsWith(PASSWORD_HASH_V2)) return bcrypt.compare(passwordDigest(password), passwordHash.slice(PASSWORD_HASH_V2.length));
  return bcrypt.compare(password, passwordHash);
}

/**
 * A real bcrypt-12 hash of a value nobody holds — the constant-work partner of
 * `verifyPassword`, and the ONE definition of it on the platform (19-د).
 *
 * WHY A DUMMY COMPARE IS NOT CEREMONY. A cost-12 compare takes ~250–500 ms
 * whichever library runs it (D-36 moved the work off the event loop; it did not
 * make it faster, and must not — the cost IS the defence). A door written as
 * `if (!row || !(await verifyPassword(...)))` short-circuits on `!row` and never
 * pays it, so «no such account» answers in ~20 ms and «wrong password» in
 * ~800 ms. That is not a statistical edge needing thousands of samples: ONE
 * request separates the two. On a platform whose merchants are identified by
 * phone number, and whose storefront login is public, the clock answers
 * «does this Iraqi mobile number shop at this named merchant?» for free.
 *
 * HOW TO USE IT. Run the compare UNCONDITIONALLY, before any branch:
 *
 *     const passwordOk = await verifyPassword(input.password, row?.passwordHash ?? ABSENT_IDENTITY_HASH);
 *     if (!row || !row.isActive || !passwordOk) throw new HttpError(401, …);
 *
 * The order matters as much as the compare. Putting `!row.isActive` or
 * `deletedAt !== null` ahead of the compare inside the same `||` chain restores
 * the oracle for disabled and removed accounts — the status code would say one
 * thing while the clock separated «live account, wrong password» from every
 * other state. Every door on this platform uses the shape above for that reason.
 */
export const ABSENT_IDENTITY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.7Gp3XW5rGN8pO1KcOxNrK5jP1Z2fZ2W";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Phase 19: `lastSeenAt` is stamped at birth so a brand-new session sorts to the
 * top of its owner's list immediately. The DEVICE is not captured here — it is
 * written by `touchSession` on the first authenticated request, which avoids
 * threading a header through nine call sites and keeps working as the same
 * person moves between browsers.
 */
/** Marketplace M4: thirty days. */
export const SHOPPER_SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

export async function createTypedSession(identityKind: IdentityKind, subjectId: string, storeId?: string, membershipId?: string): Promise<string> {
  if (identityKind === "merchant" && !storeId) {
    throw new HttpError(500, "MISSING_MERCHANT_STORE_CONTEXT", "Merchant sessions must be bound to a store.");
  }
  if (identityKind === "staff" && (!storeId || !membershipId)) {
    throw new HttpError(500, "MISSING_STAFF_MEMBERSHIP_CONTEXT", "Staff sessions must be bound to one store membership.");
  }
  // A market shopper stays signed in on his phone for a month, as in any shopping
  // app; every dashboard identity keeps the short working-day session.
  const lifetimeSeconds = identityKind === "shopper" ? SHOPPER_SESSION_LIFETIME_SECONDS : config.sessionLifetimeSeconds;
  const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);
  const sessionId = crypto.randomUUID();
  const claims: SessionClaims = { identityKind, subjectId, sessionId, ...(storeId ? { storeId } : {}), ...(membershipId ? { membershipId } : {}) };
  // Signed with the CURRENT session key only — never with a key being retired.
  const accessToken = jwt.sign(claims, KEYS.session.signing, {
    algorithm: "HS256",
    expiresIn: lifetimeSeconds,
  });
  const tokenHash = sha256(accessToken);

  if (identityKind === "platform_owner") {
    await prisma.platformOwnerSession.create({ data: { id: sessionId, platformOwnerId: subjectId, tokenHash, expiresAt, lastSeenAt: new Date() } });
  } else if (identityKind === "merchant") {
    await prisma.merchantSession.create({ data: { id: sessionId, merchantId: subjectId, storeId: storeId!, tokenHash, expiresAt, lastSeenAt: new Date() } });
  } else if (identityKind === "staff") {
    await prisma.staffSession.create({ data: { id: sessionId, staffId: subjectId, membershipId: membershipId!, storeId: storeId!, tokenHash, expiresAt, lastSeenAt: new Date() } });
  } else if (identityKind === "platform_staff") {
    // 19-ب: EXPLICIT, never the else-branch — a platform-staff session stored
    // in customer_sessions would verify, "work", and cross the boundary.
    await prisma.platformStaffSession.create({ data: { id: sessionId, platformStaffId: subjectId, tokenHash, expiresAt, lastSeenAt: new Date() } });
  } else if (identityKind === "shopper") {
    // Marketplace M4: EXPLICIT for the same reason as platform staff above.
    await prisma.shopperSession.create({ data: { id: sessionId, shopperId: subjectId, tokenHash, expiresAt, lastSeenAt: new Date() } });
  } else {
    await prisma.customerSession.create({ data: { id: sessionId, customerId: subjectId, tokenHash, expiresAt, lastSeenAt: new Date() } });
  }
  // ASVS 5.0 V16.3.1: every successful authentication (sign-in, second factor,
  // store switch) ends here, so it is logged here — once, with ids only.
  logger.info("auth.session_issued", { identityKind, subjectId, sessionId });
  return accessToken;
}

export function readSessionClaims(accessToken: string): SessionClaims {
  // Current key, then the one being retired, then the pre-derivation raw secret.
  // `algorithms` is pinned on EVERY attempt: leaving it off is what lets a token
  // claiming `alg: none` verify against nothing at all.
  for (const key of KEYS.session.verifying) {
    let claims: SessionClaims;
    try {
      claims = jwt.verify(accessToken, key, { algorithms: ["HS256"] }) as SessionClaims;
    } catch {
      // Try the next key. An expired token fails under all of them and lands on
      // the same error below, which is the answer it should get either way.
      continue;
    }
    // D-41 (phase 24-أ): the ONE choke point where the platform learns who is
    // acting. Every authenticated path reaches here — `verifyTypedSession`,
    // `verifyAnySession`, and the two permission modules that read the kind
    // directly — so recording the actor here puts it on every log line of the
    // request without threading a parameter through a single service. The token
    // is NEVER recorded; only the identity kind, the subject id, the store the
    // session is bound to and the session row id, which are exactly the columns
    // an audit of a money path needs. Deliberately OUTSIDE the try: a throw in
    // bookkeeping must never be read as a failed signature and cost a valid
    // session its request.
    setLogContext({ actorKind: claims.identityKind, actorId: claims.subjectId, storeId: claims.storeId, sessionId: claims.sessionId });
    return claims;
  }
  throw new HttpError(401, "INVALID_SESSION", "The session token is invalid or expired.");
}

/**
 * Phase 19: verifies a session WITHOUT demanding a particular identity kind.
 *
 * The session routes are the only place this is right: signing out is the same
 * act for every identity, and four copies of it would be four places to forget
 * a fix. Everywhere else must keep using `verifyTypedSession`, because "any
 * valid session" is precisely the check that lets a customer token reach a
 * merchant surface.
 */
export async function verifyAnySession(accessToken: string): Promise<SessionClaims> {
  const claims = readSessionClaims(accessToken);
  return verifyTypedSession(accessToken, claims.identityKind);
}

export async function verifyTypedSession(accessToken: string, expectedKind: IdentityKind): Promise<SessionClaims> {
  const claims = readSessionClaims(accessToken);
  if (claims.identityKind !== expectedKind) {
    // PS-3: names the session he holds and the one this area wants. See
    // `identityBoundaryMessage` for why the old English sentence was a dead end.
    throw new HttpError(403, "IDENTITY_BOUNDARY_DENIED", identityBoundaryMessage(claims.identityKind, IDENTITY_LABELS[expectedKind]));
  }
  if (expectedKind === "merchant" && !claims.storeId) {
    throw new HttpError(401, "INVALID_SESSION", "The merchant session lacks a store context.");
  }
  if (expectedKind === "staff" && (!claims.storeId || !claims.membershipId)) {
    throw new HttpError(401, "INVALID_SESSION", "The staff session lacks a membership context.");
  }

  const tokenHash = sha256(accessToken);
  const now = new Date();
  const isValid =
    expectedKind === "platform_owner"
      ? await prisma.platformOwnerSession.findFirst({ where: { id: claims.sessionId, platformOwnerId: claims.subjectId, tokenHash, revokedAt: null, expiresAt: { gt: now } } })
      : expectedKind === "merchant"
        ? await prisma.merchantSession.findFirst({ where: { id: claims.sessionId, merchantId: claims.subjectId, storeId: claims.storeId!, tokenHash, revokedAt: null, expiresAt: { gt: now } } })
        : expectedKind === "staff"
          ? await prisma.staffSession.findFirst({ where: { id: claims.sessionId, staffId: claims.subjectId, membershipId: claims.membershipId!, storeId: claims.storeId!, tokenHash, revokedAt: null, expiresAt: { gt: now } } })
          // 19-ب: EXPLICIT — falling through to customer_sessions would answer
          // "valid" for a row that does not exist in the right table.
          : expectedKind === "platform_staff"
            ? await prisma.platformStaffSession.findFirst({ where: { id: claims.sessionId, platformStaffId: claims.subjectId, tokenHash, revokedAt: null, expiresAt: { gt: now } } })
            : expectedKind === "shopper"
              ? await prisma.shopperSession.findFirst({ where: { id: claims.sessionId, shopperId: claims.subjectId, tokenHash, revokedAt: null, expiresAt: { gt: now } } })
              : await prisma.customerSession.findFirst({ where: { id: claims.sessionId, customerId: claims.subjectId, tokenHash, revokedAt: null, expiresAt: { gt: now } } });

  if (!isValid) throw new HttpError(401, "INVALID_SESSION", "The session is no longer valid.");
  return claims;
}

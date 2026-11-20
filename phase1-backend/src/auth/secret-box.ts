/**
 * 19-د (D-40) — the secrets this platform stores ON BEHALF of somebody, kept
 * unreadable in a database dump.
 *
 * ============================================================================
 * WHAT WAS WRONG, IN THE MIGRATION'S OWN WORDS
 * ============================================================================
 *
 * `20260831100000_phase19_owner_totp/migration.sql` says it plainly:
 *
 *     «anyone with a database dump today can mint valid codes»
 *
 * Three columns held plaintext: `platform_owners.totp_secret`,
 * `platform_staff.totp_secret` (ق-143) and `notification_settings.api_key`.
 * The first two are the shared secret of a second factor — a copy of the table
 * is a working authenticator app for the platform owner and for every staff
 * member. The third is a provider credential that belongs to a merchant.
 *
 * ============================================================================
 * AES-256-GCM, AND WHY AEAD RATHER THAN «ENCRYPTION»
 * ============================================================================
 *
 * GCM authenticates as well as encrypts. Without the authentication tag, an
 * attacker with WRITE access to the database could flip bits in a ciphertext
 * and the application would decrypt it to something — a corrupted secret that
 * fails verification looks exactly like an owner typing the wrong code, which
 * is a very quiet way to be attacked. A failed tag is a hard error instead.
 *
 * ============================================================================
 * THE KEY: A NEW ROOT, DERIVED THE WAY `keys.ts` DERIVES (D-62)
 * ============================================================================
 *
 * The derivation is the house pattern from `auth/keys.ts`, unchanged: HKDF-SHA256
 * over a root secret from an environment variable, split by a purpose label into
 * keys that cannot be derived from each other, 32 bytes out.
 *
 * The ROOT, however, is deliberately NOT `SESSION_JWT_SECRET`, and this is the
 * one decision here worth arguing:
 *
 *   D-62 exists so that a leaked session secret can be ROTATED without signing
 *   the platform out — `SESSION_JWT_SECRET_PREVIOUS` keeps old signatures
 *   verifiable for one session lifetime and is then withdrawn. That works
 *   because signatures are ephemeral: after eight hours no token needs the old
 *   key, and nothing is lost by retiring it.
 *
 *   Encryption is the opposite. A row encrypted under a retired key is not
 *   «stale», it is UNREADABLE. If these secrets hung off `SESSION_JWT_SECRET`,
 *   the day somebody rotated it for an unrelated reason — the exact scenario
 *   D-62 was designed to make routine and safe — every enrolled owner and staff
 *   member would be permanently locked out of a platform with no support desk
 *   above it. That turns a good habit into a catastrophe.
 *
 * So: a separate root with its own lifecycle (`CODIQ_ENCRYPTION_KEY`), the same
 * derivation, and its own retiring slot (`CODIQ_ENCRYPTION_KEY_PREVIOUS`) that
 * DECRYPTS ONLY and never seals. Rotating means: declare the old key as
 * previous, deploy, re-run the backfill (`pnpm secrets:encrypt`, which re-seals
 * everything under the current key), remove the previous. The envelope carries a
 * key id so none of that is guesswork.
 *
 * ============================================================================
 * THE ENVELOPE
 * ============================================================================
 *
 *     codiq1.<kid>.<iv>.<tag>.<ciphertext>
 *
 *   codiq1      format version. A future v2 (different cipher, different
 *               envelope) can be introduced beside it and read both.
 *   kid         8 hex characters identifying WHICH root sealed this row, so a
 *               rotation reads each row under the right key instead of trying
 *               keys until one happens to work. Derived from the root through
 *               its own HKDF label, so it is not a function of the encryption
 *               key material.
 *   iv          12 random bytes. GCM's nonce: NEVER reused under one key, so it
 *               is drawn fresh for every single seal, never derived, never a
 *               counter.
 *   tag         16-byte GCM authentication tag.
 *   ciphertext  the secret.
 *
 * Every part is base64url, so the whole thing is safe in a `text` column, in a
 * log line and in a URL, and contains no character that a base32 TOTP secret
 * could produce — which is what lets `openSecret` tell an envelope apart from a
 * value written before this phase.
 *
 * ============================================================================
 * PURPOSES ARE THE BINDING
 * ============================================================================
 *
 * Each column derives its OWN key from the root. That is not decoration: it
 * means a ciphertext lifted out of `platform_staff.totp_secret` and written into
 * `platform_owners.totp_secret` by somebody with database write access fails its
 * authentication tag rather than enrolling that person's phone as the owner's
 * second factor.
 */
import crypto from "node:crypto";
import { logger } from "../logging/logger.js";

/**
 * PR-1 adds `password-reset-link`, and it is worth saying why a QUEUED MESSAGE
 * needs the same envelope as a stored TOTP secret.
 *
 * `password_reset_tokens` stores only a sha256 hash, so a database dump yields
 * nothing replayable — except that the mail carrying the token has to travel
 * through `notification_outbox.payload`, which is an ordinary jsonb column. A
 * plaintext link sitting there would put the very value the token table refuses
 * to keep back into the same database, in the clear, for every reset ever
 * requested. Sealing the link closes that: the outbox holds a ciphertext the
 * worker opens at send time, under a root (`CODIQ_ENCRYPTION_KEY`) that is not
 * the session secret and need not live in the same place as the database.
 */
export type SecretPurpose = "platform-owner-totp" | "platform-staff-totp" | "notification-api-key" | "password-reset-link";

const FORMAT = "codiq1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Fixed, and not a secret — exactly as in `auth/keys.ts`. HKDF's salt does not
 * need to vary here because the separation being bought is between PURPOSES,
 * which `info` provides; a random salt would have to be stored somewhere and
 * would stop the API and the standalone worker from deriving the same key
 * without talking to each other.
 */
const SALT = Buffer.from("codiq/phase19d/secret-box", "utf8");

/**
 * The key a developer gets when `CODIQ_ENCRYPTION_KEY` is unset and NODE_ENV is
 * development. It is a constant in a public repository and is therefore no
 * secret at all — which is the point: it can never be mistaken for one, and it
 * is unreachable from every other environment.
 */
const DEVELOPMENT_ROOT = "codiq-development-only-encryption-root-not-a-secret";

function derive(root: string, label: string, bytes = KEY_BYTES): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(root, "utf8"), SALT, Buffer.from(label, "utf8"), bytes));
}

/** 4 bytes → 8 hex. Its own HKDF label, so the id reveals nothing about the keys. */
function keyIdOf(root: string): string {
  return derive(root, "codiq:secret-kid", 4).toString("hex");
}

export interface SecretRoot {
  root: string;
  keyId: string;
  /** True only for the development fallback, so callers can say so out loud. */
  development: boolean;
}

/**
 * FAIL LOUDLY, and fail CLOSED.
 *
 * The rule is inverted the same way `cookieSecureFromEnv` is, and for the same
 * reason: naming every environment that MUST have a key means forgetting one
 * fails open and silently. Naming the single environment that may go without —
 * local development — means forgetting fails at boot, in every other
 * environment, with the variable's name in the message.
 *
 * There is no path here that returns «no key». Falling back to storing these
 * columns in the clear is the defect being fixed; it is not an error-handling
 * strategy.
 */
export function resolveSecretRoot(environment: NodeJS.ProcessEnv = process.env): SecretRoot {
  const explicit = environment.CODIQ_ENCRYPTION_KEY?.trim();
  if (explicit) {
    if (explicit.length < 32) {
      throw new Error("CODIQ_ENCRYPTION_KEY is too short: use at least 32 characters (e.g. `openssl rand -base64 48`).");
    }
    return { root: explicit, keyId: keyIdOf(explicit), development: false };
  }
  if (environment.NODE_ENV === "development") {
    return { root: DEVELOPMENT_ROOT, keyId: keyIdOf(DEVELOPMENT_ROOT), development: true };
  }
  throw new Error(
    "Missing required environment variable: CODIQ_ENCRYPTION_KEY. " +
      "It encrypts the TOTP secrets and the notification provider key at rest (D-40); without it those columns cannot be read or written. " +
      "Generate one with `openssl rand -base64 48`. Only NODE_ENV=development may run without it.",
  );
}

export function resolvePreviousSecretRoot(environment: NodeJS.ProcessEnv = process.env): SecretRoot | null {
  const previous = environment.CODIQ_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (!previous) return null;
  return { root: previous, keyId: keyIdOf(previous), development: false };
}

/**
 * Resolved ONCE, at import, exactly as `keys.ts` builds its keys once: this is
 * what makes a missing key a BOOT failure rather than a failure on the first
 * owner who tries to sign in.
 */
const CURRENT = resolveSecretRoot();
const PREVIOUS = resolvePreviousSecretRoot();

if (CURRENT.development) {
  logger.warn(
    "CODIQ_ENCRYPTION_KEY is unset; using the PUBLIC development key. " +
      "Secrets sealed now are readable by anyone with this repository. Never in a deployed environment.",
    { component: "secret-box" },
  );
}

/** Derived once per purpose per root, for the same reason `keys.ts` does it. */
const keyCache = new Map<string, Buffer>();
function keyFor(source: SecretRoot, purpose: SecretPurpose): Buffer {
  const cacheKey = `${source.keyId}:${purpose}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = derive(source.root, `codiq:secret:${purpose}`);
    keyCache.set(cacheKey, key);
  }
  return key;
}

/** Does this stored value carry an envelope, or was it written before 19-د? */
export function isSealed(stored: string): boolean {
  return stored.startsWith(`${FORMAT}.`);
}

/** Encrypts. Always under the CURRENT key — the previous one never seals. */
export function sealSecret(purpose: SecretPurpose, plaintext: string): string {
  // A fresh nonce for every seal. Reusing one under the same key is the single
  // mistake that breaks GCM outright, so it is never derived and never counted.
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(CURRENT, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, CURRENT.keyId, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/**
 * Decrypts — and tolerates a value written before this phase.
 *
 * THE LEGACY PATH IS THE SAME SHAPE AS THE ONE IN `keys.ts`, and exists for the
 * same reason: deploying this change must not break anyone. An owner enrolled
 * last week has a base32 secret sitting in that column; his phone must keep
 * working the moment this deploys, before the backfill has touched a single
 * row. `sealSecret` is what runs on the next write, so the plaintext leaves on
 * its own — and `pnpm secrets:encrypt` removes the rest in one pass.
 *
 * A value that IS an envelope and fails to open is an ERROR, never a fallback:
 * a wrong key or a tampered row must not be mistaken for «this one is still
 * plaintext» and handed to the TOTP verifier as a secret.
 */
export function openSecret(purpose: SecretPurpose, stored: string): string {
  if (!isSealed(stored)) return stored;

  const parts = stored.split(".");
  if (parts.length !== 5) throw new Error(`[secret-box] malformed envelope for ${purpose}: expected 5 parts, found ${parts.length}`);
  const [, keyId, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string, string];

  const source = keyId === CURRENT.keyId ? CURRENT : PREVIOUS && keyId === PREVIOUS.keyId ? PREVIOUS : null;
  if (!source) {
    throw new Error(
      `[secret-box] no key with id ${keyId} is declared, so this ${purpose} cannot be read. ` +
        "During a rotation the retiring key belongs in CODIQ_ENCRYPTION_KEY_PREVIOUS.",
    );
  }

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error(`[secret-box] envelope for ${purpose} has a ${iv.length}-byte iv and a ${tag.length}-byte tag; expected ${IV_BYTES} and ${TAG_BYTES}`);
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(source, purpose), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // `final()` throws when the tag does not verify: a tampered row, or a key
    // that is not the one that sealed it. Either way the value is not a secret.
    throw new Error(`[secret-box] the authentication tag on a ${purpose} envelope did not verify — the row was altered, or the key is wrong.`);
  }
}

/** Sealed already, or written before 19-د and due to be re-sealed. */
export function needsSealing(stored: string | null): stored is string {
  return typeof stored === "string" && stored.length > 0 && !isSealed(stored);
}

/** What the guard test and the backfill report, without exposing key material. */
export function secretBoxStatus() {
  return {
    format: FORMAT,
    cipher: "aes-256-gcm",
    keyId: CURRENT.keyId,
    previousKeyId: PREVIOUS?.keyId ?? null,
    developmentFallback: CURRENT.development,
  };
}

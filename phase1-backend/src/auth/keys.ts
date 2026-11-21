/**
 * Phase 19-أ — one root secret, purpose-bound keys, and a rotation that does
 * not sign the whole platform out (D-62).
 *
 * ============================================================================
 * WHY DERIVE AT ALL
 * ============================================================================
 *
 * `SESSION_JWT_SECRET` was being used raw for two unrelated jobs: signing
 * session tokens, and signing the unsubscribe links inside marketing emails.
 * Sharing one key across two purposes has two consequences, and both are real:
 *
 *   1. ROTATION COUPLES THEM. Rotating the session key because a session token
 *      leaked would silently invalidate every unsubscribe link already sitting
 *      in somebody's inbox — a person clicking "unsubscribe" in an old email is
 *      told the link is invalid, which is a compliance failure caused by an
 *      unrelated security action.
 *   2. A COMPROMISE OF ONE IS A COMPROMISE OF BOTH, and nothing in the code says
 *      so, which is the sort of thing found out afterwards.
 *
 * HKDF splits one root secret into keys that cannot be derived from each other.
 * There is still ONE environment variable to manage — the operational simplicity
 * is kept, the coupling is not.
 *
 * ============================================================================
 * ROTATION, AND WHY THERE ARE THREE KEYS TO VERIFY AGAINST
 * ============================================================================
 *
 * Signing always uses the CURRENT key. Verification tries, in order:
 *
 *   current   — the normal path, and the only one that ever signs;
 *   previous  — `SESSION_JWT_SECRET_PREVIOUS`, so rotating the root secret does
 *               not sign every merchant out at the moment of deployment. Without
 *               it, rotation is an outage, which means it never happens, which
 *               means a leaked secret stays live;
 *   legacy    — the root secret used RAW, exactly as it was before this file
 *               existed. Every token and every unsubscribe link issued until now
 *               was signed that way, and without this path deploying this change
 *               would itself sign everyone out and break every link already sent.
 *
 * THE LEGACY PATH IS TEMPORARY AND SAYS SO. It verifies and never signs, so it
 * shrinks to nothing on its own:
 *   - for sessions, after ONE session lifetime (8 hours) no legacy token exists;
 *   - for unsubscribe links, after the last marketing email carrying one is out
 *     of every inbox — which, since SMTP is still deferred by ق-121, is likely
 *     already true. It is kept anyway rather than resting on that assumption.
 */
import crypto from "node:crypto";

/** Marketplace M4 adds `otp`: the HMAC key one-time sign-in codes are stored under. */
export type KeyPurpose = "session" | "unsubscribe" | "otp";

/** 32 bytes out, matching HMAC-SHA256's block-effective key size. */
const KEY_BYTES = 32;

/**
 * A fixed salt. HKDF's salt is not a secret and does not need to vary here: the
 * separation being bought is between PURPOSES, which `info` provides. A random
 * salt would have to be stored somewhere and would make the derivation
 * non-reproducible across processes — the worker derives the same keys as the
 * API, and both must agree without coordinating.
 */
const SALT = Buffer.from("codiq/phase19/key-derivation", "utf8");

function derive(root: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(root, "utf8"),
      SALT,
      Buffer.from(`codiq:${purpose}`, "utf8"),
      KEY_BYTES
    )
  );
}

export interface PurposeKeys {
  /** The one key that signs. */
  signing: Buffer;
  /**
   * Everything a signature may be checked against, current first. Callers try
   * them in order and accept the first that verifies.
   */
  verifying: Buffer[];
}

/**
 * Built ONCE per process, at import, from the config that is itself read once.
 * Deriving per request would put an HKDF on every authenticated call for a value
 * that cannot change while the process lives.
 */
export function buildKeys(root: string, previous: string | null): Record<KeyPurpose, PurposeKeys> {
  const legacy = Buffer.from(root, "utf8");
  const build = (purpose: KeyPurpose): PurposeKeys => {
    const signing = derive(root, purpose);
    const verifying = [signing];
    if (previous) verifying.push(derive(previous, purpose));
    // Last, because it is the one being retired: a token that verifies under a
    // real key must never fall through to it.
    verifying.push(legacy);
    return { signing, verifying };
  };
  return { session: build("session"), unsubscribe: build("unsubscribe"), otp: build("otp") };
}

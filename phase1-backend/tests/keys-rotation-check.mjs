/**
 * codiq phase 19-أ — purpose-bound keys and secret rotation (D-62).
 *
 * `buildKeys` is a pure function, so this needs no database and no server. What
 * it has to establish is small and exact:
 *
 *   1. THE TWO PURPOSES GET DIFFERENT KEYS — otherwise "purpose separation" is a
 *      comment rather than a fact, and rotating the session key still silently
 *      breaks every unsubscribe link already sent;
 *   2. NEITHER DERIVED KEY IS THE RAW SECRET — if one were, the split would be
 *      decorative;
 *   3. DEPLOYING THIS CHANGE SIGNS NOBODY OUT — a token signed the old way, with
 *      the raw secret, still verifies. This is the assertion that makes the
 *      change safe to ship at all;
 *   4. AN UNSUBSCRIBE LINK ALREADY IN AN INBOX STILL WORKS — same reason, for
 *      the other purpose;
 *   5. ROTATION DOES NOT SIGN ANYONE OUT — a token signed under the previous
 *      secret verifies while that secret is still declared, and STOPS verifying
 *      once it is withdrawn. Both halves: a key that can never be retired is not
 *      a rotation;
 *   6. AN UNRELATED SECRET IS REFUSED — the check that the others are not
 *      passing for a trivial reason;
 *   7. DERIVATION IS DETERMINISTIC ACROSS PROCESSES — the API and the standalone
 *      notification worker derive independently and must agree without talking.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const { buildKeys } = await import("../src/auth/keys.ts");

const ROOT = "a-root-secret-long-enough-to-be-real-0123456789";
const PREVIOUS = "the-secret-being-retired-0123456789abcdef";
const UNRELATED = "an-unrelated-secret-that-must-never-verify-0123";

const keys = buildKeys(ROOT, null);
const rotating = buildKeys(ROOT, PREVIOUS);

// 1 & 2. The split is real.
assert.notDeepEqual(keys.session.signing, keys.unsubscribe.signing, "D-62: the two purposes get different keys");
assert.notDeepEqual(keys.session.signing, Buffer.from(ROOT, "utf8"), "D-62: the session key is not the raw secret");
assert.notDeepEqual(keys.unsubscribe.signing, Buffer.from(ROOT, "utf8"), "D-62: nor is the unsubscribe key");
assert.equal(keys.session.signing.length, 32, "D-62: 32 bytes, matching HMAC-SHA256");

// The order matters: the key being retired must never be preferred over the
// current one, and the legacy raw secret must be last of all.
assert.deepEqual(rotating.session.verifying[0], rotating.session.signing, "D-62: the current key is tried first");
assert.deepEqual(
  rotating.session.verifying[rotating.session.verifying.length - 1],
  Buffer.from(ROOT, "utf8"),
  "D-62: the raw secret is tried LAST — it is the one being retired",
);

// 3. Deploying this signs nobody out: a token signed the OLD way still verifies.
const legacyToken = jwt.sign({ identityKind: "merchant", subjectId: "x", sessionId: "y" }, ROOT, {
  algorithm: "HS256",
  expiresIn: 3600,
});
const legacyAccepted = keys.session.verifying.some((key) => {
  try {
    jwt.verify(legacyToken, key, { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
});
assert.ok(legacyAccepted, "D-62: a token signed before this change still verifies — the deploy signs nobody out");

// 4. An unsubscribe link already in somebody's inbox still works.
const sign = (key, payload) => crypto.createHmac("sha256", key).update(payload).digest("base64url");
const payload = "pg3-unsubscribe:store-1:someone@example.test";
const legacyLink = sign(Buffer.from(ROOT, "utf8"), payload);
assert.ok(
  keys.unsubscribe.verifying.some((key) => sign(key, payload) === legacyLink),
  "D-62: an unsubscribe link signed the old way still verifies — a broken one is a person who cannot stop marketing",
);

// 5. Rotation, in both directions.
const previousToken = jwt.sign({ identityKind: "merchant", subjectId: "x", sessionId: "y" }, buildKeys(PREVIOUS, null).session.signing, {
  algorithm: "HS256",
  expiresIn: 3600,
});
const verifiesUnder = (bundle, token) =>
  bundle.session.verifying.some((key) => {
    try {
      jwt.verify(token, key, { algorithms: ["HS256"] });
      return true;
    } catch {
      return false;
    }
  });
assert.ok(verifiesUnder(rotating, previousToken), "D-62: while the old secret is declared, its tokens still work — rotation is not an outage");
assert.ok(
  !verifiesUnder(keys, previousToken),
  "D-62: and once it is withdrawn they stop — a key that can never be retired is not a rotation",
);

// 6. Nothing above passes for a trivial reason.
const foreign = jwt.sign({ identityKind: "merchant", subjectId: "x", sessionId: "y" }, UNRELATED, { algorithm: "HS256", expiresIn: 3600 });
assert.ok(!verifiesUnder(rotating, foreign), "D-62: an unrelated secret is refused by every key in the window");
assert.ok(
  !keys.unsubscribe.verifying.some((key) => sign(key, payload) === sign(Buffer.from(UNRELATED, "utf8"), payload)),
  "D-62: …and so is an unrelated unsubscribe signature",
);

// 7. Two processes derive the same keys from the same input.
assert.deepEqual(buildKeys(ROOT, null).session.signing, keys.session.signing, "D-62: deterministic — the worker and the API must agree without coordinating");

// A session key must not be usable as an unsubscribe key, in the direction that
// would actually matter: a leaked unsubscribe key must not forge a session.
const forged = jwt.sign({ identityKind: "platform_owner", subjectId: "x", sessionId: "y" }, keys.unsubscribe.signing, {
  algorithm: "HS256",
  expiresIn: 3600,
});
assert.ok(
  !verifiesUnder(keys, forged),
  "D-62: the unsubscribe key cannot mint a session — which is the whole point of splitting them",
);

// ===========================================================================
// 19-د (D-40) — THE SAME DERIVATION, APPLIED TO SECRETS AT REST
// ===========================================================================
//
// `auth/secret-box.ts` follows the pattern above — HKDF over a root from an
// environment variable, split by purpose label, 32 bytes out — for the three
// columns that held somebody else's secret in the clear. What it does NOT share
// is the ROOT, and that is the assertion this section exists to pin.
//
// D-62 makes rotating `SESSION_JWT_SECRET` routine: sign with the new key,
// verify against the old for one session lifetime, withdraw. That is safe
// because a signature is ephemeral. A row is not. Had these columns hung off the
// same root, the first person to follow D-62's own advice would have made every
// enrolled owner's and staff member's second factor permanently unreadable — on
// a platform whose migration notes say there is no support desk above the owner.

const ENCRYPTION_ROOT = "an-encryption-root-secret-long-enough-0123456789";
const ENCRYPTION_ROOT_NEXT = "the-key-this-platform-rotates-onto-0123456789abc";

// The module resolves its key ONCE at import, which is what makes a missing key
// a BOOT failure. So the environment is set before it is imported.
process.env.CODIQ_ENCRYPTION_KEY = ENCRYPTION_ROOT;
const secretBox = await import("../src/auth/secret-box.ts");

const OWNER_SECRET = "JBSWY3DPEHPK3PXP";
const sealed = secretBox.sealSecret("platform-owner-totp", OWNER_SECRET);

// The envelope is versioned, so a future format can be introduced beside this
// one rather than guessed at from the ciphertext's shape.
const parts = sealed.split(".");
assert.equal(parts.length, 5, "D-40: the envelope is version.kid.iv.tag.ciphertext");
assert.equal(parts[0], "codiq1", "D-40: the format version leads, so a v2 can be read alongside v1");
assert.match(parts[1], /^[0-9a-f]{8}$/, "D-40: a key id, so a rotation reads each row under the RIGHT key instead of trying keys until one works");
assert.equal(Buffer.from(parts[2], "base64url").length, 12, "D-40: a 12-byte GCM nonce");
assert.equal(Buffer.from(parts[3], "base64url").length, 16, "D-40: a 16-byte authentication tag");
assert.ok(!sealed.includes(OWNER_SECRET), "D-40: the plaintext is not in the envelope — the whole point");
assert.equal(secretBox.openSecret("platform-owner-totp", sealed), OWNER_SECRET, "D-40: it round-trips");

// A nonce is NEVER reused under one key. Reuse is the single mistake that breaks
// GCM outright, so two seals of the same value must not produce the same bytes.
assert.notEqual(secretBox.sealSecret("platform-owner-totp", OWNER_SECRET), sealed, "D-40: a fresh iv per seal — a repeated nonce breaks GCM");

// Purpose separation, in the direction that would actually matter: a ciphertext
// lifted out of a staff row and written into the owner's must not enrol that
// person's phone as the platform owner's second factor.
const staffSealed = secretBox.sealSecret("platform-staff-totp", OWNER_SECRET);
assert.throws(
  () => secretBox.openSecret("platform-owner-totp", staffSealed),
  /authentication tag/,
  "D-40: each column has its own derived key, so a ciphertext moved between them fails to open",
);

// AEAD is not decoration: a tampered row is an ERROR, never a value.
const tampered = [...parts.slice(0, 4), Buffer.from("not the ciphertext that was sealed").toString("base64url")].join(".");
assert.throws(() => secretBox.openSecret("platform-owner-totp", tampered), /authentication tag/, "D-40: a flipped bit fails loudly instead of decrypting to something");

// THE ACCEPTANCE CONDITION FOR THE WHOLE CHANGE: an owner enrolled BEFORE this
// phase has a bare base32 secret in that column, and his phone must keep working
// the moment this deploys — before the backfill has touched a single row. Same
// shape as the legacy verification path above, and it empties itself the same
// way: every write re-seals.
assert.equal(secretBox.openSecret("platform-owner-totp", OWNER_SECRET), OWNER_SECRET, "D-40: a secret written before 19-د still reads — the deploy locks nobody out");
assert.ok(secretBox.needsSealing(OWNER_SECRET), "D-40: …and is reported as still needing sealing");
assert.ok(!secretBox.needsSealing(sealed), "D-40: an envelope does not");

// Rotation. The retiring key DECRYPTS and never seals; withdrawing it stops the
// old rows from opening, which is what makes it a rotation rather than a key
// that can never be retired.
assert.equal(secretBox.resolvePreviousSecretRoot({}), null, "D-40: no previous key is the normal state");
const withPrevious = secretBox.resolvePreviousSecretRoot({ CODIQ_ENCRYPTION_KEY_PREVIOUS: ENCRYPTION_ROOT });
assert.equal(withPrevious.keyId, secretBox.secretBoxStatus().keyId, "D-40: the same root yields the same key id — that is what the kid on a row resolves against");
assert.notEqual(
  secretBox.resolveSecretRoot({ CODIQ_ENCRYPTION_KEY: ENCRYPTION_ROOT_NEXT }).keyId,
  secretBox.secretBoxStatus().keyId,
  "D-40: a different root is a different key id, so rows sealed under each are told apart rather than guessed at",
);

// FAIL LOUDLY, FAIL CLOSED. Inverted exactly like `cookieSecureFromEnv`: only
// local development may go without a key, so an environment nobody thought of
// fails at BOOT with the variable named — never by quietly storing plaintext.
for (const unnamed of ["production", "staging", "demo", "qa", "test", undefined]) {
  assert.throws(
    () => secretBox.resolveSecretRoot({ NODE_ENV: unnamed }),
    /CODIQ_ENCRYPTION_KEY/,
    `D-40: «${unnamed ?? "unset"}» is not development, so a missing key must stop the boot`,
  );
}
assert.equal(secretBox.resolveSecretRoot({ NODE_ENV: "development" }).development, true, "D-40: local development is the one exception, and it says so");
assert.equal(secretBox.resolveSecretRoot({ CODIQ_ENCRYPTION_KEY: ENCRYPTION_ROOT }).development, false, "…and a real key is never the development fallback");
assert.throws(() => secretBox.resolveSecretRoot({ CODIQ_ENCRYPTION_KEY: "too-short" }), /at least 32/, "D-40: a key short enough to guess is refused rather than accepted quietly");

// The two roots are independent: rotating the session secret must not touch a
// single stored secret. This is the assertion the argument above rests on.
assert.notEqual(
  secretBox.resolveSecretRoot({ CODIQ_ENCRYPTION_KEY: ROOT }).keyId,
  secretBox.resolveSecretRoot({ CODIQ_ENCRYPTION_KEY: ENCRYPTION_ROOT }).keyId,
  "D-40: the encryption root has its own lifecycle — rotating SESSION_JWT_SECRET must never make a stored secret unreadable",
);

console.log(
  JSON.stringify(
    {
      keysRotation: {
        purposes: ["session", "unsubscribe"],
        keyBytes: keys.session.signing.length,
        verifyOrder: ["current", "previous", "legacy-raw"],
        keysInWindowWithoutRotation: keys.session.verifying.length,
        keysInWindowDuringRotation: rotating.session.verifying.length,
        legacyTokensStillAccepted: true,
        retiredSecretStopsVerifying: true,
        unsubscribeKeyCannotMintSession: true,
      },
      secretsAtRest: {
        ...secretBox.secretBoxStatus(),
        envelope: "codiq1.<kid>.<iv>.<tag>.<ciphertext> — base64url",
        root: "CODIQ_ENCRYPTION_KEY, deliberately NOT SESSION_JWT_SECRET",
        purposes: ["platform-owner-totp", "platform-staff-totp", "notification-api-key"],
        legacyPlaintextStillReadable: true,
        missingKeyOutsideDevelopment: "throws at boot",
      },
    },
    null,
    2,
  ),
);
console.log("keys:rotation OK");

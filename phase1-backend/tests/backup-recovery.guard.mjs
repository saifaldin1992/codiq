/**
 * 24-ج — the guard over the disaster-recovery tooling. Run: pnpm backup:guard
 *
 * ============================================================================
 * WHAT THIS GUARD REFUSES TO BE
 * ============================================================================
 *
 * The cheap version of this file greps `docs/DISASTER_RECOVERY.md` for the word
 * «backup» and exits 0. That guard would pass on the morning the bucket is empty
 * and pass again on the morning the dumps turn out to be undecryptable — which
 * makes it worse than no guard, because it converts «nobody checked» into
 * «something checked and said fine».
 *
 * So this one executes the real backup code. Every assertion below drives the
 * actual `backup-envelope.ts` and `backup-storage.ts` the scheduled job uses.
 * It needs no database, no bucket, no network and no production credential —
 * the whole point of `docs/DEPLOYMENT.md`'s «ممنوع Neon والإنتاج» is that CI
 * must be able to prove this much without holding anything.
 *
 * ============================================================================
 * THE FOUR CLAIMS BEING PROVEN
 * ============================================================================
 *
 * 1. A dump encrypted by this code can be decrypted by this code — and by the
 *    PREVIOUS key after a rotation, so rotating does not orphan the archive.
 * 2. A dump that is truncated, altered, reordered, or sealed with a key nobody
 *    holds FAILS LOUDLY, before a byte reaches `pg_restore`. Truncation is the
 *    one that earns this file's existence: a cut-short dump is the only failure
 *    here that otherwise restores «successfully» into a half-empty database.
 * 3. The pruner — the one irreversible step in the system — cannot empty the
 *    bucket, cannot touch a fresh copy, and cannot reach outside its prefix.
 * 4. `docs/DISASTER_RECOVERY.md` states the numbers the code actually uses. The
 *    document publishes an RPO to the owner; if prose and policy drift, one of
 *    them is lying to him and CI should say which.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const { BACKUP_POLICY, backupCronExpression } = await import("../src/backup/backup-policy.ts");
const { backupKeyring, collect, currentBackupKey, decryptBackupStream, encryptBackupStream } = await import(
  "../src/backup/backup-envelope.ts"
);
const { backupObjectKey, selectExpiredBackups, resolveBackupStorage } = await import("../src/backup/backup-storage.ts");

/** Two unrelated roots, so «wrong key» is genuinely a different key. */
const ROOT_A = "guard-root-a-000000000000000000000000000000";
const ROOT_B = "guard-root-b-111111111111111111111111111111";
const KEY_A = currentBackupKey({ CODIQ_BACKUP_ENCRYPTION_KEY: ROOT_A });
const KEY_B = currentBackupKey({ CODIQ_BACKUP_ENCRYPTION_KEY: ROOT_B });

const CHUNK = 1024;
/** Deliberately not a multiple of CHUNK: the tail frame is its own code path. */
const PAYLOAD = Buffer.from(`-- codiq backup guard --\n${"CODIQ".repeat(1500)}\n-- end --`, "utf8");

const seal = (payload = PAYLOAD, key = KEY_A) => collect(encryptBackupStream([payload], key, { chunkBytes: CHUNK }));
const open = (bytes, keyring = [KEY_A]) => collect(decryptBackupStream([bytes], keyring));

async function rejects(what, run) {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail(`${what} — this MUST throw. A backup that accepts it restores a lie.`);
}

// ===========================================================================
// 1. THE ROUND TRIP, AND KEY ROTATION
// ===========================================================================

const sealed = await seal();
assert.ok(sealed.length > PAYLOAD.length, "the envelope must carry its header and per-frame tags");
assert.deepEqual(await open(sealed), PAYLOAD, "a dump this code sealed must open byte-for-byte");

// Multi-megabyte shape, in pieces of awkward size, to prove the re-chunker.
const big = Buffer.concat(Array.from({ length: 40 }, (_, i) => Buffer.alloc(700, i % 251)));
const pieces = [];
for (let at = 0; at < big.length; at += 333) pieces.push(big.subarray(at, at + 333));
assert.deepEqual(
  await collect(decryptBackupStream([await collect(encryptBackupStream(pieces, KEY_A, { chunkBytes: CHUNK }))], [KEY_A])),
  big,
  "a stream arriving in pieces unaligned to the chunk size must reassemble exactly",
);

// Rotation: yesterday's dump opens under today's keyring because PREVIOUS is on it.
const keyringAfterRotation = backupKeyring({
  CODIQ_BACKUP_ENCRYPTION_KEY: ROOT_B,
  CODIQ_BACKUP_ENCRYPTION_KEY_PREVIOUS: ROOT_A,
});
assert.equal(keyringAfterRotation.length, 2, "the keyring must carry the previous key so a rotation does not orphan dumps");
assert.deepEqual(await open(sealed, keyringAfterRotation), PAYLOAD, "rotating the backup key must not strand yesterday's dump");

// ===========================================================================
// 2. FAIL-CLOSED KEY RESOLUTION — no development fallback, ever
// ===========================================================================

const missing = await rejects("an unset CODIQ_BACKUP_ENCRYPTION_KEY", async () => currentBackupKey({}));
assert.match(missing, /CODIQ_BACKUP_ENCRYPTION_KEY/, "the message must name the variable");

// The sibling secret-box.ts DOES fall back under NODE_ENV=development, and that
// is right for it. Here it would produce a dump sealed with a root printed in
// the repository — a plaintext dump wearing a costume. Prove the costume is not
// available.
await rejects("a development fallback for the backup key", async () =>
  currentBackupKey({ NODE_ENV: "development" }),
);
await rejects("a key shorter than 32 characters", async () => currentBackupKey({ CODIQ_BACKUP_ENCRYPTION_KEY: "tooshort" }));
assert.notEqual(KEY_A.keyId, KEY_B.keyId, "different roots must derive different key ids");

// ===========================================================================
// 3. THE FAILURES THAT MUST BE LOUD
// ===========================================================================

// (a) TRUNCATION AT A FRAME BOUNDARY. This is the flagship. An upload killed
// between two whole frames yields a structurally perfect file; only the missing
// end-of-stream marker distinguishes it from a complete dump. Find the last
// frame boundary by sealing a payload and cutting the terminator off.
const terminatorBytes = 4 + 12 + 16; // length | iv | tag, over zero ciphertext
const cutAtBoundary = sealed.subarray(0, sealed.length - terminatorBytes);
const boundaryMessage = await rejects("a dump truncated exactly at a frame boundary", () => open(cutAtBoundary));
assert.match(
  boundaryMessage,
  /end-of-stream marker/,
  "a boundary-truncated dump must be rejected for its MISSING TERMINATOR, not by luck",
);

// (b) Truncation in the middle of a frame.
await rejects("a dump truncated mid-frame", () => open(sealed.subarray(0, sealed.length - terminatorBytes - 7)));

// (c) A flipped byte in the ciphertext.
const flipped = Buffer.from(sealed);
flipped[flipped.length - terminatorBytes - 3] ^= 0xff;
const flippedMessage = await rejects("a dump with one altered byte", () => open(flipped));
assert.match(flippedMessage, /failed authentication/, "an altered frame must fail its tag");

// (d) Reordered frames. The AAD binds each frame's index, so swapping two whole
// frames must fail even though every frame is individually authentic.
const headerEnd = 8 + 4 + sealed.readUInt32BE(8);
const frameSize = 4 + 12 + 16 + CHUNK;
const reordered = Buffer.concat([
  sealed.subarray(0, headerEnd),
  sealed.subarray(headerEnd + frameSize, headerEnd + frameSize * 2),
  sealed.subarray(headerEnd, headerEnd + frameSize),
  sealed.subarray(headerEnd + frameSize * 2),
]);
await rejects("a dump whose frames were reordered", () => open(reordered));

// (e) A key nobody holds. The message has to send the operator to escrow rather
// than let him conclude the file is corrupt.
const strangerMessage = await rejects("a dump sealed with an unknown key", () => open(sealed, [KEY_B]));
assert.match(strangerMessage, /escrow/, "an unknown key id must point at escrow, not at corruption");

// (f) Something that is not a backup at all.
await rejects("a file that is not an envelope", () => open(Buffer.from("PGDMP not really", "utf8")));

// ===========================================================================
// 4. THE PRUNER — the only step with no undo
// ===========================================================================

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-05T00:00:00Z");
const fixture = (ageDays) => {
  const at = new Date(now.getTime() - ageDays * day);
  return { key: backupObjectKey(at), bytes: 1024, lastModified: at };
};

// A bucket smaller than the floor is untouchable no matter how old it is.
const ancient = Array.from({ length: BACKUP_POLICY.minimumKeptCopies }, (_, i) => fixture(900 + i));
assert.deepEqual(
  selectExpiredBackups(ancient, now),
  [],
  `with only ${BACKUP_POLICY.minimumKeptCopies} objects the pruner must delete NOTHING, whatever their age — ` +
    `a stopped cron or a skewed clock must not be able to empty the bucket`,
);

// Fresh copies are never candidates, even far past the floor.
const fresh = Array.from({ length: BACKUP_POLICY.minimumKeptCopies * 3 }, (_, i) => fixture(i * 0.25));
assert.deepEqual(selectExpiredBackups(fresh, now), [], "objects inside the retention window must never be selected");

// The real shape: a long archive with genuinely expired tails.
const mixed = [
  ...Array.from({ length: BACKUP_POLICY.minimumKeptCopies * 2 }, (_, i) => fixture(i * 0.25)),
  ...Array.from({ length: 5 }, (_, i) => fixture(BACKUP_POLICY.retentionDays + 10 + i)),
];
const expired = selectExpiredBackups(mixed, now);
assert.equal(expired.length, 5, "exactly the objects past the retention window and beyond the floor may be pruned");
for (const object of expired) {
  assert.ok(object.key.startsWith(BACKUP_POLICY.objectPrefix), `the pruner must never select «${object.key}» — outside the prefix`);
  assert.ok(now.getTime() - object.lastModified.getTime() > BACKUP_POLICY.retentionDays * day, "a selected object must truly be expired");
}

// Object keys must sort chronologically, because the pruner and «--key latest»
// both trust lexicographic order to mean time order.
const ordered = [fixture(3), fixture(1), fixture(2)].map((o) => o.key);
assert.deepEqual(
  [...ordered].sort(),
  [fixture(3).key, fixture(2).key, fixture(1).key],
  "object keys must sort lexicographically into chronological order",
);

// ===========================================================================
// 5. THE DOCUMENT MUST STATE THE NUMBERS THE CODE USES
// ===========================================================================

const DOC = path.join(root, "docs", "DISASTER_RECOVERY.md");
const doc = readFileSync(DOC, "utf8");
const cron = backupCronExpression();

const claims = [
  [`كل ${BACKUP_POLICY.intervalHours} ساعات`, "the backup cadence"],
  [`\`${cron}\``, "the cron expression the Railway service must carry"],
  [`${BACKUP_POLICY.retentionDays} يوماً`, "the retention window"],
  [`${BACKUP_POLICY.minimumKeptCopies} نسخة`, "the pruner's floor"],
  [`PostgreSQL ${BACKUP_POLICY.productionServerMajor}`, "the production server major, which pg_dump must match or exceed"],
];

const drifted = claims.filter(([text]) => !doc.includes(text));
if (drifted.length) {
  console.error("backup:guard FAILED — docs/DISASTER_RECOVERY.md no longer states what the code does:\n");
  for (const [text, what] of drifted) {
    console.error(`  ✗ ${what}: the document must contain «${text}»`);
    console.error(`    Either write it, or change phase1-backend/src/backup/backup-policy.ts so the promise matches.\n`);
  }
  process.exit(1);
}

// The forbidden design, asserted structurally rather than trusted. If anyone
// ever moves the dump into CI, the credential surface widens and this fails.
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
assert.ok(
  !/backup:run/.test(workflow),
  "ci.yml must never run `backup:run` — docs/DEPLOYMENT.md forbids Neon and production credentials in CI («ممنوع Neon والإنتاج»). " +
    "The dump runs from Railway, where the credential already lives.",
);

// The connection string must reach pg_dump through libpq's environment, never
// through argv where the process table exposes it.
const runner = readFileSync(path.join(root, "phase1-backend", "scripts", "backup-database.ts"), "utf8");
assert.ok(runner.includes("PGPASSWORD"), "backup-database.ts must pass credentials through the environment");
assert.ok(
  !/spawn\(\s*"pg_dump"\s*,\s*\[[^\]]*--dbname/.test(runner),
  "backup-database.ts must not put the connection string in pg_dump's argv — the process table is readable",
);

// ===========================================================================
// ق-241 — WHICH BUCKET, AND THE ONE ANSWER THAT MUST NEVER BE GIVEN SILENTLY
// ===========================================================================
//
// A backup that dies with the thing it backs up is a copy, not a backup. The
// dumps used to have no way to live anywhere but the product-image bucket;
// `CODIQ_BACKUP_S3_*` gives them one. The rule that makes it real is the middle
// case below: a HALF-configured dedicated destination must refuse to run rather
// than fall back, because an operator who believes the dumps are isolated when
// they are not will act on that belief during an incident.
const PRODUCT_FAMILY = {
  PRODUCT_S3_ENDPOINT: "https://images.example",
  PRODUCT_S3_BUCKET: "codiq-images",
  PRODUCT_S3_ACCESS_KEY_ID: "image-id",
  PRODUCT_S3_SECRET_ACCESS_KEY: "image-secret",
};
const DEDICATED_FAMILY = {
  CODIQ_BACKUP_S3_ENDPOINT: "https://dumps.example",
  CODIQ_BACKUP_S3_BUCKET: "codiq-dumps",
  CODIQ_BACKUP_S3_ACCESS_KEY_ID: "dump-id",
  CODIQ_BACKUP_S3_SECRET_ACCESS_KEY: "dump-secret",
};

const sharedStorage = resolveBackupStorage({ ...PRODUCT_FAMILY });
assert.equal(sharedStorage.bucket, "codiq-images", "with no dedicated variables the dumps still work — into the image bucket");
assert.equal(sharedStorage.failureDomain, "shared-with-product-images", "…and the run SAYS so: the cost is reported on every successful backup, not buried in a document");

const dedicatedStorage = resolveBackupStorage({ ...PRODUCT_FAMILY, ...DEDICATED_FAMILY });
assert.equal(dedicatedStorage.bucket, "codiq-dumps", "the dedicated family wins outright when it is complete");
assert.equal(dedicatedStorage.accessKeyId, "dump-id", "…including the KEYS — a separate bucket on the same credentials is the same failure domain wearing a different name");
assert.equal(dedicatedStorage.failureDomain, "dedicated");

// The case that matters. Each variable on its own, with the other three absent.
for (const [name, value] of Object.entries(DEDICATED_FAMILY)) {
  const message = await rejects(`a dedicated destination with only ${name} set`, async () =>
    resolveBackupStorage({ ...PRODUCT_FAMILY, [name]: value }),
  );
  assert.match(message, /half-configured/i, `«${name}» alone must refuse, not fall back`);
  assert.match(message, /Refusing to fall back/i, "…and say WHY, because the operator's next move depends on it");
}
// Even a lone optional variable counts as an attempt: a typo'd region with no
// keys must not resolve quietly to the image bucket.
await rejects("a lone CODIQ_BACKUP_S3_REGION", async () => resolveBackupStorage({ ...PRODUCT_FAMILY, CODIQ_BACKUP_S3_REGION: "auto" }));

console.log(
  JSON.stringify(
    {
      backupRecovery: {
        failureDomain: {
          dedicated: "CODIQ_BACKUP_S3_* — own bucket, own keys",
          fallback: "PRODUCT_S3_* — supported, defaulted to, and named in every run's JSON line",
          refuses: "any partial CODIQ_BACKUP_S3_* configuration, including a lone optional variable",
        },
        envelope: { algorithm: "aes-256-gcm", chunkBytes: BACKUP_POLICY.chunkBytes, rotationKeys: keyringAfterRotation.length },
        rejected: ["boundary-truncation", "mid-frame-truncation", "bit-flip", "frame-reorder", "unknown-key", "not-an-envelope"],
        failClosed: ["unset-key", "development-fallback", "short-key"],
        pruner: {
          retentionDays: BACKUP_POLICY.retentionDays,
          minimumKeptCopies: BACKUP_POLICY.minimumKeptCopies,
          selectedFromFixture: expired.length,
        },
        document: { path: "docs/DISASTER_RECOVERY.md", claimsVerified: claims.length, cron },
      },
    },
    null,
    2,
  ),
);
console.log("backup:guard OK");

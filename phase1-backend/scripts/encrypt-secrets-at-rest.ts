/**
 * 19-د (D-40) — re-seal every secret that is still sitting in the clear.
 *
 * Runs immediately after `prisma migrate deploy` (see `phase1:db:migrate`),
 * because the migration beside it cannot do this itself: AES-256-GCM is an AEAD
 * mode and pgcrypto has none, so the re-encryption cannot be written as SQL
 * without dropping the authentication tag that is the whole point.
 *
 * IDEMPOTENT AND RE-RUNNABLE. A row that already carries an envelope is skipped,
 * which makes this the same tool a KEY ROTATION uses: declare the retiring key
 * as `CODIQ_ENCRYPTION_KEY_PREVIOUS`, set the new one as `CODIQ_ENCRYPTION_KEY`,
 * run this with `--reseal`, and every row moves onto the new key — read under
 * whichever key its `kid` names, written back under the current one.
 *
 * It reports counts and never a secret, so it is safe in a deploy log.
 */
import { prisma } from "../src/db/prisma.js";
import {
  isSealed,
  openSecret,
  sealSecret,
  secretBoxStatus,
  type SecretPurpose,
} from "../src/auth/secret-box.js";

/**
 * `--reseal` also rewrites rows that are ALREADY sealed, moving them onto the
 * current key. Off by default: the deploy path should do the smallest correct
 * thing, and rewriting every envelope on every deploy is not it.
 */
const reseal = process.argv.includes("--reseal");

interface Outcome {
  column: string;
  sealed: number;
  resealed: number;
  alreadySealed: number;
  empty: number;
}

/**
 * A row is worth writing when it is plaintext, or when `--reseal` is on and the
 * envelope was written under a key that is not the current one.
 */
function nextValue(purpose: SecretPurpose, stored: string, currentKeyId: string): string | null {
  if (!isSealed(stored)) return sealSecret(purpose, stored);
  if (!reseal) return null;
  const keyId = stored.split(".")[1];
  if (keyId === currentKeyId) return null;
  // Opens under whichever declared key sealed it — that is what the kid is for —
  // and comes back out under the current one.
  return sealSecret(purpose, openSecret(purpose, stored));
}

async function sealColumn<Row extends { id: string }>(
  column: string,
  purpose: SecretPurpose,
  load: () => Promise<(Row & { secret: string | null })[]>,
  save: (id: string, value: string) => Promise<unknown>
): Promise<Outcome> {
  const { keyId } = secretBoxStatus();
  const outcome: Outcome = { column, sealed: 0, resealed: 0, alreadySealed: 0, empty: 0 };
  for (const row of await load()) {
    if (!row.secret) {
      outcome.empty += 1;
      continue;
    }
    const wasSealed = isSealed(row.secret);
    const next = nextValue(purpose, row.secret, keyId);
    if (!next) {
      outcome.alreadySealed += 1;
      continue;
    }
    await save(row.id, next);
    if (wasSealed) outcome.resealed += 1;
    else outcome.sealed += 1;
  }
  return outcome;
}

async function main() {
  const status = secretBoxStatus();
  if (status.developmentFallback) {
    // Sealing rows under the PUBLIC development key would be worse than leaving
    // them in the clear: the column would look encrypted and would not be. This
    // is the one case that exits quietly rather than failing — `phase1:db:migrate`
    // runs this script, and a developer with an empty database must still be
    // able to migrate. Every deployed environment has the key or never booted.
    console.warn(
      "[secrets:encrypt] CODIQ_ENCRYPTION_KEY is unset and NODE_ENV is development — no row touched. Sealing under the public development key would only look like encryption."
    );
    return;
  }

  const outcomes = [
    await sealColumn(
      "platform_owners.totp_secret",
      "platform-owner-totp",
      async () =>
        (
          await prisma.platformOwner.findMany({
            where: { totpSecret: { not: null } },
            select: { id: true, totpSecret: true },
          })
        ).map((row) => ({ id: row.id, secret: row.totpSecret })),
      (id, totpSecret) => prisma.platformOwner.update({ where: { id }, data: { totpSecret } })
    ),
    await sealColumn(
      "platform_staff.totp_secret",
      "platform-staff-totp",
      // NO `deletedAt: null` filter, deliberately. A soft-deleted staff row is
      // still in the dump and its secret is exactly as readable as a live one —
      // and it is the account nobody is watching any more. PG-2's soft-delete
      // rule is about what a USER may see; this is about what a stolen backup
      // gives away.
      async () =>
        (
          await prisma.platformStaff.findMany({
            where: { totpSecret: { not: null } },
            select: { id: true, totpSecret: true },
          })
        ).map((row) => ({ id: row.id, secret: row.totpSecret })),
      (id, totpSecret) => prisma.platformStaff.update({ where: { id }, data: { totpSecret } })
    ),
    await sealColumn(
      "notification_settings.api_key",
      "notification-api-key",
      async () =>
        (
          await prisma.notificationSettings.findMany({
            where: { apiKey: { not: null } },
            select: { id: true, apiKey: true },
          })
        ).map((row) => ({ id: row.id, secret: row.apiKey })),
      (id, apiKey) => prisma.notificationSettings.update({ where: { id }, data: { apiKey } })
    ),
  ];

  console.log(
    JSON.stringify(
      {
        secretsAtRest: {
          cipher: status.cipher,
          format: status.format,
          keyId: status.keyId,
          previousKeyId: status.previousKeyId,
          mode: reseal ? "reseal (rotation)" : "seal (deploy)",
          columns: outcomes,
        },
      },
      null,
      2
    )
  );
  const plaintextLeft = outcomes.reduce((total, outcome) => total + outcome.sealed, 0);
  console.log(`secrets:encrypt OK — ${plaintextLeft} secret(s) taken out of the clear`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    await prisma.$disconnect();
    console.error(error);
    process.exit(1);
  });

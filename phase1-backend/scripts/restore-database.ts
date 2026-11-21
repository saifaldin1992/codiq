/**
 * 24-ج — the other half. `pnpm backup:restore`.
 *
 * ============================================================================
 * A RESTORE PATH THAT ONLY EXISTS AS PROSE IS A GUESS
 * ============================================================================
 *
 * Backups are easy to take and easy to believe in. The half that decides
 * whether any of it mattered is this one, and it is the half that is normally
 * written as six bullet points in a document and never executed until the day
 * everybody is panicking. So it is a program, it is in the repository, and
 * `docs/DISASTER_RECOVERY.md` records the timings from actually running it.
 *
 * ============================================================================
 * THE GUARD RAIL: --confirm-overwrite
 * ============================================================================
 *
 * Restoring is destructive by definition — it drops and recreates what it
 * touches. The single most expensive mistake available here is restoring a
 * three-week-old dump over a healthy production database while trying to seed a
 * scratch copy. So the target database's NAME must be typed on the command line
 * and must match the target URL, which makes the destructive act deliberate
 * without making it hard. A `--dry-run` that only decrypts is offered beside it,
 * because most of the time what you actually want is to look inside a dump.
 *
 * ============================================================================
 * MODES
 * ============================================================================
 *
 *   --key latest | --key db-backups/…      fetch from object storage
 *   --from-file  path                      a dump already on disk
 *   --to-file    path                      decrypt only; do not restore
 *   --target     postgres://…              where to restore (default: env)
 *   --confirm-overwrite  dbname            required before anything is written
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { backupKeyring, decryptBackupStream } from "../src/backup/backup-envelope.js";
import {
  backupClient,
  fetchBackup,
  listBackups,
  resolveBackupStorage,
} from "../src/backup/backup-storage.js";

interface Options {
  key: string | null;
  fromFile: string | null;
  toFile: string | null;
  target: string | null;
  confirmOverwrite: string | null;
}

export function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    key: null,
    fromFile: null,
    toFile: null,
    target: null,
    confirmOverwrite: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const take = (): string => {
      if (!value || value.startsWith("--")) throw new Error(`[restore] ${flag} needs a value.`);
      index += 1;
      return value;
    };
    // ق-156: a BARE `--` is accepted and ignored.
    //
    // `pnpm run <script> -- --key latest` is the form muscle memory types — it
    // is what npm requires and what every other script in this repository is
    // invoked with in its own docs. pnpm forwards the separator, and this
    // parser, being strict about unknown arguments, answered
    // «[restore] unknown argument «--».» and exited 1.
    //
    // That was measured, not imagined: it is exactly what happened on the first
    // attempt to verify a real production backup. Strictness is right for a
    // MISSPELLED flag — silently ignoring `--taget` would restore to the wrong
    // place — but refusing a separator that carries no meaning is strictness
    // spent on the operator instead of on the mistake. And this is the tool a
    // person reaches for on the worst day of the year.
    if (flag === "--") continue;
    if (flag === "--key") options.key = take();
    else if (flag === "--from-file") options.fromFile = take();
    else if (flag === "--to-file") options.toFile = take();
    else if (flag === "--target") options.target = take();
    else if (flag === "--confirm-overwrite") options.confirmOverwrite = take();
    else throw new Error(`[restore] unknown argument «${flag}».`);
  }
  if (!options.key && !options.fromFile)
    throw new Error("[restore] give either --key <objectKey|latest> or --from-file <path>.");
  if (options.key && options.fromFile)
    throw new Error("[restore] --key and --from-file are exclusive.");
  return options;
}

function connectionEnvironment(url: string): { env: NodeJS.ProcessEnv; database: string } {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("[restore] the target address names no database.");
  return {
    database,
    // Same reasoning as backup-database.ts: credentials through the environment,
    // never through argv.
    env: {
      ...process.env,
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || "5432",
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGDATABASE: database,
      PGSSLMODE:
        parsed.searchParams.get("sslmode") ??
        (parsed.hostname === "localhost" ? "disable" : "require"),
    },
  };
}

/** The ciphertext, on local disk, whatever it took to get it there. */
async function obtainCiphertext(
  options: Options
): Promise<{ file: string; cleanup: () => Promise<void>; source: string }> {
  if (options.fromFile) {
    await stat(options.fromFile);
    return { file: options.fromFile, cleanup: async () => {}, source: options.fromFile };
  }

  const storage = resolveBackupStorage();
  const client = backupClient(storage);
  let key = options.key as string;
  if (key === "latest") {
    const stored = await listBackups(client, storage);
    if (!stored.length)
      throw new Error("[restore] the bucket holds no backups under the configured prefix.");
    key = stored[0]!.key; // listBackups sorts newest first
  }

  const directory = await mkdtemp(path.join(tmpdir(), "codiq-restore-"));
  const file = path.join(directory, "dump.enc");
  const fetched = await fetchBackup(client, storage, key);
  const digest = crypto.createHash("sha256");
  await pipeline(
    (async function* tee() {
      for await (const chunk of fetched.body) {
        digest.update(chunk);
        yield chunk;
      }
    })(),
    createWriteStream(file)
  );

  const actual = digest.digest("hex");
  if (fetched.expectedSha256 && fetched.expectedSha256 !== actual) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `[restore] «${key}» does not match the checksum recorded when it was written ` +
        `(expected ${fetched.expectedSha256}, got ${actual}). The stored object has been altered or corrupted.`
    );
  }
  return { file, cleanup: () => rm(directory, { recursive: true, force: true }), source: key };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const options = parseArguments(process.argv.slice(2));
  const keyring = backupKeyring();
  const obtained = await obtainCiphertext(options);

  let sealedAt: string | null = null;
  let sealedWith: string | null = null;
  const plaintext = () =>
    decryptBackupStream(createReadStream(obtained.file), keyring, (header) => {
      sealedAt = header.createdAt;
      sealedWith = header.kid;
    });

  try {
    if (options.toFile) {
      await pipeline(plaintext(), createWriteStream(options.toFile));
      const { size } = await stat(options.toFile);
      console.log(
        JSON.stringify(
          {
            restore: {
              status: "decrypted",
              source: obtained.source,
              into: options.toFile,
              plaintextBytes: size,
              sealedAt,
              sealedWith,
            },
          },
          null,
          2
        )
      );
      console.log("backup:restore OK");
      return;
    }

    const target = options.target ?? process.env.CODIQ_RESTORE_TARGET_URL ?? null;
    if (!target)
      throw new Error(
        "[restore] give --target <postgres url> (or --to-file to decrypt without restoring)."
      );
    const { env, database } = connectionEnvironment(target);

    if (options.confirmOverwrite !== database) {
      throw new Error(
        `[restore] refusing to write to «${database}» without --confirm-overwrite ${database}. ` +
          `pg_restore --clean DROPS the objects it replaces; naming the database out loud is the only thing ` +
          `standing between a scratch restore and an overwritten production.`
      );
    }

    // --clean --if-exists so a partially populated target is replaced rather
    // than collided with; --no-owner/--no-acl because the dump's roles are
    // Neon's and the target's are not. --exit-on-error is the important one:
    // without it pg_restore reports success having skipped whatever failed.
    const restore = spawn(
      "pg_restore",
      [
        "--dbname",
        database,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--single-transaction",
      ],
      { env, stdio: ["pipe", "inherit", "pipe"] }
    );
    let errors = "";
    restore.stderr.on("data", (chunk) => (errors += chunk));

    const exited = new Promise<number>((resolve, reject) => {
      restore.on("error", reject);
      restore.on("close", (code) => resolve(code ?? -1));
    });

    await pipeline(plaintext(), restore.stdin);
    const code = await exited;
    if (code !== 0)
      throw new Error(`[restore] pg_restore exited ${code}.\n${errors.trim().slice(-4000)}`);

    console.log(
      JSON.stringify(
        {
          restore: {
            status: "restored",
            source: obtained.source,
            into: database,
            sealedAt,
            sealedWith,
            elapsedMs: Date.now() - startedAt,
          },
        },
        null,
        2
      )
    );
    console.log("backup:restore OK");
  } finally {
    await obtained.cleanup();
  }
}

/**
 * ق-156 — only when this file IS the command.
 *
 * Without this guard, `import`ing the module to unit-test `parseArguments`
 * would RUN A RESTORE: fetch the latest production ciphertext, decrypt it, and —
 * if a target happened to be configured in the environment — drop and recreate
 * its tables. The same omission was found in `create-first-owner.ts` and fixed
 * the same way; it is worse here, because there the accident creates a row and
 * here it destroys a database.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

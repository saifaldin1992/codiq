/**
 * 24-ج — the scheduled dump. `pnpm backup:run`.
 *
 * ============================================================================
 * WHY THIS RUNS ON RAILWAY AND NOT IN GITHUB ACTIONS
 * ============================================================================
 *
 * The obvious design is a GitHub Actions cron holding the production connection
 * string in a repository secret. `docs/DEPLOYMENT.md` forbids it in as many
 * words — «ممنوع Neon والإنتاج» — and the rule is right rather than merely
 * binding: CI runs on every pull request, including pull requests from a branch
 * anyone can push. A production credential in that blast radius is a credential
 * one careless workflow edit away from being printed.
 *
 * The production connection string already exists in exactly one place: the
 * Railway environment. So the backup runs THERE — a service in the same Railway
 * project and environment, with a cron schedule and this file as its start
 * command. It inherits the variables that are already present. The credential
 * surface does not widen by a single copy, which is the whole design constraint.
 *
 * ============================================================================
 * ORDER OF OPERATIONS, AND WHY UPLOAD COMES LAST
 * ============================================================================
 *
 * dump → encrypt → spool to disk → CHECK pg_dump's exit code → upload → prune.
 *
 * The exit-code check sits between the spool and the upload on purpose. A
 * `pg_dump` that dies halfway still produces a perfectly well-formed prefix of a
 * dump on stdout, and that prefix encrypts and uploads without complaint. Every
 * silent backup disaster is shaped like this: the object exists, the log says
 * success, and the contents are a truncated database nobody reads until the day
 * it matters. Nothing is uploaded until `pg_dump` has exited 0.
 *
 * Pruning runs last and only after a successful upload, so a run that fails to
 * produce a new copy can never be the run that deletes an old one.
 */

import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { BACKUP_POLICY } from "../src/backup/backup-policy.js";
import { currentBackupKey, encryptBackupStream } from "../src/backup/backup-envelope.js";
import {
  backupClient,
  backupObjectKey,
  deleteBackup,
  listBackups,
  resolveBackupStorage,
  selectExpiredBackups,
  spoolCiphertext,
  uploadBackup,
} from "../src/backup/backup-storage.js";

/**
 * The unpooled address, for the same reason `phase1:db:migrate` uses it: a
 * pooler multiplexes sessions, and `pg_dump` needs one stable session holding a
 * repeatable-read snapshot for the length of the dump.
 */
function databaseUrl(): string {
  const url = process.env.CODIQ_POSTGRES_URL_UNPOOLED ?? process.env.CODIQ_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[backup] no database address: set CODIQ_POSTGRES_URL_UNPOOLED (preferred — pg_dump needs one unpooled session).",
    );
  }
  return url;
}

/**
 * Connection settings go to `pg_dump` through the environment, never through
 * argv. `pg_dump -d "postgres://user:password@…"` puts the password in the
 * process table where any other process on the box — and most crash reporters —
 * can read it. libpq reads PG* variables with identical semantics and no such
 * exposure.
 */
function connectionEnvironment(url: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("[backup] the database address names no database.");
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database,
    // Neon terminates non-TLS connections, so `require` is the floor for
    // anything remote and an explicit mode in the URL always wins. A local
    // server is a drill or a developer's manual dump and typically has no TLS
    // at all; demanding it there fails honest work for no security gain, since
    // the connection never leaves the machine.
    PGSSLMODE:
      parsed.searchParams.get("sslmode") ??
      (isLocalHost(parsed.hostname) ? "disable" : "require"),
  };
}

/** Local means the bytes never touch a network, so TLS buys nothing. */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function pgDumpMajor(environment: NodeJS.ProcessEnv): Promise<number> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("pg_dump", ["--version"], { env: environment });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("error", () =>
      reject(
        new Error(
          "[backup] `pg_dump` is not on PATH in this container. Add the PostgreSQL client to the image " +
            `(major ${BACKUP_POLICY.productionServerMajor} or newer) — see docs/DISASTER_RECOVERY.md.`,
        ),
      ),
    );
    child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error("[backup] `pg_dump --version` failed."))));
  });
  const match = /(\d+)/.exec(output);
  if (!match) throw new Error(`[backup] could not read a version out of «${output.trim()}».`);
  return Number(match[1]);
}

/** `--to-file <path>`: dump and encrypt, but keep it local. */
function parseToFile(argv: readonly string[]): string | null {
  const at = argv.indexOf("--to-file");
  if (at === -1) return null;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error("[backup] --to-file needs a path.");
  return value;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const toFile = parseToFile(process.argv.slice(2));
  const url = databaseUrl();
  const environment = connectionEnvironment(url);

  // `pg_dump` refuses a server NEWER than itself, and the refusal arrives as a
  // non-zero exit inside a cron nobody watches. Checking first turns a silently
  // skipped backup into a message that names the fix.
  //
  // The check is scoped to remote hosts on purpose. A local address is a drill
  // or a developer's manual dump, and its server is whatever that machine runs —
  // holding it to production's major would fail honest local work for no reason.
  // Remote means production, and there the floor is real.
  const clientMajor = await pgDumpMajor(environment);
  if (!isLocalHost(environment.PGHOST ?? "") && clientMajor < BACKUP_POLICY.productionServerMajor) {
    throw new Error(
      `[backup] pg_dump is major ${clientMajor} but production runs PostgreSQL ${BACKUP_POLICY.productionServerMajor}. ` +
        `pg_dump cannot dump a server newer than itself — every run would fail. Install a newer client in the image.`,
    );
  }

  const key = currentBackupKey();
  const storage = toFile ? null : resolveBackupStorage();
  const client = storage ? backupClient(storage) : null;

  // -Fc is the custom format: already deflated (so a second gzip pass would buy
  // nothing but CPU) and, unlike plain SQL, it lets `pg_restore` rebuild
  // selectively — one table back, without replaying the whole company.
  // --no-owner/--no-acl because the restore target's roles are never Neon's.
  const dump = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--verbose"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let dumpErrors = "";
  dump.stderr.on("data", (chunk) => (dumpErrors += chunk));

  const exited = new Promise<number>((resolve, reject) => {
    dump.on("error", reject);
    dump.on("close", (code) => resolve(code ?? -1));
  });

  const spooled = await spoolCiphertext(encryptBackupStream(dump.stdout, key, { createdAt: startedAt }));
  const code = await exited;

  if (code !== 0) {
    await spooled.cleanup();
    // pg_dump's stderr can carry the host but never the password (it is not in
    // argv and libpq does not echo it), so this is safe to surface.
    throw new Error(`[backup] pg_dump exited ${code}; nothing was uploaded.\n${dumpErrors.trim().slice(-2000)}`);
  }

  // The dump is only published — to disk or to the bucket — after pg_dump has
  // exited 0, so a half-dump can never become the newest "backup".
  if (toFile) {
    try {
      await copyFile(spooled.file, toFile);
    } finally {
      await spooled.cleanup();
    }
    console.log(
      JSON.stringify(
        {
          backup: {
            status: "written",
            file: toFile,
            ciphertextBytes: spooled.bytes,
            sha256: spooled.sha256,
            sealedWithKeyId: key.keyId,
            pgDumpMajor: clientMajor,
            elapsedMs: Date.now() - startedAt.getTime(),
          },
        },
        null,
        2,
      ),
    );
    console.log("backup:run OK");
    return;
  }

  const objectKey = backupObjectKey(startedAt);
  try {
    await uploadBackup(client!, storage!, objectKey, spooled);
  } finally {
    await spooled.cleanup();
  }

  // Only now, with a fresh copy provably in the bucket, may anything be deleted.
  const stored = await listBackups(client!, storage!);
  const expired = selectExpiredBackups(stored, new Date());
  for (const object of expired) await deleteBackup(client!, storage!, object.key);

  console.log(
    JSON.stringify(
      {
        backup: {
          status: "uploaded",
          key: objectKey,
          ciphertextBytes: spooled.bytes,
          sha256: spooled.sha256,
          sealedWithKeyId: key.keyId,
          pgDumpMajor: clientMajor,
          // ق-241: WHERE these bytes now live, in the line the cron writes.
          // `shared-with-product-images` means one lost storage account takes
          // the dumps and the images together — the operator must be able to
          // read that off a successful run, not discover it mid-incident.
          failureDomain: storage!.failureDomain,
          elapsedMs: Date.now() - startedAt.getTime(),
          retention: {
            keptObjects: stored.length + 1 - expired.length,
            prunedObjects: expired.length,
            retentionDays: BACKUP_POLICY.retentionDays,
            minimumKeptCopies: BACKUP_POLICY.minimumKeptCopies,
          },
        },
      },
      null,
      2,
    ),
  );
  console.log("backup:run OK");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

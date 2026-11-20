/**
 * 24-ج — where the encrypted dumps live, and what is allowed to delete one.
 *
 * ============================================================================
 * WHICH BUCKET, AND THE FAILURE DOMAIN THAT ANSWER DECIDES
 * ============================================================================
 *
 * This used to read the `PRODUCT_S3_*` variables and nothing else — the same
 * bucket that carries product images, with the dumps under a prefix of their
 * own. The saving was real (no new credential to mint, rotate or forget before
 * launch) and the cost was written into `docs/DISASTER_RECOVERY.md` as named
 * gap #2: THE DUMPS SHARE A FAILURE DOMAIN WITH THE IMAGES. Lose the storage
 * account, or have its keys revoked, and both go at once — and a backup that
 * dies with the thing it is backing up is not a backup, it is a copy.
 *
 * ق-241 gives the separation a way to exist. `CODIQ_BACKUP_S3_*` overrides the
 * product family entirely: a different bucket, and — this is the part that
 * matters — a different ACCOUNT with its own keys, so revoking or losing one
 * does not reach the other.
 *
 * TWO RULES MAKE THIS SAFE RATHER THAN DECORATIVE:
 *
 *   · ALL OR NOTHING. The moment any `CODIQ_BACKUP_S3_*` variable is present,
 *     the whole family is required. A half-configured dedicated destination
 *     must NEVER quietly fall back to the product bucket: the operator would
 *     believe the dumps are isolated while they sit next to the images, which
 *     is strictly worse than not having tried — the belief is what gets acted
 *     on during an incident.
 *
 *   · THE ANSWER TRAVELS WITH THE CONFIG. `failureDomain` is carried on the
 *     config object, printed in every run's JSON line, and reported by
 *     `pnpm env:check` and `/ready`. «Where do the backups live» must be
 *     answerable without reading this file.
 *
 * Falling back to the product bucket is still supported and still the default,
 * because a platform with backups in the wrong place beats a platform whose
 * backup job refuses to run. It just no longer does it silently.
 *
 * ============================================================================
 * WHY THE CIPHERTEXT GOES TO DISK BEFORE IT GOES TO S3
 * ============================================================================
 *
 * `PutObject` needs a `Content-Length`. Handing the SDK a stream of unknown
 * length makes it fall back to chunked transfer encoding, which a good share of
 * S3-compatible implementations reject outright — and the alternative, real
 * multipart upload, means adding `@aws-sdk/lib-storage` (a new dependency, when
 * the standing rule is not to add one).
 *
 * So the encrypted stream is written to a temporary file first, then uploaded
 * with an exact length. Memory stays flat either way — the dump is never held
 * whole in RAM — and the spool buys two things worth having: an exact byte
 * count, and a SHA-256 of the ciphertext computed in the same pass, stored as
 * object metadata so a restore can prove the bytes it fetched are the bytes that
 * were written.
 */

import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { BACKUP_POLICY } from "./backup-policy.js";

const CHECKSUM_METADATA_KEY = "codiq-ciphertext-sha256";

/**
 * `dedicated` — its own bucket and its own keys, so losing one storage account
 * does not take the dumps with it. `shared-with-product-images` — the same
 * bucket the platform serves images from, under a private prefix: supported,
 * defaulted to, and never silent.
 */
export type BackupFailureDomain = "dedicated" | "shared-with-product-images";

export interface BackupStorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly failureDomain: BackupFailureDomain;
}

/** The dedicated family, and the product family it falls back to. Order matters: the first four are required. */
const VARIABLE_FAMILIES = {
  dedicated: {
    prefix: "CODIQ_BACKUP_S3_",
    required: ["CODIQ_BACKUP_S3_ENDPOINT", "CODIQ_BACKUP_S3_BUCKET", "CODIQ_BACKUP_S3_ACCESS_KEY_ID", "CODIQ_BACKUP_S3_SECRET_ACCESS_KEY"],
    region: "CODIQ_BACKUP_S3_REGION",
    forcePathStyle: "CODIQ_BACKUP_S3_FORCE_PATH_STYLE",
  },
  shared: {
    prefix: "PRODUCT_S3_",
    required: ["PRODUCT_S3_ENDPOINT", "PRODUCT_S3_BUCKET", "PRODUCT_S3_ACCESS_KEY_ID", "PRODUCT_S3_SECRET_ACCESS_KEY"],
    region: "PRODUCT_S3_REGION",
    forcePathStyle: "PRODUCT_S3_FORCE_PATH_STYLE",
  },
} as const;

const set = (environment: NodeJS.ProcessEnv, name: string) => (environment[name] ?? "").trim().length > 0;

/** True as soon as ANY dedicated variable exists — including the optional ones, so a lone typo'd region is still a configuration attempt. */
export function dedicatedBackupStorageAttempted(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(environment).some((name) => name.startsWith(VARIABLE_FAMILIES.dedicated.prefix) && set(environment, name));
}

/**
 * Mirrors `product-image-storage.service.ts` exactly for the shared family,
 * including the `!== "false"` path-style rule — a backup that reaches a
 * different bucket than the rest of the platform because the two readers
 * disagreed about a default would be a genuinely nasty surprise.
 */
export function resolveBackupStorage(environment: NodeJS.ProcessEnv = process.env): BackupStorageConfig {
  const dedicated = dedicatedBackupStorageAttempted(environment);
  const family = dedicated ? VARIABLE_FAMILIES.dedicated : VARIABLE_FAMILIES.shared;
  const missing = family.required.filter((name) => !set(environment, name));
  if (missing.length) {
    throw new Error(
      dedicated
        ? `[backup-storage] a DEDICATED backup destination is half-configured: ${missing.join(", ")} unset. ` +
          `Refusing to fall back to the product-image bucket — believing the dumps are isolated when they are not is worse than knowing they share it. ` +
          `Set all four, or unset every CODIQ_BACKUP_S3_* variable to use the product bucket deliberately.`
        : `[backup-storage] object storage is not configured: ${missing.join(", ")} unset. ` +
          `These are the same variables the platform already uses for product images.`,
    );
  }
  const read = (name: string) => environment[name] as string;
  return {
    endpoint: read(family.required[0]!),
    bucket: read(family.required[1]!),
    accessKeyId: read(family.required[2]!),
    secretAccessKey: read(family.required[3]!),
    region: environment[family.region] ?? "us-east-1",
    forcePathStyle: environment[family.forcePathStyle] !== "false",
    failureDomain: dedicated ? "dedicated" : "shared-with-product-images",
  };
}

export function backupClient(config: BackupStorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

/**
 * Object keys are ISO-8601 with `:` replaced — S3 tolerates colons but half the
 * tooling around it does not. The format keeps lexicographic order identical to
 * chronological order, which is what lets the pruner sort by key and be right.
 */
export function backupObjectKey(at: Date): string {
  return `${BACKUP_POLICY.objectPrefix}${at.toISOString().replace(/[:]/g, "-").replace(/\.\d+Z$/, "Z")}.codiq-pgdump.enc`;
}

export interface SpooledCiphertext {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  cleanup(): Promise<void>;
}

/** Writes the encrypted stream to a temp file, measuring it as it goes. */
export async function spoolCiphertext(source: AsyncIterable<Buffer>): Promise<SpooledCiphertext> {
  const directory = await mkdtemp(path.join(tmpdir(), "codiq-backup-"));
  const file = path.join(directory, "dump.enc");
  const digest = crypto.createHash("sha256");
  await pipeline(
    (async function* tee() {
      for await (const chunk of source) {
        digest.update(chunk);
        yield chunk;
      }
    })(),
    createWriteStream(file),
  );
  const { size } = await stat(file);
  return {
    file,
    bytes: size,
    sha256: digest.digest("hex"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function uploadBackup(
  client: S3Client,
  config: BackupStorageConfig,
  key: string,
  spooled: SpooledCiphertext,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: createReadStream(spooled.file),
      ContentLength: spooled.bytes,
      ContentType: "application/octet-stream",
      Metadata: { [CHECKSUM_METADATA_KEY]: spooled.sha256 },
    }),
  );
}

export interface StoredBackup {
  readonly key: string;
  readonly bytes: number;
  readonly lastModified: Date;
}

export async function listBackups(client: S3Client, config: BackupStorageConfig): Promise<StoredBackup[]> {
  const found: StoredBackup[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: BACKUP_POLICY.objectPrefix, ContinuationToken: token }),
    );
    for (const object of (page.Contents ?? []) as _Object[]) {
      if (!object.Key || !object.Key.endsWith(".enc")) continue;
      found.push({ key: object.Key, bytes: object.Size ?? 0, lastModified: object.LastModified ?? new Date(0) });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // newest first
}

/**
 * Decides what the pruner may delete. Pure, and separated from the deleting so
 * the guard can interrogate the arithmetic without a bucket — deletion is the
 * one step in this whole system with no undo, and it deserves a decision
 * function somebody can read.
 */
export function selectExpiredBackups(backups: readonly StoredBackup[], now: Date): StoredBackup[] {
  const newestFirst = [...backups].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const cutoff = now.getTime() - BACKUP_POLICY.retentionDays * 24 * 60 * 60 * 1000;
  // The floor is applied to POSITION, not to age: whatever the dates claim, the
  // newest `minimumKeptCopies` objects are never candidates. A stopped cron or a
  // skewed clock therefore cannot age the whole bucket out from under us.
  return newestFirst.slice(BACKUP_POLICY.minimumKeptCopies).filter((b) => b.lastModified.getTime() < cutoff);
}

export async function deleteBackup(client: S3Client, config: BackupStorageConfig, key: string): Promise<void> {
  if (!key.startsWith(BACKUP_POLICY.objectPrefix)) {
    throw new Error(`[backup-storage] refusing to delete «${key}»: outside the ${BACKUP_POLICY.objectPrefix} prefix.`);
  }
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

export interface FetchedBackup {
  readonly body: AsyncIterable<Uint8Array>;
  readonly expectedSha256: string | null;
}

export async function fetchBackup(client: S3Client, config: BackupStorageConfig, key: string): Promise<FetchedBackup> {
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  if (!response.Body) throw new Error(`[backup-storage] «${key}» returned no body.`);
  return {
    body: response.Body as unknown as Readable,
    expectedSha256: response.Metadata?.[CHECKSUM_METADATA_KEY] ?? null,
  };
}

/**
 * 24-ج — a database dump encrypted on the way out, in frames, so that a dump
 * which arrives half-written fails loudly instead of restoring half a company.
 *
 * ============================================================================
 * WHY NOT `sealSecret` FROM auth/secret-box.ts
 * ============================================================================
 *
 * The platform already has AES-256-GCM with HKDF key derivation, and reusing it
 * was the first thing considered. It does not fit, for a reason that is about
 * shape rather than taste: `sealSecret(purpose, plaintext: string)` takes a
 * whole string and returns a whole base64url string. A TOTP secret is 32 bytes.
 * A database dump is not — it is the entire company, and it only grows. Sealing
 * it that way would hold the plaintext AND the ciphertext AND a 33%-inflated
 * base64 copy in memory simultaneously, on a container sized for an HTTP server.
 * The backup would start failing at exactly the moment the business became worth
 * backing up.
 *
 * So this module borrows the *discipline* of secret-box.ts — HKDF-SHA256 from a
 * root, AES-256-GCM, a versioned envelope carrying a key id — and changes the
 * shape to a stream. One crypto idiom in the platform, two shapes.
 *
 * ============================================================================
 * WHY A SEPARATE KEY, `CODIQ_BACKUP_ENCRYPTION_KEY`
 * ============================================================================
 *
 * The tempting answer is to reuse `CODIQ_ENCRYPTION_KEY`: one fewer secret to
 * mint before launch, one fewer thing to lose. Three arguments beat it, and the
 * third is decisive.
 *
 * 1. BLAST RADIUS. Whoever holds the backup key can read every row this company
 *    has, in the clear. Whoever holds `CODIQ_ENCRYPTION_KEY` can read the TOTP
 *    secrets inside a database they already reached. The second capability is
 *    strictly smaller. Handing one key both jobs prices the smaller capability
 *    at the larger one's risk, permanently.
 *
 * 2. OPPOSITE STORAGE RULES. `CODIQ_ENCRYPTION_KEY` should live in exactly one
 *    place — the Railway environment — and nowhere else; a copy of it in a safe
 *    is a liability. The backup key must be the opposite: escrowed OUTSIDE
 *    Railway, because the disaster it is insurance against includes losing
 *    Railway. Two keys with contradictory handling rules cannot be one key.
 *
 * 3. ROTATION ORPHANS DUMPS — the decisive one. `CODIQ_ENCRYPTION_KEY` is built
 *    to be rotated: `CODIQ_ENCRYPTION_KEY_PREVIOUS` exists for it and
 *    `pnpm secrets:encrypt --reseal` moves rows onto the new key. Resealing
 *    walks database ROWS. It does not — cannot — reach into S3 and rewrite
 *    ninety encrypted dumps. So every routine rotation of the app key would
 *    silently render every prior dump undecryptable, and nobody would find out
 *    until a restore. The two lifecycles must not be coupled.
 *
 * This module therefore reads its own key and, mirroring secret-box.ts, accepts
 * `CODIQ_BACKUP_ENCRYPTION_KEY_PREVIOUS` for decrypt only — so rotating the
 * BACKUP key does not orphan dumps either.
 *
 * ============================================================================
 * NO DEVELOPMENT FALLBACK, DELIBERATELY
 * ============================================================================
 *
 * secret-box.ts falls back to a public constant under `NODE_ENV=development`,
 * which is right for it: a developer needs the app to boot. This module refuses
 * to. A dump encrypted under a root that is printed in the repository is not an
 * encrypted dump — it is a plaintext dump wearing a costume, and the costume is
 * what stops anyone from noticing. There is no environment in which producing
 * one is better than producing none, so the failure is a hard throw everywhere.
 *
 * ============================================================================
 * THE FRAME FORMAT, AND THE ONE THING IT EXISTS TO CATCH
 * ============================================================================
 *
 *     magic      8 bytes   "CODIQBK1"
 *     headerLen  uint32BE
 *     header     JSON, UTF-8: { v, alg, kid, chunkBytes, createdAt }
 *     frame*     uint32BE ciphertextLen | 12-byte IV | 16-byte tag | ciphertext
 *     final      a frame over zero plaintext bytes, flagged in its AAD
 *
 * Each frame carries its own random IV and its own authentication tag, and the
 * AAD binds three things into that tag: a hash of the header (so `kid` or `alg`
 * cannot be swapped under otherwise-valid frames), the frame's INDEX (so frames
 * cannot be reordered or dropped), and whether the frame is the last one.
 *
 * That last flag is the whole point. The classic silent backup failure is not a
 * corrupted dump — corruption is loud. It is a TRUNCATED dump: an upload that
 * died at 80%, a disk that filled, a container killed mid-write. Without an
 * end-of-stream marker inside the authenticated envelope, such a file decrypts
 * perfectly, restores without error, and hands you a database that is missing
 * its last tables while every log line says success. With the marker, decryption
 * of a truncated file throws before a single byte reaches `pg_restore`.
 */

import crypto from "node:crypto";
import { BACKUP_POLICY } from "./backup-policy.js";

const MAGIC = Buffer.from("CODIQBK1", "utf8");
const FORMAT_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LENGTH_BYTES = 4;

/**
 * Fixed, non-secret, and different from every other salt in the platform. HKDF
 * separation means a backup key and an app key of identical text still derive
 * different bytes, so a copy-paste between the two variables produces garbage
 * rather than a working-but-wrong configuration.
 */
const SALT = Buffer.from("codiq/24c/backup-envelope", "utf8");
const KEY_LABEL = "codiq:backup:pgdump";
const KEY_ID_LABEL = "codiq:backup-kid";
const MINIMUM_ROOT_LENGTH = 32;

export interface BackupKey {
  readonly keyId: string;
  readonly key: Buffer;
}

function derive(root: string, label: string, bytes: number): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(root, "utf8"), SALT, Buffer.from(label, "utf8"), bytes)
  );
}

function keyFromRoot(root: string): BackupKey {
  return {
    keyId: derive(root, KEY_ID_LABEL, 4).toString("hex"),
    key: derive(root, KEY_LABEL, KEY_BYTES),
  };
}

function readRoot(environment: NodeJS.ProcessEnv, variable: string): string | null {
  const value = environment[variable]?.trim();
  if (!value) return null;
  if (value.length < MINIMUM_ROOT_LENGTH) {
    throw new Error(
      `${variable} is too short: use at least ${MINIMUM_ROOT_LENGTH} characters (e.g. \`openssl rand -base64 48\`).`
    );
  }
  return value;
}

/** The key new dumps are sealed with. Throws when unset — see the header. */
export function currentBackupKey(environment: NodeJS.ProcessEnv = process.env): BackupKey {
  const root = readRoot(environment, "CODIQ_BACKUP_ENCRYPTION_KEY");
  if (!root) {
    throw new Error(
      "Missing required environment variable: CODIQ_BACKUP_ENCRYPTION_KEY. " +
        "There is no development fallback: a dump sealed with a key printed in the repository is a plaintext dump " +
        "that merely looks encrypted. Generate one with `openssl rand -base64 48` and escrow it OUTSIDE Railway — " +
        "a key that only exists in the environment you are insuring is not a backup key."
    );
  }
  return keyFromRoot(root);
}

/**
 * Every key a dump in the bucket might have been sealed with: the current one
 * plus, when declared, the previous one. Decrypt-only, so a rotation keeps old
 * dumps readable instead of orphaning them.
 */
export function backupKeyring(environment: NodeJS.ProcessEnv = process.env): BackupKey[] {
  const keyring = [currentBackupKey(environment)];
  const previous = readRoot(environment, "CODIQ_BACKUP_ENCRYPTION_KEY_PREVIOUS");
  if (previous) keyring.push(keyFromRoot(previous));
  return keyring;
}

interface EnvelopeHeader {
  v: number;
  alg: string;
  kid: string;
  chunkBytes: number;
  createdAt: string;
}

/**
 * AAD = sha256(header) ‖ uint64BE(index) ‖ uint8(final). Fixed width, and it
 * makes header substitution, frame reordering and truncation all tag failures
 * rather than silent successes.
 */
function frameAad(headerDigest: Buffer, index: number, final: boolean): Buffer {
  const suffix = Buffer.alloc(9);
  suffix.writeBigUInt64BE(BigInt(index), 0);
  suffix.writeUInt8(final ? 1 : 0, 8);
  return Buffer.concat([headerDigest, suffix]);
}

function sealFrame(
  key: BackupKey,
  headerDigest: Buffer,
  index: number,
  final: boolean,
  plaintext: Buffer
): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key.key, iv);
  cipher.setAAD(frameAad(headerDigest, index, final));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(ciphertext.length, 0);
  return Buffer.concat([length, iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Encrypt an arbitrary byte stream into the framed envelope.
 *
 * Written as an async generator rather than a `Transform` so the guard can drive
 * it with a plain array of buffers and assert on the exact bytes — a backup
 * format whose only test needs a database and a bucket is a format nobody tests.
 */
export async function* encryptBackupStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  key: BackupKey,
  options: { chunkBytes?: number; createdAt?: Date } = {}
): AsyncGenerator<Buffer> {
  const chunkBytes = options.chunkBytes ?? BACKUP_POLICY.chunkBytes;
  const header: EnvelopeHeader = {
    v: FORMAT_VERSION,
    alg: ALGORITHM,
    kid: key.keyId,
    chunkBytes,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const headerLength = Buffer.alloc(LENGTH_BYTES);
  headerLength.writeUInt32BE(headerBytes.length, 0);
  yield Buffer.concat([MAGIC, headerLength, headerBytes]);

  const headerDigest = crypto.createHash("sha256").update(headerBytes).digest();
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let index = 0;

  for await (const piece of source as AsyncIterable<Uint8Array>) {
    pending.push(Buffer.from(piece));
    pendingBytes += piece.byteLength;
    // Drain in whole chunks so peak memory is bounded by chunkBytes plus one
    // inbound piece, no matter how large the dump grows.
    while (pendingBytes >= chunkBytes) {
      const joined = Buffer.concat(pending, pendingBytes);
      yield sealFrame(key, headerDigest, index++, false, joined.subarray(0, chunkBytes));
      const rest = joined.subarray(chunkBytes);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  }

  if (pendingBytes > 0)
    yield sealFrame(key, headerDigest, index++, false, Buffer.concat(pending, pendingBytes));
  // The end-of-stream marker. Its absence is what makes a truncated dump fail.
  yield sealFrame(key, headerDigest, index, true, Buffer.alloc(0));
}

/** Pulls exact byte counts out of a stream that arrives in arbitrary pieces. */
class ByteReader {
  private buffered: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(private readonly iterator: AsyncIterator<Uint8Array>) {}

  /** Exactly `count` bytes, or null at a clean end of stream. */
  async read(count: number): Promise<Buffer | null> {
    while (this.buffered.length < count) {
      if (this.done) {
        if (this.buffered.length === 0) return null;
        throw new Error(
          `[backup-envelope] the stream ended mid-structure: wanted ${count} bytes, had ${this.buffered.length}. ` +
            `This file is truncated — do NOT restore from it.`
        );
      }
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
    }
    const taken = this.buffered.subarray(0, count);
    this.buffered = this.buffered.subarray(count);
    return Buffer.from(taken);
  }

  /** Like `read`, but a short stream is always an error. */
  async readExact(count: number, what: string): Promise<Buffer> {
    const chunk = await this.read(count);
    if (!chunk) {
      throw new Error(
        `[backup-envelope] the stream ended before ${what}. This file is truncated — do NOT restore from it.`
      );
    }
    return chunk;
  }
}

export interface DecryptedEnvelope {
  readonly header: EnvelopeHeader;
}

/**
 * Decrypt the framed envelope, verifying every frame's tag and refusing a stream
 * that stops before its end-of-stream marker.
 *
 * Yields plaintext only. `onHeader` reports the metadata (which key sealed it,
 * when) without forcing callers to peek at the byte layout.
 */
export async function* decryptBackupStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  keyring: readonly BackupKey[],
  onHeader?: (header: EnvelopeHeader) => void
): AsyncGenerator<Buffer> {
  const iterable = source as AsyncIterable<Uint8Array>;
  const iterator = (iterable[Symbol.asyncIterator]?.() ??
    (source as Iterable<Uint8Array>)[Symbol.iterator]()) as AsyncIterator<Uint8Array>;
  const reader = new ByteReader(iterator);

  const magic = await reader.readExact(MAGIC.length, "the file magic");
  if (!magic.equals(MAGIC)) {
    throw new Error(
      `[backup-envelope] this is not a Codiq backup envelope (magic was ${JSON.stringify(magic.toString("latin1"))}). ` +
        `Check the object key before restoring.`
    );
  }

  const headerLength = (await reader.readExact(LENGTH_BYTES, "the header length")).readUInt32BE(0);
  const headerBytes = await reader.readExact(headerLength, "the header");
  const header = JSON.parse(headerBytes.toString("utf8")) as EnvelopeHeader;

  if (header.v !== FORMAT_VERSION) {
    throw new Error(
      `[backup-envelope] envelope format v${header.v} is not supported by this build (expects v${FORMAT_VERSION}).`
    );
  }
  if (header.alg !== ALGORITHM) {
    throw new Error(
      `[backup-envelope] unexpected algorithm «${header.alg}»; this build only opens ${ALGORITHM}.`
    );
  }

  const key = keyring.find((candidate) => candidate.keyId === header.kid);
  if (!key) {
    throw new Error(
      `[backup-envelope] no key with id ${header.kid} is declared. This dump was sealed with a key that is neither ` +
        `CODIQ_BACKUP_ENCRYPTION_KEY nor CODIQ_BACKUP_ENCRYPTION_KEY_PREVIOUS — recover that key from escrow; ` +
        `the ciphertext is useless without it.`
    );
  }
  onHeader?.(header);

  const headerDigest = crypto.createHash("sha256").update(headerBytes).digest();
  let index = 0;

  for (;;) {
    const lengthBytes = await reader.read(LENGTH_BYTES);
    if (!lengthBytes) {
      // A clean end of stream HERE means the final marker never arrived.
      throw new Error(
        `[backup-envelope] the envelope ended after ${index} frame(s) without its end-of-stream marker. ` +
          `The upload was cut short — this dump is INCOMPLETE and must not be restored.`
      );
    }
    const ciphertextLength = lengthBytes.readUInt32BE(0);
    const iv = await reader.readExact(IV_BYTES, `frame ${index}'s nonce`);
    const tag = await reader.readExact(TAG_BYTES, `frame ${index}'s authentication tag`);
    const ciphertext =
      ciphertextLength === 0
        ? Buffer.alloc(0)
        : await reader.readExact(ciphertextLength, `frame ${index}'s body`);

    // A zero-length frame is only ever the terminator, so the flag it must be
    // authenticated under is known before the tag is checked.
    const final = ciphertextLength === 0;
    const decipher = crypto.createDecipheriv(ALGORITHM, key.key, iv);
    decipher.setAAD(frameAad(headerDigest, index, final));
    decipher.setAuthTag(tag);

    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error(
        `[backup-envelope] frame ${index} failed authentication. The dump has been altered, reordered or corrupted ` +
          `in storage — do NOT restore from it. Reach for the previous object under the same prefix.`
      );
    }

    if (final) return;
    if (plaintext.length > 0) yield plaintext;
    index += 1;
  }
}

/** Convenience for the guard and small payloads. Never used on a real dump. */
export async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

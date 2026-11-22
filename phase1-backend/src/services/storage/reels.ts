/**
 * Object storage — reels. Split verbatim from
 * product-image-storage.service.ts (review batch 3, ت-٤);
 * product-image-storage.service.ts re-exports what it always exported.
 */
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { HttpError } from "../../auth/auth.errors.js";
import { s3Config, client } from "./bucket.js";

// ── Marketplace M10: short videos ──────────────────────────────────────────

/** A reel's ceiling. Thirty seconds of phone video at a sensible bitrate fits well inside it. */
export const REEL_MAX_BYTES = 30 * 1024 * 1024;

export const reelVideoConstraints = {
  maxBytes: REEL_MAX_BYTES,
  allowedContentTypes: new Set(["video/mp4", "video/webm", "video/quicktime"]),
};

/**
 * The container is read from the BYTES, never from the name or the declared
 * type: an ISO-BMFF file (MP4, MOV) carries `ftyp` at offset 4, a WebM file
 * starts with the EBML magic. Anything else — a script renamed .mp4 — is refused.
 */
export function detectReelVideo(buffer: Buffer): { contentType: string; extension: string } | null {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    return brand === "qt  "
      ? { contentType: "video/quicktime", extension: "mov" }
      : { contentType: "video/mp4", extension: "mp4" };
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  )
    return { contentType: "video/webm", extension: "webm" };
  return null;
}

export async function putReelVideo(storeId: string, file: Express.Multer.File) {
  if (file.size > REEL_MAX_BYTES)
    throw new HttpError(413, "REEL_TOO_LARGE", "المقطع أكبر من ٣٠ ميغابايت.");
  const detected = detectReelVideo(file.buffer);
  if (!detected)
    throw new HttpError(
      422,
      "REEL_TYPE_NOT_ALLOWED",
      "المقطع يجب أن يكون فيديو MP4 أو MOV أو WebM."
    );
  const config = s3Config();
  const objectKey = `market/reels/${storeId}/${randomUUID()}.${detected.extension}`;
  await client(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: file.buffer,
      ContentType: detected.contentType,
      ContentLength: file.size,
    })
  );
  return { objectKey, contentType: detected.contentType, byteSize: file.size };
}

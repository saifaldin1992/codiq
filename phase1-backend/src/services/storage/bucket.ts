/**
 * Object storage — bucket. Split verbatim from
 * product-image-storage.service.ts (review batch 3, ت-٤);
 * product-image-storage.service.ts re-exports what it always exported.
 */
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { HttpError } from "../../auth/auth.errors.js";
import { logger } from "../../logging/logger.js";
import { fingerprint } from "../../logging/redact.js";

/**
 * ق-238 — WHAT HE UPLOADS IS NO LONGER WHAT WE KEEP.
 *
 * Fifteen megabytes, not five. Five was a STORAGE ceiling wearing the clothes of
 * an upload rule, and it produced exactly the failure the owner named: a
 * merchant photographs a bottle with a current phone, the platform answers «حتى
 * ٥ ميغا فقط», and he concludes the thing is broken. A 48MP phone clears five
 * routinely.
 *
 * It is now an ABUSE ceiling and nothing else — every product upload is
 * re-encoded to a variant set before a byte reaches the bucket, so what storage
 * sees is ~560 KB whatever arrives. sharp's own `limitInputPixels` (268 MP, on
 * by default) covers the decompression bomb a byte count cannot see.
 *
 * PRESCRIPTIONS KEEP FIVE AND KEEP THEIR ORIGINAL — see `validatePrescriptionImage`.
 */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * ق-238 — THE BANNER AND THE LOGO KEEP FIVE, AND THAT IS NOT AN OVERSIGHT.
 *
 * Only PRODUCT images are re-encoded in this change. A store banner and a store
 * logo are still written exactly as uploaded, so their limit is still a STORAGE
 * limit and raising it would mean a fifteen-megabyte hero image kept whole and
 * served to the public under a year of `immutable` — a regression wearing the
 * clothes of an improvement. They are one upload per store rather than thirty,
 * so the pressure that justified this work is not on them; giving them the
 * variant set is a follow-up, and until it lands this number is the honest one.
 */
export const MAX_STORE_IMAGE_BYTES = 5 * 1024 * 1024;

export const MAX_PRESCRIPTION_BYTES = 5 * 1024 * 1024;

export const allowedContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function s3Config(): S3Config {
  const endpoint = process.env.PRODUCT_S3_ENDPOINT;
  const bucket = process.env.PRODUCT_S3_BUCKET;
  const accessKeyId = process.env.PRODUCT_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PRODUCT_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new HttpError(
      503,
      "IMAGE_STORAGE_NOT_CONFIGURED",
      "Product image storage is not configured."
    );
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.PRODUCT_S3_REGION ?? "us-east-1",
  };
}

export function client(config: S3Config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: process.env.PRODUCT_S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

export async function getProductImageBytes(objectKey: string) {
  const config = s3Config();
  const object = await client(config).send(
    new GetObjectCommand({ Bucket: config.bucket, Key: objectKey })
  );
  if (!object.Body || !("transformToByteArray" in object.Body))
    throw new HttpError(404, "IMAGE_NOT_FOUND", "The requested product image could not be read.");
  return Buffer.from(await object.Body.transformToByteArray());
}

/**
 * The delete loop both callers share. Best-effort for the same reason the
 * comment above gives: the caller has already decided the bytes are unwanted, so
 * a storage outage must not turn cleanup into an exception that kills the work
 * that asked for it. A leftover object is a cost line; a thrown cleanup is a
 * failed request or a stalled sweep.
 */
export async function deleteStoredObjects(objectKeys: readonly string[], label: string) {
  if (!objectKeys.length) return;
  try {
    const config = s3Config();
    const s3 = client(config);
    for (const objectKey of objectKeys) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }));
      } catch (error) {
        // D-41: the object KEY is an address, not a name — paired with the
        // bucket it is what a presigned URL is minted from, so it never reaches
        // a log line. The fingerprint is enough to see the same object failing
        // on pass after pass, which is the only reason it was ever printed.
        logger.error("storage.delete_failed", {
          component: label,
          objectKeyFingerprint: fingerprint(objectKey),
          err: error,
        });
      }
    }
  } catch (error) {
    logger.error("storage.unavailable", {
      component: label,
      objects: objectKeys.length,
      err: error,
    });
  }
}

/**
 * A byte range of a stored object, streamed — a video player asks for pieces
 * (seeking, the first frames) and must get 206 with Content-Range, not the whole
 * file every time. `range` is the client's header, passed through to S3 only if
 * it is one well-formed `bytes=` range.
 */
export async function getObjectRange(objectKey: string, range: string | undefined) {
  const config = s3Config();
  const valid = range && /^bytes=\d*-\d*$/.test(range) && range !== "bytes=-" ? range : undefined;
  const object = await client(config).send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      ...(valid ? { Range: valid } : {}),
    })
  );
  if (!object.Body) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الملفّ غير موجود.");
  return {
    body: object.Body as NodeJS.ReadableStream,
    partial: Boolean(valid && object.ContentRange),
    contentRange: object.ContentRange ?? null,
    contentLength: object.ContentLength ?? null,
  };
}

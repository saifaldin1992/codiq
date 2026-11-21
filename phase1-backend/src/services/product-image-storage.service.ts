import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { HttpError } from "../auth/auth.errors.js";
import { logger } from "../logging/logger.js";
import { fingerprint } from "../logging/redact.js";
import { PRODUCT_IMAGE_VARIANT_SET, renderProductImageVariants, variantObjectKey, type ImageVariantName, type RenderedImageSet } from "./image-variants.service.js";

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
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
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
const MAX_STORE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PRESCRIPTION_BYTES = 5 * 1024 * 1024;
const allowedContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function s3Config(): S3Config {
  const endpoint = process.env.PRODUCT_S3_ENDPOINT;
  const bucket = process.env.PRODUCT_S3_BUCKET;
  const accessKeyId = process.env.PRODUCT_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PRODUCT_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new HttpError(503, "IMAGE_STORAGE_NOT_CONFIGURED", "Product image storage is not configured.");
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.PRODUCT_S3_REGION ?? "us-east-1" };
}

function client(config: S3Config) {
  return new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: process.env.PRODUCT_S3_FORCE_PATH_STYLE !== "false", credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
}

function detectedImageType(buffer: Buffer): { contentType: string; extension: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { contentType: "image/jpeg", extension: "jpg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: "image/png", extension: "png" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return { contentType: "image/webp", extension: "webp" };
  return null;
}

/**
 * The one check all three kinds share. The ceiling is a PARAMETER because the
 * three no longer agree on it (ق-238), and the message QUOTES that parameter —
 * the old text said «up to 5 MB» as a literal and would have started lying the
 * moment any of the three moved.
 */
function validateImageWithin(file: Express.Multer.File, maxBytes: number, code: string, label: string) {
  if (!allowedContentTypes.has(file.mimetype) || file.size <= 0 || file.size > maxBytes) {
    throw new HttpError(422, code, `Only JPEG, PNG, and WebP ${label} up to ${Math.round(maxBytes / (1024 * 1024))} MB are allowed.`);
  }
  // THE MIME TYPE IS THE BROWSER'S CLAIM; THIS IS THE FILE'S OWN WORD.
  const detected = detectedImageType(file.buffer);
  if (!detected || detected.contentType !== file.mimetype) {
    throw new HttpError(422, code, "The uploaded file content does not match a supported image type.");
  }
  return detected;
}

export function validateProductImage(file: Express.Multer.File) {
  return validateImageWithin(file, MAX_IMAGE_BYTES, "INVALID_PRODUCT_IMAGE", "images");
}

/** Banners and logos: stored as uploaded, so five megabytes is still a storage limit. */
export function validateStoreImage(file: Express.Multer.File) {
  return validateImageWithin(file, MAX_STORE_IMAGE_BYTES, "INVALID_PRODUCT_IMAGE", "images");
}

/**
 * ق-238 — renders the three sizes and writes NOTHING.
 *
 * Split from the upload deliberately: `addProductImages` must charge the plan
 * meter for what will actually be STORED, and the only honest way to know that
 * is to encode first. The bucket stays untouched until the quota has answered —
 * the invariant phase 16 wrote, and this keeps it while making the number true.
 */
export async function renderProductImage(file: Express.Multer.File): Promise<RenderedImageSet> {
  validateProductImage(file);
  return renderProductImageVariants(file.buffer);
}

/**
 * `{uuid}.webp` holds `full`; the other two hang off it by suffix
 * (`variantObjectKey`). One uuid, one row, three objects.
 *
 * Sequential rather than `Promise.all`: a partial set is a product whose card is
 * a 404, and a bucket that is rate-limiting us should slow this down rather than
 * have three requests race into the same limit.
 */
async function putRenderedSet(prefix: string, rendered: RenderedImageSet) {
  const config = s3Config();
  const s3 = client(config);
  const objectKey = `${prefix}/${randomUUID()}.webp`;
  for (const variant of rendered.variants) {
    await s3.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: variantObjectKey(objectKey, variant.variant),
      Body: variant.body,
      ContentType: variant.contentType,
      ContentLength: variant.byteSize,
    }));
  }
  return { objectKey, contentType: "image/webp", byteSize: rendered.totalBytes, variantSet: PRODUCT_IMAGE_VARIANT_SET, width: rendered.width, height: rendered.height };
}

export async function putProductImage(storeId: string, productId: string, rendered: RenderedImageSet) {
  return putRenderedSet(`products/${storeId}/${productId}`, rendered);
}

/**
 * Every object a row names — so a delete removes the WHOLE set and never two
 * thirds of it. A legacy row (`variantSet` null) names exactly one object, which
 * is why the null branch is not an error case but the original behaviour.
 */
export function productImageObjectKeys(image: { objectKey: string; variantSet?: number | null }): string[] {
  if (!image.variantSet) return [image.objectKey];
  return (["full", "card", "thumb"] as ImageVariantName[]).map((variant) => variantObjectKey(image.objectKey, variant));
}

export async function getProductImageBytes(objectKey: string) {
  const config = s3Config();
  const object = await client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
  if (!object.Body || !("transformToByteArray" in object.Body)) throw new HttpError(404, "IMAGE_NOT_FOUND", "The requested product image could not be read.");
  return Buffer.from(await object.Body.transformToByteArray());
}

/**
 * PG-2: the purge sweep drops the bytes AFTER the row is committed gone.
 * Best-effort by design — the database is the record of truth and the rows are
 * already deleted, so a storage outage must not turn a completed purge into an
 * exception that kills the worker's interval. A leftover object is a cost line,
 * a crashed sweep is a stalled feature.
 */
export async function deleteProductImageObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "trash-purger");
}

/**
 * The delete loop both callers share. Best-effort for the same reason the
 * comment above gives: the caller has already decided the bytes are unwanted, so
 * a storage outage must not turn cleanup into an exception that kills the work
 * that asked for it. A leftover object is a cost line; a thrown cleanup is a
 * failed request or a stalled sweep.
 */
async function deleteStoredObjects(objectKeys: readonly string[], label: string) {
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
        logger.error("storage.delete_failed", { component: label, objectKeyFingerprint: fingerprint(objectKey), err: error });
      }
    }
  } catch (error) {
    logger.error("storage.unavailable", { component: label, objects: objectKeys.length, err: error });
  }
}

// ---------- Phase 20B-1: prescription uploads ride the SAME S3 pipeline ----------
// Same bucket, same credentials, same magic-byte detection — only the key
// prefix (prescriptions/{storeId}/{orderId}/{uuid}) and the error code differ.
// These objects are strictly private: no public route ever serves them.

/**
 * ق-238 — THE ONE UPLOAD THAT IS NOT RE-ENCODED, AND KEEPS THE OLD CEILING.
 *
 * A prescription is a document, not a picture: a pharmacist reads a doctor's
 * handwriting off it, and every resize spends exactly the detail that decision
 * rests on. It is also private — no public route serves it — so none of the
 * bandwidth argument that drives the product variants applies here at all.
 * Five megabytes of original beats fifteen megabytes of anything else.
 */
export function validatePrescriptionImage(file: Express.Multer.File) {
  return validateImageWithin(file, MAX_PRESCRIPTION_BYTES, "INVALID_PRESCRIPTION_IMAGE", "prescription images");
}

export async function putPrescriptionImage(storeId: string, orderId: string, file: Express.Multer.File) {
  const detected = validatePrescriptionImage(file);
  const config = s3Config();
  const objectKey = `prescriptions/${storeId}/${orderId}/${randomUUID()}.${detected.extension}`;
  await client(config).send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: file.buffer, ContentType: detected.contentType, ContentLength: file.size }));
  return { objectKey, contentType: detected.contentType, byteSize: file.size };
}

/**
 * 19-د (ATTACK-SURFACE): before this existed, NOTHING in the codebase deleted an
 * object under the `prescriptions/` prefix. The only DeleteObjectCommand was
 * `deleteProductImageObjects`, whose single caller passes product-image keys —
 * so a prescription written to the bucket stayed there whatever happened to the
 * row that named it, and an object whose row was rolled back could not even be
 * FOUND again: the key existed nowhere else.
 *
 * Its caller today is the compensating path in `uploadOrderPrescription`. That
 * is the leak with an attacker behind it. Wiring it to an actual erasure
 * request — a customer asking to be forgotten, a store being removed — is a
 * policy the platform owner has not written yet, and is deliberately NOT
 * invented here.
 */
export async function deletePrescriptionObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "prescription-cleanup");
}

export async function getPrescriptionBytes(objectKey: string) {
  const config = s3Config();
  const object = await client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
  if (!object.Body || !("transformToByteArray" in object.Body)) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested prescription could not be read.");
  return Buffer.from(await object.Body.transformToByteArray());
}

/**
 * ق-198 — the storefront's own large images.
 *
 * The same validator, the same bucket and the same delete loop as a product
 * image: a banner is a product image that belongs to the store rather than to
 * one product, and inventing a second pipeline for it would have meant a second
 * magic-byte check to keep honest and a second thing the plan meter could miss.
 * Only the key prefix differs, so anners/ is greppable in the bucket.
 */
export async function putStoreBanner(storeId: string, file: Express.Multer.File) {
  const detected = validateStoreImage(file);
  const config = s3Config();
  const objectKey = `banners/${storeId}/${randomUUID()}.${detected.extension}`;
  await client(config).send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: file.buffer, ContentType: detected.contentType, ContentLength: file.size }));
  return { objectKey, contentType: detected.contentType, byteSize: file.size };
}

export async function getStoreBannerBytes(objectKey: string) {
  return getProductImageBytes(objectKey);
}

/** Best-effort, exactly like the product-image delete: the bytes are already unwanted. */
export async function deleteStoreBannerObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "store-banner");
}

/**
 * ق-199 — the store's logo. One per store, replaced rather than listed, and
 * otherwise a banner: same validator, same bucket, same plan meter, own prefix.
 */
export async function putStoreLogo(storeId: string, file: Express.Multer.File) {
  const detected = validateStoreImage(file);
  const config = s3Config();
  const objectKey = `logos/${storeId}/${randomUUID()}.${detected.extension}`;
  await client(config).send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: file.buffer, ContentType: detected.contentType, ContentLength: file.size }));
  return { objectKey, contentType: detected.contentType, byteSize: file.size };
}

export async function getStoreLogoBytes(objectKey: string) {
  return getProductImageBytes(objectKey);
}

export async function deleteStoreLogoObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "store-logo");
}
/**
 * Marketplace M1 — the store's cover in the market directory and on its market
 * page. A banner in every way that matters (validator, bucket, plan meter); its
 * own prefix so covers/ is greppable in the bucket.
 */
export async function putStoreCover(storeId: string, file: Express.Multer.File) {
  const detected = validateStoreImage(file);
  const config = s3Config();
  const objectKey = `covers/${storeId}/${randomUUID()}.${detected.extension}`;
  await client(config).send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: file.buffer, ContentType: detected.contentType, ContentLength: file.size }));
  return { objectKey, contentType: detected.contentType, byteSize: file.size };
}

export async function deleteStoreCoverObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "store-cover");
}

/**
 * Marketplace M3 — the platform's own market images (banners). Same validator
 * and bucket as every store image; no plan meter, because the platform pays.
 */
export async function putMarketImage(kind: "banners" | "avatars" | "tickets", file: Express.Multer.File) {
  const detected = validateStoreImage(file);
  const config = s3Config();
  const objectKey = `market/${kind}/${randomUUID()}.${detected.extension}`;
  await client(config).send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: file.buffer, ContentType: detected.contentType, ContentLength: file.size }));
  return { objectKey, contentType: detected.contentType, byteSize: file.size };
}

export async function deleteMarketImageObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "market-image");
}

export const productImageConstraints = { maxBytes: MAX_IMAGE_BYTES, allowedContentTypes };
export const prescriptionImageConstraints = { maxBytes: MAX_PRESCRIPTION_BYTES, allowedContentTypes };
export const storeImageConstraints = { maxBytes: MAX_STORE_IMAGE_BYTES, allowedContentTypes };

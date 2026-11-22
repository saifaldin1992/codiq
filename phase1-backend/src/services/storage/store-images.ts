/**
 * Object storage — store-images. Split verbatim from
 * product-image-storage.service.ts (review batch 3, ت-٤);
 * product-image-storage.service.ts re-exports what it always exported.
 */
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { validateStoreImage } from "./validate.js";
import { s3Config, client, getProductImageBytes, deleteStoredObjects } from "./bucket.js";

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

export async function deleteStoreCoverObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "store-cover");
}

/**
 * Marketplace M3 — the platform's own market images (banners). Same validator
 * and bucket as every store image; no plan meter, because the platform pays.
 */
export async function putMarketImage(
  kind: "banners" | "avatars" | "tickets" | "reel-posters",
  file: Express.Multer.File
) {
  const detected = validateStoreImage(file);
  const config = s3Config();
  const objectKey = `market/${kind}/${randomUUID()}.${detected.extension}`;
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

export async function deleteMarketImageObjects(objectKeys: readonly string[]) {
  await deleteStoredObjects(objectKeys, "market-image");
}

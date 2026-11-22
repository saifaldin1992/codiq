/**
 * Object storage — products. Split verbatim from
 * product-image-storage.service.ts (review batch 3, ت-٤);
 * product-image-storage.service.ts re-exports what it always exported.
 */
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  type RenderedImageSet,
  renderProductImageVariants,
  variantObjectKey,
  PRODUCT_IMAGE_VARIANT_SET,
  type ImageVariantName,
} from "../image-variants.service.js";
import { validateProductImage } from "./validate.js";
import { s3Config, client, deleteStoredObjects } from "./bucket.js";

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
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: variantObjectKey(objectKey, variant.variant),
        Body: variant.body,
        ContentType: variant.contentType,
        ContentLength: variant.byteSize,
      })
    );
  }
  return {
    objectKey,
    contentType: "image/webp",
    byteSize: rendered.totalBytes,
    variantSet: PRODUCT_IMAGE_VARIANT_SET,
    width: rendered.width,
    height: rendered.height,
  };
}

export async function putProductImage(
  storeId: string,
  productId: string,
  rendered: RenderedImageSet
) {
  return putRenderedSet(`products/${storeId}/${productId}`, rendered);
}

/**
 * Every object a row names — so a delete removes the WHOLE set and never two
 * thirds of it. A legacy row (`variantSet` null) names exactly one object, which
 * is why the null branch is not an error case but the original behaviour.
 */
export function productImageObjectKeys(image: {
  objectKey: string;
  variantSet?: number | null;
}): string[] {
  if (!image.variantSet) return [image.objectKey];
  return (["full", "card", "thumb"] as ImageVariantName[]).map((variant) =>
    variantObjectKey(image.objectKey, variant)
  );
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

/**
 * Object storage — validate. Split verbatim from
 * product-image-storage.service.ts (review batch 3, ت-٤);
 * product-image-storage.service.ts re-exports what it always exported.
 */
import { HttpError } from "../../auth/auth.errors.js";
import {
  allowedContentTypes,
  MAX_IMAGE_BYTES,
  MAX_STORE_IMAGE_BYTES,
  MAX_PRESCRIPTION_BYTES,
} from "./bucket.js";

export function detectedImageType(
  buffer: Buffer
): { contentType: string; extension: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { contentType: "image/jpeg", extension: "jpg" };
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return { contentType: "image/png", extension: "png" };
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return { contentType: "image/webp", extension: "webp" };
  return null;
}

/**
 * The one check all three kinds share. The ceiling is a PARAMETER because the
 * three no longer agree on it (ق-238), and the message QUOTES that parameter —
 * the old text said «up to 5 MB» as a literal and would have started lying the
 * moment any of the three moved.
 */
function validateImageWithin(
  file: Express.Multer.File,
  maxBytes: number,
  code: string,
  label: string
) {
  if (!allowedContentTypes.has(file.mimetype) || file.size <= 0 || file.size > maxBytes) {
    throw new HttpError(
      422,
      code,
      `Only JPEG, PNG, and WebP ${label} up to ${Math.round(maxBytes / (1024 * 1024))} MB are allowed.`
    );
  }
  // THE MIME TYPE IS THE BROWSER'S CLAIM; THIS IS THE FILE'S OWN WORD.
  const detected = detectedImageType(file.buffer);
  if (!detected || detected.contentType !== file.mimetype) {
    throw new HttpError(
      422,
      code,
      "The uploaded file content does not match a supported image type."
    );
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
  return validateImageWithin(
    file,
    MAX_PRESCRIPTION_BYTES,
    "INVALID_PRESCRIPTION_IMAGE",
    "prescription images"
  );
}

export const productImageConstraints = { maxBytes: MAX_IMAGE_BYTES, allowedContentTypes };

export const prescriptionImageConstraints = {
  maxBytes: MAX_PRESCRIPTION_BYTES,
  allowedContentTypes,
};

export const storeImageConstraints = { maxBytes: MAX_STORE_IMAGE_BYTES, allowedContentTypes };

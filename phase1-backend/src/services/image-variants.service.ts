/**
 * ق-238 — THE MERCHANT UPLOADS A PHOTO; THE PLATFORM DECIDES ITS SIZE.
 *
 * Before this, whatever came out of a merchant's phone is exactly what every
 * shopper downloaded. Measured on the real projection (`storefront.service.ts`
 * serves one image per card, twenty-four cards to a catalog page) a 1.5 MB phone
 * photo makes a THIRTY-SIX MEGABYTE page. On Iraqi mobile data that store does
 * not open — the shopper sees nothing, reports nothing, and leaves. It is a
 * usability defect first and a bandwidth bill second.
 *
 * THREE SIZES, NOT ONE, because a thumbnail and a zoom are different pictures:
 *
 *   thumb  200px   the cart line, the order row, the dashboard list
 *   card   800px   the catalog grid — the byte that matters, served by default
 *   full  1600px   the product page and its zoom
 *
 * WEBP FOR ALL THREE. Every browser the storefront supports has read it for
 * years, and it is ~30% smaller than JPEG at the same quality. The upload still
 * accepts JPEG and PNG — what the merchant HAS is not what the shopper GETS.
 *
 * THE ORIGINAL IS NOT KEPT, and that is a decision rather than an oversight.
 * 1600px covers every storefront use including zoom; keeping a fourth copy would
 * double the storage the plan meter charges him for, to serve bytes nothing ever
 * requests. His own copy is still on his phone.
 *
 * TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 * `rotate()` with no argument applies the EXIF orientation flag BEFORE the
 * metadata is stripped. Phones record orientation rather than rotating pixels,
 * so without this every portrait photo a merchant takes arrives sideways — the
 * single most common image bug there is, and invisible on the developer's own
 * desktop screenshots.
 *
 * Metadata is dropped, which is a privacy fix the merchant does not know he
 * needs: a phone photo carries GPS coordinates, and the product image is a
 * PUBLIC object. Publishing a shop's — or a home's — exact location beside a
 * perfume bottle is not a thing to leave to chance.
 */
import type { Metadata, Sharp, SharpOptions } from "sharp";
import { HttpError } from "../auth/auth.errors.js";
import { logger } from "../logging/logger.js";

/**
 * ق-238 — LOADED AT FIRST USE, NOT AT BOOT.
 *
 * sharp carries a NATIVE binary. Imported at the top of this module it would be
 * pulled in by the route table, which means a deploy whose platform binary
 * failed to install does not lose image uploads — it loses the whole server:
 * the merchant's door, every storefront, checkout. `config.ts` already refuses
 * exactly this trade in another place and says why in one line — a boot refusal
 * on a live platform is a self-inflicted outage.
 *
 * Deferred here, that same deploy answers 503 on ONE route and sells normally on
 * every other. The cost is a millisecond on the first upload after a restart.
 */
// Spelled out rather than `typeof import("sharp")`: that is the MODULE namespace,
// which is not callable, while the default export is. Naming the one call shape
// this file uses also means a sharp upgrade that changes the rest of its surface
// cannot quietly change what we depend on.
type SharpFactory = (input: Buffer, options?: SharpOptions) => Sharp;
let sharpFactory: SharpFactory | null = null;

async function loadSharp(): Promise<SharpFactory> {
  if (sharpFactory) return sharpFactory;
  try {
    sharpFactory = (await import("sharp")).default as unknown as SharpFactory;
    return sharpFactory;
  } catch (error) {
    // 503, not 500: the request is fine and the merchant did nothing wrong —
    // this deployment cannot process images at all, which is an operator's
    // problem and needs to be visible as one.
    logger.error("image.sharp_unavailable", { component: "image-variants", err: error });
    throw new HttpError(
      503,
      "IMAGE_PROCESSING_UNAVAILABLE",
      "تعذّرت معالجة الصور على الخادم حالياً. حاول بعد قليل."
    );
  }
}

/** Bumped only when the SET changes — never when a quality knob moves. Rows carry it so a reader knows what exists. */
export const PRODUCT_IMAGE_VARIANT_SET = 1;

export const IMAGE_VARIANTS = {
  thumb: { width: 200, quality: 78 },
  card: { width: 800, quality: 82 },
  full: { width: 1600, quality: 82 },
} as const;

export type ImageVariantName = keyof typeof IMAGE_VARIANTS;

/** `full` is the object the stored key names; the other two hang off it by suffix. */
export const DEFAULT_SERVED_VARIANT: ImageVariantName = "card";

export const VARIANT_NAMES = Object.keys(IMAGE_VARIANTS) as ImageVariantName[];

export function isVariantName(value: unknown): value is ImageVariantName {
  return typeof value === "string" && (VARIANT_NAMES as readonly string[]).includes(value);
}

/**
 * `…/{uuid}.webp` is `full`; `…/{uuid}-card.webp` and `…/{uuid}-thumb.webp` are
 * the others. Derived rather than stored: three columns that can disagree with
 * the bucket are three ways to serve a 404, and the suffix cannot drift.
 */
export function variantObjectKey(fullObjectKey: string, variant: ImageVariantName): string {
  if (variant === "full") return fullObjectKey;
  const dot = fullObjectKey.lastIndexOf(".");
  if (dot === -1) return `${fullObjectKey}-${variant}`;
  return `${fullObjectKey.slice(0, dot)}-${variant}${fullObjectKey.slice(dot)}`;
}

export interface RenderedVariant {
  variant: ImageVariantName;
  body: Buffer;
  contentType: "image/webp";
  byteSize: number;
}

export interface RenderedImageSet {
  variants: RenderedVariant[];
  /** Of `full` — carried on the row so the client can reserve the box and not reflow the grid. */
  width: number;
  height: number;
  /** What the plan meter charges: everything actually written to the bucket. */
  totalBytes: number;
}

/**
 * Never enlarges. A merchant who uploads a 300px picture gets 300px in all three
 * slots rather than a blurred 1600 — upscaling invents detail and costs bytes to
 * do it, and the honest answer to a small source is a small picture.
 */
export async function renderProductImageVariants(source: Buffer): Promise<RenderedImageSet> {
  const sharp = await loadSharp();
  let base: Sharp;
  let meta: Metadata;
  try {
    base = sharp(source, { failOn: "error" }).rotate();
    meta = await base.metadata();
  } catch {
    // The magic-byte check upstream already said this is a JPEG/PNG/WebP, so a
    // decode failure here means the bytes past that header are not an image —
    // truncated, or a payload wearing an image's first four bytes.
    throw new HttpError(422, "INVALID_PRODUCT_IMAGE", "تعذّرت قراءة الصورة. جرّب صورةً أخرى.");
  }
  // After `rotate()` the reported metadata is still the ON-DISK orientation, so a
  // portrait photo reports landscape here. Swap when the EXIF flag says the
  // picture is turned a quarter — otherwise the stored width/height lie and the
  // grid reserves the wrong box.
  const turned = typeof meta.orientation === "number" && meta.orientation >= 5;
  const sourceWidth = (turned ? meta.height : meta.width) ?? 0;
  const sourceHeight = (turned ? meta.width : meta.height) ?? 0;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new HttpError(
      422,
      "INVALID_PRODUCT_IMAGE",
      "تعذّرت قراءة أبعاد الصورة. جرّب صورةً أخرى."
    );
  }

  // THE DECODE FAILS HERE, NOT ABOVE — and that cost a 500 before it was found.
  //
  // `metadata()` reads the HEADER. A file whose IHDR is perfect and whose pixel
  // data is corrupt sails past it and dies in `toBuffer`, where libpng actually
  // inflates the bytes. Wrapping only the metadata call therefore protected
  // exactly the case that never happens in the wild — a file with a broken
  // header is usually a file that is not an image at all — and left the real
  // one (a truncated upload over a dropped mobile connection, the commonest
  // failure there is here) escaping as an INTERNAL_ERROR.
  //
  // The suite found it: `phase7` carries a hand-built PNG whose IDAT checksum is
  // literally four zero bytes. It passed every check for as long as it existed,
  // because nothing in the platform had ever decoded an uploaded image.
  const variants: RenderedVariant[] = [];
  try {
    for (const variant of VARIANT_NAMES) {
      const spec = IMAGE_VARIANTS[variant];
      const body = await sharp(source, { failOn: "error" })
        .rotate()
        .resize({ width: spec.width, withoutEnlargement: true })
        .webp({ quality: spec.quality })
        .toBuffer();
      variants.push({ variant, body, contentType: "image/webp", byteSize: body.byteLength });
    }
  } catch {
    throw new HttpError(
      422,
      "INVALID_PRODUCT_IMAGE",
      "تعذّرت قراءة الصورة — قد يكون الملفّ ناقصاً. أعد رفعها."
    );
  }

  const fullWidth = Math.min(sourceWidth, IMAGE_VARIANTS.full.width);
  const scale = fullWidth / sourceWidth;
  return {
    variants,
    width: fullWidth,
    height: Math.max(1, Math.round(sourceHeight * scale)),
    totalBytes: variants.reduce((sum, rendered) => sum + rendered.byteSize, 0),
  };
}

/**
 * Review batch 3, م-٤ — a store's own images (banner, logo, cover) and the market's (banner,
 * avatar, ticket photo, reel poster) are public, and were stored byte for byte: a phone photo's
 * EXIF — its GPS among it — went out with them. Re-encoded in the same format, upright, with
 * no metadata (sharp writes none unless asked), as the product variants already are.
 */
export async function stripImageMetadata(bytes: Buffer, contentType: string): Promise<Buffer> {
  const sharp = await loadSharp();
  const image = sharp(bytes, { failOn: "error" }).rotate();
  if (contentType === "image/jpeg") return image.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  if (contentType === "image/png") return image.png().toBuffer();
  return image.webp({ quality: 90 }).toBuffer();
}

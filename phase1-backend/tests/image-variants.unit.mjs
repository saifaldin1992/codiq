/**
 * Unit — ق-238: the merchant's phone decides nothing about what the shopper downloads.
 *
 * Before this, `putProductImage` wrote the uploaded bytes verbatim and every
 * storefront route served them verbatim. The catalog projection
 * (`storefront.service.ts`, `images: { take: 1 }`) puts one picture on each of
 * twenty-four cards, so a 1.5 MB phone photo made a THIRTY-SIX MEGABYTE page.
 * On Iraqi mobile data that store does not open — and the shopper does not
 * report it, he leaves.
 *
 * What this pins, in the order it can break:
 *
 *   1. THREE SIZES EXIST and each is smaller than the one above it. A rename or
 *      a lost `resize` call turns the card back into the original silently —
 *      nothing throws, the page just gets heavy again.
 *   2. THE SET IS DRAMATICALLY SMALLER THAN THE SOURCE. This is the whole claim;
 *      if it ever stops being true the change has stopped paying for itself.
 *   3. EXIF ROTATION IS APPLIED. Phones store orientation as a FLAG rather than
 *      rotating pixels. Miss it and every portrait photo a merchant takes lands
 *      sideways — the most common image bug there is, and invisible on a
 *      developer's own desktop screenshots.
 *   4. METADATA IS DROPPED. A phone photo carries GPS. A product image is a
 *      PUBLIC object. Publishing a shop's — or a home's — coordinates beside a
 *      perfume bottle is not something to leave to a library default.
 *   5. SMALL SOURCES ARE NOT ENLARGED. Upscaling invents detail and charges
 *      bytes for it.
 *   6. THE KEYS DERIVE, they are not stored. Three columns that can disagree
 *      with the bucket are three ways to serve a 404.
 *
 * Run: pnpm images:test
 */
import assert from "node:assert/strict";
import sharp from "sharp";

const { renderProductImageVariants, variantObjectKey, isVariantName, IMAGE_VARIANTS, DEFAULT_SERVED_VARIANT, PRODUCT_IMAGE_VARIANT_SET } =
  await import("../src/services/image-variants.service.ts");

const summary = {};

/** A photograph-shaped source: noise, so the encoder cannot cheat with flat colour. */
async function photo(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 256;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

// ============================================================
// 1. THREE SIZES, AND EACH IS SMALLER THAN THE ONE ABOVE IT.
// ============================================================
const source = await photo(3000, 2000);
const rendered = await renderProductImageVariants(source);

assert.equal(rendered.variants.length, 3, "thumb, card and full — all three or the contract is broken");
const byName = Object.fromEntries(rendered.variants.map((variant) => [variant.variant, variant]));
for (const name of ["thumb", "card", "full"]) {
  assert.ok(byName[name], "the " + name + " variant must exist");
  assert.equal(byName[name].contentType, "image/webp", name + " must be webp — that is the ~30% the format buys");
  const meta = await sharp(byName[name].body).metadata();
  assert.equal(meta.width, IMAGE_VARIANTS[name].width, name + " must be exactly " + IMAGE_VARIANTS[name].width + "px wide");
  assert.equal(meta.format, "webp", name + " must decode as webp, not merely claim to be");
}
assert.ok(byName.thumb.byteSize < byName.card.byteSize, "thumb must be smaller than card");
assert.ok(byName.card.byteSize < byName.full.byteSize, "card must be smaller than full");
summary.threeSizes = "thumb " + byName.thumb.byteSize + "B < card " + byName.card.byteSize + "B < full " + byName.full.byteSize + "B";

// ============================================================
// 2. THE SET COSTS A FRACTION OF THE SOURCE — THE WHOLE CLAIM.
// ============================================================
// Deliberately a loose bound. The point is not a precise ratio (that moves with
// the encoder) but that the change never quietly stops paying: a regression that
// wrote the original back would land at ~1.0 and fail here loudly.
const ratio = rendered.totalBytes / source.byteLength;
assert.ok(ratio < 0.5, "all three variants together must cost well under the single original (was " + ratio.toFixed(3) + ")");
// And the byte that actually matters: the card is what twenty-four grid cells ask for.
const cardRatio = byName.card.byteSize / source.byteLength;
assert.ok(cardRatio < 0.2, "the card alone must be a small fraction of the source (was " + cardRatio.toFixed(3) + ")");
summary.shrink = "set " + (ratio * 100).toFixed(1) + "% of source · card alone " + (cardRatio * 100).toFixed(1) + "%";

// ============================================================
// 3. EXIF ORIENTATION IS APPLIED, NOT CARRIED.
// ============================================================
// Orientation 6 means «rotate 90° clockwise to display». A 400x800 file with
// that flag is a 800x400 PICTURE. Without `.rotate()` the output is 400 wide and
// every portrait photo in the shop is on its side.
const turnedSource = await sharp(await photo(400, 800)).withMetadata({ orientation: 6 }).toBuffer();
const turned = await renderProductImageVariants(turnedSource);
const turnedFull = await sharp(turned.variants.find((variant) => variant.variant === "full").body).metadata();
assert.ok(turnedFull.width > turnedFull.height, "an orientation-6 source must come out landscape — the flag is applied, not passed through");
assert.equal(turned.width, turnedFull.width, "the stored width must equal the rendered width, not the on-disk one");
assert.equal(turned.height, turnedFull.height, "same for height — the grid reserves its box from these numbers");
summary.exifRotation = "400x800 + orientation:6 → " + turned.width + "x" + turned.height;

// ============================================================
// 4. METADATA — INCLUDING GPS — DOES NOT SURVIVE.
// ============================================================
const located = await sharp(await photo(900, 600))
  .withExif({ IFD0: { Copyright: "codiq-test" }, GPS: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" } })
  .toBuffer();
const scrubbed = await renderProductImageVariants(located);
for (const variant of scrubbed.variants) {
  const meta = await sharp(variant.body).metadata();
  assert.equal(meta.exif, undefined, variant.variant + " must carry no EXIF block — a public object must not publish a location");
}
summary.metadataStripped = "EXIF and GPS absent from all three";

// ============================================================
// 5. A SMALL SOURCE IS NOT ENLARGED.
// ============================================================
const small = await renderProductImageVariants(await photo(150, 150));
for (const variant of small.variants) {
  const meta = await sharp(variant.body).metadata();
  assert.ok(meta.width <= 150, variant.variant + " must not upscale a 150px source (got " + meta.width + ")");
}
assert.equal(small.width, 150, "the recorded width is the real one, not the variant's ceiling");
summary.neverEnlarges = "150px source stays 150px in all three slots";

// ============================================================
// 6. THE KEYS DERIVE FROM ONE UUID.
// ============================================================
const key = "products/store-1/product-1/abc-123.webp";
assert.equal(variantObjectKey(key, "full"), key, "full IS the stored key — no suffix, so one row still names one canonical object");
assert.equal(variantObjectKey(key, "card"), "products/store-1/product-1/abc-123-card.webp");
assert.equal(variantObjectKey(key, "thumb"), "products/store-1/product-1/abc-123-thumb.webp");
assert.equal(variantObjectKey("no-extension", "card"), "no-extension-card", "a key with no dot must still derive rather than corrupt");
summary.derivedKeys = "one uuid, three objects, zero extra columns";

// ============================================================
// 7. THE QUERY PARAMETER ACCEPTS ONLY WHAT EXISTS.
// ============================================================
// `?v=` comes from the open internet. Anything not in the set must fall back to
// the default rather than compose a key that 404s — or worse, escape the prefix.
for (const bad of ["original", "../../secret", "", null, undefined, 1, "FULL", "card "]) {
  assert.equal(isVariantName(bad), false, "«" + String(bad) + "» must not be accepted as a variant name");
}
for (const good of ["thumb", "card", "full"]) assert.equal(isVariantName(good), true);
assert.equal(DEFAULT_SERVED_VARIANT, "card", "absent «?v=» must serve the CARD — a forgetful client should fail toward the small picture");
assert.equal(PRODUCT_IMAGE_VARIANT_SET, 1, "the set number rows carry; bump it only when the SET changes");
summary.paramValidation = "8 rejected, 3 accepted, default is card";

// ============================================================
// 8. BYTES THAT ARE NOT AN IMAGE ARE REFUSED, NOT CRASHED ON.
// ============================================================
// The magic-byte check upstream has already said «this is a JPEG». A decode
// failure here therefore means the bytes PAST that header are not one — a
// truncated upload, or a payload wearing four borrowed bytes.
const truncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
await assert.rejects(
  () => renderProductImageVariants(truncated),
  (error) => error.status === 422 && error.code === "INVALID_PRODUCT_IMAGE",
  "a broken image must be a 422 the merchant can read, never a 500",
);
summary.refusesNonImage = "422 INVALID_PRODUCT_IMAGE, not a crash";

// ============================================================
// 9. A VALID HEADER OVER BROKEN PIXELS IS THE CASE THAT COST A 500.
// ============================================================
// These are the REAL bytes that found the bug. Five suites carried this
// hand-built 1x1 PNG for as long as they existed: its IHDR is perfect and its
// IDAT checksum is four zero bytes. Nothing had ever noticed, because nothing
// in the platform had ever DECODED an uploaded image — the magic-byte check
// reads eight bytes and asks nothing about the rest.
//
// It matters far beyond a fixture. `sharp(...).metadata()` reads the header and
// returns happily; the decode only fails later, inside `toBuffer`. A try that
// wrapped the metadata call alone therefore protected the case that never
// happens in the wild and left the common one — a phone upload truncated by a
// dropped mobile connection — escaping as INTERNAL_ERROR. The merchant saw «حدث
// خطأ» and lost his photo; the shape of the fix is that he now reads why.
const headerValidPixelsBroken = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d" +
  "49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
assert.equal((await sharp(headerValidPixelsBroken).metadata()).format, "png", "the header alone must still read as a PNG — that is the whole trap");
await assert.rejects(
  () => renderProductImageVariants(headerValidPixelsBroken),
  (error) => error.status === 422 && error.code === "INVALID_PRODUCT_IMAGE",
  "a file whose header is valid and whose pixels are not must be 422, never 500",
);
summary.brokenPixelsAfterValidHeader = "decode failure during encoding is 422, not INTERNAL_ERROR";

console.log(JSON.stringify({ suite: "image-variants", status: "passed", summary }, null, 2));

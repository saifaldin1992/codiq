/**
 * P27-20 (ق-107) — the platform logo the owner uploads himself.
 *
 * ق-23 required every platform mark to be vector. The owner amended that on
 * 2026-08-29: an uploaded logo may be a PNG, because he has one and does not
 * have an SVG. The amendment is scoped, not a repeal — the mark COMPILED INTO
 * the code (`<BrandMark/>`) stays vector, and an SVG upload is still accepted
 * and still preferred. What changed is that PNG is no longer refused.
 *
 * Three design points worth their lines:
 *
 * 1. **The object key carries a version.** Replacing a logo under one fixed key
 *    would leave every browser, proxy and email client showing the old one for
 *    as long as their cache lives — the owner would change it and see no change.
 *    A new version means a new URL, so invalidation is free and total.
 *
 * 2. **The minimum is 512×512** for a raster upload. Below that the logo is soft
 *    on a high-density screen, and the owner cannot see that on his own monitor.
 *    The dimensions are read from the PNG header rather than trusted from the
 *    client, because a client-side check is a suggestion.
 *
 * 3. **Reverting is deleting the setting, not uploading a default.** The default
 *    is the vector mark in the code, so «العودة إلى الافتراضي» can never fail
 *    for want of a stored file.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";
import type { PlatformActor } from "../auth/platform-permissions.js";
import { recordPlatformAuditEvent } from "./platform-audit.service.js";

const LOGO_KEY = "platform.logo";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MIN_RASTER_EDGE = 512;

export interface PlatformLogo {
  objectKey: string;
  contentType: string;
  version: string;
  width: number | null;
  height: number | null;
  byteSize: number;
}

function s3Config() {
  const endpoint = process.env.PRODUCT_S3_ENDPOINT;
  const bucket = process.env.PRODUCT_S3_BUCKET;
  const accessKeyId = process.env.PRODUCT_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PRODUCT_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new HttpError(503, "IMAGE_STORAGE_NOT_CONFIGURED", "تخزين الصور غير مهيأ على هذه البيئة.");
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.PRODUCT_S3_REGION ?? "us-east-1" };
}

function client(config: ReturnType<typeof s3Config>) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: process.env.PRODUCT_S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG width and height, read from the IHDR chunk the format puts first — bytes
 * 16..24 of any valid PNG. Read from the BYTES, never from what the client says.
 */
function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** An SVG has no pixels to be soft, so it passes the size rule by nature. */
function looksLikeSvg(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<?xml") ? head.includes("<svg") : head.startsWith("<svg");
}

export function validatePlatformLogo(file: Express.Multer.File): { contentType: string; extension: string; width: number | null; height: number | null } {
  if (!file?.buffer?.length || file.size > MAX_LOGO_BYTES) {
    throw new HttpError(422, "INVALID_PLATFORM_LOGO", "ارفع ملف شعار حجمه 2 ميغابايت أو أقل.");
  }
  if (looksLikeSvg(file.buffer)) {
    // An SVG is script-bearing markup. This function does NOT make it safe — it
    // only records the type. Until 19-د the comment here claimed the object was
    // "served as a DOWNLOAD-typed object", and no code anywhere did that; the
    // route served it inline on the app's own origin, which is stored XSS.
    // The claim is now true, and it is true in ONE place you can go and read:
    // `GET /public/brand/logo/:objectKey` in http/routes/public.ts sends every
    // logo with `Content-Disposition: attachment`, a `default-src 'none'` CSP
    // and nosniff. Anything else that ever serves these bytes must do the same,
    // or rasterise them first.
    return { contentType: "image/svg+xml", extension: "svg", width: null, height: null };
  }
  const dimensions = pngDimensions(file.buffer);
  if (!dimensions) {
    throw new HttpError(422, "INVALID_PLATFORM_LOGO", "الشعار يجب أن يكون ملف PNG أو SVG. الصيغ الأخرى غير مقبولة.");
  }
  if (dimensions.width < MIN_RASTER_EDGE || dimensions.height < MIN_RASTER_EDGE) {
    throw new HttpError(
      422,
      "PLATFORM_LOGO_TOO_SMALL",
      `الشعار النقطي يجب أن يكون ${MIN_RASTER_EDGE}×${MIN_RASTER_EDGE} بكسل على الأقل — المرفوع ${dimensions.width}×${dimensions.height}. الأصغر يظهر باهتاً على الشاشات عالية الكثافة وفي الطباعة.`,
    );
  }
  return { contentType: "image/png", extension: "png", width: dimensions.width, height: dimensions.height };
}

export async function readPlatformLogo(): Promise<PlatformLogo | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: LOGO_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as PlatformLogo;
    return parsed?.objectKey ? parsed : null;
  } catch {
    // A malformed row must not take the whole platform's branding down with it:
    // the built-in vector mark is always a correct answer.
    return null;
  }
}

export async function putPlatformLogo(actor: PlatformActor, file: Express.Multer.File, now: Date): Promise<PlatformLogo> {
  const detected = validatePlatformLogo(file);
  const config = s3Config();
  // The version IS the cache key. A fixed object key would leave browsers and
  // email clients showing the previous logo until their caches expired.
  const version = now.valueOf().toString(36);
  const objectKey = `platform/logo-${version}.${detected.extension}`;
  await client(config).send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: file.buffer,
    ContentType: detected.contentType,
    ContentLength: file.size,
  }));
  const logo: PlatformLogo = { objectKey, contentType: detected.contentType, version, width: detected.width, height: detected.height, byteSize: file.size };
  // 19-ب: the S3 write stays outside the transaction (an orphaned object is
  // bytes, not a lie); the SETTING and its audit record commit together.
  await prisma.$transaction(async (tx) => {
    await tx.platformSetting.upsert({
      where: { key: LOGO_KEY },
      update: { value: JSON.stringify(logo) },
      create: { key: LOGO_KEY, value: JSON.stringify(logo) },
    });
    await recordPlatformAuditEvent(tx, {
      entityType: "brand",
      entityLabel: "شعار المنصة",
      action: "logo_changed",
      actor,
      metadata: { version, byteSize: file.size, contentType: detected.contentType },
    });
  });
  return logo;
}

/**
 * Back to the built-in mark. The stored OBJECT is deliberately left in place:
 * an owner who reverts by mistake gets his logo back by re-uploading, and the
 * bytes cost less than the regret. The purge of old logo objects is a phase-24
 * housekeeping item, not something to do on a click labelled «رجوع».
 */
export async function clearPlatformLogo(actor: PlatformActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.platformSetting.deleteMany({ where: { key: LOGO_KEY } });
    await recordPlatformAuditEvent(tx, {
      entityType: "brand",
      entityLabel: "شعار المنصة",
      action: "logo_cleared",
      actor,
    });
  });
}

export async function platformLogoBytes(objectKey: string): Promise<{ body: Uint8Array; contentType: string }> {
  const logo = await readPlatformLogo();
  // Only the CURRENT logo object is servable. Without this the endpoint would
  // read any key an attacker could name inside the bucket.
  if (!logo || logo.objectKey !== objectKey) {
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "الشعار غير موجود.");
  }
  const config = s3Config();
  const object = await client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
  if (!object.Body || !("transformToByteArray" in object.Body)) {
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "تعذّرت قراءة الشعار.");
  }
  return { body: await object.Body.transformToByteArray(), contentType: logo.contentType };
}

export const platformLogoConstraints = { maxBytes: MAX_LOGO_BYTES, minRasterEdge: MIN_RASTER_EDGE };

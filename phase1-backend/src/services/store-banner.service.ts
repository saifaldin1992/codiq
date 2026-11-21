/**
 * ق-198 — the merchant owns the large images on his own front page.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * The storefront's landing page had nothing a merchant could change. The only
 * image on it came from the theme, and the only words he owned were the one-line
 * vacation banner. The reference shop this platform is being shaped after opens
 * with a full-bleed slider of several large photographs — and that slider IS the
 * first impression of the shop. Leaving it fixed would mean every store on the
 * platform opens with the same nothing, however different the shops are.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY REUSES
 * ============================================================================
 *
 * Everything. A banner is a product image that belongs to the STORE rather than
 * to one product: the same magic-byte validator, the same S3 bucket, the same
 * best-effort delete loop, the same authenticated-upload guard, and the same
 * `max_image_storage_mb` plan meter — which already sums `store_banners` because
 * `merchantUsage` counts bytes, not tables.
 *
 * That reuse is the point. A second upload pipeline would have meant a second
 * magic-byte check to keep honest, a second thing the plan meter could miss, and
 * a second place for a `javascript:` URL to reach a shopper.
 *
 * ============================================================================
 * TWO RULES THAT ARE NOT CONVENIENCE
 * ============================================================================
 *
 * 1. HIDE, DO NOT DELETE, is the ordinary act. A seasonal slide comes back every
 *    year; deleting it costs a re-upload and a second charge against the storage
 *    plan for bytes the merchant already paid for. `isActive` is the switch the
 *    screen offers first, and deletion is the deliberate one.
 *
 * 2. THE LINK IS http(s) OR NOTHING, enforced by a CHECK in the migration and
 *    again here. A slide is a merchant-authored anchor shown to every one of his
 *    shoppers; a `javascript:` URL there is stored XSS that he hands out himself.
 *    Validating in one place only would leave the other as the way in.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import { deleteStoreBannerObjects, putStoreBanner } from "./product-image-storage.service.js";
import { assertWithinPlanLimit } from "./entitlement.service.js";
import { BANNER_PLACEMENTS, type BannerPlacement } from "../http/schemas/store-banner.schema.js";

/**
 * How many slides one store may keep. Generous, and a ceiling rather than a
 * policy: a shopper never scrolls twelve hero images, and an unbounded slider is
 * a way to spend the storage plan without noticing.
 */
export const MAX_STORE_BANNERS = 12;

const HTTP_URL = /^https?:\/\//;

/** ق-210: the placement a slide gets when the screen does not say. */
const DEFAULT_PLACEMENT: BannerPlacement = "hero";

export interface StoreBannerView {
  id: string;
  url: string;
  linkUrl: string | null;
  altText: string | null;
  isActive: boolean;
  sortOrder: number;
  byteSize: number;
  /** ق-210 — 'hero' (the opening slider) or 'mid' (the strip between the rails). */
  placement: BannerPlacement;
}

/** The path the browser fetches. Bytes are streamed by the route, never signed URLs — the same shape product images use. */
const bannerUrl = (storeSlug: string, id: string) =>
  `/api/store/${encodeURIComponent(storeSlug)}/banners/${id}/image`;

/** A placement the storefront cannot draw is read as the hero one rather than dropped: the slide exists and the merchant paid for it. */
function placementOf(value: string): BannerPlacement {
  return (BANNER_PLACEMENTS as readonly string[]).includes(value)
    ? (value as BannerPlacement)
    : DEFAULT_PLACEMENT;
}

function view(
  storeSlug: string,
  row: {
    id: string;
    linkUrl: string | null;
    altText: string | null;
    isActive: boolean;
    sortOrder: number;
    byteSize: number;
    placement: string;
  }
): StoreBannerView {
  return {
    id: row.id,
    url: bannerUrl(storeSlug, row.id),
    linkUrl: row.linkUrl,
    altText: row.altText,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    byteSize: row.byteSize,
    placement: placementOf(row.placement),
  };
}

const BANNER_SELECT = {
  id: true,
  linkUrl: true,
  altText: true,
  isActive: true,
  sortOrder: true,
  byteSize: true,
  placement: true,
} as const;

/** The merchant's own list: hidden slides included, because he is the one who hid them. */
export async function listStoreBanners(
  storeId: string,
  storeSlug: string
): Promise<{ storeSlug: string; banners: StoreBannerView[] }> {
  const rows = await prisma.storeBanner.findMany({
    where: { storeId },
    // Placement first: the screen draws the two sliders as two lists, and the
    // merchant reorders inside one of them.
    orderBy: [{ placement: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    select: BANNER_SELECT,
  });
  return { storeSlug, banners: rows.map((row) => view(storeSlug, row)) };
}

/** The shopper's list: live slides only, in order. */
export async function publicStoreBanners(
  storeId: string,
  storeSlug: string
): Promise<StoreBannerView[]> {
  const rows = await prisma.storeBanner.findMany({
    where: { storeId, isActive: true },
    orderBy: [{ placement: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    select: BANNER_SELECT,
  });
  // Both placements in one payload, each slide saying where it belongs: the
  // storefront asks for the shop's slides once and draws two sliders from the
  // answer, rather than making the same trip twice for the same page.
  return rows.map((row) => view(storeSlug, row));
}

function assertLink(linkUrl: string | null | undefined): string | null {
  if (linkUrl === undefined || linkUrl === null || linkUrl === "") return null;
  const trimmed = String(linkUrl).trim();
  if (!HTTP_URL.test(trimmed)) {
    throw new HttpError(
      422,
      "INVALID_BANNER_LINK",
      "رابط الشريحة يجب أن يبدأ بـ http:// أو https://"
    );
  }
  return trimmed;
}

export async function addStoreBanner(
  storeId: string,
  storeSlug: string,
  merchantId: string,
  file: Express.Multer.File | undefined,
  input: { linkUrl?: unknown; altText?: unknown; placement?: unknown }
): Promise<StoreBannerView> {
  if (!file) throw new HttpError(422, "INVALID_BANNER_IMAGE", "صورة الشريحة مطلوبة.");
  const placement =
    typeof input.placement === "string" ? placementOf(input.placement) : DEFAULT_PLACEMENT;
  // The ceiling is PER PLACEMENT (ق-210): the two sliders are two decisions, and
  // a full hero slider must not stop the merchant from putting one promo strip in
  // the middle of his page.
  const existing = await prisma.storeBanner.count({ where: { storeId, placement } });
  if (existing >= MAX_STORE_BANNERS) {
    throw new HttpError(
      422,
      "BANNER_LIMIT_REACHED",
      `لا يمكن تجاوز ${MAX_STORE_BANNERS} شريحة في هذا الموضع من الصفحة الرئيسية. احذف واحدة أو أخفِها.`
    );
  }
  const linkUrl = assertLink(input.linkUrl as string | null | undefined);
  const altText =
    typeof input.altText === "string" && input.altText.trim()
      ? input.altText.trim().slice(0, 200)
      : null;

  // Charged BEFORE the bytes are stored, exactly as product images are: a plan
  // that is already full must refuse before anything reaches the bucket.
  await assertWithinPlanLimit(
    prisma,
    merchantId,
    "max_image_storage_mb",
    Math.max(1, Math.ceil(file.size / (1024 * 1024))),
    "لرفع صورة الصفحة الرئيسية"
  );

  const stored = await putStoreBanner(storeId, file);
  try {
    const last = await prisma.storeBanner.findFirst({
      where: { storeId, placement },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const created = await prisma.storeBanner.create({
      data: {
        storeId,
        ...stored,
        linkUrl,
        altText,
        placement,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
      select: BANNER_SELECT,
    });
    return view(storeSlug, created);
  } catch (error) {
    // The object was written before the row. A failed insert must not leave
    // bytes in the bucket that no row will ever name — they would be charged to
    // the merchant's plan forever with nothing able to free them.
    await deleteStoreBannerObjects([stored.objectKey]);
    throw error;
  }
}

export async function updateStoreBanner(
  storeId: string,
  storeSlug: string,
  bannerId: string,
  input: {
    linkUrl?: unknown;
    altText?: unknown;
    isActive?: unknown;
    sortOrder?: unknown;
    placement?: unknown;
  }
): Promise<StoreBannerView> {
  const data: Prisma.StoreBannerUpdateInput = {};
  if (input.linkUrl !== undefined) data.linkUrl = assertLink(input.linkUrl as string | null);
  // Moving a slide between the two sliders is an edit like any other — it keeps
  // its bytes, its link and its alt text, which a delete-and-re-upload would not.
  if (input.placement !== undefined) data.placement = placementOf(String(input.placement));
  if (input.altText !== undefined)
    data.altText =
      typeof input.altText === "string" && input.altText.trim()
        ? input.altText.trim().slice(0, 200)
        : null;
  if (input.isActive !== undefined) data.isActive = Boolean(input.isActive);
  if (input.sortOrder !== undefined) {
    const order = Number(input.sortOrder);
    if (!Number.isInteger(order) || order < 0 || order > 999)
      throw new HttpError(
        422,
        "INVALID_BANNER_ORDER",
        "ترتيب الشريحة يجب أن يكون رقماً صحيحاً موجباً."
      );
    data.sortOrder = order;
  }
  if (Object.keys(data).length === 0)
    throw new HttpError(422, "NOTHING_TO_UPDATE", "لا يوجد تغيير لتطبيقه.");

  // Scoped to the store, so a banner id from another tenant is simply not found.
  const updated = await prisma.storeBanner.updateMany({ where: { id: bannerId, storeId }, data });
  if (updated.count !== 1) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الشريحة غير موجودة.");
  const row = await prisma.storeBanner.findFirstOrThrow({
    where: { id: bannerId, storeId },
    select: BANNER_SELECT,
  });
  return view(storeSlug, row);
}

export async function deleteStoreBanner(storeId: string, bannerId: string): Promise<void> {
  const row = await prisma.storeBanner.findFirst({
    where: { id: bannerId, storeId },
    select: { id: true, objectKey: true },
  });
  if (!row) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الشريحة غير موجودة.");
  // The row first: if the object delete fails, the merchant's plan keeps paying
  // for orphaned bytes, but the SCREEN is correct — and the reverse (an object
  // gone while a row still points at it) shows a broken image to every shopper.
  await prisma.storeBanner.delete({ where: { id: row.id } });
  await deleteStoreBannerObjects([row.objectKey]);
}

/** The bytes, for the public image route. Scoped to the store like every other read here. */
export async function storeBannerObject(storeId: string, bannerId: string) {
  const row = await prisma.storeBanner.findFirst({
    where: { id: bannerId, storeId, isActive: true },
    select: { objectKey: true, contentType: true },
  });
  if (!row) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الشريحة غير موجودة.");
  return row;
}

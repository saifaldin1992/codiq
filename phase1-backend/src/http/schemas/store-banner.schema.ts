/**
 * ق-198 — what a merchant may say about one of his front-page slides.
 *
 * The image itself arrives as multipart and is validated by its MAGIC BYTES in
 * the storage service, never by these fields — a content type in a form is a
 * claim, not a fact. What is validated here is only the text that rides beside
 * it, and the link, whose shape is also a CHECK in migration 20260910120000
 * because a `javascript:` slide is stored XSS the merchant hands to his own
 * shoppers, and one validation site would leave the other as the way in.
 */
import { z } from "zod";

const linkUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => value === "" || /^https?:\/\//.test(value), {
    message: "رابط الشريحة يجب أن يبدأ بـ http:// أو https://",
  })
  .nullish();

const altText = z.string().trim().max(200).nullish();

/**
 * ق-210 — WHERE on the front page the slide lands: the full-bleed opening slider
 * or the promotional strip between the rails. Closed here and again by
 * store_banners_placement_ck, because a placement the storefront cannot render is
 * an invisible slide the merchant paid storage for.
 */
export const BANNER_PLACEMENTS = ["hero", "mid"] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];
/** Arrives as a multipart form field on create, so a plain string it is. */
const placement = z.enum(BANNER_PLACEMENTS).optional();

export const createStoreBannerSchema = z.object({
  linkUrl,
  altText,
  placement,
});

export const updateStoreBannerSchema = z
  .object({
    linkUrl,
    altText,
    isActive: z.boolean().optional(),
    placement,
    // Reordering is a number, not a drag-and-drop payload: the screen sends the
    // slide's new position and the server keeps the list a list.
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  // An empty PATCH is a caller mistake worth naming rather than a silent no-op.
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "لا يوجد تغيير لتطبيقه.",
  });

/** zod shapes for the owner's market content: banners, collections, malls, the front page and the category tree. */
import { z } from "zod";

export const BANNER_PLACEMENTS = [
  "home_hero",
  "home_strip",
  "categories_top",
  "search_top",
] as const;
export const LINK_KINDS = [
  "none",
  "store",
  "product",
  "category",
  "collection",
  "mall",
  "section",
  "search",
] as const;
export const SECTION_KEYS = [
  "discounts",
  "half-price",
  "new",
  "trending",
  "best-sellers",
  "sells-fast",
  "preorders",
  "top-rated",
] as const;
export const HOME_SECTION_KINDS = [
  "banners",
  "categories",
  "products",
  "stores",
  "collections",
  "malls",
  "recently_viewed",
  "for_you",
] as const;

const slug = z
  .string()
  .trim()
  .max(60)
  .regex(/^[a-z0-9-]+$/, "الرابط بحروف إنجليزيّة صغيرة وأرقام وشرطات")
  .refine(
    (value) =>
      value.length > 0 && !value.startsWith("-") && !value.endsWith("-") && !value.includes("--"),
    { message: "الرابط لا يبدأ ولا ينتهي بشرطة ولا يكرّرها" }
  );
const when = z.string().datetime({ offset: true }).nullable();
const windowOk = (value: { startsAt?: string | null; endsAt?: string | null }) =>
  !value.startsAt || !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt);

export const bannerSchema = z
  .object({
    placement: z.enum(BANNER_PLACEMENTS),
    title: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(140).nullable(),
    linkKind: z.enum(LINK_KINDS),
    linkTarget: z.string().trim().min(1).max(120).nullable(),
    startsAt: when,
    endsAt: when,
    sortOrder: z.number().int().min(0).max(10_000),
    isActive: z.boolean(),
    isAd: z.boolean(),
  })
  .refine((value) => (value.linkKind === "none") === (value.linkTarget === null), {
    message: "اختر وجهة الرابط أو «بلا رابط»",
    path: ["linkTarget"],
  })
  .refine(
    (value) =>
      value.linkKind !== "section" ||
      (SECTION_KEYS as readonly string[]).includes(value.linkTarget ?? ""),
    { message: "قسم غير معروف", path: ["linkTarget"] }
  )
  .refine(windowOk, { message: "نهاية العرض قبل بدايته", path: ["endsAt"] });
export type BannerInput = z.infer<typeof bannerSchema>;

export const bannerEventSchema = z.object({ kind: z.enum(["view", "click"]) });

export const collectionSchema = z
  .object({
    slug,
    kind: z.enum(["collection", "discount"]),
    title: z.string().trim().min(2).max(80),
    subtitle: z.string().trim().max(160).nullable(),
    headlineDiscountPercent: z.number().int().min(1).max(99).nullable(),
    startsAt: when,
    endsAt: when,
    sortOrder: z.number().int().min(0).max(10_000),
    isActive: z.boolean(),
  })
  .refine(windowOk, { message: "نهاية العرض قبل بدايته", path: ["endsAt"] });
export type CollectionInput = z.infer<typeof collectionSchema>;

export const collectionItemsSchema = z.object({ productIds: z.array(z.string().uuid()).max(200) });

export const mallSchema = z.object({
  slug,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable(),
  sortOrder: z.number().int().min(0).max(10_000),
  isActive: z.boolean(),
});
export type MallInput = z.infer<typeof mallSchema>;

export const mallStoresSchema = z.object({
  storeSlugs: z.array(z.string().trim().min(1).max(120)).max(100),
});

const productListConfig = z
  .object({
    sort: z
      .enum([
        "recommended",
        "newest",
        "price_asc",
        "price_desc",
        "rating",
        "best_selling",
        "trending",
        "discount",
      ])
      .optional(),
    period: z.enum(["day", "week", "month", "quarter"]).optional(),
    category: z.string().trim().max(60).optional(),
    discount: z.enum(["any", "30", "50"]).optional(),
    sellsFast: z.boolean().optional(),
    preorder: z.boolean().optional(),
    collection: z.string().trim().max(60).optional(),
    section: z.enum(SECTION_KEYS).optional(),
  })
  .strict();

export const homeSectionsSchema = z.object({
  sections: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("banners"),
          title: z.string().trim().max(60).nullable(),
          isActive: z.boolean(),
          config: z.object({ placement: z.enum(BANNER_PLACEMENTS) }).strict(),
        }),
        z.object({
          kind: z.literal("categories"),
          title: z.string().trim().max(60).nullable(),
          isActive: z.boolean(),
          config: z.object({}).strict(),
        }),
        z.object({
          kind: z.literal("products"),
          title: z.string().trim().min(1).max(60),
          isActive: z.boolean(),
          config: productListConfig,
        }),
        z.object({
          kind: z.literal("stores"),
          title: z.string().trim().min(1).max(60),
          isActive: z.boolean(),
          config: z
            .object({
              sort: z.enum(["recommended", "rating", "response", "views", "sales", "newest"]),
              ambassador: z.boolean().optional(),
            })
            .strict(),
        }),
        z.object({
          kind: z.literal("collections"),
          title: z.string().trim().min(1).max(60),
          isActive: z.boolean(),
          config: z.object({}).strict(),
        }),
        z.object({
          kind: z.literal("malls"),
          title: z.string().trim().min(1).max(60),
          isActive: z.boolean(),
          config: z.object({}).strict(),
        }),
        z.object({
          kind: z.literal("recently_viewed"),
          title: z.string().trim().min(1).max(60),
          isActive: z.boolean(),
          config: z.object({}).strict(),
        }),
        z.object({
          kind: z.literal("for_you"),
          title: z.string().trim().min(1).max(60),
          isActive: z.boolean(),
          config: z.object({}).strict(),
        }),
      ])
    )
    .min(1)
    .max(40),
});
export type HomeSectionsInput = z.infer<typeof homeSectionsSchema>;

export const categoryCreateSchema = z.object({
  slug,
  name: z.string().trim().min(2).max(60),
  parentId: z.number().int().positive().nullable(),
  sortOrder: z.number().int().min(0).max(10_000),
});
export const categoryUpdateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  parentId: z.number().int().positive().nullable(),
  sortOrder: z.number().int().min(0).max(10_000),
  isActive: z.boolean(),
});

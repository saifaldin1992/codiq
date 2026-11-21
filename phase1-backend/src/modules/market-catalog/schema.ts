/** zod shapes for the market catalog: the product list's query, and what the merchant edits. */
import { z } from "zod";

export const MARKET_PRODUCT_SORTS = [
  "relevance",
  "recommended",
  "newest",
  "price_asc",
  "price_desc",
  "rating",
  "best_selling",
  "trending",
  "discount",
] as const;
export type MarketProductSort = (typeof MARKET_PRODUCT_SORTS)[number];
export const SALES_PERIODS = ["day", "week", "month", "quarter"] as const;
export const PRODUCT_TAGS = [
  "original",
  "imported",
  "warranty",
  "limited_edition",
  "exclusive",
  "free_delivery",
  "free_returns",
] as const;
export const PRODUCT_CONDITIONS = ["new", "used", "refurbished"] as const;

const uuidList = (max: number) =>
  z
    .string()
    .max(max * 37)
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined
    )
    .refine(
      (value) =>
        value === undefined ||
        (value.length <= max &&
          value.every((part) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)
          )),
      { message: "قائمة معرّفات غير صالحة" }
    );
const flag = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((value) => value === "1" || value === "true");
const price = z.coerce.number().int().min(0).max(2_147_483_647).optional();

export const marketProductQuerySchema = z
  .object({
    q: z.string().trim().max(80).optional(),
    sort: z.enum(MARKET_PRODUCT_SORTS).optional(),
    period: z.enum(SALES_PERIODS).optional().default("month"),
    category: z.string().trim().max(60).optional(),
    store: z.string().trim().max(120).optional(),
    deliverTo: z.string().trim().max(40).optional(),
    minPrice: price,
    maxPrice: price,
    discount: z.enum(["any", "30", "50"]).optional(),
    rating: z.enum(["3", "excellent"]).optional(),
    condition: z.enum(PRODUCT_CONDITIONS).optional(),
    tag: z.enum(PRODUCT_TAGS).optional(),
    preorder: flag,
    inStock: flag,
    exclude: z.string().uuid().optional(),
    // Marketplace M3: a curated collection, a mall's stores, explicit products («شاهدته مؤخراً»),
    // products like these («مقترح لك»), and the ones running out.
    collection: z.string().trim().max(60).optional(),
    mall: z.string().trim().max(60).optional(),
    ids: uuidList(24),
    relatedTo: uuidList(10),
    sellsFast: flag,
    cursor: z.string().max(512).optional(),
    limit: z.unknown().optional(),
  })
  .refine(
    (value) =>
      value.minPrice === undefined ||
      value.maxPrice === undefined ||
      value.minPrice <= value.maxPrice,
    { message: "أقلّ سعر أكبر من أعلى سعر", path: ["minPrice"] }
  )
  .refine((value) => value.maxPrice === undefined || value.maxPrice > 0, {
    message: "أعلى سعر يجب أن يكون أكبر من صفر",
    path: ["maxPrice"],
  });
export type MarketProductQuery = z.infer<typeof marketProductQuerySchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ بصيغة YYYY-MM-DD");

export const productMarketFieldsSchema = z
  .object({
    marketCategoryId: z.number().int().positive().nullable(),
    compareAtPriceIqd: z.number().int().positive().max(2_147_483_647).nullable(),
    condition: z.enum(PRODUCT_CONDITIONS),
    tags: z
      .array(z.enum(PRODUCT_TAGS))
      .max(PRODUCT_TAGS.length)
      .transform((tags) => Array.from(new Set(tags))),
    specs: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(40),
          value: z.string().trim().min(1).max(120),
        })
      )
      .max(30),
    isPreorder: z.boolean(),
    preorderReleaseOn: isoDate.nullable(),
    preorderShipsBy: isoDate.nullable(),
    maxPerOrder: z.number().int().min(1).max(99).nullable(),
    /** Marketplace M13a (E6): optional, so older callers leave them as they are. */
    instalmentsEligible: z.boolean().optional(),
    instalmentsCashPrice: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.isPreorder || (value.preorderReleaseOn === null && value.preorderShipsBy === null),
    { message: "تواريخ الطلب المسبق للمنتجات المسبقة فقط", path: ["isPreorder"] }
  )
  .refine(
    (value) =>
      !value.preorderReleaseOn ||
      !value.preorderShipsBy ||
      value.preorderShipsBy >= value.preorderReleaseOn,
    { message: "تاريخ الشحن قبل تاريخ الإصدار", path: ["preorderShipsBy"] }
  )
  .refine(
    (value) => !(value.instalmentsCashPrice === true && value.instalmentsEligible === false),
    { message: "«بسعر الكاش» يحتاج أن يكون المنتج متاحاً بالتقسيط", path: ["instalmentsCashPrice"] }
  );
export type ProductMarketFieldsInput = z.infer<typeof productMarketFieldsSchema>;

export const productAddonsSchema = z.object({
  addons: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        priceIqd: z.number().int().min(0).max(100_000_000),
        isActive: z.boolean().optional().default(true),
      })
    )
    .max(20),
});

export const categoryMappingSchema = z.object({
  marketCategoryId: z.number().int().positive().nullable(),
});

/**
 * ق-199 — what a merchant may say about his own storefront.
 *
 * One schema for one screen («واجهة المتجر»). Every key here is a column on
 * `stores` (migration 20260910150000) and a key the shopper's `public-config`
 * carries; `storefront-config.guard.mjs` holds the three lists equal so a field
 * can never exist that the merchant can set and nobody ever sees.
 *
 * Absent means «leave it»; `null` or `""` on a text field means «clear it» —
 * the same reading `updateStoreVacation` has always had, so the screen can send
 * one section at a time.
 */
import { z } from "zod";

/**
 * The front-page sections, in their default order.
 *
 * `banners_mid` (ق-210) is the SECOND slider — the promotional strip the
 * reference shop carries between its rails. It is a section rather than a fixed
 * position because the whole point of this list is that the merchant decides what
 * his front page opens with and what comes next.
 */
export const HOME_SECTION_KEYS = ["banners", "categories", "newest", "best_selling", "banners_mid", "top_rated", "reviews"] as const;
export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

/**
 * Neutral by design (D-101): «وصل حديثاً» rather than the reference shop's
 * «عطور جديدة» — a pharmacy and a perfumery share this platform, and the
 * merchant renames what he likes.
 */
export const HOME_SECTION_DEFAULT_TITLES: Record<HomeSectionKey, string> = {
  banners: "",
  categories: "تسوّق حسب التصنيف",
  newest: "وصل حديثاً",
  best_selling: "الأكثر مبيعاً",
  banners_mid: "",
  top_rated: "الأعلى تقييماً",
  reviews: "آراء العملاء",
};

const text = (max: number) => z.string().trim().max(max).nullish();

/**
 * A social handle is a USERNAME, never a URL: the prefix is fixed in code, so a
 * handle can never carry a scheme, a host, or a script. A leading «@» is
 * forgiven, because that is how people copy them.
 */
const handle = (pattern: RegExp, network: string) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ""))
    .refine((value) => value === "" || pattern.test(value), { message: `اكتب اسم المستخدم فقط على ${network} — بلا رابط.` })
    .nullish();

const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), { message: "بريد الدعم غير صالح." })
  .nullish();

export const homeSectionsSchema = z
  .array(
    z.object({
      key: z.enum(HOME_SECTION_KEYS),
      enabled: z.boolean(),
      title: z.string().trim().min(1).max(60).nullish(),
    }),
  )
  .max(HOME_SECTION_KEYS.length)
  .refine((sections) => new Set(sections.map((section) => section.key)).size === sections.length, { message: "كل قسم يُذكر مرة واحدة." });

export type HomeSectionInput = z.infer<typeof homeSectionsSchema>[number];

/**
 * ق-211 — the merchant's own footer pages.
 *
 * The three POLICIES below (return, privacy, delivery) are named by the checkout
 * screen itself and stay fixed. These are the rest: «من نحن», «اتفاقية
 * المستخدم», an article about what the shop sells — prose that differs shop to
 * shop, so the platform ships the mechanism and not the titles.
 *
 * The slug is the URL. It is lowercase-ascii and hyphens only: an Arabic slug
 * would be percent-encoded into forty characters of noise in the address bar,
 * and the TITLE — which is what a shopper reads — is free Arabic text.
 */
export const MAX_CUSTOM_PAGES = 6;
export const customPagesSchema = z
  .array(
    z.object({
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "رابط الصفحة: أحرف إنجليزية صغيرة وأرقام وشرطات فقط."),
      title: z.string().trim().min(1).max(80),
      body: z.string().trim().min(1).max(20000),
    }),
  )
  .max(MAX_CUSTOM_PAGES)
  .refine((pages) => new Set(pages.map((page) => page.slug)).size === pages.length, { message: "لا يمكن تكرار رابط الصفحة." })
  // `policies/:kind` and `pages/:slug` are two different routes, but a merchant
  // reading his own footer sees one list — so a page that shadows a policy's name
  // is a trap for him and not for the router.
  .refine((pages) => pages.every((page) => !(POLICY_KINDS as readonly string[]).includes(page.slug)), {
    message: "هذا الرابط محجوز لإحدى السياسات — اختر رابطاً آخر.",
  });

export type CustomPageInput = z.infer<typeof customPagesSchema>[number];

/** Typed attribute groups on a product: the merchant's own vocabulary, in the data. */
export const productAttributesSchema = z
  .array(
    z.object({
      group: z.string().trim().min(1).max(60),
      rows: z.array(z.object({ key: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(200) })).min(1).max(20),
    }),
  )
  .max(10);

export const updateStorefrontSettingsSchema = z
  .object({
    // Identity. The name has the same bounds `requiredStoreName` enforces on rename.
    name: z.string().trim().min(2, "اسم المتجر قصير جداً.").max(80, "اسم المتجر طويل جداً.").optional(),
    headline: text(120),
    subline: text(300),
    // The strip above the header.
    announcementEnabled: z.boolean().optional(),
    announcementText: text(200),
    // Contact (P27-2 §1). Phones are normalised to E.164 by the service.
    supportEmail: optionalEmail,
    supportPhone: text(40),
    supportWhatsapp: text(40),
    addressLine: text(200),
    city: text(60),
    // Social handles (P27-2 §2).
    socialFacebook: handle(/^[A-Za-z0-9._-]{1,60}$/, "فيسبوك"),
    socialInstagram: handle(/^[A-Za-z0-9._]{1,30}$/, "إنستغرام"),
    socialX: handle(/^[A-Za-z0-9_]{1,15}$/, "إكس"),
    socialTiktok: handle(/^[A-Za-z0-9._]{1,24}$/, "تيك توك"),
    socialSnapchat: handle(/^[A-Za-z0-9._-]{1,30}$/, "سناب شات"),
    socialYoutube: handle(/^[A-Za-z0-9._-]{1,30}$/, "يوتيوب"),
    // Written policies (P27-2 §3).
    policyReturn: text(5000),
    policyPrivacy: text(5000),
    policyDelivery: text(5000),
    // Whether a stranger may buy without an account.
    guestCheckoutEnabled: z.boolean().optional(),
    // The rest of «روابط مهمة» — the pages the merchant writes himself (ق-211).
    customPages: customPagesSchema.optional(),
    // The front page.
    homeSections: homeSectionsSchema.optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "لا يوجد تغيير لتطبيقه." });

export type UpdateStorefrontSettingsInput = z.infer<typeof updateStorefrontSettingsSchema>;

export const POLICY_KINDS = ["return", "privacy", "delivery"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];
export const POLICY_TITLES: Record<PolicyKind, string> = {
  return: "سياسة الإرجاع والاستبدال",
  privacy: "سياسة الخصوصية",
  delivery: "سياسة التوصيل",
};

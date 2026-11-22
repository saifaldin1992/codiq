/**
 * ق-199 — the storefront the merchant owns, as data.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * The storefront printed the URL slug where the shop's name belongs, had no
 * logo, no announcement strip, no contact block, no social links, no written
 * policies, and no switch for whether a stranger may buy without an account.
 * The only sentence a merchant could put on his own shop was the vacation
 * notice. Every one of those is a thing that differs from shop to shop.
 *
 * ============================================================================
 * THE ONE RULE
 * ============================================================================
 *
 * Every field here is edited from ONE merchant screen («واجهة المتجر»), stored
 * on ONE row (`stores`), and read by ONE public payload
 * (`GET /store/:slug/public-config`, via `publicStorefrontConfig`). The map
 * `STOREFRONT_FIELDS` below names, for every merchant-editable field, the public
 * key it becomes — and `storefront-config.guard.mjs` holds the schema, this
 * map, the public payload and the two screens equal, so a field can never
 * exist that the merchant can set and the shopper never sees, or the reverse.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * ============================================================================
 *
 *  · Colours and typography — the platform's identity is the platform's.
 *  · A language switch — there is no translation layer (P27-9); a toggle that
 *    flips direction on Arabic strings would be a lie.
 *  · Payment-method logos for methods that are not live — the payload carries
 *    the ENABLED methods, and today that is cash on delivery.
 */
import type { Prisma } from "@prisma/client";
import { resolveSetting } from "./config.service.js";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../auth/auth.errors.js";
import { toE164 } from "../auth/identity.js";
import { assertWithinPlanLimit, replacementIncrementMb } from "./entitlement.service.js";
import { deleteStoreLogoObjects, putStoreLogo } from "./product-image-storage.service.js";
import { enabledPaymentMethods, type EnabledPaymentMethod } from "./payment-methods.service.js";
import {
  HOME_SECTION_DEFAULT_TITLES,
  HOME_SECTION_KEYS,
  POLICY_KINDS,
  POLICY_TITLES,
  customPagesSchema,
  homeSectionsSchema,
  type CustomPageInput,
  type HomeSectionKey,
  type PolicyKind,
  type UpdateStorefrontSettingsInput,
} from "../http/schemas/storefront-config.schema.js";

/**
 * Merchant field → the public key(s) it becomes. Read by the guard, and by
 * nobody else: a comment can drift, a map that a test reads cannot.
 */
export const STOREFRONT_FIELDS: Record<keyof UpdateStorefrontSettingsInput, readonly string[]> = {
  name: ["name"],
  headline: ["headline"],
  subline: ["subline"],
  announcementEnabled: ["announcement"],
  announcementText: ["announcement"],
  supportEmail: ["contact"],
  supportPhone: ["contact"],
  supportWhatsapp: ["contact"],
  addressLine: ["contact"],
  city: ["contact"],
  socialFacebook: ["social"],
  socialInstagram: ["social"],
  socialX: ["social"],
  socialTiktok: ["social"],
  socialSnapchat: ["social"],
  socialYoutube: ["social"],
  policyReturn: ["policies"],
  policyPrivacy: ["policies"],
  policyDelivery: ["policies"],
  customPages: ["pages"],
  guestCheckoutEnabled: ["guestCheckout"],
  homeSections: ["homeSections"],
};

/** The prefix is fixed here; the column holds a username and nothing else. */
export const SOCIAL_PREFIXES = {
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com/",
  x: "https://x.com/",
  tiktok: "https://www.tiktok.com/@",
  snapchat: "https://www.snapchat.com/add/",
  youtube: "https://www.youtube.com/@",
} as const;

const SETTINGS_SELECT = {
  id: true, slug: true, name: true,
  logoObjectKey: true, logoContentType: true, logoByteSize: true,
  headline: true, subline: true,
  announcementEnabled: true, announcementText: true,
  supportEmail: true, supportPhone: true, supportWhatsapp: true, addressLine: true, city: true,
  socialFacebook: true, socialInstagram: true, socialX: true, socialTiktok: true, socialSnapchat: true, socialYoutube: true,
  policyReturn: true, policyPrivacy: true, policyDelivery: true, customPages: true,
  guestCheckoutEnabled: true, homeSections: true,
} satisfies Prisma.StoreSelect;

type StoreRow = Prisma.StoreGetPayload<{ select: typeof SETTINGS_SELECT }>;

export interface HomeSectionView { key: HomeSectionKey; enabled: boolean; title: string }

/**
 * The stored list is a DELTA, not the truth: it may be empty, partial, or from
 * before a section existed. The resolved list is always complete and ordered —
 * stored entries first in their order, then every section the merchant never
 * mentioned, on, with its default title.
 */
export function resolveHomeSections(stored: unknown): HomeSectionView[] {
  const parsed = homeSectionsSchema.safeParse(stored);
  const chosen = parsed.success ? parsed.data : [];
  const seen = new Set<HomeSectionKey>();
  const out: HomeSectionView[] = [];
  for (const entry of chosen) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push({ key: entry.key, enabled: entry.enabled, title: entry.title?.trim() || HOME_SECTION_DEFAULT_TITLES[entry.key] });
  }
  for (const key of HOME_SECTION_KEYS) {
    if (!seen.has(key)) out.push({ key, enabled: true, title: HOME_SECTION_DEFAULT_TITLES[key] });
  }
  return out;
}

/**
 * ق-211 — the stored pages, read defensively for the same reason the sections
 * are: the column is JSONB, and a payload that predates a rule must not take a
 * whole storefront down. A page that no longer parses is dropped, not repaired.
 */
export function resolveCustomPages(stored: unknown): CustomPageInput[] {
  const parsed = customPagesSchema.safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** The path the browser fetches; `v` changes with every new upload so the bytes may be cached as immutable. */
function logoUrl(slug: string, objectKey: string): string {
  const version = objectKey.split("/").pop()?.split(".")[0] ?? "0";
  return `/api/store/${encodeURIComponent(slug)}/logo?v=${encodeURIComponent(version)}`;
}

export interface StorefrontSettingsView {
  storeSlug: string;
  name: string;
  logo: { url: string; byteSize: number } | null;
  headline: string | null;
  subline: string | null;
  announcementEnabled: boolean;
  announcementText: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  supportWhatsapp: string | null;
  addressLine: string | null;
  city: string | null;
  socialFacebook: string | null;
  socialInstagram: string | null;
  socialX: string | null;
  socialTiktok: string | null;
  socialSnapchat: string | null;
  socialYoutube: string | null;
  policyReturn: string | null;
  policyPrivacy: string | null;
  policyDelivery: string | null;
  customPages: CustomPageInput[];
  guestCheckoutEnabled: boolean;
  homeSections: HomeSectionView[];
}

function settingsView(row: StoreRow): StorefrontSettingsView {
  return {
    storeSlug: row.slug,
    name: row.name,
    logo: row.logoObjectKey && row.logoByteSize ? { url: logoUrl(row.slug, row.logoObjectKey), byteSize: row.logoByteSize } : null,
    headline: row.headline, subline: row.subline,
    announcementEnabled: row.announcementEnabled, announcementText: row.announcementText,
    supportEmail: row.supportEmail, supportPhone: row.supportPhone, supportWhatsapp: row.supportWhatsapp, addressLine: row.addressLine, city: row.city,
    socialFacebook: row.socialFacebook, socialInstagram: row.socialInstagram, socialX: row.socialX, socialTiktok: row.socialTiktok,
    socialSnapchat: row.socialSnapchat, socialYoutube: row.socialYoutube,
    policyReturn: row.policyReturn, policyPrivacy: row.policyPrivacy, policyDelivery: row.policyDelivery,
    customPages: resolveCustomPages(row.customPages),
    guestCheckoutEnabled: row.guestCheckoutEnabled,
    homeSections: resolveHomeSections(row.homeSections),
  };
}

async function loadStore(storeId: string): Promise<StoreRow> {
  const row = await prisma.store.findUnique({ where: { id: storeId }, select: SETTINGS_SELECT });
  if (!row) throw new HttpError(404, "STORE_NOT_FOUND", "المتجر المطلوب غير موجود.");
  return row;
}

/** The merchant's own view: every field, including the ones that are off. */
export async function storefrontSettings(storeId: string): Promise<StorefrontSettingsView> {
  return settingsView(await loadStore(storeId));
}

/** `null` and `""` both mean «clear it»; absent means «leave it». */
function clearable(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value === null ? "" : value.trim();
  return trimmed === "" ? null : trimmed;
}

function phoneOrThrow(value: string | null | undefined, code: string, label: string): string | null | undefined {
  const cleared = clearable(value);
  if (cleared === undefined || cleared === null) return cleared;
  const normalized = toE164(cleared);
  if (!normalized) throw new HttpError(422, code, `${label} غير صالح — اكتبه بصيغة 07XXXXXXXXX أو \u200E+9647XXXXXXXXX.`);
  return normalized;
}

export async function updateStorefrontSettings(storeId: string, input: UpdateStorefrontSettingsInput): Promise<StorefrontSettingsView> {
  const current = await loadStore(storeId);
  const data: Prisma.StoreUncheckedUpdateInput = {};

  if (input.name !== undefined) data.name = input.name;
  for (const key of ["headline", "subline", "announcementText", "supportEmail", "addressLine", "city", "socialFacebook", "socialInstagram", "socialX", "socialTiktok", "socialSnapchat", "socialYoutube", "policyReturn", "policyPrivacy", "policyDelivery"] as const) {
    const next = clearable(input[key]);
    if (next !== undefined) data[key] = next;
  }
  const phone = phoneOrThrow(input.supportPhone, "INVALID_SUPPORT_PHONE", "هاتف الدعم");
  if (phone !== undefined) data.supportPhone = phone;
  const whatsapp = phoneOrThrow(input.supportWhatsapp, "INVALID_SUPPORT_WHATSAPP", "رقم واتساب");
  if (whatsapp !== undefined) data.supportWhatsapp = whatsapp;

  // The strip may only be ON with a sentence in it — the CHECK in the migration
  // says the same, and refusing here names the field instead of a constraint.
  if (input.announcementEnabled !== undefined) data.announcementEnabled = input.announcementEnabled;
  const enabledAfter = input.announcementEnabled ?? current.announcementEnabled;
  const textAfter = data.announcementText !== undefined ? (data.announcementText as string | null) : current.announcementText;
  if (enabledAfter && !textAfter) throw new HttpError(422, "ANNOUNCEMENT_TEXT_REQUIRED", "اكتب نص شريط الإعلان قبل تفعيله.");

  if (input.customPages !== undefined) {
    data.customPages = input.customPages.map((page) => ({ slug: page.slug, title: page.title, body: page.body })) as Prisma.InputJsonValue;
  }

  if (input.guestCheckoutEnabled !== undefined) data.guestCheckoutEnabled = input.guestCheckoutEnabled;
  if (input.homeSections !== undefined) {
    data.homeSections = input.homeSections.map((section) => ({ key: section.key, enabled: section.enabled, title: section.title?.trim() || null })) as Prisma.InputJsonValue;
  }

  const updated = await prisma.store.update({ where: { id: storeId }, data, select: SETTINGS_SELECT });
  return settingsView(updated);
}

// ── the logo ────────────────────────────────────────────────────────────────

export async function setStoreLogo(storeId: string, merchantId: string, file: Express.Multer.File | undefined): Promise<StorefrontSettingsView> {
  if (!file) throw new HttpError(422, "INVALID_LOGO_IMAGE", "صورة الشعار مطلوبة.");
  const current = await loadStore(storeId);
  // Charged BEFORE the bytes are stored, exactly as product images and slides
  // are — and the merchant who owns the store pays, whoever the actor is.
  const added = current.logoObjectKey ? replacementIncrementMb(file.size, current.logoByteSize) : Math.max(1, Math.ceil(file.size / (1024 * 1024)));
  if (added > 0) await assertWithinPlanLimit(prisma, merchantId, "max_image_storage_mb", added, "لرفع شعار المتجر");
  const stored = await putStoreLogo(storeId, file);
  let updated: StoreRow;
  try {
    updated = await prisma.store.update({
      where: { id: storeId },
      data: { logoObjectKey: stored.objectKey, logoContentType: stored.contentType, logoByteSize: stored.byteSize },
      select: SETTINGS_SELECT,
    });
  } catch (error) {
    // The object was written before the row: a failed update must not leave
    // bytes no row will ever name, charged to the plan with nothing to free them.
    await deleteStoreLogoObjects([stored.objectKey]);
    throw error;
  }
  // The row first, then the old bytes — a failed delete costs plan space, the
  // reverse shows every shopper a broken image.
  if (current.logoObjectKey) await deleteStoreLogoObjects([current.logoObjectKey]);
  return settingsView(updated);
}

export async function removeStoreLogo(storeId: string): Promise<StorefrontSettingsView> {
  const current = await loadStore(storeId);
  if (!current.logoObjectKey) throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا يوجد شعار لحذفه.");
  const updated = await prisma.store.update({ where: { id: storeId }, data: { logoObjectKey: null, logoContentType: null, logoByteSize: null }, select: SETTINGS_SELECT });
  await deleteStoreLogoObjects([current.logoObjectKey]);
  return settingsView(updated);
}

/** For the public bytes route. */
export async function storeLogoObject(storeId: string): Promise<{ objectKey: string; contentType: string }> {
  const row = await prisma.store.findUnique({ where: { id: storeId }, select: { logoObjectKey: true, logoContentType: true } });
  if (!row?.logoObjectKey || !row.logoContentType) throw new HttpError(404, "RESOURCE_NOT_FOUND", "لا يوجد شعار لهذا المتجر.");
  return { objectKey: row.logoObjectKey, contentType: row.logoContentType };
}

// ── the shopper's side ──────────────────────────────────────────────────────

export interface PublicStorefrontConfig {
  name: string;
  logoUrl?: string;
  headline?: string;
  subline?: string;
  announcement?: { text: string };
  contact?: { email?: string; phone?: string; whatsapp?: string; addressLine?: string; city?: string };
  social?: { facebook?: string; instagram?: string; x?: string; tiktok?: string; snapchat?: string; youtube?: string };
  policies?: PolicyKind[];
  /** ق-211: the merchant's own footer pages — titles and slugs only; the body is one route away. */
  pages?: { slug: string; title: string }[];
  paymentMethods: EnabledPaymentMethod[];
  guestCheckout: boolean;
  homeSections: HomeSectionView[];
}

function compact<T extends Record<string, string | undefined>>(entries: T): T | undefined {
  const kept = Object.fromEntries(Object.entries(entries).filter(([, value]) => value)) as T;
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Everything the storefront needs to draw the shop, in the shape the shell and
 * the home page read. Optional keys are ABSENT rather than null when there is
 * nothing to say — the gating `pixels`, `vacation` and `verified` established.
 */
export async function publicStorefrontConfig(storeId: string): Promise<PublicStorefrontConfig> {
  // ق-209: the methods the merchant switched on, with what a wallet transfer
  // needs the shopper to know — never a decorative logo row.
  // The guest option is shown exactly when checkout will accept it: the store's
  // switch AND the merchant's and the platform's word (an «allow» setting).
  const [row, methods, guestCheckout] = await Promise.all([loadStore(storeId), enabledPaymentMethods(prisma, storeId), guestCheckoutAllowed(storeId)]);
  const contact = compact({ email: row.supportEmail ?? undefined, phone: row.supportPhone ?? undefined, whatsapp: row.supportWhatsapp ?? undefined, addressLine: row.addressLine ?? undefined, city: row.city ?? undefined });
  const social = compact({
    facebook: row.socialFacebook ? `${SOCIAL_PREFIXES.facebook}${row.socialFacebook}` : undefined,
    instagram: row.socialInstagram ? `${SOCIAL_PREFIXES.instagram}${row.socialInstagram}` : undefined,
    x: row.socialX ? `${SOCIAL_PREFIXES.x}${row.socialX}` : undefined,
    tiktok: row.socialTiktok ? `${SOCIAL_PREFIXES.tiktok}${row.socialTiktok}` : undefined,
    snapchat: row.socialSnapchat ? `${SOCIAL_PREFIXES.snapchat}${row.socialSnapchat}` : undefined,
    youtube: row.socialYoutube ? `${SOCIAL_PREFIXES.youtube}${row.socialYoutube}` : undefined,
  });
  const policies = POLICY_KINDS.filter((kind) => Boolean(policyText(row, kind)));
  // Titles and slugs only: the footer needs the links, and a shop with six long
  // pages would otherwise put sixty kilobytes of prose in every shopper's first
  // request for the sake of a list nobody has clicked yet.
  const pages = resolveCustomPages(row.customPages).map((page) => ({ slug: page.slug, title: page.title }));
  return {
    name: row.name,
    ...(row.logoObjectKey ? { logoUrl: logoUrl(row.slug, row.logoObjectKey) } : {}),
    ...(row.headline ? { headline: row.headline } : {}),
    ...(row.subline ? { subline: row.subline } : {}),
    ...(row.announcementEnabled && row.announcementText ? { announcement: { text: row.announcementText } } : {}),
    ...(contact ? { contact } : {}),
    ...(social ? { social } : {}),
    ...(policies.length ? { policies } : {}),
    ...(pages.length ? { pages } : {}),
    paymentMethods: methods,
    guestCheckout,
    homeSections: resolveHomeSections(row.homeSections).filter((section) => section.enabled),
  };
}

function policyText(row: Pick<StoreRow, "policyReturn" | "policyPrivacy" | "policyDelivery">, kind: PolicyKind): string | null {
  return kind === "return" ? row.policyReturn : kind === "privacy" ? row.policyPrivacy : row.policyDelivery;
}

export async function storePolicy(storeId: string, rawKind: string): Promise<{ kind: PolicyKind; title: string; body: string }> {
  const kind = POLICY_KINDS.find((entry) => entry === rawKind);
  if (!kind) throw new HttpError(404, "RESOURCE_NOT_FOUND", "السياسة المطلوبة غير موجودة.");
  const row = await prisma.store.findUnique({ where: { id: storeId }, select: { policyReturn: true, policyPrivacy: true, policyDelivery: true } });
  const body = row ? policyText(row, kind) : null;
  if (!body) throw new HttpError(404, "RESOURCE_NOT_FOUND", "لم يكتب المتجر هذه السياسة بعد.");
  return { kind, title: POLICY_TITLES[kind], body };
}

/**
 * ق-211 — one of the merchant's own pages, by its slug.
 *
 * Deliberately the same shape `storePolicy` returns, so the storefront draws both
 * with one component: a title and a body, or a 404. A slug that is not in the
 * array is not found — there is no «empty page» state for a page the merchant
 * never wrote.
 */
export async function storeCustomPage(storeId: string, rawSlug: string): Promise<{ slug: string; title: string; body: string }> {
  const slug = String(rawSlug ?? "").trim().toLowerCase();
  const row = await prisma.store.findUnique({ where: { id: storeId }, select: { customPages: true } });
  const page = resolveCustomPages(row?.customPages).find((entry) => entry.slug === slug);
  if (!page) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الصفحة المطلوبة غير موجودة.");
  return { slug: page.slug, title: page.title, body: page.body };
}

/** Read at checkout: may a shopper with no account buy here? */
export async function guestCheckoutAllowed(storeId: string): Promise<boolean> {
  // ق-251: the one function — the platform or the merchant may have closed guest checkout above the store's own switch.
  const row = await prisma.store.findUnique({ where: { id: storeId }, select: { merchantId: true } });
  if (!row) return false;
  return (await resolveSetting("checkout.guest_allowed", { merchantId: row.merchantId, storeId })).value === true;
}

/**
 * ق-184's second half: the store's support address becomes Reply-To on the
 * store's mail to ITS customers, so a shopper who answers his order
 * confirmation reaches the shop and not the platform.
 */
export async function storeSupportReplyTo(storeId: string): Promise<string | undefined> {
  const row = await prisma.store.findUnique({ where: { id: storeId }, select: { supportEmail: true } });
  return row?.supportEmail?.trim() || undefined;
}

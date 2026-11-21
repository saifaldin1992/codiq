/**
 * codiq phase 20B-3 — ad pixels (D-26): store_marketing_settings service.
 *
 * STRICT server-side format validation is the injection defense line: a pixel
 * id that does not match its exact official shape is refused with 422 — no
 * angle bracket, quote, or script fragment can ever be stored, and the public
 * config re-validates on the way out (defense in depth). The storefront is the
 * ONLY surface that ever loads these ids (StorefrontProvider is the single
 * injection point — dashboards never mount it).
 *
 * Future CSP note (D-34): when helmet lands, the script-src/connect-src
 * allowlist for STOREFRONT pages only is:
 *   connect.facebook.net, analytics.tiktok.com, www.googletagmanager.com
 * Dashboard pages get NO third-party script origin. The policy must ALSO
 * include worker-src 'self' (and a script-src 'self' covering /sw.js) or
 * shipped POS-offline dies silently — the till's service worker just stops
 * registering.
 */
import { HttpError } from "../auth/auth.errors.js";
import { prisma } from "../db/prisma.js";

export const META_PIXEL_ID_PATTERN = /^[0-9]{5,20}$/;
export const TIKTOK_PIXEL_ID_PATTERN = /^[A-Z0-9]{10,30}$/;
export const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

const PIXEL_FIELDS = [
  {
    key: "metaPixelId",
    pattern: META_PIXEL_ID_PATTERN,
    label: "Meta Pixel",
    hint: "أرقام فقط (5–20 خانة)",
  },
  {
    key: "tiktokPixelId",
    pattern: TIKTOK_PIXEL_ID_PATTERN,
    label: "TikTok Pixel",
    hint: "أحرف لاتينية كبيرة وأرقام (10–30 خانة)",
  },
  {
    key: "ga4MeasurementId",
    pattern: GA4_MEASUREMENT_ID_PATTERN,
    label: "GA4 Measurement ID",
    hint: "بصيغة G-XXXXXXX (أحرف كبيرة وأرقام)",
  },
] as const;
type PixelFieldKey = (typeof PIXEL_FIELDS)[number]["key"];

export interface MarketingSettingsView {
  metaPixelId: string | null;
  tiktokPixelId: string | null;
  ga4MeasurementId: string | null;
  isEnabled: boolean;
}

function view(
  settings: {
    metaPixelId: string | null;
    tiktokPixelId: string | null;
    ga4MeasurementId: string | null;
    isEnabled: boolean;
  } | null
): MarketingSettingsView {
  return {
    metaPixelId: settings?.metaPixelId ?? null,
    tiktokPixelId: settings?.tiktokPixelId ?? null,
    ga4MeasurementId: settings?.ga4MeasurementId ?? null,
    isEnabled: settings?.isEnabled === true,
  };
}

export async function marketingSettingsView(storeId: string): Promise<MarketingSettingsView> {
  return view(await prisma.storeMarketingSettings.findUnique({ where: { storeId } }));
}

/**
 * settings.manage write path. Each id field: undefined = keep, null/"" = clear,
 * anything else must match the exact official format or the whole write is 422.
 */
export async function updateMarketingSettings(
  storeId: string,
  body: Record<string, unknown>
): Promise<MarketingSettingsView> {
  const data: Partial<Record<PixelFieldKey, string | null>> & { isEnabled?: boolean } = {};
  for (const field of PIXEL_FIELDS) {
    const value = body[field.key];
    if (value === undefined) continue;
    if (value === null || value === "") {
      data[field.key] = null;
      continue;
    }
    if (typeof value !== "string" || !field.pattern.test(value.trim())) {
      throw new HttpError(
        422,
        "INVALID_PIXEL_FORMAT",
        `صيغة معرّف ${field.label} غير صالحة — ${field.hint}. لا يُقبل أي محتوى آخر.`
      );
    }
    data[field.key] = value.trim();
  }
  if (body.isEnabled !== undefined) {
    if (typeof body.isEnabled !== "boolean")
      throw new HttpError(422, "INVALID_INPUT", "isEnabled يجب أن يكون قيمة منطقية.");
    data.isEnabled = body.isEnabled;
  }
  const saved = await prisma.storeMarketingSettings.upsert({
    where: { storeId },
    create: {
      storeId,
      metaPixelId: data.metaPixelId ?? null,
      tiktokPixelId: data.tiktokPixelId ?? null,
      ga4MeasurementId: data.ga4MeasurementId ?? null,
      isEnabled: data.isEnabled ?? false,
    },
    update: data,
  });
  return view(saved);
}

/**
 * Public storefront config: pixels are present ONLY when the store enabled the
 * integration AND at least one id passes its format check again (a row written
 * before some future validation change can never leak an unvalidated value).
 * Disabled or empty settings return null — the route then omits the key.
 */
export async function publicPixelsConfig(
  storeId: string
): Promise<{ metaPixelId?: string; tiktokPixelId?: string; ga4MeasurementId?: string } | null> {
  const settings = await prisma.storeMarketingSettings.findUnique({ where: { storeId } });
  if (!settings?.isEnabled) return null;
  const pixels: { metaPixelId?: string; tiktokPixelId?: string; ga4MeasurementId?: string } = {};
  if (settings.metaPixelId && META_PIXEL_ID_PATTERN.test(settings.metaPixelId))
    pixels.metaPixelId = settings.metaPixelId;
  if (settings.tiktokPixelId && TIKTOK_PIXEL_ID_PATTERN.test(settings.tiktokPixelId))
    pixels.tiktokPixelId = settings.tiktokPixelId;
  if (settings.ga4MeasurementId && GA4_MEASUREMENT_ID_PATTERN.test(settings.ga4MeasurementId))
    pixels.ga4MeasurementId = settings.ga4MeasurementId;
  return Object.keys(pixels).length ? pixels : null;
}

/** zod shapes for the market-stores module: the directory's query, the merchant's profile, the owner's decisions. */
import { z } from "zod";

export const MARKET_STORE_SORTS = ["recommended", "rating", "response", "views", "sales", "newest", "nearest"] as const;
export type MarketStoreSort = (typeof MARKET_STORE_SORTS)[number];

const flag = z.enum(["1", "true", "0", "false"]).optional().transform((value) => value === "1" || value === "true");
const coordinate = (min: number, max: number) => z.coerce.number().min(min).max(max).optional();

export const marketStoreQuerySchema = z.object({
  sort: z.enum(MARKET_STORE_SORTS).optional().default("recommended"),
  governorate: z.string().trim().min(1).max(40).optional(),
  district: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(80).optional(),
  type: z.string().trim().min(1).max(40).optional(),
  verified: flag,
  brand: flag,
  ambassador: flag,
  lat: coordinate(-90, 90),
  lng: coordinate(-180, 180),
  cursor: z.string().max(512).optional(),
  limit: z.unknown().optional(),
}).refine((value) => (value.lat === undefined) === (value.lng === undefined), { message: "lat و lng معاً أو لا شيء", path: ["lat"] })
  .refine((value) => value.sort !== "nearest" || value.lat !== undefined, { message: "الترتيب حسب القرب يحتاج موقعك", path: ["sort"] });
export type MarketStoreQuery = z.infer<typeof marketStoreQuerySchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "الوقت بصيغة HH:MM");

export const marketProfileSchema = z.object({
  businessType: z.string().trim().min(2).max(40).nullable(),
  governorateKey: z.string().trim().min(1).max(40).nullable(),
  districtId: z.number().int().positive().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  pickupEnabled: z.boolean(),
  openingHours: z.array(z.object({ weekday: z.number().int().min(0).max(6), opensAt: hhmm, closesAt: hhmm })).max(7),
}).refine((value) => (value.latitude === null) === (value.longitude === null), { message: "خطّ العرض وخطّ الطول معاً", path: ["latitude"] })
  .refine((value) => value.districtId === null || value.governorateKey !== null, { message: "اختر المحافظة قبل المنطقة", path: ["districtId"] })
  .refine((value) => !value.pickupEnabled || value.latitude !== null, { message: "الاستلام من المتجر يحتاج موقع المتجر على الخريطة", path: ["pickupEnabled"] })
  .refine((value) => new Set(value.openingHours.map((row) => row.weekday)).size === value.openingHours.length, { message: "يوم مكرّر في أوقات الدوام", path: ["openingHours"] })
  .refine((value) => value.openingHours.every((row) => row.opensAt !== row.closesAt), { message: "وقت الفتح يساوي وقت الإغلاق", path: ["openingHours"] });
export type MarketProfileInput = z.infer<typeof marketProfileSchema>;

export const marketDecisionSchema = z.object({
  decision: z.enum(["list", "reject", "delist"]),
  note: z.string().trim().max(500).optional(),
}).refine((value) => value.decision === "list" || (value.note?.length ?? 0) >= 5, { message: "اكتب سبب الرفض أو الإزالة ليقرأه التاجر", path: ["note"] });

export const marketFlagsSchema = z.object({
  isBrand: z.boolean().optional(),
  boostedUntil: z.string().datetime({ offset: true }).nullable().optional(),
  ambassadorUntil: z.string().datetime({ offset: true }).nullable().optional(),
});

export const MARKET_QUEUE_FILTERS = ["pending", "listed", "rejected", "delisted"] as const;

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);
/** Marketplace M11: the visible box of the map. */
export const marketMapQuerySchema = z.object({ south: latitude, west: longitude, north: latitude, east: longitude });
// Two plain decimals split on the comma — no pattern to backtrack on.
const DECIMAL = /^-?\d{1,3}\.?\d{0,7}$/;
const point = z.string().trim().max(40)
  .refine((value) => { const parts = value.split(","); return parts.length === 2 && parts.every((part) => DECIMAL.test(part)); }, "نقطة بصيغة lat,lng")
  .transform((value) => { const [lat, lng] = value.split(",").map(Number); return { lat, lng }; })
  .refine((value) => Math.abs(value.lat) <= 90 && Math.abs(value.lng) <= 180, "نقطة خارج الخريطة");
/** «على طريقك»: two points and how far off the line a store may be (km). */
export const marketRouteQuerySchema = z.object({ from: point, to: point, corridor: z.coerce.number().min(0.2).max(5).optional().default(1.5) });

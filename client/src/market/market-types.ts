/** The shapes the market's store routes answer with (modules/market-stores). */
export type MarketTier = "bronze" | "silver" | "gold" | "platinum";
export type GrantedMark = "verified" | "brand" | "ambassador" | "boosted" | "new_store";
export type BadgeCode = GrantedMark | "fast_response" | "low_cancellation" | "high_rating" | "repeat_customers" | "top_seller";

export type MarketStoreCard = {
  slug: string;
  name: string;
  businessType: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  governorate: { key: string; name: string } | null;
  district: { id: number; name: string } | null;
  location: { latitude: number; longitude: number } | null;
  pickupEnabled: boolean;
  marks: GrantedMark[];
  badges: { code: BadgeCode; level: MarketTier }[];
  score: number | null;
  tier: MarketTier | null;
  rating: number | null;
  ratingCount: number;
  medianResponseMinutes: number | null;
  views30d: number;
  productCount: number;
  completedOrders30d: number;
  distanceKm: number | null;
};

export type MarketStoreSort = "recommended" | "rating" | "response" | "views" | "sales" | "newest" | "nearest";

export type MarketStoresPage = { stores: MarketStoreCard[]; nextCursor: string | null; sort: MarketStoreSort };

export type BadgeView = { code: BadgeCode; title: string; description: string; earned: boolean; level: MarketTier | null };

export type MarketStorePageData = {
  storeSlug: string;
  store: MarketStoreCard & {
    headline: string | null;
    about: string | null;
    addressLine: string | null;
    whatsapp: string | null;
    phone: string | null;
    joinedAt: string;
    closedForOrders: string | null;
    storefrontPath: string;
  };
  reputation: {
    score: number | null; tier: MarketTier | null; tierLabel: string | null; rating: number | null; ratingCount: number;
    completedOrders: number; cancelRate: number | null; repeatRate: number | null; medianResponseMinutes: number | null; computedAt: string | null;
  };
  badges: BadgeView[];
  hours: { days: { weekday: number; opensAt: string | null; closesAt: string | null }[]; openNow: boolean | null };
  paymentMethods: { code: string; displayName: string }[];
};

export const TIER_LABELS: Record<MarketTier, string> = { bronze: "برونزي", silver: "فضّي", gold: "ذهبي", platinum: "بلاتيني" };
export const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

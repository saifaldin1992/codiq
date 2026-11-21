/** Product shapes from /api/market/products and the browser-only «recently viewed» list. */
export type MarketProductCard = {
  id: string;
  name: string;
  store: { slug: string; name: string; verified: boolean };
  imageUrl: string | null;
  priceIqd: number;
  maxPriceIqd: number;
  compareAtPriceIqd: number | null;
  discountPercent: number;
  rating: number | null;
  ratingCount: number;
  productScore: number | null;
  sold30d: number;
  isAvailable: boolean;
  sellsFast: boolean;
  hasOptions: boolean;
  isPreorder: boolean;
  condition: "new" | "used" | "refurbished";
  tags: string[];
  matchPercent: number | null;
  createdAt: string;
  /** Marketplace M8a: «عرض الساعة» running on it now. */
  deal: { percentOff: number; endsAt: string } | null;
};

export type MarketProductDetail = MarketProductCard & {
  description: string | null;
  specs: { name: string; value: string }[];
  requiresPrescription: boolean;
  category: { slug: string; name: string } | null;
  images: string[];
  variants: { id: string; name: string; isDefault: boolean; priceIqd: number; listPriceIqd: number | null; options: Record<string, string>; isAvailable: boolean }[];
  addons: { id: string; name: string; priceIqd: number }[];
  preorder: { releaseOn: string | null; shipsBy: string | null } | null;
  maxPerOrder: number | null;
  storefrontPath: string;
  /** Marketplace M13a (E6): «أو من X د.ع شهرياً», when a lender is on and the product may be bought in instalments. */
  instalments: { fromMonthlyIqd: number; months: number; maxMonths: number; cashPrice: boolean } | null;
};

export const TAG_LABELS: Record<string, string> = {
  original: "أصلي", imported: "مستورد", warranty: "مضمون", limited_edition: "إصدار محدود",
  exclusive: "حصري", free_delivery: "توصيل مجاني", free_returns: "إرجاع مجاني",
};
export const CONDITION_LABELS: Record<string, string> = { new: "جديد", used: "مستعمل", refurbished: "مجدّد" };

export const iqd = (value: number) => `${value.toLocaleString("ar-IQ")} د.ع`;

const RECENT_KEY = "codiq.market.recent-products";
const RECENT_MAX = 20;

export function readRecentProducts(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberProduct(id: string) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecentProducts().filter((other) => other !== id)].slice(0, RECENT_MAX)));
  } catch { /* storage unavailable */ }
}

const SEARCH_KEY = "codiq.market.recent-searches";
export function readRecentSearches(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEARCH_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((term): term is string => typeof term === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}
export function rememberSearch(term: string) {
  try {
    window.localStorage.setItem(SEARCH_KEY, JSON.stringify([term, ...readRecentSearches().filter((other) => other !== term)].slice(0, 10)));
  } catch { /* storage unavailable */ }
}
export function clearRecentSearches() {
  try { window.localStorage.removeItem(SEARCH_KEY); } catch { /* storage unavailable */ }
}

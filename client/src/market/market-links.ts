/** Where a banner or a home block leads, as a path inside the market app. */
export type MarketLink = { kind: string; target: string | null };

export const SECTION_TITLES: Record<string, string> = {
  discounts: "كل التخفيضات",
  "half-price": "نصف السعر أو أقل",
  new: "وصل حديثاً",
  trending: "الأكثر شعبية",
  "best-sellers": "الأكثر مبيعاً",
  "sells-fast": "ينفد قريباً",
  preorders: "الطلب المسبق",
  "top-rated": "الأعلى تقييماً",
};

export function marketHref(link: MarketLink | null): string | null {
  if (!link?.target) return null;
  const target = encodeURIComponent(link.target);
  switch (link.kind) {
    case "store":
      return `/s/${target}`;
    case "product":
      return `/p/${target}`;
    case "category":
      return `/c/${target}`;
    case "collection":
      return `/collection/${target}`;
    case "mall":
      return `/mall/${target}`;
    case "section":
      return `/section/${target}`;
    case "search":
      return `/search?q=${target}`;
    default:
      return null;
  }
}

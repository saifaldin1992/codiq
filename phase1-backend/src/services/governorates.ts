/**
 * ق-162 — the eighteen governorates, in ONE place, with their Arabic names.
 *
 * ============================================================================
 * WHAT WAS BROKEN, AND HOW COMPLETELY
 * ============================================================================
 *
 * The list lived twice and nothing made the copies agree:
 *
 *   · `store-bootstrap.service.ts` seeded every new store's delivery rates with
 *     ENGLISH keys — `Baghdad`, `Basra`, `Dhi Qar`…
 *   · `DeliveryRatesManager.tsx` carried a private `GOVERNORATE_LABELS` map so
 *     the MERCHANT saw «بغداد» while the stored key stayed `Baghdad`. Correct,
 *     and invisible to anyone reading the server.
 *
 * And the SHOPPER typed his governorate into a free-text field labelled
 * «المحافظة», which `deliveryRateForGovernorate` then matched against the
 * stored key with an exact string comparison.
 *
 * So an Iraqi shopper on an Arabic-first storefront typed «بغداد», no row
 * matched, and checkout answered `422 DELIVERY_UNAVAILABLE_FOR_GOVERNORATE` —
 * in English, with a full cart and a typed address. **No real customer could
 * complete an order on any store**, unless he happened to type `Baghdad`
 * letter-for-letter in a language the shop is not written in.
 *
 * It was invisible to CI for the same reason the phone bug was: every test
 * wrote `"Baghdad"`, because the seed wrote `"Baghdad"`. The tests agreed with
 * the code, and both disagreed with the form.
 *
 * ============================================================================
 * THE SHAPE OF THE FIX
 * ============================================================================
 *
 * The stored KEY stays English and stays exactly what it was — every existing
 * row, every enabled rate, every saved address keeps working, and no migration
 * is needed. What changes is that the Arabic name is now a fact the SERVER
 * knows, so it can be offered to the shopper as a choice rather than demanded
 * from him as a guess, and so the two lists can never drift apart again.
 */
export interface Governorate {
  /** The stored value. Never translated, never renamed: rows depend on it. */
  key: string;
  /** What an Iraqi reads. The only form that should ever reach a shopper. */
  ar: string;
}

/**
 * Order matters: it is the order a merchant sees his rates in, and the order a
 * shopper sees the choices in. Baghdad and Basra first because that is where
 * the orders are, then the rest alphabetically by their Arabic name.
 */
export const GOVERNORATES: readonly Governorate[] = [
  { key: "Baghdad", ar: "بغداد" },
  { key: "Basra", ar: "البصرة" },
  { key: "Erbil", ar: "أربيل" },
  { key: "Al Anbar", ar: "الأنبار" },
  { key: "Babylon", ar: "بابل" },
  { key: "Dhi Qar", ar: "ذي قار" },
  { key: "Diyala", ar: "ديالى" },
  { key: "Dohuk", ar: "دهوك" },
  { key: "Karbala", ar: "كربلاء" },
  { key: "Kirkuk", ar: "كركوك" },
  { key: "Maysan", ar: "ميسان" },
  { key: "Muthanna", ar: "المثنى" },
  { key: "Najaf", ar: "النجف" },
  { key: "Nineveh", ar: "نينوى" },
  { key: "Al-Qadisiyyah", ar: "القادسية" },
  { key: "Saladin", ar: "صلاح الدين" },
  { key: "Sulaymaniyah", ar: "السليمانية" },
  { key: "Wasit", ar: "واسط" },
] as const;

/** The keys, in the same order — what `createStoreFoundation` seeds. */
export const GOVERNORATE_KEYS: readonly string[] = GOVERNORATES.map((g) => g.key);

const BY_KEY = new Map(GOVERNORATES.map((g) => [g.key, g]));
const BY_ARABIC = new Map(GOVERNORATES.map((g) => [g.ar, g]));

/** The Arabic name for a stored key, or the key itself if it is not one of ours. */
export function governorateLabel(key: string): string {
  return BY_KEY.get(key)?.ar ?? key;
}

/**
 * Whatever a person typed or a client sent → the stored key, or `null`.
 *
 * Accepts the English key, the Arabic name, and the definite article dropped —
 * a person writes «بصرة» as often as «البصرة». It NEVER throws: the caller
 * decides what an unknown governorate means, and for a saved address written
 * before this existed the answer must stay «pass it through untouched» rather
 * than «reject an address the shopper has used for months».
 */
export function toGovernorateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (BY_KEY.has(trimmed)) return trimmed;
  const arabic = BY_ARABIC.get(trimmed);
  if (arabic) return arabic.key;
  // «بصرة» for «البصرة», and the reverse.
  const withArticle = trimmed.startsWith("ال") ? trimmed : `ال${trimmed}`;
  const withoutArticle = trimmed.startsWith("ال") ? trimmed.slice(2) : trimmed;
  return BY_ARABIC.get(withArticle)?.key ?? BY_ARABIC.get(withoutArticle)?.key ?? null;
}

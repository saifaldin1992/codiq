/** Marketplace M6: the fixed lists the shopper picks from. The codes are what the database checks. */
export const CANCEL_REASONS = [
  { code: "changed_mind", label: "غيّرت رأيي" },
  { code: "ordered_by_mistake", label: "طلبته بالخطأ" },
  { code: "found_better_price", label: "وجدت سعراً أفضل" },
  { code: "delivery_too_slow", label: "التوصيل سيتأخّر كثيراً" },
  { code: "wrong_details", label: "أخطأت في العنوان أو التفاصيل" },
  { code: "other", label: "سبب آخر" },
] as const;

export const RETURN_REASONS = [
  { code: "damaged", label: "وصل تالفاً أو مكسوراً" },
  { code: "wrong_item", label: "وصلني منتج غير الذي طلبته" },
  { code: "not_as_described", label: "لا يطابق الوصف أو الصور" },
  { code: "missing_parts", label: "ناقص قطعة أو ملحق" },
  { code: "size_or_fit", label: "المقاس أو اللون غير مناسب" },
  { code: "other", label: "سبب آخر" },
] as const;

/** Quick tags under the stars. Positive ones first, then the complaints. */
export const RATING_TAGS = [
  { code: "fast_delivery", label: "توصيل سريع" },
  { code: "good_packaging", label: "تغليف ممتاز" },
  { code: "as_described", label: "مطابق للوصف" },
  { code: "polite_courier", label: "مندوب محترم" },
  { code: "good_value", label: "سعر مناسب" },
  { code: "late_delivery", label: "تأخّر التوصيل" },
  { code: "poor_packaging", label: "تغليف سيّئ" },
  { code: "not_as_described", label: "غير مطابق للوصف" },
] as const;

export const DELIVERY_STAGES = [
  { code: "at_warehouse", label: "في المخزن" },
  { code: "with_courier", label: "مع المندوب" },
  { code: "on_the_way", label: "في الطريق إليك" },
  { code: "postponed", label: "مؤجّل" },
  { code: "returning", label: "راجع إلى المتجر" },
] as const;

export type CancelReasonCode = (typeof CANCEL_REASONS)[number]["code"];
export type ReturnReasonCode = (typeof RETURN_REASONS)[number]["code"];
export type RatingTagCode = (typeof RATING_TAGS)[number]["code"];
export type DeliveryStageCode = (typeof DELIVERY_STAGES)[number]["code"];

export function labelOf(
  list: readonly { code: string; label: string }[],
  code: string | null | undefined
): string | null {
  return code ? (list.find((entry) => entry.code === code)?.label ?? null) : null;
}

export const codesOf = <T extends readonly { code: string }[]>(list: T) =>
  list.map((entry) => entry.code) as unknown as [T[number]["code"], ...T[number]["code"][]];

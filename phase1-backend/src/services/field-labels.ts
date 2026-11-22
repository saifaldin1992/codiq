/**
 * The Arabic a person reads for a field or an order status named in a refusal.
 *
 * Validation messages used to name the JSON key («recipientName is invalid»,
 * «priceIqd must be a non-negative integer»); the merchant and the shopper read
 * Arabic everywhere else, so the key is translated here and the CODE — which is
 * what clients and tests match on — is left untouched.
 */
const FIELD_LABELS: Record<string, string> = {
  sku: "الرمز (SKU)", name: "الاسم", description: "الوصف", priceIqd: "السعر", stockQuantity: "المخزون",
  lowStockThreshold: "حدّ تنبيه المخزون", reason: "السبب", code: "الرمز", from: "تاريخ البداية", to: "تاريخ النهاية",
  startsAt: "تاريخ البداية", endsAt: "تاريخ النهاية", courierName: "اسم المندوب", trackingNumber: "رقم الشحنة",
  courier: "المندوب", maxUsesTotal: "الحد الأقصى للاستعمال", maxUsesPerCustomer: "الحد لكل زبون",
  minSubtotalIqd: "الحد الأدنى للطلب", percentOff: "النسبة", amountOffIqd: "المبلغ", maxDiscountIqd: "أقصى خصم",
  position: "الترتيب", expectedStockQuantity: "المخزون المتوقع",
};

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const head = field.split(".")[0] ?? field;
  return FIELD_LABELS[head] ? `${FIELD_LABELS[head]} (${field.slice(head.length + 1)})` : field;
}

export const ORDER_STATUS_LABELS_AR: Record<string, string> = {
  new: "جديد", processing: "مقبول", preparation: "قيد التجهيز", out_for_delivery: "في الطريق",
  completed: "مكتمل", cancelled: "ملغي", rejected: "مرفوض", returned: "مُرجع",
};

export function orderStatusLabel(status: unknown): string {
  return ORDER_STATUS_LABELS_AR[String(status)] ?? String(status ?? "");
}

/**
 * CD-1b «مندوبك في الطريق» — the courier-dispatched email (moved out of outbox-worker.ts,
 * review batch 4, م-٣). The last line says what to have ready at the door: the cash still
 * owed, or that the order is already paid. A row queued before `cashIqd` existed keeps the
 * old sentence.
 */
export function courierDispatchedMessage(
  storeName: string,
  payload: Record<string, unknown>,
  linkLine: (prefix: string, relativePath: unknown) => string
) {
  const orderNumber = String(payload.orderNumber ?? "");
  return {
    subject: `مندوبك في الطريق — الطلب ${orderNumber}`,
    body:
      `خرج طلبك ${orderNumber} من ${storeName} مع مندوب التوصيل، وهو الآن في طريقه إليك.` +
      linkLine("تابع حالة طلبك في أي وقت من هنا:", payload.trackingUrl) +
      cashAtTheDoor(payload.cashIqd),
  };
}

function cashAtTheDoor(cashIqd: unknown): string {
  if (typeof cashIqd !== "number") return "\nيرجى تجهيز مبلغ الدفع عند الاستلام.";
  if (cashIqd === 0) return "\nطلبك مدفوع مسبقاً — لا شيء تدفعه عند الاستلام.";
  return `\nيرجى تجهيز مبلغ الدفع عند الاستلام: ${cashIqd} د.ع`;
}

/**
 * ق-250 — the merchant's maintenance mail (moved out of outbox-worker.ts, review batch 4): when a
 * window that touches him is scheduled, when it is over, and — owner decision 2026-11-22 — when it
 * is cancelled. Times are Baghdad's, written out; his stores and orders are named as untouched
 * because that is the question he will have.
 */
export const MAINTENANCE_NOTICE_EVENTS = [
  "maintenance.scheduled",
  "maintenance.ended",
  "maintenance.cancelled",
] as const;

export function maintenanceMessage(eventType: string, payload: Record<string, unknown>) {
  const subject = String(payload.subject ?? "المنصّة");
  const from = String(payload.startsAtLocal ?? "");
  const to = String(payload.endsAtLocal ?? "");
  const message = String(payload.messageAr ?? "");
  if (eventType === "maintenance.scheduled") {
    return {
      subject: `صيانة مجدولة — ${subject}`,
      body:
        `ستتوقّف «${subject}» للصيانة من ${from} إلى ${to} (بتوقيت بغداد).` +
        (message ? `\n\n${message}` : ``) +
        `\n\nمتجرك وطلباتك وزبائنك لا يُمسّون؛ ما يتوقّف هو ما سُمّي أعلاه، ` +
        `وللمدّة المذكورة فقط. تصلك رسالة حين ينتهي.`,
    };
  }
  if (eventType === "maintenance.cancelled") {
    // Cancelled before it began: nothing stops. Cancelled while running: it is over early.
    if (payload.phaseAtCancel === "active")
      return {
        subject: `انتهت الصيانة مبكراً — ${subject}`,
        body:
          `صيانة «${subject}» التي كانت مجدولة من ${from} إلى ${to} (بتوقيت بغداد) ` +
          `انتهت قبل موعدها، وعاد كلّ شيء إلى العمل.`,
      };
    return {
      subject: `أُلغيت الصيانة — ${subject}`,
      body:
        `أُلغيت صيانة «${subject}» التي كانت مجدولة من ${from} إلى ${to} (بتوقيت بغداد). ` +
        `لن يتوقّف شيء — تابع عملك كالمعتاد.`,
    };
  }
  return {
    subject: `انتهت الصيانة — ${subject}`,
    body:
      `انتهت صيانة «${subject}» التي كانت مجدولة من ${from} إلى ${to}، ` +
      `وعاد كلّ شيء إلى العمل.\n\nشكراً لصبرك.`,
  };
}

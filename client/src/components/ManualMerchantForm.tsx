import { useState } from "react";
import { Input } from "@/components/ui/input";
import { PasswordInputWithMeter } from "@/components/ui/password-input-with-meter";
import { Button } from "@/components/ui/button";

type Notice = { tone: "success" | "error"; text: string } | null;

export function ManualMerchantForm() {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true); setNotice(null);
    try {
      const response = await fetch("/api/platform/merchants/manual", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessName: form.get("businessName"), ownerName: form.get("ownerName"), phone: form.get("phone"), email: form.get("email"), temporaryPassword: form.get("temporaryPassword"), firstStoreName: form.get("firstStoreName") }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.code ?? "CREATE_MERCHANT_FAILED");
      setNotice({ tone: "success", text: `تم إنشاء التاجر والمتجر «${payload.store.name}» بنجاح. معرف المتجر: ${payload.store.slug}` });
      formElement.reset();
    } catch (error) { setNotice({ tone: "error", text: `تعذر الإنشاء: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}` }); }
    finally { setPending(false); }
  }

  return <form onSubmit={submit} className="space-y-4" aria-label="نموذج إضافة تاجر يدويًا">
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1.5 text-sm font-semibold text-[#44526A]"><span>اسم التاجر</span><Input required name="businessName" minLength={2} placeholder="مثال: شركة النخلة" /></label>
      <label className="space-y-1.5 text-sm font-semibold text-[#44526A]"><span>اسم المتجر الأول</span><Input required name="firstStoreName" minLength={2} placeholder="مثال: متجر النخلة" /></label>
      {/* P27-12 (ق-100): the THIRD creation path, and the one the acceptance
          criterion forgets. Leave it without these and the platform keeps minting
          merchants with no phone, so the column can never be tightened. */}
      <label className="space-y-1.5 text-sm font-semibold text-[#44526A]"><span>اسم التاجر الشخصي</span><Input required name="ownerName" minLength={2} placeholder="مثال: سيف الدين" /></label>
      <label className="space-y-1.5 text-sm font-semibold text-[#44526A]"><span>رقم هاتف التاجر</span><Input required name="phone" inputMode="tel" placeholder="07XXXXXXXXX" dir="ltr" /></label>
      <label className="space-y-1.5 text-sm font-semibold text-[#44526A]"><span>البريد الإلكتروني</span><Input required name="email" type="email" autoComplete="off" placeholder="merchant@example.com" /></label>
      <div className="space-y-1.5 text-sm font-semibold text-[#44526A]"><label htmlFor="temporaryPassword-field">كلمة المرور المؤقتة</label><PasswordInputWithMeter id="temporaryPassword-field" required name="temporaryPassword" minLength={8} autoComplete="new-password" placeholder="8 خانات على الأقل" /></div>
    </div>
    <p className="rounded-2xl bg-[var(--codiq-canvas)] px-4 py-3 text-xs leading-6 text-[#536E99]">سيستخدم النموذج جلسة مالك المنصة الحالية المحمية في المتصفح. لا تُدخل رموز وصول يدويًا.</p>
    {notice ? <p role="status" className={`rounded-2xl px-4 py-3 text-sm font-semibold ${notice.tone === "success" ? "bg-[var(--codiq-success-soft)] text-[#167446]" : "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"}`}>{notice.text}</p> : null}
    <Button disabled={pending} className="rounded-xl bg-[var(--codiq-accent)] px-5 text-white hover:bg-[var(--codiq-accent-hover)]">{pending ? "جارٍ إنشاء التاجر…" : "إنشاء تاجر ومتجر أول"}</Button>
  </form>;
}

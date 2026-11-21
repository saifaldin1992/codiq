import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ManualCustomerForm({ storeSlug }: { storeSlug?: string }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  if (!storeSlug)
    return (
      <p className="rounded-2xl bg-[var(--codiq-warning-soft)] p-4 text-sm leading-6 text-[#8A5A14]">
        افتح هذه الصفحة داخل مسار متجر محدد لإضافة زبون؛ لا يُسمح بإنشاء زبون خارج سياق
        `store-slug`.
      </p>
    );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/merchant/stores/${encodeURIComponent(storeSlug!)}/customers/manual`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fullName: form.get("fullName"),
            email: form.get("email"),
            phone: form.get("phone"),
          }),
        }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.code ?? "CREATE_CUSTOMER_FAILED");
      setNotice({
        tone: "success",
        text: `تم ربط الزبون «${payload.customer.fullName}» بالمتجر الحالي فقط — ويصير الحساب حسابه حين يسجّل بنفس الرقم.`,
      });
      formElement.reset();
    } catch (error) {
      setNotice({
        tone: "error",
        text: `تعذر الإنشاء: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="نموذج إضافة عميل يدويًا">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-semibold text-[#44526A]">
          <span>اسم العميل</span>
          <Input required name="fullName" minLength={2} placeholder="الاسم الكامل" />
        </label>
        <label className="space-y-1.5 text-sm font-semibold text-[#44526A]">
          <span>الهاتف</span>
          <Input required name="phone" minLength={5} inputMode="tel" placeholder="07xxxxxxxxx" />
        </label>
      </div>
      {/* ق-212: optional, like the storefront's own registration — most COD shoppers have no email, and inventing one per customer collides on its second use. */}
      <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
        <span>
          البريد الإلكتروني{" "}
          <span className="font-normal text-[var(--codiq-text-muted)]">(اختياري)</span>
        </span>
        <Input name="email" type="email" autoComplete="off" placeholder="customer@example.com" />
      </label>
      <p className="rounded-2xl bg-[var(--codiq-canvas)] px-4 py-3 text-xs leading-6 text-[#536E99]">
        يرتبط الطلب تلقائيًا بجلسة التاجر وبـ`store-slug` الظاهر في المسار؛ لا تُدخل رمز وصول
        يدويًا.
      </p>
      {notice ? (
        <p
          role="status"
          className={`rounded-2xl px-4 py-3 text-sm font-semibold ${notice.tone === "success" ? "bg-[var(--codiq-success-soft)] text-[#167446]" : "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"}`}
        >
          {notice.text}
        </p>
      ) : null}
      <Button
        disabled={pending}
        className="rounded-xl bg-[var(--codiq-accent)] px-5 text-white hover:bg-[var(--codiq-accent-hover)]"
      >
        {pending ? "جارٍ إضافة العميل…" : "إضافة عميل للمتجر"}
      </Button>
    </form>
  );
}

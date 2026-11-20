import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { invalidatePlatformBrand, usePlatformBrand } from "@/hooks/usePlatformBrand";
import { CircleAlert, ImageUp, Info, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";

/**
 * P27-20 (ق-107) — the owner uploads his own logo and it changes everywhere.
 *
 * «كل الأماكن» is not quite all of them, and this panel says so BEFORE the
 * upload rather than leaving him to notice later that his browser tab still
 * carries the old mark. ق-10 applies to a promise as much as to a number.
 */
export function PlatformLogoSection() {
  const { logo } = usePlatformBrand();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "revert" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function send(method: "PUT" | "DELETE", body?: FormData) {
    setBusy(method === "PUT" ? "upload" : "revert");
    setFailure(null);
    setDone(null);
    try {
      const response = await fetch("/api/platform/brand/logo", { method, credentials: "same-origin", body });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "تعذّر تنفيذ العملية — أعد المحاولة.");
      invalidatePlatformBrand();
      setDone(method === "PUT" ? "تم رفع الشعار — يظهر الآن في كل أنحاء المنصة." : "عاد الشعار الافتراضي.");
      // The mark is drawn by many mounted components; a reload is the honest way
      // to show the owner exactly what every visitor will see.
      setTimeout(() => window.location.reload(), 900);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "تعذّر تنفيذ العملية — أعد المحاولة.");
    } finally {
      setBusy(null);
    }
  }

  function upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    void send("PUT", form);
  }

  return (
    <section className="rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-6" dir="rtl" data-testid="platform-logo-section">
      <div className="flex items-start gap-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><ImageUp className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-[#263650]">شعار المنصة</p>
          <p className="mt-1 text-sm leading-7 text-[#6B7A93]">
            يُقرأ من مكان واحد، فتغييره هنا يغيّره في رؤوس اللوحات الثلاث والصفحة التعريفية وبطاقة الدخول وتذييل المتاجر.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-4">
            <div className="grid h-20 w-20 place-items-center rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-2">
              <BrandMark className="h-full w-full" />
            </div>
            <div className="text-sm text-[#6B7A93]">
              <p className="font-semibold text-[#33435D]">{logo ? "شعارك المرفوع" : "الشعار الافتراضي المدمج"}</p>
              <p className="mt-0.5 text-[12px]">PNG بحد أدنى 512×512 · أو SVG (وهو الأفضل ويبقى حاداً في كل مقاس) · حتى 2 ميغابايت</p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/svg+xml"
              className="hidden"
              data-testid="platform-logo-input"
              onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(file); event.target.value = ""; }}
            />
            <Button type="button" data-testid="platform-logo-upload" disabled={busy !== null} onClick={() => fileInput.current?.click()} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">
              <ImageUp className="ml-1 h-4 w-4" />{busy === "upload" ? "جارٍ الرفع…" : logo ? "استبدال الشعار" : "رفع شعار"}
            </Button>
            {logo ? (
              <Button type="button" variant="outline" data-testid="platform-logo-revert" disabled={busy !== null} onClick={() => void send("DELETE")} className="rounded-xl">
                <RotateCcw className="ml-1 h-4 w-4" />{busy === "revert" ? "جارٍ…" : "العودة إلى الافتراضي"}
              </Button>
            ) : null}
          </div>

          {failure ? (
            <p role="alert" data-testid="platform-logo-error" className="mt-4 flex items-start gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-danger)]">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{failure}
            </p>
          ) : null}
          {done ? <p data-testid="platform-logo-done" className="mt-4 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{done}</p> : null}

          {/* Said before the upload, not discovered after it. */}
          <div className="mt-5 rounded-2xl border border-dashed border-[#CBD9ED] bg-[var(--codiq-surface-sunken)] px-4 py-3.5 text-[13px] leading-7 text-[#5C6D89]">
            <p className="flex items-center gap-1.5 font-bold text-[#33435D]"><Info className="h-3.5 w-3.5" />ثلاثة مواضع لا يغيّرها الرفع</p>
            <ul className="mt-1.5 list-inside list-disc space-y-0.5">
              <li>أيقونة تبويب المتصفح — تُقرأ قبل تشغيل أي شيفرة.</li>
              <li>صورة الرابط في واتساب وفيسبوك — تقرؤها روبوتاتها من وسم ثابت.</li>
              <li>الشعار داخل بريد أُرسل سابقاً — خرج فعلاً ولا يعود.</li>
            </ul>
            <p className="mt-1.5">الثلاثة تتغيّر بنشر جديد، لا برفع.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

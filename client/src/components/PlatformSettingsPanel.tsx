/**
 * codiq menus pass A — «إعدادات المنصة»: one settings home hosting what exists
 * today (the merchant self-registration policy over the live endpoints) plus
 * honestly phase-badged sections for what is scheduled.
 */
import { PlatformLogoSection } from "@/components/PlatformLogoSection";
import { EmailComplaintsSection } from "@/components/EmailComplaintsSection";
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Globe2, LoaderCircle, Plug2, ServerCog, UserCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

function RegistrationPolicySection({ navigate }: { navigate: (path: string) => void }) {
  const [mode, setMode] = useState<"auto" | "manual" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ mode: "auto" | "manual" }>("/api/platform/settings/registration");
      setMode(result.mode);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function switchMode(next: "auto" | "manual") {
    setBusy(true);
    try {
      await api("/api/platform/settings/registration", { method: "PUT", body: JSON.stringify({ mode: next }) });
      setMode(next);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><UserCheck className="h-4 w-4" /> سياسة التسجيل الذاتي للتجار</p>
      {failure ? <p className="mb-3 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {mode === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {mode !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} onClick={() => void switchMode("auto")} className={`rounded-2xl px-5 py-3 text-sm font-bold transition ${mode === "auto" ? "bg-[var(--codiq-accent)] text-white" : "bg-[var(--codiq-canvas)] text-[var(--codiq-text-secondary)]"}`}>تفعيل تلقائي</button>
          <button type="button" disabled={busy} onClick={() => void switchMode("manual")} className={`rounded-2xl px-5 py-3 text-sm font-bold transition ${mode === "manual" ? "bg-[var(--codiq-accent)] text-white" : "bg-[var(--codiq-canvas)] text-[var(--codiq-text-secondary)]"}`}>بموافقتي أولاً</button>
          <p className="text-xs leading-6 text-[var(--codiq-text-muted)]">{mode === "auto" ? "كل تسجيل جديد يُفعّل متجره فوراً على الخطة المجانية." : "التسجيلات الجديدة تنتظر موافقتك؛ لا دخول ولا متجر فعال قبلها."}</p>
        </div>
      ) : null}
      <button type="button" onClick={() => navigate("/platform/dashboard/merchants/registration-requests")} className="mt-4 text-xs font-bold text-[var(--codiq-accent)] underline-offset-4 hover:underline">فتح طابور طلبات التسجيل ←</button>
    </div>
  );
}

function ScheduledSection({ icon: Icon, title, phase, detail }: { icon: LucideIcon; title: string; phase: string; detail: string }) {
  return (
    <div className="rounded-[26px] border border-dashed border-[#CBD9ED] bg-[var(--codiq-surface-sunken)] p-6">
      <div className="flex items-start gap-3.5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Icon className="h-4.5 w-4.5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-[#263650]">{title}</p>
            <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-bold text-[#65748B]">قريباً — المرحلة {phase}</span>
          </div>
          <p className="mt-1.5 text-xs leading-6 text-[var(--codiq-text-muted)]">{detail}</p>
        </div>
      </div>
    </div>
  );
}

export function PlatformSettingsPanel({ navigate }: { navigate: (path: string) => void }) {
  return (
    <div className="max-w-[860px] space-y-4" dir="rtl">
      <RegistrationPolicySection navigate={navigate} />
      <PlatformLogoSection />
      <EmailComplaintsSection />
      <ScheduledSection icon={Globe2} title="النطاقات والروابط" phase="24" detail="إدارة النطاقات المخصصة للمتاجر من الواجهة مع توثيق DNS (المخزن جاهز منذ المرحلة 17)." />
      <ScheduledSection icon={Plug2} title="التكاملات" phase="24" detail="Webhooks ومزودو الخدمات الخارجيون على مستوى المنصة." />
      <ScheduledSection icon={ServerCog} title="النظام والصيانة" phase="24" detail="لوحة صحة المنصة: الخادم وقاعدة البيانات والتخزين وأخطاء 5xx (بند B-04)." />
    </div>
  );
}

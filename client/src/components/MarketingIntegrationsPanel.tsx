/**
 * codiq phase 20B-3 — «التكاملات» (D-26): ad pixels configuration.
 * Guarded server-side by settings.manage; ids are STRICTLY format-validated on
 * the server (Meta digits 5–20, TikTok A-Z/0-9 10–30, GA4 G-XXXX…) — anything
 * else is a 422 and nothing is stored. Pixels are injected in the STOREFRONT
 * only (StorefrontProvider), never in any dashboard, and only after the
 * merchant flips the enable switch here.
 */
import { LoaderCircle, Megaphone, RefreshCw, Save, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Settings = { metaPixelId: string | null; tiktokPixelId: string | null; ga4MeasurementId: string | null; isEnabled: boolean };

function apiError(payload: unknown) {
  if (typeof payload === "object" && payload && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    return error?.message ?? "تعذر إتمام العملية.";
  }
  return "تعذر إتمام العملية.";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiError(payload));
  return payload as T;
}

const inputClass = "w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none transition focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10";

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <label className="block text-right"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">{label}</span>{children}<span className="mt-1.5 block text-[11px] leading-5 text-[#8994A8]" dir="rtl">{hint}</span></label>;
}

export function MarketingIntegrationsPanel({ storeSlug }: { storeSlug?: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [metaDraft, setMetaDraft] = useState("");
  const [tiktokDraft, setTiktokDraft] = useState("");
  const [ga4Draft, setGa4Draft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/marketing/integrations` : null;

  const refresh = useCallback(async () => {
    if (!base) return;
    try {
      const data = await api<{ settings: Settings }>(base);
      setSettings(data.settings);
      setMetaDraft(data.settings.metaPixelId ?? "");
      setTiktokDraft(data.settings.tiktokPixelId ?? "");
      setGa4Draft(data.settings.ga4MeasurementId ?? "");
      setEnabledDraft(data.settings.isEnabled);
      setFailure(null);
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر تحميل إعدادات التكاملات."); }
  }, [base]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!base) return;
    setBusy(true);
    setMessage(null);
    try {
      const data = await api<{ settings: Settings }>(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metaPixelId: metaDraft.trim() || null, tiktokPixelId: tiktokDraft.trim() || null, ga4MeasurementId: ga4Draft.trim() || null, isEnabled: enabledDraft }),
      });
      setSettings(data.settings);
      setMessage("حُفظت إعدادات البكسلات. تُحقن الأكواد في صفحات المتجر فقط عند التفعيل.");
      setFailure(null);
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر حفظ الإعدادات."); }
    finally { setBusy(false); }
  }

  if (!storeSlug) return <div className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]" dir="rtl"><ShieldAlert className="mb-3 h-6 w-6" />اختر متجرًا عبر مسار لوحة التاجر المقيد بـ`store-slug` قبل إدارة التكاملات.</div>;
  if (!settings && !failure) return <div className="flex items-center gap-3 rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[#61708A]" dir="rtl"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" />جارٍ تحميل إعدادات التكاملات…</div>;

  return <div className="max-w-[860px] space-y-5" dir="rtl">
    {failure ? <p data-testid="integrations-error" className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><ShieldAlert className="h-4 w-4" /> {failure}</p> : null}
    {message ? <p data-testid="integrations-notice" className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{message}</p> : null}
    <form onSubmit={save} className="space-y-5 rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Megaphone className="h-5 w-5" /></span><div><h2 className="font-bold text-[#273753]">البكسلات الإعلانية</h2><p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">Meta وTikTok وGoogle Analytics 4 — تُحقن الأكواد الرسمية في صفحات المتجر (الواجهة العامة) فقط، ولا تُحمَّل أبداً داخل لوحات التحكم. الأحداث المرسلة: زيارة الصفحة، الإضافة إلى السلة، وإتمام الشراء (بلا عدّ مزدوج عند إعادة المحاولة).</p></div></div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Meta Pixel ID" hint="أرقام فقط، 5–20 خانة. مثال: 1234567890123"><input data-testid="pixel-meta-input" value={metaDraft} onChange={(event) => setMetaDraft(event.target.value)} placeholder="1234567890123" dir="ltr" className={inputClass} /></Field>
        <Field label="TikTok Pixel ID" hint="أحرف لاتينية كبيرة وأرقام، 10–30 خانة"><input data-testid="pixel-tiktok-input" value={tiktokDraft} onChange={(event) => setTiktokDraft(event.target.value)} placeholder="ABC123DEF456G" dir="ltr" className={inputClass} /></Field>
        <Field label="GA4 Measurement ID" hint="بصيغة G-XXXXXXXXXX"><input data-testid="pixel-ga4-input" value={ga4Draft} onChange={(event) => setGa4Draft(event.target.value)} placeholder="G-ABC123XYZ" dir="ltr" className={inputClass} /></Field>
      </div>
      <label className="flex items-center justify-between rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3">
        <span className="text-sm font-bold text-[#33435D]">تفعيل حقن البكسلات في صفحات المتجر</span>
        <input data-testid="pixels-enabled-toggle" type="checkbox" className="h-5 w-5 accent-[var(--codiq-accent)]" checked={enabledDraft} onChange={(event) => setEnabledDraft(event.target.checked)} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} type="submit" data-testid="pixels-save" className="rounded-xl bg-[var(--codiq-accent)] px-5">{busy ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />}حفظ الإعدادات</Button>
        <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => void refresh()}><RefreshCw className="ml-1 h-3.5 w-3.5" />تحديث</Button>
      </div>
      <p className="flex items-start gap-2 rounded-2xl bg-[var(--codiq-neutral-soft)] px-4 py-3 text-xs leading-6 text-[#65748B]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--codiq-accent)]" />يتحقق الخادم من صيغة كل معرّف بدقة قبل الحفظ — أي محتوى خارج الصيغة الرسمية يُرفض. إرسال الأحداث من الخادم (Conversions API) مؤجل صراحة إلى مراحل 24/25.</p>
    </form>
  </div>;
}

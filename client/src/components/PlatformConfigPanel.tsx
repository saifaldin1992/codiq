/**
 * ق-251 (المرحلة 29-3) — the «التهيئة» tab of the owner's «الخدمات والإتاحة»:
 * the closed registry of settings, each with its rule, its default, the levels
 * that may speak, and the platform's own value — a ceiling for caps, a lock for
 * permissions. No free key/value: what is not in the registry cannot be typed.
 */
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

type Setting = {
  code: string; label: string; description: string; type: "integer" | "boolean"; rule: "cap" | "allow" | "pref"; ruleLabel: string;
  default: number | boolean; levels: string[]; levelLabels: string[]; platformValue: number | boolean | null; min?: number; max?: number;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

const valueText = (setting: Pick<Setting, "type">, value: number | boolean | null) => value === null ? "—" : setting.type === "boolean" ? (value ? "مسموح" : "غير مسموح") : String(value);
const input = "w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]";

export function ConfigTab({ notify }: { notify: (message: string, failed?: boolean) => void }) {
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSettings((await api<{ settings: Setting[] }>("/api/platform/config")).settings); }
    catch (error) { notify(error instanceof Error ? error.message : "تعذر تحميل التهيئة.", true); }
  }, [notify]);
  useEffect(() => { void load(); }, [load]);

  async function save(setting: Setting, raw: string | null) {
    setBusy(setting.code);
    try {
      const value = raw === null ? null : setting.type === "boolean" ? raw === "true" : Number(raw);
      await api(`/api/platform/config/${encodeURIComponent(setting.code)}`, { method: "PUT", body: JSON.stringify({ value }) });
      notify(raw === null ? `أُزيلت قيمة المنصّة لـ«${setting.label}» — يعود الافتراضيّ.` : `حُفظت قيمة المنصّة لـ«${setting.label}» — تصل كلّ التجّار الآن.`);
      setDrafts((current) => ({ ...current, [setting.code]: "" }));
      await load();
    } catch (error) { notify(error instanceof Error ? error.message : "تعذر الحفظ.", true); }
    finally { setBusy(null); }
  }

  return <div className="space-y-4" data-testid="config-tab">
    <p className="flex items-center gap-2 text-sm font-bold text-[var(--codiq-text)]"><SlidersHorizontal className="h-4 w-4 text-[var(--codiq-accent)]" /> سجلّ الإعدادات المغلق</p>
    <p className="text-xs leading-5 text-[var(--codiq-text-muted)]">افتراض المنصّة ← الخطّة ← رأي التاجر ← إعداد المتجر ← تفضيل الزبون. قيمتك هنا سقفٌ فوق كلّ الخطط (للسقوف) أو قفلٌ لا يُفتح تحته (للسماح)؛ اتركها فارغةً ليبقى الافتراضيّ.</p>
    {!settings ? <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p> : <ul className="divide-y divide-[var(--codiq-border)] rounded-[20px] border border-[var(--codiq-border)]">
      {settings.map((setting) => <li key={setting.code} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_260px]" data-testid={`platform-config-${setting.code}`}>
        <div className="min-w-0">
          <p className="text-sm font-bold text-[var(--codiq-text)]">{setting.label} <span className="mr-1 text-xs font-semibold text-[var(--codiq-text-muted)]" dir="ltr">{setting.code}</span></p>
          <p className="mt-0.5 text-xs leading-5 text-[var(--codiq-text-muted)]">{setting.description}</p>
          <p className="mt-1 text-[11px] text-[var(--codiq-text-secondary)]">{setting.ruleLabel} · الافتراضيّ {valueText(setting, setting.default)} · يتكلّم فيه: {setting.levelLabels.join("، ")}</p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold text-[var(--codiq-text-secondary)]">قيمة المنصّة — الآن: <span data-testid={`platform-config-value-${setting.code}`}>{valueText(setting, setting.platformValue)}</span></span>
          {setting.type === "boolean"
            ? <select value={drafts[setting.code] ?? ""} onChange={(event) => setDrafts({ ...drafts, [setting.code]: event.target.value })} className={input} data-testid={`platform-config-input-${setting.code}`}><option value="">— اختر —</option><option value="true">مسموح</option><option value="false">غير مسموح</option></select>
            : <input type="number" min={setting.min} max={setting.max} value={drafts[setting.code] ?? ""} onChange={(event) => setDrafts({ ...drafts, [setting.code]: event.target.value })} className={input} dir="ltr" data-testid={`platform-config-input-${setting.code}`} />}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy !== null || !(drafts[setting.code] ?? "")} onClick={() => void save(setting, drafts[setting.code] ?? "")} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" data-testid={`platform-config-save-${setting.code}`}>{busy === setting.code ? <LoaderCircle className="ml-1 h-4 w-4 animate-spin" /> : null}حفظ</Button>
            {setting.platformValue !== null ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void save(setting, null)} className="rounded-xl" data-testid={`platform-config-clear-${setting.code}`}>إزالة</Button> : null}
          </div>
        </div>
      </li>)}
    </ul>}
  </div>;
}

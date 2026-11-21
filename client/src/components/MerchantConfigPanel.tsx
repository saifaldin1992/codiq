/**
 * ق-251 (المرحلة 29-3) — «التهيئة» as the merchant reads it.
 *
 * Every setting the platform knows, with the value that applies to THIS store,
 * who decided it (the platform, his plan, his own account, the store itself), and
 * the whole chain — so «why is my marketing cap 100?» has an answer on the
 * screen. Where the registry gives him a say, he sets his account-wide value
 * here; the server refuses by name anything that would loosen what sits above.
 */
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

type Level = "platform" | "plan" | "merchant" | "store" | "customer";
type Setting = {
  code: string;
  label: string;
  description: string;
  type: "integer" | "boolean";
  rule: "cap" | "allow" | "pref";
  ruleLabel: string;
  value: number | boolean;
  source: Level | "default";
  sourceLabel: string;
  chain: { level: Level; value: number | boolean; label: string }[];
  merchantValue: number | boolean | null;
  canOverride: boolean;
  min?: number;
  max?: number;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

const valueText = (setting: Pick<Setting, "type">, value: number | boolean) =>
  setting.type === "boolean" ? (value ? "مسموح" : "غير مسموح") : String(value);
const sourceTone = (source: Setting["source"]) =>
  source === "platform"
    ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"
    : source === "plan"
      ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]"
      : source === "merchant" || source === "store"
        ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"
        : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]";

export function MerchantConfigPanel({ storeSlug }: { storeSlug?: string }) {
  if (!storeSlug)
    return <p className="text-sm text-[var(--codiq-text-muted)]">اختر متجرًا أولًا.</p>;
  return <MerchantConfigCard storeSlug={storeSlug} />;
}

function MerchantConfigCard({ storeSlug }: { storeSlug: string }) {
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; failed: boolean } | null>(null);
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/config`;

  const load = useCallback(async () => {
    try {
      setSettings((await api<{ settings: Setting[] }>(base)).settings);
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : "تعذر تحميل التهيئة.",
        failed: true,
      });
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(setting: Setting, raw: string | null) {
    setBusy(setting.code);
    try {
      const value = raw === null ? null : setting.type === "boolean" ? raw === "true" : Number(raw);
      await api(`${base}/${encodeURIComponent(setting.code)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      setNotice({
        message:
          raw === null
            ? `أُزيل رأيك في «${setting.label}» — يعود ما فوقه.`
            : `حُفظ «${setting.label}» لكلّ متاجرك.`,
        failed: false,
      });
      setDrafts((current) => ({ ...current, [setting.code]: "" }));
      await load();
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : "تعذر الحفظ.", failed: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" dir="rtl" data-testid="merchant-config">
      <div className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
        <h2 className="flex items-center gap-2 text-xl font-bold text-[var(--codiq-text)]">
          <SlidersHorizontal className="h-5 w-5 text-[var(--codiq-accent)]" />
          التهيئة
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--codiq-text-muted)]">
          ما ينطبق على متجرك ومَن قرّره: المنصّة، ثمّ خطّتك، ثمّ حسابك، ثمّ المتجر نفسه. السقوف تضيق
          ولا تتّسع، والسماح يُغلق ولا يُفتح — فلا تكسر إعداداتك ما فوقها.
        </p>
        {notice ? (
          <p
            role="status"
            className={`mt-4 rounded-xl px-3 py-2 text-sm font-semibold ${notice.failed ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`}
            data-testid="config-notice"
          >
            {notice.message}
          </p>
        ) : null}
      </div>
      <div className="rounded-[26px] bg-[var(--codiq-surface)] p-2 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-4">
        {!settings ? (
          <p className="p-4 text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
        ) : (
          <ul className="divide-y divide-[var(--codiq-border)]">
            {settings.map((setting) => (
              <li
                key={setting.code}
                className="grid gap-3 px-3 py-4 sm:grid-cols-[minmax(0,1fr)_240px]"
                data-testid={`config-${setting.code}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--codiq-text)]">
                    {setting.label}{" "}
                    <span
                      className="mr-1 text-xs font-semibold text-[var(--codiq-text-muted)]"
                      dir="ltr"
                    >
                      {setting.code}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--codiq-text-muted)]">
                    {setting.description}
                  </p>
                  <p className="mt-2 text-sm">
                    <span
                      className="font-bold text-[var(--codiq-text)]"
                      data-testid={`config-value-${setting.code}`}
                    >
                      {valueText(setting, setting.value)}
                    </span>{" "}
                    <span
                      className={`mr-2 rounded-full px-2 py-0.5 text-[11px] font-bold ${sourceTone(setting.source)}`}
                      data-testid={`config-source-${setting.code}`}
                    >
                      {setting.sourceLabel}
                    </span>{" "}
                    <span className="text-[11px] text-[var(--codiq-text-muted)]">
                      {setting.ruleLabel}
                    </span>
                  </p>
                  {setting.chain.length ? (
                    <p className="mt-1 text-[11px] text-[var(--codiq-text-muted)]">
                      السلسلة:{" "}
                      {setting.chain
                        .map((entry) => `${entry.label} ${valueText(setting, entry.value)}`)
                        .join(" ← ")}
                    </p>
                  ) : null}
                </div>
                {setting.canOverride ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] font-bold text-[var(--codiq-text-secondary)]">
                      رأيك لكلّ متاجرك
                      {setting.merchantValue !== null
                        ? ` — الآن: ${valueText(setting, setting.merchantValue)}`
                        : ""}
                    </span>
                    {setting.type === "boolean" ? (
                      <select
                        value={drafts[setting.code] ?? ""}
                        onChange={(event) =>
                          setDrafts({ ...drafts, [setting.code]: event.target.value })
                        }
                        className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm"
                        data-testid={`config-input-${setting.code}`}
                      >
                        <option value="">— اختر —</option>
                        <option value="true">مسموح</option>
                        <option value="false">غير مسموح</option>
                      </select>
                    ) : (
                      <input
                        type="number"
                        min={setting.min}
                        max={setting.max}
                        value={drafts[setting.code] ?? ""}
                        onChange={(event) =>
                          setDrafts({ ...drafts, [setting.code]: event.target.value })
                        }
                        className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm"
                        dir="ltr"
                        data-testid={`config-input-${setting.code}`}
                      />
                    )}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy !== null || !(drafts[setting.code] ?? "")}
                        onClick={() => void save(setting, drafts[setting.code] ?? "")}
                        className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
                        data-testid={`config-save-${setting.code}`}
                      >
                        {busy === setting.code ? (
                          <LoaderCircle className="ml-1 h-4 w-4 animate-spin" />
                        ) : null}
                        حفظ
                      </Button>
                      {setting.merchantValue !== null ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => void save(setting, null)}
                          className="rounded-xl"
                          data-testid={`config-clear-${setting.code}`}
                        >
                          إزالة رأيي
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="self-center text-[11px] leading-5 text-[var(--codiq-text-muted)]">
                    يقرّره ما فوقك — لا رأيَ للتاجر هنا.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

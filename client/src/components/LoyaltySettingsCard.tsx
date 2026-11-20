/**
 * ق-166 — the switch that turns the loyalty programme on.
 *
 * CD-5 shipped the service, the routes, the migration, the ledger columns, the
 * settlement and the shopper's redeem card, and was marked complete. The one
 * control that makes any of it run — `PUT /merchant/stores/:slug/loyalty` —
 * had no caller anywhere in the repository, so `loyaltyEnabled` defaulted to
 * false and would have stayed false in every store forever. The shopper's
 * redeem card was dead in ALL of them, not in one that forgot to configure it.
 *
 * This is that screen. Nothing here is new capability: the server has enforced
 * every rule below since CD-5.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

type Loyalty = { enabled: boolean; earnPer1000: number; pointValueIqd: number };

/**
 * Mirrored from `loyalty.service.ts` so the merchant is told the rule BEFORE he
 * submits rather than by a 422 afterwards. The server stays the authority — it
 * re-checks the pair that would result, including a PUT carrying one field —
 * and these bounds exist to make the refusal rare, not to replace it.
 */
const EARN_MAX = 1000;
const POINT_VALUE_MIN = 1;
const POINT_VALUE_MAX = 10000;
const MAX_AWARD_IQD_PER_1000 = 1000;

const numberFormat = new Intl.NumberFormat("ar-IQ");

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "تعذر تنفيذ الطلب.");
  return body as T;
}

export function LoyaltySettingsCard({ storeSlug }: { storeSlug?: string }) {
  const [settings, setSettings] = useState<Loyalty | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [earnDraft, setEarnDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/loyalty` : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const result = await api<{ loyalty: Loyalty }>(base);
      setSettings(result.loyalty);
      setEnabled(result.loyalty.enabled);
      setEarnDraft(String(result.loyalty.earnPer1000));
      setValueDraft(String(result.loyalty.pointValueIqd));
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "تعذر تحميل إعدادات برنامج النقاط.");
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const earn = Number(earnDraft);
  const pointValue = Number(valueDraft);
  const bothValid =
    Number.isInteger(earn) && earn >= 0 && earn <= EARN_MAX &&
    Number.isInteger(pointValue) && pointValue >= POINT_VALUE_MIN && pointValue <= POINT_VALUE_MAX;
  // What the merchant actually pays: what 1,000 dinars of sales award, valued
  // at redemption. This is the number the cap is about, so it is the number
  // shown — not the two inputs it is computed from.
  const costPer1000 = bothValid ? earn * pointValue : null;
  const overCap = costPer1000 !== null && costPer1000 > MAX_AWARD_IQD_PER_1000;

  async function save() {
    if (!base || !bothValid || overCap) return;
    setSaving(true);
    setNotice(null);
    setFailure(null);
    try {
      const result = await api<{ loyalty: Loyalty }>(base, {
        method: "PUT",
        body: JSON.stringify({ enabled, earnPer1000: earn, pointValueIqd: pointValue }),
      });
      setSettings(result.loyalty);
      setNotice(result.loyalty.enabled ? "حُفظ. برنامج النقاط يعمل الآن في متجرك." : "حُفظ. برنامج النقاط متوقف.");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "تعذر حفظ الإعدادات.");
    } finally {
      setSaving(false);
    }
  }

  if (!storeSlug) return <p className="text-sm text-[var(--codiq-text-muted)]">اختر متجرًا أولًا.</p>;
  if (!settings && !failure) return <div className="flex items-center gap-2 text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />جارٍ التحميل…</div>;

  const dirty = settings !== null && (
    enabled !== settings.enabled || earn !== settings.earnPer1000 || pointValue !== settings.pointValueIqd
  );

  return (
    <div className="space-y-5">
      <div className="rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--codiq-accent)]" />
          <h2 className="font-black text-[var(--codiq-text)]">برنامج النقاط</h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">
          يكسب الزبون نقاطًا مع كل طلب يستلمه، ويخصمها من طلبٍ لاحق. النقاط تُحتسب على قيمة المنتجات دون أجرة التوصيل.
        </p>

        <label className="mt-5 flex cursor-pointer items-center justify-between gap-4 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4">
          <span>
            <span className="block font-bold text-[var(--codiq-text)]">تشغيل البرنامج</span>
            <span className="mt-1 block text-xs leading-5 text-[var(--codiq-text-muted)]">
              وهو متوقف افتراضيًا، فلا يرى الزبون بطاقة استبدال النقاط حتى تُشغّله.
            </span>
          </span>
          <input
            type="checkbox"
            data-testid="loyalty-enabled"
            checked={enabled}
            onChange={(event) => { setEnabled(event.target.checked); setNotice(null); }}
            className="h-5 w-5 shrink-0 accent-[var(--codiq-accent)]"
          />
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="loyalty-earn" className="text-sm font-bold text-[var(--codiq-text-secondary)]">نقاط عن كل ١٠٠٠ دينار</label>
            <input
              id="loyalty-earn"
              data-testid="loyalty-earn"
              inputMode="numeric"
              value={earnDraft}
              onChange={(event) => { setEarnDraft(event.target.value.replace(/\D/g, "")); setNotice(null); }}
              className="h-11 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
            />
            <p className="text-xs leading-5 text-[var(--codiq-text-muted)]">رقم صحيح بين ٠ و{numberFormat.format(EARN_MAX)}.</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="loyalty-value" className="text-sm font-bold text-[var(--codiq-text-secondary)]">قيمة النقطة عند الاستبدال (دينار)</label>
            <input
              id="loyalty-value"
              data-testid="loyalty-value"
              inputMode="numeric"
              value={valueDraft}
              onChange={(event) => { setValueDraft(event.target.value.replace(/\D/g, "")); setNotice(null); }}
              className="h-11 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
            />
            <p className="text-xs leading-5 text-[var(--codiq-text-muted)]">رقم صحيح بين {POINT_VALUE_MIN} و{numberFormat.format(POINT_VALUE_MAX)} دينار.</p>
          </div>
        </div>

        {costPer1000 !== null ? (
          <p
            data-testid="loyalty-cost"
            className={`mt-4 rounded-2xl p-3.5 text-sm leading-6 ${overCap ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}
          >
            كل ١٠٠٠ دينار مبيعات تمنح الزبون ما قيمته <strong>{numberFormat.format(costPer1000)} دينار</strong> عند الاستبدال.
            {overCap ? ` والحدّ الأعلى ${numberFormat.format(MAX_AWARD_IQD_PER_1000)} دينار — خفّض النقاط أو قيمة النقطة.` : ""}
          </p>
        ) : null}

        {/* ق-146. Said here because a merchant's first instinct on seeing a
            bill is to cut the point value, and he needs to know that doing so
            does not reach back into what shoppers are already holding. */}
        <p className="mt-4 text-xs leading-6 text-[var(--codiq-text-muted)]">
          تغيير المعدّل يسري على ما يُكسب من الآن فصاعدًا. أمّا النقاط التي يملكها زبائنك فتبقى بقيمتها يوم كُسبت — فخفض القيمة لا يمسّ ما هو محجوز عندهم.
        </p>

        {failure ? <p role="alert" className="mt-4 flex items-center gap-2 text-sm text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4 shrink-0" />{failure}</p> : null}
        {notice ? <p role="status" className="mt-4 text-sm font-bold text-[var(--codiq-success)]">{notice}</p> : null}

        <Button
          type="button"
          data-testid="loyalty-save"
          disabled={saving || !dirty || !bothValid || overCap}
          onClick={() => void save()}
          className="mt-5 h-11 rounded-xl px-6 font-bold"
        >
          {saving ? "جارٍ الحفظ…" : "حفظ"}
        </Button>
      </div>
    </div>
  );
}

/**
 * codiq phase 16 — platform-owner subscription assignment. Manual until the
 * billing phase automates renewals; every change is server-authoritative.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CreditCard, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type MerchantRow = {
  id: string;
  email: string;
  businessName: string;
  isActive: boolean;
  storeCount: number;
  plan: { code: string; name: string } | null;
  subscriptionEndsAt?: string | null;
  isTrial?: boolean;
};
const dayFormat = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium" });
type PlanRow = { id: string; code: string; name: string; isActive: boolean };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function SubscriptionsManager() {
  const [merchants, setMerchants] = useState<MerchantRow[] | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [merchantsResult, plansResult] = await Promise.all([
        api<{ merchants: MerchantRow[] }>("/api/platform/merchants"),
        api<{ plans: PlanRow[] }>("/api/platform/plans"),
      ]);
      setMerchants(merchantsResult.merchants);
      setPlans(plansResult.plans.filter((plan) => plan.isActive));
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      setMerchants(null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function assign(merchantId: string, planCode: string) {
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      await api(`/api/platform/merchants/${merchantId}/subscription`, { method: "PUT", body: JSON.stringify({ planCode }) });
      setNotice("أُسند الاشتراك الجديد وأصبح نافذاً فوراً.");
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[1030px] space-y-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><CreditCard className="h-4 w-4" /> اشتراكات التجار — إسناد يدوي حتى مرحلة الفوترة</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p data-testid="subscription-notice" className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
      {merchants === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {merchants?.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا يوجد تجار بعد.</p> : null}
      <div className="space-y-2">
        {merchants?.map((merchant) => (
          <div key={merchant.id} data-testid={`subscription-row-${merchant.email}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-[#263650]">{merchant.businessName}</p>
              <p className="truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">{merchant.email}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-semibold text-[#65748B]">متاجر: {merchant.storeCount}</span>
              <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-hover)]">{merchant.plan?.name ?? "بلا خطة"}</span>
              {merchant.isTrial && merchant.subscriptionEndsAt ? <span data-testid="subscription-trial-badge" className="rounded-full bg-[var(--codiq-warning-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-text-secondary)]">تجربة حتى {dayFormat.format(new Date(merchant.subscriptionEndsAt))}</span> : null}
              <select
                data-testid="subscription-plan-select"
                className="rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2 py-1.5 text-xs font-semibold"
                value={merchant.plan?.code ?? ""}
                disabled={busy}
                onChange={(event) => void assign(merchant.id, event.target.value)}
              >
                {merchant.plan ? null : <option value="">اختر خطة</option>}
                {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

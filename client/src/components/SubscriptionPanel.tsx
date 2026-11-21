/**
 * codiq phase 16 — merchant subscription view: current plan and live usage
 * against every server-enforced limit. Approved addition (2026-08-26):
 * upgrade/downgrade requests filed from here into the owner's review queue.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpCircle,
  BadgeCheck,
  CircleAlert,
  Gauge,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Entitlement = { feature: string; label: string; limit: number; used: number };
type View = {
  plan: { code: string; name: string; monthlyPriceIqd: number; version?: number | null };
  subscription?: { endsAt: string | null; isTrial: boolean; daysLeft: number | null };
  entitlements: Entitlement[];
};
const dayFormat = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "long" });
type PublicPlan = { code: string; name: string; monthlyPriceIqd: number };

const money = new Intl.NumberFormat("ar-IQ");

export function SubscriptionPanel() {
  const [view, setView] = useState<View | null>(null);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  const [requestFailure, setRequestFailure] = useState<string | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/merchant/subscription", { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
      setView(body);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      setView(null);
    }
    try {
      const response = await fetch("/api/public/plans", { credentials: "same-origin" });
      if (response.ok) setPlans(((await response.json())?.plans ?? []) as PublicPlan[]);
    } catch {
      // The plan list is auxiliary; the panel stays functional without it.
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function requestPlanChange(planCode: string) {
    setRequestBusy(true);
    setRequestNotice(null);
    setRequestFailure(null);
    try {
      const response = await fetch("/api/merchant/subscription/upgrade-request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
      setRequestNotice("أُرسل طلبك وسيراجعه فريق المنصة.");
    } catch (error) {
      setRequestFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setRequestBusy(false);
    }
  }

  return (
    <div className="max-w-[860px] space-y-5">
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex items-center justify-between">
          <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
            <Gauge className="h-4 w-4" /> اشتراكك واستهلاكك الفعلي
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="rounded-xl text-[var(--codiq-text-secondary)]"
          >
            <RefreshCw className="ml-1 h-4 w-4" /> تحديث
          </Button>
        </div>
        {failure ? (
          <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
            <CircleAlert className="h-4 w-4" /> {failure}
          </p>
        ) : null}
        {view === null && !failure ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">
            <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
          </p>
        ) : null}
        {view ? (
          <>
            <div
              data-testid="subscription-plan"
              className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#F0F5FF] px-5 py-4"
            >
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm">
                  <BadgeCheck className="h-5 w-5" />
                </div>
                <div>
                  {/* ق-181: a trial is NAMED — a merchant used to read a paid plan's name and
                      its monthly price with no word that the month was free or when it ended. */}
                  <p className="text-lg font-bold text-[var(--codiq-text)]">
                    {view.subscription?.isTrial ? (
                      <>تجربة مجانية على خطة «{view.plan.name}»</>
                    ) : (
                      <>خطة «{view.plan.name}»</>
                    )}
                  </p>
                  {view.subscription?.isTrial && view.subscription.endsAt ? (
                    <p
                      className="text-xs text-[var(--codiq-text-muted)]"
                      data-testid="subscription-trial"
                    >
                      مجاناً حتى {dayFormat.format(new Date(view.subscription.endsAt))} — يبقى{" "}
                      <strong>{view.subscription.daysLeft}</strong> يوماً. بعدها تنتقل تلقائياً إلى
                      الخطة المجانية ما لم تطلب ترقية.
                    </p>
                  ) : (
                    <p className="text-xs text-[#61708A]">
                      {view.plan.monthlyPriceIqd === 0
                        ? "مجانية"
                        : `${money.format(view.plan.monthlyPriceIqd)} د.ع شهرياً`}
                      {view.plan.version ? (
                        <span data-testid="subscription-plan-version">
                          {" "}
                          · الإصدار {view.plan.version} — شروطك ثابتة حتى التجديد
                        </span>
                      ) : null}
                    </p>
                  )}
                </div>
              </div>
              <p className="text-xs font-semibold text-[#61708A]">
                اطلب الترقية أو التخفيض من الأزرار أدناه — تصبح الحدود الجديدة نافذة فور موافقة
                إدارة المنصة.
              </p>
            </div>
            {plans.some((plan) => plan.code !== view.plan.code) ? (
              <div className="mb-6 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] px-5 py-4">
                <p className="mb-3 flex items-center gap-2 text-xs font-bold text-[#44526A]">
                  <ArrowUpCircle className="h-4 w-4 text-[var(--codiq-accent)]" /> تغيير الخطة
                  (بموافقة إدارة المنصة)
                </p>
                <div className="flex flex-wrap gap-2">
                  {plans
                    .filter((plan) => plan.code !== view.plan.code)
                    .map((plan) => (
                      <Button
                        key={plan.code}
                        data-testid={`plan-request-${plan.code}`}
                        disabled={requestBusy}
                        onClick={() => void requestPlanChange(plan.code)}
                        size="sm"
                        variant="outline"
                        className="rounded-xl border-[var(--codiq-border-strong)] text-[var(--codiq-accent)] hover:bg-[#F0F5FF]"
                      >
                        {plan.monthlyPriceIqd > view.plan.monthlyPriceIqd
                          ? `طلب ترقية إلى «${plan.name}»`
                          : `طلب تخفيض إلى «${plan.name}»`}
                      </Button>
                    ))}
                </div>
                {requestNotice ? (
                  <p
                    data-testid="upgrade-request-notice"
                    className="mt-3 rounded-xl bg-[var(--codiq-success-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-success)]"
                  >
                    {requestNotice}
                  </p>
                ) : null}
                {requestFailure ? (
                  <p
                    data-testid="upgrade-request-error"
                    className="mt-3 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]"
                  >
                    {requestFailure}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-4">
              {view.entitlements.map((entitlement) => {
                const ratio =
                  entitlement.limit > 0 ? Math.min(1, entitlement.used / entitlement.limit) : 1;
                const nearLimit = ratio >= 0.8;
                return (
                  <div key={entitlement.feature} data-testid={`entitlement-${entitlement.feature}`}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="font-semibold text-[#33435D]">{entitlement.label}</span>
                      <span
                        className={`font-bold ${nearLimit ? "text-[var(--codiq-danger)]" : "text-[var(--codiq-text-secondary)]"}`}
                        dir="ltr"
                      >
                        {entitlement.used} / {entitlement.limit}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-[var(--codiq-neutral-soft)]">
                      <div
                        className={`h-full rounded-full transition-all ${nearLimit ? "bg-[#D96A6A]" : "bg-[var(--codiq-accent)]"}`}
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </div>
                    {/* ق-243: the bar used to read 200/200 with no way to know that the
                        orders the merchant himself rejected were inside the number. */}
                    {entitlement.feature === "max_monthly_orders" ? (
                      <p
                        data-testid="entitlement-orders-rule"
                        className="mt-1 text-xs text-[var(--codiq-text-muted)]"
                      >
                        لا تُحسب الطلبات الملغاة والمرفوضة ضمن طلبات الشهر.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

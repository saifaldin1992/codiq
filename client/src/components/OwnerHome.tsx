import { PlatformPulse } from "@/components/PlatformPulse";
import { Button } from "@/components/ui/button";
import {
  Activity,
  ArrowLeft,
  ClipboardList,
  CircleAlert,
  Clock,
  ServerCog,
  Store,
  TrendingDown,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

/**
 * P27-13 (ق-101) — the owner asked for «كل الإشعارات والإحصائيات» on his home
 * page instead of three cards.
 *
 * Every figure here comes from ONE server aggregate. The three cards this
 * replaces each fetched a list and counted it in the browser, which meant «عدد
 * التجار» stopped being true the moment the platform outgrew one page — a number
 * that looked right and was not, which is the exact failure ق-10 exists to stop.
 *
 * The two sections that have no real data source yet are NAMED rather than
 * rendered empty: operational health waits on D-41 (phase 24), and a
 * cross-store activity feed would be a new owner-facing surface over
 * `store_audit_events` that the PG-2 plan deliberately did not open.
 */
interface Overview {
  awaiting: { key: string; count: number; href: string }[];
  scale: { merchants: number; activeMerchants: number; stores: number; activeStores: number };
  commerce: {
    period: { from: string; to: string };
    ordersToday: number;
    sales: { current: number; previous: number };
    commission: { current: number; previous: number };
  };
}

const AWAITING_LABEL: Record<string, { label: string; hint: string; icon: typeof UserCheck }> = {
  registration_requests: {
    label: "طلبات تسجيل تنتظر قرارك",
    hint: "تاجر سجّل بنفسه ولا يستطيع الدخول قبل موافقتك.",
    icon: UserCheck,
  },
  upgrade_requests: {
    label: "طلبات ترقية خطة",
    hint: "تاجر طلب خطة أعلى وينتظر اعتمادها.",
    icon: TrendingUp,
  },
};

const money = new Intl.NumberFormat("ar-IQ");
const PERIODS = [7, 30, 90] as const;

function Trend({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    // No baseline is NOT «+100%». Saying so would be inventing a comparison.
    return (
      <span className="text-[11px] font-semibold text-[#8A97AC]">لا توجد مدة سابقة للمقارنة</span>
    );
  }
  const delta = ((current - previous) / previous) * 100;
  const up = delta >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-bold ${up ? "text-[var(--codiq-success)]" : "text-[#B34B43]"}`}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(delta).toFixed(delta >= 10 || delta <= -10 ? 0 : 1)}٪ عن المدة السابقة
    </span>
  );
}

function Metric({
  label,
  value,
  suffix,
  children,
}: {
  label: string;
  value: string;
  suffix?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5">
      <p className="text-[12px] font-semibold text-[#8A96A9]">{label}</p>
      <p className="mt-2 text-2xl font-bold text-[#263650]">
        {value}
        {suffix ? (
          <span className="mr-1 text-sm font-semibold text-[#6B7A93]">{suffix}</span>
        ) : null}
      </p>
      {children ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}

function Scheduled({
  icon: Icon,
  title,
  phase,
  detail,
}: {
  icon: typeof ServerCog;
  title: string;
  phase: string;
  detail: string;
}) {
  return (
    <div className="rounded-[20px] border border-dashed border-[#CBD9ED] bg-[var(--codiq-surface-sunken)] p-5">
      <div className="flex items-center gap-2 text-[#5C6D89]">
        <Icon className="h-4 w-4" />
        <p className="text-sm font-bold text-[#33435D]">{title}</p>
        <span className="rounded-full bg-[var(--codiq-surface)] px-2 py-0.5 text-[10px] font-bold text-[#65748B]">
          قريباً — المرحلة {phase}
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-6 text-[#6B7A93]">{detail}</p>
    </div>
  );
}

export function OwnerHome({ navigate }: { navigate: (path: string) => void }) {
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFailure(null);
    fetch(`/api/platform/overview?days=${days}`, { credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message ?? "تعذّر تحميل نبض المنصة.");
        return payload.overview as Overview;
      })
      .then((next) => {
        if (alive) setOverview(next);
      })
      .catch((cause) => {
        if (alive) setFailure(cause instanceof Error ? cause.message : "تعذّر تحميل نبض المنصة.");
      });
    return () => {
      alive = false;
    };
  }, [days]);

  const waiting = (overview?.awaiting ?? []).filter((row) => row.count > 0);

  return (
    <div className="space-y-5" dir="rtl" data-testid="owner-home">
      {failure ? (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
        >
          <CircleAlert className="h-4 w-4" />
          {failure}
        </p>
      ) : null}

      {/* 1 — what is waiting on HIM. First, because it is the only part he must act on. */}
      <section>
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <Clock className="h-4 w-4" />
          ما ينتظر قرارك
        </p>
        <div className="mt-3 space-y-2">
          {overview && waiting.length === 0 ? (
            <p
              data-testid="owner-home-clear"
              className="rounded-[20px] border border-[#D8EEDF] bg-[#F4FBF7] px-4 py-3.5 text-sm font-semibold text-[var(--codiq-success)]"
            >
              لا شيء ينتظر قرارك الآن.
            </p>
          ) : null}
          {waiting.map((row) => {
            const meta = AWAITING_LABEL[row.key];
            if (!meta) return null;
            const Icon = meta.icon;
            return (
              <button
                key={row.key}
                type="button"
                data-testid={`owner-home-awaiting-${row.key}`}
                onClick={() => navigate(row.href)}
                className="flex w-full items-center gap-4 rounded-[20px] border border-[#F0D9B8] bg-[#FFFBF4] px-4 py-3.5 text-right transition hover:border-[#E4BE84]"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-surface)] text-[#A9741F]">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-[#33435D]">
                    {meta.label} · {money.format(row.count)}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-[#6B7A93]">{meta.hint}</span>
                </span>
                <ArrowLeft className="h-4 w-4 shrink-0 text-[#A9741F]" />
              </button>
            );
          })}
        </div>
      </section>

      {/* 2 — commercial pulse, over a window he chooses. */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
            <Activity className="h-4 w-4" />
            نبض تجاري
          </p>
          <div className="flex gap-1.5">
            {PERIODS.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={days === option ? "default" : "outline"}
                data-testid={`owner-home-period-${option}`}
                onClick={() => setDays(option)}
                className={`h-8 rounded-xl px-3 text-[12px] ${days === option ? "bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" : ""}`}
              >
                {option} يوماً
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="مبيعات المنصة"
            value={overview ? money.format(overview.commerce.sales.current) : "—"}
            suffix="د.ع"
          >
            {overview ? (
              <Trend
                current={overview.commerce.sales.current}
                previous={overview.commerce.sales.previous}
              />
            ) : null}
          </Metric>
          <Metric
            label="عمولاتك"
            value={overview ? money.format(overview.commerce.commission.current) : "—"}
            suffix="د.ع"
          >
            {overview ? (
              <Trend
                current={overview.commerce.commission.current}
                previous={overview.commerce.commission.previous}
              />
            ) : null}
          </Metric>
          <Metric
            label="طلبات اليوم"
            value={overview ? money.format(overview.commerce.ordersToday) : "—"}
          />
          <Metric label="التجار" value={overview ? money.format(overview.scale.merchants) : "—"}>
            {overview ? (
              <span className="text-[11px] font-semibold text-[#8A97AC]">
                {money.format(overview.scale.activeMerchants)} نشط ·{" "}
                {money.format(overview.scale.activeStores)} متجر نشط
              </span>
            ) : null}
          </Metric>
        </div>
      </section>

      {/* PG-7 — business health, and the one figure that predicts a merchant
          leaving before he leaves. */}
      <section>
        <PlatformPulse />
      </section>
      {/* 3 — the parts with no honest data source yet, named rather than blank. */}
      <section>
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <ClipboardList className="h-4 w-4" />
          ما لم يُبنَ بعد
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Scheduled
            icon={ServerCog}
            title="الصحة التشغيلية"
            phase="24"
            detail="رسائل عالقة في الصندوق الصادر وعمليات وصلت الحرف الميت — تحتاج السجلات المنظمة (D-41). أما المتاجر بلا نشاط فصارت أعلاه في صحة المنصة."
          />
          <Scheduled
            icon={Users}
            title="آخر الأحداث عبر المتاجر"
            phase="22"
            detail="سجل النشاط موجود لكل متجر منذ PG-2. عرضه للمالك عبر المتاجر سطحٌ جديد يمسّ حدود المستأجرين، ويستحق مراجعته على حدة لا أن يُلحق هنا."
          />
        </div>
      </section>

      <p className="flex items-center gap-1.5 text-[11px] text-[#8A96A9]">
        <Store className="h-3 w-3" />
        كل رقم أعلاه مجموع من قاعدة البيانات كاملةً، لا عدّ صفحة واحدة في المتصفح.
      </p>
    </div>
  );
}

import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";
import { Activity, ArrowLeft, CircleAlert, Info, TrendingUp, UserMinus, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * PG-7 (ق-75) — business health.
 *
 * The definition comes FROM THE SERVER and is printed on the screen, because a
 * number whose meaning the reader has to guess is a number he will misread. The
 * decision it encodes: «نشط» means SOLD. A merchant who signs in daily and sells
 * nothing is not active — he is the one about to leave, and he is reported as
 * his own figure rather than folded into a healthy-looking total.
 */
interface Pulse {
  windowDays: number;
  definitions: { active: string; stalled: string; neverSold: string };
  active: number;
  stalledCount: number;
  neverSoldCount: number;
  signedInWithoutSelling: number;
  conversion: { registered: number; reachedFirstOrder: number };
  fastestGrowing: { storeId: string; storeName: string; current: number; previous: number }[];
}

interface Cohort { kind: string; merchants: { id: string; businessName: string; email: string }[] }

const money = new Intl.NumberFormat("ar-IQ");
const WINDOWS = [7, 30, 90] as const;

function Figure({ label, value, tone, hint, onOpen }: { label: string; value: number; tone: "good" | "warn" | "bad" | "plain"; hint: string; onOpen?: () => void }) {
  const colours = {
    good: "border-[#D8EEDF] bg-[#F4FBF7] text-[var(--codiq-success)]",
    warn: "border-[#F0D9B8] bg-[#FFFBF4] text-[#A9741F]",
    bad: "border-[#F3CBCA] bg-[#FFF7F7] text-[#9B3733]",
    plain: "border-[var(--codiq-border)] bg-[var(--codiq-surface)] text-[#33435D]",
  }[tone];
  return (
    <div className={`rounded-[20px] border p-5 ${colours}`}>
      <p className="text-[12px] font-semibold opacity-80">{label}</p>
      <p className="mt-1.5 text-2xl font-bold">{money.format(value)}</p>
      <p className="mt-1.5 text-[11px] leading-5 opacity-75">{hint}</p>
      {onOpen ? (
        <button type="button" onClick={onOpen} className="mt-2 inline-flex items-center gap-1 text-[12px] font-bold underline underline-offset-4">
          مَن هم؟ <ArrowLeft className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

export function PlatformPulse() {
  const [days, setDays] = useState<number>(7);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [cohort, setCohort] = useState<Cohort | null>(null);
  // 20-2: «مَن هم هؤلاء التجار تحديداً» is the PG-7 acceptance criterion, and it
  // used to answer with the first hundred names and no sign there were more.
  const [cohortCursor, setCohortCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCohort(null);
    setFailure(null);
    fetch(`/api/platform/pulse?days=${days}`, { credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message ?? "تعذّر تحميل صحة المنصة.");
        return payload.pulse as Pulse;
      })
      .then((next) => { if (alive) setPulse(next); })
      .catch((cause) => { if (alive) setFailure(cause instanceof Error ? cause.message : "تعذّر تحميل صحة المنصة."); });
    return () => { alive = false; };
  }, [days]);

  async function openCohort(kind: string, cursor?: string) {
    setFailure(null);
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ days: String(days), limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/platform/pulse/${kind}?${query.toString()}`, { credentials: "same-origin" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "تعذّر فتح القائمة.");
      const next = payload as Cohort & { nextCursor: string | null };
      setCohort((current) => (cursor && current ? { ...next, merchants: [...current.merchants, ...next.merchants] } : next));
      setCohortCursor(next.nextCursor);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "تعذّر فتح القائمة.");
    } finally {
      setLoadingMore(false);
    }
  }

  const conversionRate = pulse && pulse.conversion.registered > 0
    ? Math.round((pulse.conversion.reachedFirstOrder / pulse.conversion.registered) * 100)
    : null;

  return (
    <div className="space-y-5" dir="rtl" data-testid="platform-pulse">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><Activity className="h-4 w-4" />صحة المنصة</p>
        <div className="flex gap-1.5">
          {WINDOWS.map((option) => (
            <Button key={option} type="button" size="sm" variant={days === option ? "default" : "outline"} data-testid={`pulse-window-${option}`} onClick={() => setDays(option)} className={`h-8 rounded-xl px-3 text-[12px] ${days === option ? "bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" : ""}`}>
              {option} يوماً
            </Button>
          ))}
        </div>
      </div>

      {failure ? <p role="alert" className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" />{failure}</p> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure label="تجار نشطون" value={pulse?.active ?? 0} tone="good" hint={pulse?.definitions.active ?? ""} onOpen={() => void openCohort("active")} />
        <Figure label="⚠️ متوقفون" value={pulse?.stalledCount ?? 0} tone="bad" hint={pulse?.definitions.stalled ?? ""} onOpen={() => void openCohort("stalled")} />
        <Figure label="دخل ولم يبع" value={pulse?.signedInWithoutSelling ?? 0} tone="warn" hint="فتح لوحته خلال المدة ولم يُسجَّل له أي بيع. هذا إنذار مبكر قبل التوقف." />
        <Figure label="لم يبدأ بعد" value={pulse?.neverSoldCount ?? 0} tone="plain" hint={pulse?.definitions.neverSold ?? ""} onOpen={() => void openCohort("never_sold")} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[#8A96A9]"><UserPlus className="h-3.5 w-3.5" />من التسجيل إلى أول طلب</p>
          <p className="mt-2 text-2xl font-bold text-[#263650]">
            {conversionRate === null ? "—" : `${money.format(conversionRate)}٪`}
          </p>
          <p className="mt-1.5 text-[11px] leading-5 text-[#8A97AC]">
            {pulse
              ? pulse.conversion.registered === 0
                ? "لا تسجيلات جديدة خلال المدة — فلا نسبة تُحسب."
                : `${money.format(pulse.conversion.reachedFirstOrder)} من ${money.format(pulse.conversion.registered)} تاجراً سجّلوا خلال المدة وصلوا إلى أول طلب.`
              : ""}
          </p>
        </div>
        <div className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[#8A96A9]"><TrendingUp className="h-3.5 w-3.5" />أسرع المتاجر نمواً</p>
          {pulse && pulse.fastestGrowing.length === 0 ? (
            <p className="mt-2 text-[13px] text-[#8A97AC]">لا متجر نما عن المدة السابقة.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {(pulse?.fastestGrowing ?? []).map((store) => (
                <li key={store.storeId} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate font-bold text-[#33435D]">{store.storeName}</span>
                  <span className="shrink-0 font-semibold text-[var(--codiq-success)]">{money.format(store.previous)} ← {money.format(store.current)} طلباً</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {cohort ? (
        <div className="rounded-[20px] border border-[#D8E6F8] bg-[var(--codiq-canvas)] p-5" data-testid="pulse-cohort">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-sm font-bold text-[#35577F]"><Users className="h-4 w-4" />{cohort.merchants.length} تاجراً{cohortCursor ? " معروضاً" : ""}</p>
            <Button type="button" size="sm" variant="ghost" className="h-8 rounded-xl text-[#66779A]" onClick={() => setCohort(null)}>إغلاق</Button>
          </div>
          {cohort.merchants.length === 0 ? (
            <p className="mt-2 text-[13px] text-[#6B7A93]">لا أحد في هذه الفئة الآن.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {cohort.merchants.map((merchant) => (
                <li key={merchant.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-[var(--codiq-surface)] px-3.5 py-2.5 text-[13px]">
                  <span className="font-bold text-[#33435D]">{merchant.businessName}</span>
                  <span dir="ltr" className="text-[12px] text-[#8A97AC]">{merchant.email}</span>
                </li>
              ))}
            </ul>
          )}
          <LoadMoreButton cursor={cohortCursor} busy={loadingMore} onLoad={(cursor) => void openCohort(cohort.kind, cursor)} testId="pulse-cohort-more" />
        </div>
      ) : null}

      <p className="flex items-start gap-1.5 text-[11px] leading-5 text-[#8A96A9]">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        التعريفات أعلاه تأتي من الخادم نفسه، لا من هذه الشاشة — فلا يمكن أن يختلف ما يُحسب عمّا يُقرأ.
      </p>
    </div>
  );
}

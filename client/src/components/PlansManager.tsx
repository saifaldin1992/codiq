/**
 * codiq phase 16 — platform-owner plan management. Limits and prices are
 * server-authoritative; this page edits them through the owner API only.
 * Approved addition (2026-08-26): plan creation and archive-instead-of-delete
 * (the default plan is server-protected against archiving).
 */
import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, CircleAlert, Layers3, LoaderCircle, Plus, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PlanRow = {
  id: string;
  code: string;
  name: string;
  monthlyPriceIqd: number;
  commissionBps: number;
  isActive: boolean;
  /** The owner's «توصية المنصة» pick — server-enforced to at most one plan. */
  isRecommended: boolean;
  limits: Record<string, number>;
};

const LIMIT_LABELS: Record<string, string> = {
  max_stores: "المتاجر",
  max_products: "المنتجات",
  max_staff: "الموظفون",
  max_monthly_orders: "طلبات الشهر",
  max_image_storage_mb: "التخزين (MB)",
};
const money = new Intl.NumberFormat("ar-IQ");

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

function PlanCard({ plan, onSaved, busy, setBusy }: { plan: PlanRow; onSaved: () => Promise<void>; busy: boolean; setBusy: (value: boolean) => void }) {
  const [price, setPrice] = useState(String(plan.monthlyPriceIqd));
  const [commission, setCommission] = useState(String(plan.commissionBps));
  const [limits, setLimits] = useState<Record<string, string>>(Object.fromEntries(Object.entries(plan.limits).map(([key, value]) => [key, String(value)])));
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await api(`/api/platform/plans/${plan.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          monthlyPriceIqd: Number(price),
          commissionBps: Number(commission),
          limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, Number(value)])),
        }),
      });
      setNotice("حُفظت الخطة.");
      await onSaved();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * The single-recommendation rule lives on the server: turning this on clears
   * every other plan inside one transaction, so the UI just re-reads the list.
   */
  async function toggleRecommended() {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await api(`/api/platform/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify({ isRecommended: !plan.isRecommended }) });
      setNotice(plan.isRecommended
        ? "أُلغيت التوصية — لن تظهر شارة «توصية المنصة» على أي خطة في صفحة الأسعار."
        : "صارت هذه الخطة «توصية المنصة» في صفحة الأسعار، وأُلغيت التوصية عن بقية الخطط.");
      await onSaved();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await api(`/api/platform/plans/${plan.id}/${plan.isActive ? "archive" : "unarchive"}`, { method: "POST" });
      setNotice(plan.isActive ? "أُرشفت الخطة — لن تُعرض للتجار الجدد، ويستمر مشتركوها الحاليون كما هم." : "أُعيد تفعيل الخطة وعادت إلى قائمة الأسعار.");
      await onSaved();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={`plan-card-${plan.code}`} className={`rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm ${plan.isActive ? "" : "opacity-60"}`}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-base font-bold text-[#263650]">{plan.name}</p>
          <p className="text-xs text-[#8490A5]" dir="ltr">{plan.code}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {plan.isRecommended ? <span data-testid={`plan-recommended-badge-${plan.code}`} className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-hover)]">توصية المنصة</span> : null}
          <span data-testid={`plan-status-${plan.code}`} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${plan.isActive ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"}`}>{plan.isActive ? "نشطة" : "مؤرشفة"}</span>
        </div>
      </div>
      <label className="mb-3 block space-y-1.5 text-xs font-semibold text-[#44526A]">
        <span>السعر الشهري (دينار عراقي)</span>
        <Input data-testid={`plan-price-${plan.code}`} value={price} onChange={(event) => setPrice(event.target.value)} inputMode="numeric" dir="ltr" />
      </label>
      <label className="mb-3 block space-y-1.5 text-xs font-semibold text-[#44526A]">
        <span>عمولة المنصة (نقاط أساس — 100 = 1%)</span>
        <Input data-testid={`plan-commission-${plan.code}`} value={commission} onChange={(event) => setCommission(event.target.value)} inputMode="numeric" dir="ltr" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(LIMIT_LABELS).map(([key, label]) => (
          <label key={key} className="block space-y-1 text-[11px] font-semibold text-[#44526A]">
            <span>{label}</span>
            <Input data-testid={`plan-limit-${plan.code}-${key}`} value={limits[key] ?? "0"} onChange={(event) => setLimits({ ...limits, [key]: event.target.value })} inputMode="numeric" dir="ltr" className="h-8 text-sm" />
          </label>
        ))}
      </div>
      {failure ? <p className="mt-3 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
      {notice ? <p data-testid={`plan-saved-${plan.code}`} className="mt-3 rounded-xl bg-[var(--codiq-success-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
      <Button data-testid={`plan-save-${plan.code}`} disabled={busy} onClick={() => void save()} size="sm" className="mt-3 w-full rounded-xl bg-[var(--codiq-accent)] text-white hover:bg-[var(--codiq-accent-hover)]">حفظ الخطة</Button>
      {/* A real switch (role/aria-checked), not a styled checkbox: the owner picks
          which plan the public pricing grid recommends, and the server allows
          exactly one at a time. */}
      <button
        type="button"
        role="switch"
        data-testid={`plan-recommend-${plan.code}`}
        aria-checked={plan.isRecommended}
        disabled={busy || !plan.isActive}
        onClick={() => void toggleRecommended()}
        className={`mt-2 flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-start text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${plan.isRecommended ? "border-[#BFD6F5] bg-[var(--codiq-canvas)] text-[var(--codiq-accent-hover)]" : "border-[var(--codiq-border)] bg-[var(--codiq-surface)] text-[#4C5B73] hover:bg-[var(--codiq-surface-sunken)]"}`}
      >
        <span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4" /> توصية المنصة</span>
        <span aria-hidden="true" className={`relative h-5 w-9 shrink-0 rounded-full transition ${plan.isRecommended ? "bg-[var(--codiq-accent)]" : "bg-[#D5DDE9]"}`}>
          <span className={`absolute top-[2px] h-4 w-4 rounded-full bg-[var(--codiq-surface)] shadow transition-[inset-inline-start] duration-200 ${plan.isRecommended ? "start-[18px]" : "start-[2px]"}`} />
        </span>
      </button>
      <p className="mt-1.5 text-[11px] leading-5 text-[#5B6880]">
        {plan.isActive ? "خطة واحدة فقط يمكن أن تحمل هذه الشارة؛ تفعيلها هنا يلغيها عن البقية." : "أعِد تفعيل الخطة قبل ترشيحها."}
      </p>
      <Button
        data-testid={`plan-${plan.isActive ? "archive" : "unarchive"}-${plan.code}`}
        disabled={busy}
        onClick={() => void toggleArchive()}
        size="sm"
        variant="outline"
        className={`mt-2 w-full rounded-xl ${plan.isActive ? "border-[#F3D3D7] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]" : "border-[#CFE3D8] text-[var(--codiq-success)] hover:bg-[var(--codiq-success-soft)]"}`}
      >
        {plan.isActive ? <><Archive className="ml-1 h-4 w-4" /> أرشفة الخطة</> : <><ArchiveRestore className="ml-1 h-4 w-4" /> إلغاء الأرشفة</>}
      </Button>
      <p className="mt-2 text-center text-[11px] text-[#8490A5]">{money.format(plan.monthlyPriceIqd)} د.ع / شهرياً حالياً</p>
    </div>
  );
}

const EMPTY_DRAFT = { code: "", name: "", price: "0", commission: "0", sortOrder: "10", limits: Object.fromEntries(Object.keys(LIMIT_LABELS).map((key) => [key, "0"])) as Record<string, string> };

function CreatePlanForm({ onCreated, busy, setBusy }: { onCreated: () => Promise<void>; busy: boolean; setBusy: (value: boolean) => void }) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await api("/api/platform/plans", {
        method: "POST",
        body: JSON.stringify({
          code: draft.code.trim(),
          name: draft.name.trim(),
          monthlyPriceIqd: Number(draft.price),
          commissionBps: Number(draft.commission),
          sortOrder: Number(draft.sortOrder),
          limits: Object.fromEntries(Object.entries(draft.limits).map(([key, value]) => [key, Number(value)])),
        }),
      });
      setNotice("أُنشئت الخطة الجديدة وظهرت فوراً في قائمة الأسعار.");
      setDraft(EMPTY_DRAFT);
      await onCreated();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="plan-create-card" className="rounded-[24px] border border-dashed border-[#C7D6EB] bg-[var(--codiq-surface-sunken)] p-5">
      <p className="mb-4 flex items-center gap-2 text-sm font-bold text-[#263650]"><Plus className="h-4 w-4 text-[var(--codiq-accent)]" /> إنشاء خطة جديدة</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-xs font-semibold text-[#44526A]">
          <span>رمز الخطة (إنجليزي)</span>
          <Input data-testid="plan-create-code" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} placeholder="starter" dir="ltr" />
        </label>
        <label className="block space-y-1.5 text-xs font-semibold text-[#44526A]">
          <span>اسم الخطة</span>
          <Input data-testid="plan-create-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="block space-y-1.5 text-xs font-semibold text-[#44526A]">
          <span>السعر الشهري (دينار عراقي)</span>
          <Input data-testid="plan-create-price" value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} inputMode="numeric" dir="ltr" />
        </label>
        <label className="block space-y-1.5 text-xs font-semibold text-[#44526A]">
          <span>عمولة المنصة (نقاط أساس)</span>
          <Input data-testid="plan-create-commission" value={draft.commission} onChange={(event) => setDraft({ ...draft, commission: event.target.value })} inputMode="numeric" dir="ltr" />
        </label>
        <label className="block space-y-1.5 text-xs font-semibold text-[#44526A]">
          <span>ترتيب العرض</span>
          <Input data-testid="plan-create-sort" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} inputMode="numeric" dir="ltr" />
        </label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Object.entries(LIMIT_LABELS).map(([key, label]) => (
          <label key={key} className="block space-y-1 text-[11px] font-semibold text-[#44526A]">
            <span>{label}</span>
            <Input data-testid={`plan-create-limit-${key}`} value={draft.limits[key] ?? "0"} onChange={(event) => setDraft({ ...draft, limits: { ...draft.limits, [key]: event.target.value } })} inputMode="numeric" dir="ltr" className="h-8 text-sm" />
          </label>
        ))}
      </div>
      {failure ? <p data-testid="plan-create-error" className="mt-3 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
      {notice ? <p data-testid="plan-create-success" className="mt-3 rounded-xl bg-[var(--codiq-success-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
      <Button data-testid="plan-create-submit" disabled={busy} onClick={() => void create()} size="sm" className="mt-4 w-full rounded-xl bg-[var(--codiq-accent)] text-white hover:bg-[var(--codiq-accent-hover)]"><Plus className="ml-1 h-4 w-4" /> إنشاء الخطة</Button>
    </div>
  );
}

export function PlansManager() {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ plans: PlanRow[] }>("/api/platform/plans");
      setPlans(result.plans);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      setPlans(null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-[1030px] space-y-5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><Layers3 className="h-4 w-4" /> خطط الاشتراك — حدود تُفرض على الخادم عند كل عملية</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {plans === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      <div className="grid gap-4 md:grid-cols-3">
        {plans?.map((plan) => <PlanCard key={plan.id} plan={plan} onSaved={load} busy={busy} setBusy={setBusy} />)}
      </div>
      {plans !== null ? <CreatePlanForm onCreated={load} busy={busy} setBusy={setBusy} /> : null}
    </div>
  );
}

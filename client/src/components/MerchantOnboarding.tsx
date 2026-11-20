import { Button } from "@/components/ui/button";
import { ArrowLeft, Check, Circle, PackageCheck, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * PG-8 (ق-76) — the first path a new merchant walks.
 *
 * Four of the five steps read their state from his actual store, so the card can
 * never claim he did something he has since undone. The fifth is «see what an
 * arriving order looks like» — and it CREATES NOTHING: the example below is
 * rendered from his own product and never inserted, which is how it stays out of
 * his ledger and his analytics by construction rather than by everyone
 * remembering to exclude it.
 *
 * It never blocks the dashboard: it is a card above the content with a dismiss
 * button, and once dismissed or finished it does not come back.
 */
interface Step { key: string; done: boolean; href: string | null }
interface Onboarding {
  visible: boolean;
  completedCount: number;
  totalCount: number;
  steps: Step[];
  preview: { productName: string; unitPriceIqd: number; quantity: number; deliveryFeeIqd: number; totalIqd: number } | null;
}

const LABELS: Record<string, { title: string; hint: string; cta: string }> = {
  first_product: { title: "أضف أول منتج", hint: "اسم وسعر وكمية — تستطيع تعديل الباقي لاحقاً.", cta: "أضف منتجاً" },
  product_image: { title: "أضف صورة للمنتج", hint: "المنتج بصورة يُشترى أكثر بكثير من منتج بلا صورة.", cta: "أضف صورة" },
  delivery_enabled: { title: "فعّل التوصيل لمحافظة واحدة على الأقل", hint: "بلا سعر توصيل مفعّل لا يستطيع أحد إتمام طلب.", cta: "أسعار التوصيل" },
  order_preview: { title: "شاهد كيف يصلك الطلب", hint: "مثال مبنيّ من منتجك أنت — لا يُنشئ طلباً ولا يدخل حساباتك.", cta: "أرني" },
  store_published: { title: "انشر متجرك", hint: "متجر غير منشور لا يراه زبون.", cta: "إعدادات المتجر" },
};

const money = new Intl.NumberFormat("ar-IQ");

export function MerchantOnboarding({ storeSlug, navigate }: { storeSlug?: string; navigate: (path: string) => void }) {
  const [state, setState] = useState<Onboarding | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/onboarding` : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const response = await fetch(base, { credentials: "same-origin" });
      if (!response.ok) return;
      const payload = await response.json();
      setState(payload.onboarding as Onboarding);
    } catch {
      // A welcome card must never be the reason a dashboard fails to render.
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  async function post(action: "preview-seen" | "dismiss") {
    if (!base) return;
    try {
      const response = await fetch(`${base}/${action}`, { method: "POST", credentials: "same-origin" });
      if (response.ok) setState((await response.json()).onboarding as Onboarding);
    } catch {
      // Same reasoning: silence beats a broken dashboard.
    }
  }

  if (!state?.visible) return null;

  return (
    <section dir="rtl" data-testid="merchant-onboarding" className="rounded-[24px] border border-[#D8E6F8] bg-gradient-to-bl from-[var(--codiq-canvas)] to-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-2xl bg-[var(--codiq-accent)] text-white"><Sparkles className="h-4 w-4" /></span>
          <div>
            <p className="text-sm font-bold text-[#263650]">ابدأ متجرك في خمس خطوات</p>
            <p className="text-[12px] text-[#6B7A93]">أنجزت {money.format(state.completedCount)} من {money.format(state.totalCount)}</p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" data-testid="onboarding-dismiss" onClick={() => void post("dismiss")} className="h-8 rounded-xl text-[12px] text-[#66779A]">
          <X className="ml-1 h-3.5 w-3.5" />إخفاء
        </Button>
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--codiq-border)]">
        <div className="h-full rounded-full bg-[var(--codiq-accent)] transition-all" style={{ width: `${Math.round((state.completedCount / state.totalCount) * 100)}%` }} />
      </div>

      <ol className="mt-4 space-y-2">
        {state.steps.map((step) => {
          const label = LABELS[step.key];
          if (!label) return null;
          return (
            <li key={step.key} data-testid={`onboarding-step-${step.key}`} className={`flex flex-wrap items-center gap-3 rounded-2xl px-3.5 py-3 ${step.done ? "bg-[#F4FBF7]" : "bg-[var(--codiq-surface)]"}`}>
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${step.done ? "bg-[var(--codiq-success)] text-white" : "border border-[#CBD9ED] text-[#8A97AC]"}`}>
                {step.done ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-2 w-2 fill-current" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-bold ${step.done ? "text-[var(--codiq-success)] line-through decoration-[#B4D9C4]" : "text-[#33435D]"}`}>{label.title}</span>
                {!step.done ? <span className="mt-0.5 block text-[12px] leading-5 text-[#6B7A93]">{label.hint}</span> : null}
              </span>
              {!step.done ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`onboarding-cta-${step.key}`}
                  onClick={() => { if (step.key === "order_preview") { setShowPreview(true); void post("preview-seen"); } else if (step.href) navigate(step.href); }}
                  className="h-8 shrink-0 rounded-xl text-[12px]"
                >
                  {label.cta}<ArrowLeft className="mr-1 h-3 w-3" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>

      {showPreview && state.preview ? (
        <div data-testid="onboarding-preview" className="mt-4 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--codiq-accent)]"><PackageCheck className="h-3.5 w-3.5" />هكذا يصلك الطلب</p>
          <div className="mt-3 space-y-1.5 text-sm text-[#40536D]">
            <div className="flex justify-between gap-4"><span>{state.preview.productName} × {money.format(state.preview.quantity)}</span><span className="font-bold">{money.format(state.preview.unitPriceIqd)} د.ع</span></div>
            <div className="flex justify-between gap-4"><span>التوصيل</span><span className="font-bold">{money.format(state.preview.deliveryFeeIqd)} د.ع</span></div>
            <div className="flex justify-between gap-4 border-t border-[var(--codiq-neutral-soft)] pt-1.5 text-base"><span>الإجمالي</span><strong>{money.format(state.preview.totalIqd)} د.ع</strong></div>
          </div>
          {/* Said plainly, because a merchant who thinks this is a real order
              will look for it in his numbers and not find it. */}
          <p className="mt-3 rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2 text-[11px] leading-5 text-[#6B7A93]">
            هذا مثال معروض فقط — لم يُنشأ طلب، ولا يظهر في مبيعاتك ولا في سجلك المالي.
          </p>
        </div>
      ) : null}
    </section>
  );
}

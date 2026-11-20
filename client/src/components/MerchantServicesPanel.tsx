/**
 * المرحلة 29 (ق-249) — «الخدمات»: what this store may use right now, and why
 * not when not. The server resolves every state (platform switch, an override
 * on this merchant or store, a rollout that has not reached him, a dependency
 * that is down, his own store status); the screen only says it in his words.
 */
import { useCallback, useEffect, useState } from "react";
import { LayoutGrid, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Capability = { code: string; name: string; description: string; state: string; label: string; source: string };
type Service = { code: string; name: string; description: string; state: string; capabilities: Capability[] };

const SOURCE_LABELS: Record<string, string> = {
  merchant: "حسابك موقوف من المنصّة",
  store: "بسبب حالة متجرك",
  platform_override: "قرارٌ من المنصّة",
  maintenance_window: "صيانة مجدولة من المنصّة",
  incident: "حادثٌ قيد المعالجة",
  merchant_override: "قرارٌ من المنصّة لحسابك",
  store_override: "قرارٌ من المنصّة لهذا المتجر",
  service: "الخدمة كلّها في هذه الحالة",
  capability: "هذه القدرة في هذه الحالة",
  dependency: "تعتمد على خدمةٍ غير متاحة الآن",
  flag: "تُطرح تدريجيّاً ولم تصلك بعد",
  none: "",
};
const tone = (state: string) => state === "AVAILABLE" ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : state === "COMING_SOON" ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]" : "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]";

export function MerchantServicesPanel({ storeSlug }: { storeSlug?: string }) {
  if (!storeSlug) return <p className="text-sm text-[var(--codiq-text-muted)]">اختر متجرًا أولًا.</p>;
  return <MerchantServicesCard storeSlug={storeSlug} />;
}

function MerchantServicesCard({ storeSlug }: { storeSlug: string }) {
  const [services, setServices] = useState<Service[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!storeSlug) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/services`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
      setServices(body.services); setFailure(null);
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر تحميل الخدمات."); }
    finally { setLoading(false); }
  }, [storeSlug]);
  useEffect(() => { void load(); }, [load]);

  return <section className="space-y-5" dir="rtl" data-testid="merchant-services">
    <div className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-xl font-bold text-[var(--codiq-text)]"><LayoutGrid className="h-5 w-5 text-[var(--codiq-accent)]" />الخدمات</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--codiq-text-muted)]">ما يعمل في متجرك الآن، وما ينتظر، وسبب كلّ حالة — كما تراه المنصّة لا كما تخمّنه الشاشة.</p></div>
        <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={loading} onClick={() => void load()}><RefreshCw className={`ml-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />تحديث</Button>
      </div>
      {failure ? <p className="mt-4 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
    </div>
    {services ? <div className="grid gap-4 md:grid-cols-2">
      {services.map((service) => <div key={service.code} className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm" data-testid={`merchant-service-${service.code}`}>
        <div className="flex items-center justify-between gap-2"><h3 className="text-base font-bold text-[var(--codiq-text)]">{service.name}</h3><span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${tone(service.state)}`}>{service.state === "AVAILABLE" ? "تعمل" : "فيها ما ينتظر"}</span></div>
        <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">{service.description}</p>
        <ul className="mt-3 divide-y divide-[var(--codiq-border)]">
          {service.capabilities.map((capability) => <li key={capability.code} className="flex items-start justify-between gap-3 py-2 text-sm">
            <div><p className="font-semibold text-[var(--codiq-text)]">{capability.name}</p><p className="text-xs text-[var(--codiq-text-muted)]">{capability.description}</p>{capability.state !== "AVAILABLE" && SOURCE_LABELS[capability.source] ? <p className="mt-0.5 text-[11px] font-semibold text-[var(--codiq-warning)]">{SOURCE_LABELS[capability.source]}</p> : null}</div>
            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${tone(capability.state)}`} data-testid={`capability-${capability.code}`}>{capability.label}</span>
          </li>)}
        </ul>
      </div>)}
    </div> : loading ? <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p> : null}
  </section>;
}

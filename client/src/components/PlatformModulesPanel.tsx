/**
 * «الوحدات» — what this installation is made of: every platform module in mount
 * order, its domain, and the domain events it listens to. Read-only; a module
 * is added in code (`phase1-backend/src/modules/registry.ts`), not from here.
 */
import { useEffect, useState } from "react";
import { Boxes, CircleAlert, LoaderCircle, Radio } from "lucide-react";

type InstalledModule = { id: string; domain: string; title: string; position: number; listensTo: string[] };

const DOMAIN_LABELS: Record<string, string> = {
  identity: "الهويّة والأمان",
  storefront: "واجهة المتجر",
  catalog: "الكتالوج",
  orders: "الطلبات",
  pos: "نقطة البيع",
  finance: "المال",
  marketing: "التسويق",
  team: "الفرق",
  platform: "المنصّة",
  operations: "التشغيل",
};

export function PlatformModulesPanel() {
  const [modules, setModules] = useState<InstalledModule[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/platform/modules", { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) { setFailure(body?.error?.message ?? `فشل الطلب (${response.status})`); return; }
      setModules(body.modules);
    })();
  }, []);

  if (failure) return <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p>;
  if (!modules) return <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;

  const domains = Array.from(new Set(modules.map((module) => module.domain)));
  return (
    <div className="max-w-[1030px] space-y-5" data-testid="platform-modules">
      <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <Boxes className="h-4 w-4" /> {modules.length} وحدة مركّبة بترتيب تركيبها — الإضافة من الشيفرة لا من هنا
      </p>
      {domains.map((domain) => (
        <section key={domain} className="rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
          <p className="mb-3 text-sm font-bold text-[var(--codiq-text)]">{DOMAIN_LABELS[domain] ?? domain}</p>
          <div className="space-y-2">
            {modules.filter((module) => module.domain === domain).map((module) => (
              <div key={module.id} data-testid={`platform-module-${module.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--codiq-text)]">{module.title}</p>
                  <p className="text-[11px] text-[var(--codiq-text-muted)]" dir="ltr">#{module.position + 1} · {module.id}</p>
                </div>
                {module.listensTo.length ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent)]" dir="ltr">
                    <Radio className="h-3 w-3" /> {module.listensTo.join(" · ")}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

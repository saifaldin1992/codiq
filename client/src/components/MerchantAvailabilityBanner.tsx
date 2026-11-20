/**
 * ق-250 (المرحلة 29-2) — what the platform has to tell this merchant, above
 * everything else on his dashboard: maintenance running now, maintenance
 * coming within the week, and open incidents that touch him.
 *
 * Nothing here is dismissible on purpose: a banner he can close is a banner he
 * closes before reading, and the next call from a customer lands on him. It
 * disappears by itself when the window ends or the incident is resolved.
 */
import { useEffect, useState } from "react";
import { CircleAlert, Clock3, Wrench } from "lucide-react";

type MaintenanceNotice = { id: string; phase: "upcoming" | "active" | "ended" | "cancelled"; scope: string; subject: string; startsAtLocal: string; endsAtLocal: string; messageAr: string; affects: string[] };
type IncidentNotice = { id: string; status: string; severity: "minor" | "major" | "critical"; title: string; publicMessage: string; affects: string[]; blocks: boolean };
type Notices = { maintenance: MaintenanceNotice[]; incidents: IncidentNotice[] };

const SEVERITY_LABEL: Record<IncidentNotice["severity"], string> = { minor: "طفيف", major: "كبير", critical: "حرج" };
const STATUS_LABEL: Record<string, string> = { investigating: "قيد التحقيق", identified: "حُدّد السبب", monitoring: "قيد المراقبة", resolved: "حُلّ" };

export function MerchantAvailabilityBanner({ storeSlug }: { storeSlug?: string }) {
  const [notices, setNotices] = useState<Notices | null>(null);

  useEffect(() => {
    if (!storeSlug) { setNotices(null); return; }
    const slug = storeSlug;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/merchant/stores/${encodeURIComponent(slug)}/availability/notices`, { credentials: "same-origin" });
        if (!response.ok) { if (!cancelled) setNotices(null); return; }
        const payload = (await response.json()) as Notices;
        if (!cancelled) setNotices(payload);
      } catch {
        if (!cancelled) setNotices(null);
      }
    }
    void load();
    // A window that starts while the dashboard is open must appear without a reload.
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [storeSlug]);

  if (!notices || (notices.maintenance.length === 0 && notices.incidents.length === 0)) return null;

  return (
    <div className="mx-5 mt-5 space-y-2 sm:mx-8 lg:mx-10" dir="rtl" data-testid="availability-banner">
      {notices.incidents.map((incident) => (
        <div key={incident.id} role="status" data-testid={`incident-notice-${incident.id}`} className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm ${incident.blocks || incident.severity === "critical" ? "border-[var(--codiq-danger-border)] bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" : "border-[var(--codiq-border)] bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]"}`}>
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-bold">{incident.title} <span className="mr-1 rounded-full bg-[var(--codiq-surface)] px-2 py-0.5 text-[11px] font-bold">{SEVERITY_LABEL[incident.severity]} · {STATUS_LABEL[incident.status] ?? incident.status}</span></p>
            <p className="mt-0.5 leading-6">{incident.publicMessage}</p>
            {incident.blocks ? <p className="mt-0.5 text-xs font-semibold">القدرات المتأثّرة موقوفة حتى يُحلّ الحادث{incident.affects.length ? `: ${incident.affects.join("، ")}` : "."}</p> : null}
          </div>
        </div>
      ))}
      {notices.maintenance.map((row) => (
        <div key={row.id} role="status" data-testid={`maintenance-notice-${row.id}`} className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm ${row.phase === "active" ? "border-[var(--codiq-border)] bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]" : "border-[var(--codiq-border)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]"}`}>
          {row.phase === "active" ? <Wrench className="mt-0.5 h-4 w-4 shrink-0" /> : <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />}
          <div>
            <p className="font-bold">{row.phase === "active" ? "صيانة جارية" : "صيانة مجدولة"} — {row.subject} <span dir="ltr" className="text-xs font-semibold">{row.startsAtLocal} → {row.endsAtLocal}</span> <span className="text-xs">(بتوقيت بغداد)</span></p>
            <p className="mt-0.5 leading-6">{row.messageAr}</p>
            {row.affects.length ? <p className="mt-0.5 text-xs font-semibold" dir="ltr">{row.affects.join(", ")}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

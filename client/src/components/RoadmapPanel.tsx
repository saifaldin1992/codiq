import { CalendarClock } from "lucide-react";
import { comingSoonLabel, type NavEntry } from "@/config/navigation";

/**
 * «قريباً» — everything scheduled, in one place instead of fifteen.
 *
 * The sidebar used to carry a «قريباً — المرحلة X» badge on one entry in three.
 * That was honest and it was also exhausting: a merchant opening the dashboard
 * to find an order was reading a roadmap he did not ask for, and the working
 * screens were outnumbered by promises.
 *
 * Moving them here keeps BOTH things true. Nothing is hidden — every scheduled
 * destination is still listed, still names its phase, and its URL still works
 * and still says the same thing. It is just somewhere a person goes on purpose
 * rather than something he wades through on the way to his work.
 *
 * Grouped by phase, because that is the only ordering that answers the question
 * a merchant actually has here: «متى؟».
 */
export function RoadmapPanel({ entries }: { entries: readonly NavEntry[] }) {
  // Grouped by phase, phases in their natural order. Built from the navigation
  // config itself, so this page cannot drift from what the sidebar knows.
  const byPhase = new Map<string, NavEntry[]>();
  for (const entry of entries) {
    const phase = typeof entry.status === "object" ? entry.status.phase : "—";
    const bucket = byPhase.get(phase);
    if (bucket) bucket.push(entry);
    else byPhase.set(phase, [entry]);
  }
  const phases = Array.from(byPhase.keys()).sort((a, b) =>
    a.localeCompare(b, "ar", { numeric: true, sensitivity: "base" })
  );

  return (
    <div className="max-w-[760px]">
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <CalendarClock className="h-4 w-4" /> خارطة الطريق
        </p>
        <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">ما الذي يُبنى بعد</h2>
        <p className="mb-7 text-sm leading-7 text-[var(--codiq-text-muted)]">
          هذه الوجهات مجدولة ولم تُبنَ بعد. كانت موزّعة داخل القوائم بشارة «قريباً» على واحدة من كل
          ثلاث — فجمعناها هنا. لا شيء أُخفي: كل واحدة تذكر مرحلتها، ورابطها يعمل ويقول الشيء نفسه.
        </p>

        <div className="space-y-6">
          {phases.map((phase) => (
            <section key={phase}>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--codiq-text-secondary)]">
                <span className="rounded-full bg-[var(--codiq-accent-soft)] px-3 py-1 text-xs font-bold text-[var(--codiq-accent-on-soft)]">
                  المرحلة {phase}
                </span>
                <span className="text-xs font-medium text-[var(--codiq-text-muted)]">
                  {byPhase.get(phase)!.length} وجهات
                </span>
              </h3>
              <ul className="space-y-2">
                {byPhase.get(phase)!.map((entry) => (
                  <li
                    key={entry.path}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--codiq-border)] px-4 py-3"
                  >
                    <span className="text-sm font-semibold text-[var(--codiq-text)]">
                      {entry.label}
                    </span>
                    <span className="text-xs font-medium text-[var(--codiq-text-muted)]">
                      {comingSoonLabel(entry.status) ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** The one empty/placeholder block every market page uses, so «nothing here yet» looks the same everywhere. */
export function MarketEmptyState({ icon: Icon, title, body, action, testId }: { icon: LucideIcon; title: string; body?: string; action?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[28px] bg-[var(--codiq-surface)] px-6 py-12 text-center shadow-sm" data-testid={testId}>
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Icon className="h-7 w-7" /></span>
      <p className="text-base font-bold text-[var(--codiq-text)]">{title}</p>
      {body ? <p className="max-w-[320px] text-sm leading-6 text-[var(--codiq-text-muted)]">{body}</p> : null}
      {action}
    </div>
  );
}

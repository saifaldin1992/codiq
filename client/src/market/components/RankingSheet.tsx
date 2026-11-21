/** «كيف نرتّب المتاجر؟» — the published criteria and weights, read from the server so the text is the formula. */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { marketGet } from "../market-api";

type Ranking = { criteria: { code: string; title: string; weight: number }[]; minimumOrders: number; tiers: Record<string, string> };

export function RankingSheet({ onClose }: { onClose: () => void }) {
  const [ranking, setRanking] = useState<Ranking | null>(null);
  useEffect(() => { marketGet<Ranking>("/api/market/ranking").then(setRanking).catch(() => undefined); }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--codiq-text)]/40" role="dialog" aria-modal="true" aria-label="كيف نرتّب المتاجر؟" onClick={onClose} data-testid="market-ranking-sheet">
      <div className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-t-[28px] bg-[var(--codiq-surface)] p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-base font-black text-[var(--codiq-text)]">كيف نرتّب المتاجر؟</p>
          <button type="button" aria-label="إغلاق" className="rounded-full p-2 text-[var(--codiq-text-muted)]" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <p className="mb-4 text-sm leading-6 text-[var(--codiq-text-secondary)]">
          نحسب لكل متجر نتيجة من ١٠٠ من أدائه الفعلي مع الزبائن، ونرتّب بها. لا تُحسب النتيجة قبل أن يكمل المتجر {ranking?.minimumOrders ?? 5} طلبات على الأقل.
        </p>
        <ul className="space-y-2">
          {(ranking?.criteria ?? []).map((criterion) => (
            <li key={criterion.code} className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--codiq-surface-sunken)] px-3 py-2.5">
              <span className="text-sm text-[var(--codiq-text)]">{criterion.title}</span>
              <span className="shrink-0 rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-xs font-bold text-[var(--codiq-accent)]">{criterion.weight}%</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs leading-5 text-[var(--codiq-text-muted)]">المستويات: برونزي من ٤٠، فضّي من ٥٥، ذهبي من ٧٠، بلاتيني من ٨٥.</p>
      </div>
    </div>
  );
}

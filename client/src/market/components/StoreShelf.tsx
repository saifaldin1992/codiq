/** A titled, sideways-scrolling row of stores from one directory query. Hidden when the query has nothing. */
import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { useMarketStores } from "../use-market-stores";
import { StoreShelfCard } from "./StoreCards";

export function StoreShelf({ title, subtitle, url, action, testId }: { title: string; subtitle?: string; url: string | null; action?: ReactNode; testId: string }) {
  const { stores, failure } = useMarketStores(url);
  if (failure || (stores && stores.length === 0)) return null;
  return (
    <section className="space-y-2" data-testid={testId}>
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-black text-[var(--codiq-text)]">{title}</h2>
          {subtitle ? <p className="text-[11px] text-[var(--codiq-text-muted)]">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {stores ? (
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {stores.map((store) => <StoreShelfCard key={store.slug} store={store} />)}
        </div>
      ) : (
        <p className="py-6 text-center text-xs text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>
      )}
    </section>
  );
}

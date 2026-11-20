/** The two shapes a store takes in a list: a tall card in a sideways shelf, and a row in the full directory. */
import { Link } from "wouter";
import { BadgeCheck, Clock3, MapPin, Store } from "lucide-react";
import type { MarketStoreCard } from "../market-types";
import { MarkChips, RatingInline, TierChip } from "./StoreBadges";

function StoreLogo({ store, size }: { store: MarketStoreCard; size: "sm" | "md" }) {
  const box = size === "sm" ? "h-12 w-12" : "h-14 w-14";
  return store.logoUrl ? (
    <img src={store.logoUrl} alt="" loading="lazy" className={`${box} shrink-0 rounded-2xl border-2 border-[var(--codiq-surface)] bg-[var(--codiq-surface)] object-cover shadow-sm`} />
  ) : (
    <span className={`${box} flex shrink-0 items-center justify-center rounded-2xl border-2 border-[var(--codiq-surface)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)] shadow-sm`}><Store className="h-6 w-6" /></span>
  );
}

function placeOf(store: MarketStoreCard) {
  return [store.governorate?.name, store.district?.name].filter(Boolean).join(" · ");
}

export function StoreShelfCard({ store }: { store: MarketStoreCard }) {
  return (
    <Link href={`/s/${encodeURIComponent(store.slug)}`} className="block w-[168px] shrink-0 overflow-hidden rounded-[22px] bg-[var(--codiq-surface)] shadow-sm" data-testid={`market-store-card-${store.slug}`}>
      <div className="relative h-[72px] bg-[var(--codiq-accent-soft)]">
        {store.coverUrl ? <img src={store.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
        <div className="absolute -bottom-6 right-3"><StoreLogo store={store} size="sm" /></div>
      </div>
      <div className="space-y-1 px-3 pb-3 pt-7">
        <p className="flex items-center gap-1 truncate text-sm font-bold text-[var(--codiq-text)]">
          <span className="truncate">{store.name}</span>
          {store.marks.includes("verified") ? <BadgeCheck className="h-4 w-4 shrink-0 text-[var(--codiq-accent)]" aria-label="موثّق" /> : null}
        </p>
        <p className="truncate text-[11px] text-[var(--codiq-text-muted)]">{store.businessType ?? placeOf(store)}</p>
        <RatingInline rating={store.rating} count={store.ratingCount} />
        {store.distanceKm !== null ? <p className="text-[11px] font-semibold text-[var(--codiq-accent)]">{store.distanceKm.toLocaleString("ar-IQ")} كم</p> : null}
      </div>
    </Link>
  );
}

export function StoreListRow({ store }: { store: MarketStoreCard }) {
  return (
    <Link href={`/s/${encodeURIComponent(store.slug)}`} className="flex items-center gap-3 rounded-[22px] bg-[var(--codiq-surface)] p-3 shadow-sm" data-testid={`market-store-row-${store.slug}`}>
      <StoreLogo store={store} size="md" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-1 text-sm font-bold text-[var(--codiq-text)]">
          <span className="truncate">{store.name}</span>
          {store.marks.includes("verified") ? <BadgeCheck className="h-4 w-4 shrink-0 text-[var(--codiq-accent)]" aria-label="موثّق" /> : null}
        </p>
        <p className="flex items-center gap-2 truncate text-[11px] text-[var(--codiq-text-muted)]">
          {store.businessType ? <span>{store.businessType}</span> : null}
          {placeOf(store) ? <span className="inline-flex items-center gap-0.5"><MapPin className="h-3 w-3" />{placeOf(store)}</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <RatingInline rating={store.rating} count={store.ratingCount} />
          {store.medianResponseMinutes !== null ? <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--codiq-text-muted)]"><Clock3 className="h-3 w-3" /> يردّ خلال {store.medianResponseMinutes.toLocaleString("ar-IQ")} د</span> : null}
          {store.distanceKm !== null ? <span className="text-[11px] font-semibold text-[var(--codiq-accent)]">{store.distanceKm.toLocaleString("ar-IQ")} كم</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {store.tier ? <TierChip tier={store.tier} /> : null}
          <MarkChips marks={store.marks} />
        </div>
      </div>
    </Link>
  );
}

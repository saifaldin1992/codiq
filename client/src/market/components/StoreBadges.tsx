/** Badge icons, tier colours and the small chips a store card carries. Colours are theme tokens only. */
import { BadgeCheck, Crown, Flame, Gauge, HeartHandshake, Megaphone, Repeat2, ShieldCheck, Sparkles, Star, Trophy, type LucideIcon } from "lucide-react";
import type { BadgeCode, GrantedMark, MarketTier } from "../market-types";
import { TIER_LABELS } from "../market-types";

export const BADGE_ICONS: Record<BadgeCode, LucideIcon> = {
  verified: BadgeCheck,
  brand: Crown,
  ambassador: Trophy,
  boosted: Megaphone,
  new_store: Sparkles,
  fast_response: Gauge,
  low_cancellation: ShieldCheck,
  high_rating: Star,
  repeat_customers: Repeat2,
  top_seller: Flame,
};

export const TIER_CLASSES: Record<MarketTier, string> = {
  bronze: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]",
  silver: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]",
  gold: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-rating)]",
  platinum: "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]",
};

export function TierChip({ tier, prefix = "متجر" }: { tier: MarketTier; prefix?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${TIER_CLASSES[tier]}`} data-testid="market-tier-chip">
      <HeartHandshake className="h-3 w-3" /> {prefix} {TIER_LABELS[tier]}
    </span>
  );
}

const MARK_LABELS: Record<GrantedMark, string> = { verified: "موثّق", brand: "علامة تجاريّة", ambassador: "سفير", boosted: "مُروَّج", new_store: "جديد" };

export function MarkChips({ marks, limit = 3 }: { marks: GrantedMark[]; limit?: number }) {
  const shown = marks.filter((mark) => mark !== "verified").slice(0, limit);
  if (!shown.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((mark) => {
        const Icon = BADGE_ICONS[mark];
        return (
          <span key={mark} className="inline-flex items-center gap-0.5 rounded-full bg-[var(--codiq-surface-sunken)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--codiq-text-secondary)]">
            <Icon className="h-3 w-3 text-[var(--codiq-accent)]" /> {MARK_LABELS[mark]}
          </span>
        );
      })}
    </span>
  );
}

export function RatingInline({ rating, count }: { rating: number | null; count: number }) {
  if (rating === null || count === 0) return <span className="text-[11px] text-[var(--codiq-text-muted)]">لا تقييمات بعد</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--codiq-text-secondary)]">
      <Star className="h-3.5 w-3.5 fill-[var(--codiq-rating)] text-[var(--codiq-rating)]" />
      {rating.toLocaleString("ar-IQ", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} <span className="font-normal text-[var(--codiq-text-muted)]">({count.toLocaleString("ar-IQ")})</span>
    </span>
  );
}

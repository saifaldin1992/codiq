/** Marketplace M7: the heart on a product and «متابعة» on a store. Signed-out taps go to sign-in. */
import { useState } from "react";
import { useLocation } from "wouter";
import { Heart, UserCheck, UserPlus } from "lucide-react";
import { useShopper } from "../market-shopper";
import { toggleFavourite, toggleFollow, useIsFavourite, useIsFollowing } from "../market-favourites";

export function FavouriteHeart({ productId, className = "" }: { productId: string; className?: string }) {
  const { shopper } = useShopper();
  const [, navigate] = useLocation();
  const on = useIsFavourite(productId);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "إزالة من المفضّلة" : "إضافة إلى المفضّلة"}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!shopper) { navigate("/account"); return; } void toggleFavourite(productId, !on).catch(() => undefined); }}
      className={`flex h-8 w-8 items-center justify-center rounded-full bg-[var(--codiq-surface)] shadow-sm ${className}`}
      data-testid={`market-favourite-${productId}`}
    >
      <Heart className={`h-4 w-4 ${on ? "fill-[var(--codiq-danger)] text-[var(--codiq-danger)]" : "text-[var(--codiq-text-secondary)]"}`} />
    </button>
  );
}

export function FollowStoreButton({ storeSlug }: { storeSlug: string }) {
  const { shopper } = useShopper();
  const [, navigate] = useLocation();
  const on = useIsFollowing(storeSlug);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={busy}
      onClick={() => { if (!shopper) { navigate("/account"); return; } setBusy(true); void toggleFollow(storeSlug, !on).catch(() => undefined).finally(() => setBusy(false)); }}
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold ${on ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]"}`}
      data-testid="market-store-follow"
    >
      {on ? <UserCheck className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />} {on ? "تتابعه" : "متابعة"}
    </button>
  );
}

/**
 * CD-2 — the ♥ on a product page.
 *
 * Saving and asking-to-be-paged are separate acts, so this button only SAVES.
 * The restock alert is offered on the wishlist page, where the shopper can see
 * what he is agreeing to; a heart that also signed him up for mail would be a
 * consent nobody gave.
 *
 * It reflects real state rather than guessing: the current wishlist is read on
 * mount, so a product already saved shows as saved instead of inviting him to
 * save it twice.
 */
import { useEffect, useState } from "react";
import { Heart, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { storefrontApi } from "@/lib/storefront-api";

export function WishlistButton({
  slug,
  productId,
  variantId,
  inStock,
  signedIn,
}: {
  slug: string;
  productId: string;
  variantId: string | null;
  inStock: boolean;
  signedIn: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn || !variantId) return;
    let alive = true;
    void storefrontApi
      .wishlist(slug)
      .then((data) => {
        if (alive) setSaved(data.items.some((item) => item.variantId === variantId));
      })
      .catch(() => {
        /* a wishlist that failed to load must not block buying */
      });
    return () => {
      alive = false;
    };
  }, [slug, variantId, signedIn]);

  if (!signedIn || !variantId) return null;

  async function toggle() {
    setBusy(true);
    try {
      if (saved) {
        await storefrontApi.removeFromWishlist(slug, variantId!);
        setSaved(false);
      } else {
        await storefrontApi.addToWishlist(slug, { variantId: variantId! });
        setSaved(true);
      }
    } catch {
      /* the storefront shell surfaces nothing here — the heart simply does not move */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      onClick={() => void toggle()}
      aria-pressed={saved}
      aria-label={saved ? "احذف من قائمة رغباتي" : "احفظ في قائمة رغباتي"}
      className="rounded-xl"
      title={inStock ? undefined : "احفظه الآن، ويمكنك طلب تنبيه عند التوفر من قائمة رغباتك"}
    >
      {busy ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <Heart
          className={`h-4 w-4 ${saved ? "fill-[var(--codiq-favourite)] text-[var(--codiq-favourite)]" : ""}`}
        />
      )}
    </Button>
  );
}

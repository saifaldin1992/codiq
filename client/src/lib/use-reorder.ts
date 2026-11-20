/**
 * codiq CD-1c — «اطلبه مجدداً» shared behavior for the two history surfaces
 * (the orders list rows and the order detail page).
 *
 * The server never partially fails a reorder: it adds what it can and returns
 * an honest `skipped` list. This hook mirrors that honesty in the UI —
 *
 *   • something was added  → go to the cart, carrying a notice that names every
 *                            skipped line and why;
 *   • nothing was added    → stay put and surface the same honest notice
 *                            inline, because navigating to a cart that did not
 *                            change (or is empty) would read as a success.
 */
import { useCallback, useState } from "react";
import { useLocation } from "wouter";
import { useStorefront } from "@/components/StorefrontProvider";
import { errorMessage, reorderSkippedNotice, storefrontApi } from "@/lib/storefront-api";

export function useReorder() {
  const { slug, cart, setCart, setNotice } = useStorefront();
  const [, navigate] = useLocation();
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);

  const reorder = useCallback(async (orderId: string) => {
    if (pendingOrderId) return;
    setPendingOrderId(orderId);
    setInlineNotice(null);
    try {
      const result = await storefrontApi.reorder(slug, orderId);
      setCart(result.cart);
      // The server reports exactly how many lines landed — inferring it from a
      // version delta misreads a stale local cart and the all-capped case.
      const added = result.addedCount > 0;
      const skippedNotice = reorderSkippedNotice(result.skipped);
      if (added) {
        setNotice(skippedNotice ? `أضفنا منتجات الطلب المتاحة إلى سلتك. ${skippedNotice}` : "أضفنا منتجات الطلب إلى سلتك.");
        navigate(`/store/${slug}/cart`);
        return;
      }
      setInlineNotice(skippedNotice || "لم تتغير سلتك.");
    } catch (error) {
      setInlineNotice(errorMessage(error));
    } finally {
      setPendingOrderId(null);
    }
  }, [cart, navigate, pendingOrderId, setCart, setNotice, slug]);

  return { reorder, pendingOrderId, inlineNotice };
}

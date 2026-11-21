/**
 * CD-2 «قائمة رغباتي» — the shopper's saved variants.
 *
 * Two states live on every row and they are not the same thing: the item is
 * SAVED, and separately the shopper has asked to be PAGED when it returns.
 * Saving is private and costs nothing; asking to be paged is consent to be
 * mailed. The screen keeps them apart so a heart never quietly signs anyone up.
 *
 * And the alert is honest about being one-shot: once it is sent the request is
 * spent, and the row says so rather than letting him assume a standing watch.
 */
import { useCallback, useEffect, useState } from "react";
import { LoadMoreButton } from "@/components/LoadMoreButton";
import { Link } from "wouter";
import { BellRing, CircleAlert, Heart, LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStorefront } from "@/components/StorefrontProvider";
import { storefrontApi } from "@/lib/storefront-api";

type Item = {
  id: string;
  productId: string;
  productName: string;
  variantId: string;
  variantName: string | null;
  sku: string;
  priceIqd: number;
  inStock: boolean;
  notifyOnRestock: boolean;
};

const money = new Intl.NumberFormat("ar-IQ");

export default function CustomerWishlistPage() {
  const { slug, customer, loading } = useStorefront();
  const [items, setItems] = useState<Item[] | null>(null);
  // 20-2: the list is a keyset page now — a shopper who has been saving things
  // for months could not reach the ones he saved first.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) setLoadingMore(true);
      try {
        const data = await storefrontApi.wishlist(slug, cursor);
        setItems((current) => (cursor ? [...(current ?? []), ...data.items] : data.items));
        setNextCursor(data.nextCursor);
        setFailure(null);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "تعذر تحميل قائمتك.");
      } finally {
        setLoadingMore(false);
      }
    },
    [slug]
  );
  useEffect(() => {
    if (customer) void load();
  }, [customer, load]);

  async function remove(item: Item) {
    setBusyId(item.variantId);
    try {
      await storefrontApi.removeFromWishlist(slug, item.variantId);
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر الحذف.");
    } finally {
      setBusyId(null);
    }
  }

  async function setNotify(item: Item, notifyOnRestock: boolean) {
    setBusyId(item.variantId);
    try {
      await storefrontApi.addToWishlist(slug, { variantId: item.variantId, notifyOnRestock });
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر الحفظ.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading)
    return (
      <p className="text-sm text-[var(--storefront-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> لحظة…
      </p>
    );
  if (!customer) {
    return (
      <section className="space-y-3">
        <h1 className="text-lg font-black text-[var(--storefront-text)]">قائمة رغباتي</h1>
        <p className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-5 text-sm text-[var(--storefront-muted)]">
          سجّل الدخول لترى ما حفظته.{" "}
          <Link
            href={`/store/${slug}/account/login`}
            className="font-bold text-[var(--storefront-accent)] hover:underline"
          >
            تسجيل الدخول
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <h1 className="flex items-center gap-2 text-lg font-black text-[var(--storefront-text)]">
        <Heart className="h-5 w-5" /> قائمة رغباتي
      </h1>
      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {!items ? (
        <p className="text-sm text-[var(--storefront-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {items && items.length === 0 ? (
        <p className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-6 text-center text-sm text-[var(--storefront-muted)]">
          قائمتك فارغة. اضغط ♥ على أي منتج لحفظه هنا.
        </p>
      ) : null}

      <ul className="space-y-2">
        {(items ?? []).map((item) => (
          <li key={item.id} className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href={`/store/${slug}/products/${item.productId}`}
                  className="truncate text-sm font-bold text-[var(--storefront-text)] hover:underline"
                >
                  {item.productName}
                  {item.variantName ? (
                    <span className="text-[var(--storefront-muted)]"> — {item.variantName}</span>
                  ) : null}
                </Link>
                <p className="mt-0.5 text-xs text-[var(--storefront-muted)]">
                  {money.format(item.priceIqd)} د.ع ·{" "}
                  {item.inStock ? (
                    <span className="font-bold text-[var(--codiq-success)]">متوفر</span>
                  ) : (
                    <span className="font-bold text-[var(--codiq-danger)]">غير متوفر حالياً</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === item.variantId}
                  onClick={() => void remove(item)}
                  className="rounded-xl text-[var(--codiq-text-secondary)]"
                  aria-label={`احذف ${item.productName} من قائمتي`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* The alert only makes sense while the shelf is empty. Offering it on
                something in stock would be offering to tell him what he can see. */}
            {!item.inStock ? (
              <label className="mt-2 flex items-center gap-2 border-t border-[var(--storefront-border)] pt-2 text-[13px] font-semibold text-[var(--storefront-text)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--storefront-accent)]"
                  checked={item.notifyOnRestock}
                  disabled={busyId === item.variantId}
                  onChange={(event) => void setNotify(item, event.target.checked)}
                />
                <BellRing className="h-4 w-4 text-[var(--storefront-accent)]" aria-hidden="true" />
                نبّهني عند التوفر
                <span className="text-[11px] font-normal text-[var(--storefront-muted)]">
                  — رسالة واحدة، ثم يُغلق الطلب
                </span>
              </label>
            ) : null}
          </li>
        ))}
      </ul>
      <LoadMoreButton
        tone="storefront"
        cursor={nextCursor}
        busy={loadingMore}
        onLoad={(cursor) => void load(cursor)}
        testId="wishlist-more"
      />
    </section>
  );
}

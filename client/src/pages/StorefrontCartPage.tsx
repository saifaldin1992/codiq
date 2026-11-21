/**
 * ق-203 — the cart in the reference's arrangement: a line per product with
 * its picture, «ملخص الطلب» with honest lines (the delivery fee is not known
 * before an address is chosen, and the summary says so), and «إتمام الطلب» —
 * which a guest may press when the merchant allows buying without an account.
 */
import { Link, useLocation } from "wouter";
import { ArrowLeft, Minus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStorefront } from "@/components/StorefrontProvider";
import { EmptyState, ErrorState, LoadingState } from "@/components/StorefrontStates";
import { errorMessage, formatIqd, storefrontApi } from "@/lib/storefront-api";

export default function StorefrontCartPage() {
  const { slug, cart, customer, config, loading, notice, setCart, setNotice, refreshCart } =
    useStorefront();
  const [, navigate] = useLocation();
  async function change(itemId: string, quantity: number) {
    if (quantity < 1) return;
    try {
      const data = await storefrontApi.updateCartItem(slug, itemId, quantity);
      setCart(data.cart);
    } catch (error) {
      setNotice(errorMessage(error));
      await refreshCart();
    }
  }
  async function remove(itemId: string) {
    try {
      await storefrontApi.removeCartItem(slug, itemId);
      await refreshCart();
      setNotice("تم حذف المنتج من السلة.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }
  if (loading || !cart) return <LoadingState label="جارٍ تحميل السلة…" />;
  if (notice && !cart.items.length && cart.status !== "empty" && cart.status !== "expired")
    return <ErrorState message={notice} retry={() => void refreshCart()} />;
  if (!cart.items.length)
    return (
      <EmptyState
        title="سلتك فارغة"
        detail={
          cart.status === "expired"
            ? "انتهت صلاحية سلة الضيف. يمكنك البدء بسلة جديدة."
            : "أضف منتجاً من المتجر للبدء."
        }
        action={{ label: "تصفح المنتجات", onClick: () => navigate(`/store/${slug}/products`) }}
      />
    );
  const total = cart.items.reduce((sum, item) => sum + item.quantity * item.priceSnapshotIqd, 0);
  const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  // ق-201: a guest may check out when the merchant allows it; otherwise the
  // door is the sign-in page, with the way back to checkout kept.
  const guestAllowed = config?.guestCheckout ?? false;
  const canProceed = customer !== null || guestAllowed;
  const proceed = () =>
    navigate(
      canProceed
        ? `/store/${slug}/checkout`
        : `/store/${slug}/account/login?returnTo=${encodeURIComponent(`/store/${slug}/checkout`)}`
    );

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-bold text-[var(--storefront-accent)]">سلة الشراء</p>
        <h1 className="mt-1 text-2xl font-black text-[var(--storefront-text)] sm:text-3xl">
          راجع اختيارك
        </h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {cart.items.map((item) => (
            <article
              key={item.id}
              className="flex gap-4 rounded-[22px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-4"
            >
              <Link
                href={`/store/${slug}/products/${item.productId}`}
                className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl bg-[var(--storefront-accent-soft)] text-xs font-bold text-[var(--storefront-muted)]"
              >
                {item.product?.image ? (
                  <img
                    src={storefrontApi.imageUrl(
                      slug,
                      item.productId,
                      item.product.image.id,
                      "thumb"
                    )}
                    alt={item.product.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  "منتج"
                )}
              </Link>
              <div className="min-w-0 flex-1">
                <h2 className="font-black text-[var(--storefront-text)]">
                  <Link
                    href={`/store/${slug}/products/${item.productId}`}
                    className="hover:text-[var(--storefront-accent)]"
                  >
                    {item.product?.name ?? "منتج غير متاح"}
                  </Link>
                </h2>
                {item.variant && !item.variant.isDefault ? (
                  <p
                    data-testid="cart-line-variant"
                    className="mt-0.5 text-xs font-bold text-[var(--storefront-muted)]"
                  >
                    {item.variant.name}
                  </p>
                ) : null}
                <p className="mt-1 text-sm font-bold tabular-nums text-[var(--storefront-accent)]">
                  {formatIqd.format(item.priceSnapshotIqd)} د.ع
                </p>
                {!item.product?.isActive ? (
                  <p className="mt-1 text-xs font-bold text-[var(--codiq-danger)]">
                    لم يعد هذا المنتج متاحاً؛ احذفه من السلة قبل إتمام الطلب.
                  </p>
                ) : null}
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex items-center rounded-xl border border-[var(--storefront-border)]">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="إنقاص الكمية"
                      disabled={item.quantity <= 1}
                      onClick={() => void change(item.id, item.quantity - 1)}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <span className="w-9 text-center text-sm font-black">{item.quantity}</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="زيادة الكمية"
                      disabled={item.quantity >= 99}
                      onClick={() => void change(item.id, item.quantity + 1)}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-black tabular-nums text-[var(--storefront-text)]">
                      {formatIqd.format(item.priceSnapshotIqd * item.quantity)} د.ع
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`حذف ${item.product?.name ?? "المنتج"}`}
                      className="text-[var(--codiq-danger)]"
                      onClick={() => void remove(item.id)}
                    >
                      <Trash2 className="ml-1 h-4 w-4" />
                      حذف
                    </Button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
        <aside
          className="h-fit rounded-[26px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-6 shadow-sm"
          aria-labelledby="cart-summary-heading"
        >
          <h2
            id="cart-summary-heading"
            className="text-lg font-black text-[var(--storefront-text)]"
          >
            ملخص الطلب
          </h2>
          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--storefront-muted)]">مجموع المنتجات ({count})</dt>
              <dd className="font-bold tabular-nums">{formatIqd.format(total)} د.ع</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--storefront-muted)]">التوصيل</dt>
              <dd className="text-xs font-semibold text-[var(--storefront-muted)]">
                يُحسب حسب المحافظة عند إتمام الطلب
              </dd>
            </div>
            <div className="flex justify-between border-t border-[var(--storefront-border)] pt-3 text-base">
              <dt className="font-bold">الإجمالي قبل التوصيل</dt>
              <dd className="font-black tabular-nums text-[var(--storefront-accent)]">
                {formatIqd.format(total)} د.ع
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-6 text-[var(--storefront-muted)]">
            تُحجز الكميات ويُتحقق من الأسعار عند تأكيد الطلب، لا عند الإضافة إلى السلة.
          </p>
          <Button
            type="button"
            data-testid="cart-checkout"
            onClick={proceed}
            className="mt-5 h-12 w-full rounded-xl bg-[var(--storefront-accent)] font-black hover:bg-[var(--storefront-accent-hover)]"
          >
            {canProceed ? "إتمام الطلب" : "سجّل الدخول لإتمام الطلب"}
          </Button>
          {!customer && guestAllowed ? (
            <p className="mt-3 text-center text-xs text-[var(--storefront-muted)]">
              لا يلزم إنشاء حساب —{" "}
              <Link
                href={`/store/${slug}/account/login?returnTo=${encodeURIComponent(`/store/${slug}/checkout`)}`}
                className="font-bold text-[var(--storefront-accent)] hover:underline"
              >
                لديك حساب؟ سجّل الدخول
              </Link>
            </p>
          ) : null}
          <Link
            href={`/store/${slug}/products`}
            className="mt-4 flex items-center justify-center gap-1.5 text-sm font-bold text-[var(--storefront-muted)] hover:text-[var(--storefront-accent)]"
          >
            متابعة التسوق
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </aside>
      </div>
    </section>
  );
}

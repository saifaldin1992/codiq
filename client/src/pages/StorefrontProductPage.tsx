/**
 * ق-203 — the product page in the reference's arrangement: breadcrumb, a
 * gallery with thumbnails, the name with its star row, the price, whether it
 * is in stock, the variant picker, quantity, «أضف إلى السلة» and «اشتري
 * الآن», then «تفاصيل المنتج» with the merchant's typed attributes, the
 * evidence-based «يُشترى معه عادة», the same-category «عناصر قد تعجبك», and
 * the reviews.
 */
import { BoughtTogether } from "@/components/BoughtTogether";
import { WishlistButton } from "@/components/WishlistButton";
import { ProductReviews, Stars } from "@/components/ProductReviews";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { CheckCircle2, ChevronLeft, Minus, PackageX, Plus, ShoppingCart, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStorefront } from "@/components/StorefrontProvider";
import { isNewProduct } from "@/components/ProductCard";
import { ErrorState, LoadingState } from "@/components/StorefrontStates";
import { categoryPath } from "@/lib/category-tree";
import {
  errorMessage,
  formatIqd,
  ProductDetail,
  ProductVariantOption,
  RelatedProduct,
  storefrontApi,
} from "@/lib/storefront-api";
import { trackAddToCart } from "@/lib/storefront-pixels";

// Phase 20A: preselect the default variant when it is available, otherwise the
// first available variant, otherwise the default (page renders as sold out).
function initialVariantId(variants: ProductVariantOption[]) {
  if (variants.length <= 1) return null;
  const picked =
    variants.find((variant) => variant.isDefault && variant.isAvailable) ??
    variants.find((variant) => variant.isAvailable) ??
    variants.find((variant) => variant.isDefault) ??
    variants[0];
  return picked?.id ?? null;
}

const number = new Intl.NumberFormat("ar-IQ");

/** ق-200 «عناصر قد تعجبك» — siblings, with no evidence claimed (that is BoughtTogether's job). */
function RelatedRail({ slug, productId }: { slug: string; productId: string }) {
  const [items, setItems] = useState<RelatedProduct[]>([]);
  useEffect(() => {
    let alive = true;
    storefrontApi
      .related(slug, productId)
      .then((data) => {
        if (alive) setItems(data.related);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [slug, productId]);
  if (!items.length) return null;
  return (
    <section className="space-y-3" aria-labelledby="related-heading" data-testid="related-products">
      <h2 id="related-heading" className="text-lg font-black text-[var(--storefront-text)]">
        عناصر قد تعجبك
      </h2>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.productId}>
            <Link
              href={`/store/${slug}/products/${item.productId}`}
              className="block h-full rounded-2xl border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-3 transition hover:shadow-md"
            >
              <div className="grid aspect-square place-items-center overflow-hidden rounded-xl bg-[var(--storefront-accent-soft)]">
                {item.imageId ? (
                  <img
                    src={storefrontApi.imageUrl(slug, item.productId, item.imageId)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <p className="mt-2 line-clamp-2 text-center text-sm font-bold text-[var(--storefront-text)]">
                {item.name}
              </p>
              <p className="mt-0.5 text-center text-sm font-black tabular-nums text-[var(--storefront-accent)]">
                {formatIqd.format(item.priceIqd)} د.ع
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function StorefrontProductPage() {
  const { storeSlug, productId } = useParams<{ storeSlug: string; productId: string }>();
  const { setCart, setNotice, customer, categories } = useStorefront();
  const [, navigate] = useLocation();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [imageId, setImageId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cart" | "buy" | null>(null);
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await storefrontApi.product(storeSlug, productId);
      setProduct(data.product);
      setSelectedVariantId(initialVariantId(data.product.variants ?? []));
      setImageId(data.product.images[0]?.id ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [storeSlug, productId]);
  const variants = product?.variants ?? [];
  // With a single (default-only) variant no picker exists and every value below
  // falls back to the product-level fields. A lone non-default variant must be
  // sent explicitly: the server's legacy resolution requires an active default.
  const selectedVariant =
    variants.length > 1
      ? (variants.find((variant) => variant.id === selectedVariantId) ?? null)
      : variants[0] && !variants[0].isDefault
        ? variants[0]
        : null;
  // ق-203: options render for a SINGLE-variant product too — a perfume with one
  // size still has مقدمة/قلب/قاعدة typed on it, and until now they showed nowhere.
  const optionRows = useMemo(
    () =>
      Object.entries(
        ((selectedVariant ?? variants[0])?.options as Record<string, unknown> | undefined) ?? {}
      ).filter(([, value]) => value !== null && value !== "" && value !== undefined),
    [selectedVariant, variants]
  );
  const crumbs = useMemo(
    () => categoryPath(categories, product?.category?.id),
    [categories, product]
  );

  async function addToCart(): Promise<boolean> {
    if (!product) return false;
    try {
      const data = await storefrontApi.addCartItem(
        storeSlug,
        product.id,
        quantity,
        selectedVariant?.id
      );
      setCart(data.cart);
      trackAddToCart((selectedVariant?.priceIqd ?? product.priceIqd) * quantity);
      return true;
    } catch (caught) {
      setNotice(errorMessage(caught));
      return false;
    }
  }
  async function add() {
    setBusy("cart");
    try {
      if (await addToCart()) setNotice("تمت إضافة المنتج إلى السلة.");
    } finally {
      setBusy(null);
    }
  }
  // «اشتري الآن»: the same add, then straight to checkout — which itself
  // decides between a guest, a sign-in, and a saved address.
  async function buyNow() {
    setBusy("buy");
    try {
      if (await addToCart()) navigate(`/store/${storeSlug}/checkout`);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <LoadingState label="جارٍ تحميل المنتج…" />;
  if (error || !product)
    return <ErrorState message={error ?? "المنتج غير متاح."} retry={() => void load()} />;
  const shown = product.images.find((image) => image.id === imageId) ?? product.images[0];
  const displayPriceIqd = selectedVariant ? selectedVariant.priceIqd : product.priceIqd;
  const available = selectedVariant ? selectedVariant.isAvailable : product.isAvailable;
  const rating = product.rating ?? { average: null, count: 0 };
  const attributes = product.attributes ?? [];

  return (
    <>
      <section className="space-y-5">
        <nav
          aria-label="مسار التصفح"
          className="flex flex-wrap items-center gap-1 text-xs text-[var(--storefront-muted)]"
        >
          <Link href={`/store/${storeSlug}`} className="hover:text-[var(--storefront-accent)]">
            الرئيسية
          </Link>
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <Link
            href={`/store/${storeSlug}/products`}
            className="hover:text-[var(--storefront-accent)]"
          >
            المنتجات
          </Link>
          {crumbs.map((crumb) => (
            <span key={crumb.id} className="flex items-center gap-1">
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <Link
                href={`/store/${storeSlug}/categories/${crumb.id}`}
                className="hover:text-[var(--storefront-accent)]"
              >
                {crumb.name}
              </Link>
            </span>
          ))}
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="font-bold text-[var(--storefront-text)]">{product.name}</span>
        </nav>
        <div className="grid gap-7 rounded-[30px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-4 shadow-[0_16px_40px_rgba(30,45,69,.06)] md:grid-cols-2 md:p-7">
          <div className="space-y-3">
            <div className="relative aspect-square overflow-hidden rounded-[22px] bg-[var(--storefront-accent-soft)]">
              {shown ? (
                <img
                  src={storefrontApi.imageUrl(storeSlug, product.id, shown.id, "full")}
                  alt={product.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full place-items-center text-sm font-bold text-[var(--storefront-muted)]">
                  لا توجد صورة
                </div>
              )}
              {isNewProduct(product) ? (
                <span className="absolute right-3 top-3 rounded-full bg-[var(--storefront-accent)] px-3 py-1 text-xs font-bold text-white shadow">
                  جديد
                </span>
              ) : null}
            </div>
            {product.images.length > 1 ? (
              <ul className="flex gap-2 overflow-auto" aria-label="صور المنتج">
                {product.images.map((image) => (
                  <li key={image.id}>
                    <button
                      type="button"
                      aria-pressed={image.id === shown?.id}
                      onClick={() => setImageId(image.id)}
                      className={`block h-16 w-16 overflow-hidden rounded-xl border-2 ${image.id === shown?.id ? "border-[var(--storefront-accent)]" : "border-transparent"}`}
                    >
                      <img
                        src={storefrontApi.imageUrl(storeSlug, product.id, image.id, "thumb")}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="flex flex-col justify-center">
            {product.category ? (
              <Link
                href={`/store/${storeSlug}/categories/${product.category.id}`}
                className="text-sm font-bold text-[var(--storefront-accent)] hover:underline"
              >
                {product.category.name}
              </Link>
            ) : null}
            <h1 className="mt-2 text-2xl font-black text-[var(--storefront-text)] sm:text-3xl">
              {product.name}
            </h1>
            <div
              className="mt-2 flex items-center gap-2 text-xs text-[var(--storefront-muted)]"
              data-testid="product-rating"
            >
              <Stars
                rating={Math.round(rating.average ?? 0)}
                label={rating.average === null ? "لا تقييمات بعد" : `${rating.average} من 5`}
              />
              <span>
                {rating.count ? `(${number.format(rating.count)} تقييم)` : "لا تقييمات بعد"}
              </span>
            </div>
            {product.requiresPrescription ? (
              <span
                data-testid="prescription-badge"
                className="mt-3 inline-flex w-fit items-center rounded-full bg-violet-50 px-3 py-1.5 text-xs font-bold text-violet-800"
              >
                يتطلب وصفة طبية
              </span>
            ) : null}
            <p
              data-testid="product-price"
              className="mt-4 text-3xl font-black tabular-nums text-[var(--storefront-accent)]"
            >
              {formatIqd.format(displayPriceIqd)} <span className="text-sm">د.ع</span>
            </p>
            <p
              role="status"
              data-testid="product-availability"
              className={`mt-2 inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${available ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-amber-50 text-amber-800"}`}
            >
              {available ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  متوفر
                </>
              ) : (
                <>
                  <PackageX className="h-3.5 w-3.5" />
                  نفد المخزون حالياً
                </>
              )}
            </p>
            {product.requiresPrescription ? (
              <p className="mt-3 rounded-2xl bg-violet-50 p-3 text-xs leading-6 text-violet-900">
                هذا المنتج يتطلب وصفة طبية: بعد إنشاء الطلب سيُطلب منك رفع صورة الوصفة من صفحة
                الطلب، ولن يبدأ المتجر بمعالجته قبل اعتمادها.
              </p>
            ) : null}
            {variants.length > 1 ? (
              <div data-testid="variant-picker" className="mt-6">
                <p className="text-sm font-bold text-[var(--storefront-text)]">اختر المتغير</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {variants.map((variant) => {
                    const selected = variant.id === selectedVariantId;
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        data-testid={`variant-option-${variant.sku}`}
                        aria-pressed={selected}
                        disabled={!variant.isAvailable}
                        onClick={() => setSelectedVariantId(variant.id)}
                        className={`rounded-xl border px-3.5 py-2 text-right text-sm font-bold transition ${selected ? "border-[var(--storefront-accent)] bg-[var(--storefront-accent-soft)] text-[var(--storefront-accent)]" : "border-[var(--storefront-border)] bg-[var(--storefront-canvas)] text-[var(--storefront-text)]"} ${!variant.isAvailable ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <span>{variant.name}</span>
                        <span className="mr-2 text-xs font-black">
                          {formatIqd.format(variant.priceIqd)} د.ع
                        </span>
                        {!variant.isAvailable ? (
                          <span className="mr-2 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                            نفد
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <div className="flex items-center rounded-xl border border-[var(--storefront-border)] bg-[var(--storefront-canvas)]">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="إنقاص الكمية"
                  disabled={quantity <= 1 || !available}
                  onClick={() => setQuantity((value) => value - 1)}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span aria-live="polite" className="w-10 text-center font-black">
                  {quantity}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="زيادة الكمية"
                  disabled={quantity >= 99 || !available}
                  onClick={() => setQuantity((value) => value + 1)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <WishlistButton
                slug={storeSlug}
                productId={product.id}
                variantId={selectedVariant?.id ?? variants[0]?.id ?? null}
                inStock={available}
                signedIn={customer !== null}
              />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                disabled={busy !== null || !available}
                onClick={() => void add()}
                className="h-12 rounded-xl bg-[var(--storefront-accent)] font-bold hover:bg-[var(--storefront-accent-hover)]"
              >
                <ShoppingCart className="ml-2 h-4 w-4" />
                {!available ? "نفد المخزون" : busy === "cart" ? "جارٍ الإضافة…" : "أضف إلى السلة"}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="buy-now"
                disabled={busy !== null || !available}
                onClick={() => void buyNow()}
                className="h-12 rounded-xl border-[var(--storefront-accent)] font-bold text-[var(--storefront-accent)] hover:bg-[var(--storefront-accent-soft)]"
              >
                <Zap className="ml-2 h-4 w-4" />
                {busy === "buy" ? "جارٍ التحويل…" : "اشتري الآن"}
              </Button>
            </div>
            <p className="mt-3 text-xs text-[var(--storefront-muted)]">
              يُحفظ السعر في السلة عند الإضافة ويجري التحقق النهائي عند تأكيد الطلب.
            </p>
          </div>
        </div>
        <section
          className="rounded-[26px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-5 sm:p-7"
          aria-labelledby="details-heading"
          data-testid="product-details"
        >
          <h2 id="details-heading" className="text-lg font-black text-[var(--storefront-text)]">
            تفاصيل المنتج
          </h2>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-8 text-[var(--storefront-muted)]">
            {product.description || "لا يوجد وصف إضافي لهذا المنتج."}
          </p>
          {attributes.length || optionRows.length ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {attributes.map((group) => (
                <dl key={group.group} className="rounded-2xl bg-[var(--storefront-canvas)] p-4">
                  <dt className="text-sm font-black text-[var(--storefront-text)]">
                    {group.group}
                  </dt>
                  {group.rows.map((row) => (
                    <div key={row.key} className="mt-2 flex justify-between gap-3 text-sm">
                      <span className="text-[var(--storefront-muted)]">{row.key}</span>
                      <dd className="font-semibold text-[var(--storefront-text)]">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              ))}
              {optionRows.length ? (
                <dl className="rounded-2xl bg-[var(--storefront-canvas)] p-4">
                  <dt className="text-sm font-black text-[var(--storefront-text)]">
                    {selectedVariant?.name ?? variants[0]?.name ?? "المواصفات"}
                  </dt>
                  {optionRows.map(([key, value]) => (
                    <div key={key} className="mt-2 flex justify-between gap-3 text-sm">
                      <span className="text-[var(--storefront-muted)]">{key}</span>
                      <dd className="font-semibold text-[var(--storefront-text)]">
                        {String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          ) : null}
        </section>
      </section>
      <div className="mt-8">
        <BoughtTogether slug={storeSlug} productId={product.id} />
      </div>
      <div className="mt-8">
        <RelatedRail slug={storeSlug} productId={product.id} />
      </div>
      <div className="mt-8">
        <ProductReviews slug={storeSlug} productId={product.id} signedIn={customer !== null} />
      </div>
    </>
  );
}

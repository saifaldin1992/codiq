/**
 * One product in the market: gallery (swipe, tap to enlarge), price and the
 * price before, badges, pre-order dates, options, add-ons, the per-order cap,
 * description, specifications, the store, and two shelves (similar, more from
 * the store). Buying happens in the store's own checkout until the unified
 * cart (M5); the button goes there.
 */
import { FavouriteHeart } from "../components/FavouriteButtons";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { BadgeCheck, CalendarClock, ChevronLeft, CircleAlert, CircleCheck, Flame, LoaderCircle, Minus, Package, Plus, Share2, ShieldCheck, ShoppingBag, Star, Store, X } from "lucide-react";
import { marketGet, MarketApiError } from "../market-api";
import { CONDITION_LABELS, iqd, rememberProduct, TAG_LABELS, type MarketProductDetail } from "../market-products";
import { queryString } from "../use-market-list";
import { ProductShelf } from "../components/ProductShelf";
import { DeliveryToMe } from "../components/DeliveryToMe";
import { useShopper } from "../market-shopper";
import { cartWrite } from "../market-cart";
import { MarketEmptyState } from "../MarketEmptyState";

const day = (value: string | null) => (value ? new Date(`${value}T00:00:00Z`).toLocaleDateString("ar-IQ", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : null);

export function MarketProductPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [product, setProduct] = useState<MarketProductDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [addFailure, setAddFailure] = useState<string | null>(null);
  const { shopper } = useShopper();
  const [, navigate] = useLocation();

  useEffect(() => {
    const controller = new AbortController();
    setProduct(null); setMissing(false); setFailure(null); setVariantId(null); setExpanded(false); setAddonIds([]); setQuantity(1); setAdded(null); setAddFailure(null);
    marketGet<{ product: MarketProductDetail }>(`/api/market/products/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((body) => { setProduct(body.product); setVariantId(body.product.variants[0]?.id ?? null); rememberProduct(body.product.id); window.scrollTo(0, 0); })
      .catch((error: Error) => { if (error.name === "AbortError") return; if (error instanceof MarketApiError && error.status === 404) setMissing(true); else setFailure(error.message); });
    return () => controller.abort();
  }, [id]);

  const similarUrl = useMemo(() => (product?.category ? `/api/market/products?${queryString({ category: product.category.slug, exclude: product.id, limit: 10 })}` : null), [product]);
  const storeUrl = useMemo(() => (product ? `/api/market/products?${queryString({ store: product.store.slug, exclude: product.id, sort: "recommended", limit: 10 })}` : null), [product]);

  if (missing) return <MarketEmptyState testId="market-product-missing" icon={Package} title="المنتج غير متوفّر" body="يبدو أنّ المتجر أزال هذا المنتج أو أوقف بيعه مؤقتاً." action={<Link href="/" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">تصفّح منتجات أخرى</Link>} />;
  if (failure) return <p className="py-10 text-center text-sm text-[var(--codiq-danger)]">{failure}</p>;
  if (!product) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;

  const variant = product.variants.find((row) => row.id === variantId) ?? product.variants[0];
  const price = variant?.priceIqd ?? product.priceIqd;
  const compare = product.compareAtPriceIqd && product.compareAtPriceIqd > price ? product.compareAtPriceIqd : null;
  const discount = compare ? Math.round(((compare - price) / compare) * 100) : 0;
  const images = product.images.length ? product.images : product.imageUrl ? [product.imageUrl] : [];
  const long = (product.description?.length ?? 0) > 240;
  const addonsTotal = product.addons.filter((addon) => addonIds.includes(addon.id)).reduce((sum, addon) => sum + addon.priceIqd, 0);
  const maxQuantity = Math.min(99, product.maxPerOrder ?? 99);
  const addToCart = async () => {
    if (!shopper) { navigate("/account"); return; }
    if (!variant) return;
    setAdding(true); setAddFailure(null); setAdded(null);
    try {
      await cartWrite("/api/market/cart/items", { method: "POST", body: JSON.stringify({ variantId: variant.id, quantity, addonIds }) });
      setAdded("تمت الإضافة إلى السلة");
    } catch (error) { setAddFailure((error as Error).message); } finally { setAdding(false); }
  };

  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: product.name, url: window.location.href });
      else { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    } catch { /* closed */ }
  };

  return (
    <div className="space-y-5" data-testid="market-product-page">
      {product.category ? (
        <nav className="flex items-center gap-1 text-xs" aria-label="المسار">
          <Link href="/categories" className="font-semibold text-[var(--codiq-accent)]">الفئات</Link><ChevronLeft className="h-3 w-3 text-[var(--codiq-text-muted)]" />
          <Link href={`/c/${product.category.slug}`} className="font-semibold text-[var(--codiq-accent)]">{product.category.name}</Link>
        </nav>
      ) : null}

      <div className="relative -mx-4">
        <div className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none]" data-testid="market-product-gallery">
          {images.length ? images.map((src, index) => (
            <button key={src} type="button" onClick={() => setZoom(src)} className="aspect-square w-full shrink-0 snap-center bg-[var(--codiq-surface-sunken)]" aria-label={`صورة ${index + 1}`}>
              <img src={src} alt="" className="h-full w-full object-contain" loading={index ? "lazy" : "eager"} />
            </button>
          )) : <div className="flex aspect-square w-full items-center justify-center bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-muted)]"><Package className="h-12 w-12" /></div>}
        </div>
        {images.length > 1 ? <span className="absolute bottom-3 left-3 rounded-full bg-[var(--codiq-surface)]/90 px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-text)]">{images.length.toLocaleString("ar-IQ")} صور</span> : null}
        <button type="button" onClick={() => void share()} aria-label="مشاركة" className="absolute left-3 top-3 rounded-full bg-[var(--codiq-surface)] p-2 shadow" data-testid="market-product-share"><Share2 className="h-4 w-4" /></button>
        {copied ? <span className="absolute left-14 top-4 rounded-full bg-[var(--codiq-surface)] px-2 py-1 text-[11px] font-bold text-[var(--codiq-success)]">نُسخ الرابط</span> : null}
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {product.isPreorder ? <Chip tone="accent"><CalendarClock className="h-3 w-3" /> طلب مسبق</Chip> : null}
          {product.sellsFast ? <Chip tone="warning"><Flame className="h-3 w-3" /> ينفد بسرعة</Chip> : null}
          {product.condition !== "new" ? <Chip tone="neutral">{CONDITION_LABELS[product.condition]}</Chip> : null}
          {product.tags.map((tag) => <Chip key={tag} tone="success"><ShieldCheck className="h-3 w-3" /> {TAG_LABELS[tag] ?? tag}</Chip>)}
        </div>
        <div className="flex items-start justify-between gap-2"><h1 className="text-lg font-black leading-7 text-[var(--codiq-text)]" data-testid="market-product-name">{product.name}</h1><FavouriteHeart productId={product.id} className="shrink-0" /></div>
        <div className="flex flex-wrap items-baseline gap-2" data-testid="market-product-price">
          <span className="text-2xl font-black text-[var(--codiq-text)]">{iqd(price)}</span>
          {compare ? <><span className="text-sm text-[var(--codiq-text-muted)] line-through">{iqd(compare)}</span><span className="rounded-full bg-[var(--codiq-danger-soft)] px-2 py-0.5 text-xs font-black text-[var(--codiq-danger)]">خصم {discount.toLocaleString("ar-IQ")}%</span></> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--codiq-text-secondary)]">
          {product.rating !== null ? <span className="inline-flex items-center gap-1"><Star className="h-4 w-4 fill-[var(--codiq-rating)] text-[var(--codiq-rating)]" /> {product.rating.toLocaleString("ar-IQ", { maximumFractionDigits: 1 })} ({product.ratingCount.toLocaleString("ar-IQ")} تقييم)</span> : <span>لا تقييمات بعد</span>}
          {product.productScore !== null ? <span className="font-bold text-[var(--codiq-accent)]">تقييم المنتج {product.productScore.toLocaleString("ar-IQ")} من ١٠٠</span> : null}
          {product.sold30d > 0 ? <span>بيع {product.sold30d.toLocaleString("ar-IQ")} هذا الشهر</span> : null}
        </div>
        {product.preorder ? (
          <div className="rounded-2xl bg-[var(--codiq-accent-soft)] px-3 py-2 text-xs leading-6 text-[var(--codiq-accent)]" data-testid="market-product-preorder">
            احجزه الآن قبل وصول الشحنة.{product.preorder.releaseOn ? ` يصدر في ${day(product.preorder.releaseOn)}.` : ""}{product.preorder.shipsBy ? ` يُشحن بحلول ${day(product.preorder.shipsBy)}.` : ""}
          </div>
        ) : null}
      </section>

      {product.variants.length > 1 ? (
        <section className="space-y-2" data-testid="market-product-variants">
          <h2 className="text-sm font-black text-[var(--codiq-text)]">الخيارات</h2>
          <div className="flex flex-wrap gap-2">
            {product.variants.map((row) => (
              <button key={row.id} type="button" onClick={() => setVariantId(row.id)} aria-pressed={row.id === variant?.id} disabled={!row.isAvailable && !product.isPreorder}
                className={`rounded-xl border px-3 py-2 text-xs font-bold disabled:opacity-40 ${row.id === variant?.id ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "border-[var(--codiq-border)] text-[var(--codiq-text)]"}`}>
                {row.name}{!row.isAvailable ? " · نفد" : ""}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {product.addons.length ? (
        <section className="space-y-2" data-testid="market-product-addons">
          <h2 className="text-sm font-black text-[var(--codiq-text)]">إضافات اختياريّة</h2>
          <ul className="space-y-1.5">{product.addons.map((addon) => (
            <li key={addon.id}>
              <label className="flex cursor-pointer items-center justify-between gap-2 rounded-xl bg-[var(--codiq-surface)] px-3 py-2 text-xs shadow-sm">
                <span className="flex items-center gap-2 text-[var(--codiq-text)]"><input type="checkbox" checked={addonIds.includes(addon.id)} onChange={(event) => setAddonIds(event.target.checked ? [...addonIds, addon.id] : addonIds.filter((id) => id !== addon.id))} data-testid={`market-product-addon-${addon.id}`} /> {addon.name}</span>
                <span className="font-bold text-[var(--codiq-text)]">+ {iqd(addon.priceIqd)}</span>
              </label>
            </li>
          ))}</ul>
        </section>
      ) : null}

      <div className="sticky bottom-20 z-10 space-y-2 rounded-[24px] bg-[var(--codiq-surface)] p-3 shadow-lg" data-testid="market-product-buy-box">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-[var(--codiq-border)] px-1">
            <button type="button" aria-label="زيادة" disabled={quantity >= maxQuantity} onClick={() => setQuantity(quantity + 1)} className="p-2 disabled:opacity-30" data-testid="market-product-plus"><Plus className="h-4 w-4" /></button>
            <span className="min-w-6 text-center text-sm font-black" data-testid="market-product-quantity">{quantity.toLocaleString("ar-IQ")}</span>
            <button type="button" aria-label="إنقاص" disabled={quantity <= 1} onClick={() => setQuantity(quantity - 1)} className="p-2 disabled:opacity-30"><Minus className="h-4 w-4" /></button>
          </div>
          <button type="button" onClick={() => void addToCart()} disabled={!product.isAvailable || adding} className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-black text-[var(--codiq-surface)] disabled:bg-[var(--codiq-neutral-soft)] disabled:text-[var(--codiq-text-muted)]" data-testid="market-product-add">
            {adding ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShoppingBag className="h-4 w-4" />} {product.isAvailable ? `${product.isPreorder ? "احجز" : "أضف إلى السلة"} · ${iqd((price + addonsTotal) * quantity)}` : "غير متوفّر حالياً"}
          </button>
        </div>
        {added ? <p className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--codiq-success)]" data-testid="market-product-added"><span className="flex items-center gap-1"><CircleCheck className="h-4 w-4" /> {added}</span><Link href="/cart" className="font-bold text-[var(--codiq-accent)]">افتح السلة</Link></p> : null}
        {addFailure ? <p className="flex items-center gap-1 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-product-add-error"><CircleAlert className="h-4 w-4" /> {addFailure}</p> : null}
        {!shopper && product.isAvailable ? <p className="text-center text-[11px] text-[var(--codiq-text-muted)]">ستُطلب منك رقم هاتفك لحفظ السلة.</p> : null}
        {product.maxPerOrder ? <p className="text-center text-[11px] text-[var(--codiq-text-muted)]" data-testid="market-product-limit">الحدّ الأقصى {product.maxPerOrder.toLocaleString("ar-IQ")} لكل طلب</p> : null}
        <a href={product.storefrontPath} className="block text-center text-[11px] font-semibold text-[var(--codiq-text-muted)] underline" data-testid="market-product-buy">أو تسوّق من صفحة المتجر</a>
      </div>

      <DeliveryToMe storeSlug={product.store.slug} />

      <Link href={`/s/${encodeURIComponent(product.store.slug)}`} className="flex items-center justify-between rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-product-store">
        <span className="flex items-center gap-2 text-sm font-bold text-[var(--codiq-text)]"><Store className="h-5 w-5 text-[var(--codiq-accent)]" /> {product.store.name}{product.store.verified ? <BadgeCheck className="h-4 w-4 text-[var(--codiq-accent)]" /> : null}</span>
        <span className="flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]">زيارة المتجر <ChevronLeft className="h-4 w-4" /></span>
      </Link>

      {product.description ? (
        <section className="space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm">
          <h2 className="text-sm font-black text-[var(--codiq-text)]">الوصف</h2>
          <p className={`whitespace-pre-line text-sm leading-7 text-[var(--codiq-text-secondary)] ${long && !expanded ? "line-clamp-5" : ""}`}>{product.description}</p>
          {long ? <button type="button" onClick={() => setExpanded((value) => !value)} className="text-xs font-bold text-[var(--codiq-accent)]">{expanded ? "عرض أقل" : "عرض المزيد"}</button> : null}
        </section>
      ) : null}

      {product.specs.length ? (
        <section className="space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-product-specs">
          <h2 className="text-sm font-black text-[var(--codiq-text)]">المواصفات</h2>
          <dl className="divide-y divide-[var(--codiq-border)] text-xs">
            {product.specs.map((spec) => <div key={`${spec.name}:${spec.value}`} className="flex justify-between gap-4 py-2"><dt className="text-[var(--codiq-text-muted)]">{spec.name}</dt><dd className="text-left font-semibold text-[var(--codiq-text)]">{spec.value}</dd></div>)}
          </dl>
        </section>
      ) : null}

      <ProductShelf testId="market-product-similar" title="منتجات مشابهة" url={similarUrl} />
      <ProductShelf testId="market-product-more-from-store" title={`المزيد من ${product.store.name}`} url={storeUrl} />

      {zoom ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--codiq-text)]" role="dialog" aria-modal="true" aria-label="تكبير الصورة" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" className="max-h-full max-w-full object-contain" />
          <button type="button" aria-label="إغلاق" className="absolute left-4 top-4 rounded-full bg-[var(--codiq-surface)] p-2"><X className="h-5 w-5" /></button>
        </div>
      ) : null}
    </div>
  );
}

function Chip({ tone, children }: { tone: "accent" | "warning" | "success" | "neutral"; children: React.ReactNode }) {
  const classes = { accent: "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]", warning: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]", success: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]", neutral: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]" }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${classes}`}>{children}</span>;
}

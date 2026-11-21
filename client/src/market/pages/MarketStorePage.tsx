/**
 * One store in the market: cover and identity, reputation, badges (with the
 * full catalog in a sheet — earned and not yet), opening hours with «مفتوح
 * الآن», how to pay, where it is, its newest products, and its reviews.
 * Shopping itself still happens in the store's own storefront until the
 * unified cart (M5); the page links there.
 */
import { FollowStoreButton } from "../components/FavouriteButtons";
import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { BadgeCheck, ChevronLeft, Clock3, CreditCard, ExternalLink, Eye, LoaderCircle, MapPin, MessageCircle, Package, Share2, Star, Store, X } from "lucide-react";
import { marketGet, MarketApiError } from "../market-api";
import type { BadgeView, MarketStorePageData } from "../market-types";
import { TIER_LABELS, WEEKDAYS } from "../market-types";
import { BADGE_ICONS, MarkChips, RatingInline, TIER_CLASSES, TierChip } from "../components/StoreBadges";
import { MarketEmptyState } from "../MarketEmptyState";
import { ProductShelf } from "../components/ProductShelf";

type Review = { id: string; rating: number; body: string | null; createdAt: string; author: string; product: { id: string; name: string } };

export function MarketStorePage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [data, setData] = useState<MarketStorePageData | null>(null);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reviews, setReviews] = useState<{ reviews: Review[]; nextCursor: string | null } | null>(null);
  const [badgeSheet, setBadgeSheet] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setData(null); setMissing(false); setFailure(null); setReviews(null);
    const encoded = encodeURIComponent(slug);
    marketGet<MarketStorePageData>(`/api/market/stores/${encoded}`, { signal: controller.signal })
      .then((page) => {
        setData(page);
        marketGet<{ reviews: Review[]; nextCursor: string | null }>(`/api/market/stores/${encoded}/reviews?limit=3`, { signal: controller.signal }).then(setReviews).catch(() => setReviews({ reviews: [], nextCursor: null }));
      })
      .catch((error: Error) => {
        if (error.name === "AbortError") return;
        if (error instanceof MarketApiError && error.status === 404) setMissing(true); else setFailure(error.message);
      });
    return () => controller.abort();
  }, [slug]);

  if (missing) return <MarketEmptyState testId="market-store-missing" icon={Store} title="المتجر غير موجود" body="ربما غادر المتجر السوق أو تغيّر رابطه." action={<Link href="/stores" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">تصفّح المتاجر</Link>} />;
  if (failure) return <p className="py-10 text-center text-sm text-[var(--codiq-danger)]">{failure}</p>;
  if (!data) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;

  const { store, reputation, hours } = data;
  const earned = data.badges.filter((badge) => badge.earned);
  const place = [store.governorate?.name, store.district?.name].filter(Boolean).join(" · ");
  const today = new Date(Date.now() + 3 * 3600_000).getUTCDay();

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: store.name, url });
      else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    } catch { /* the shopper closed the share sheet */ }
  };

  return (
    <div className="-mx-4 -mt-4 space-y-4" data-testid="market-store-page">
      <div className="relative h-36 bg-[var(--codiq-accent-soft)]">
        {store.coverUrl ? <img src={store.coverUrl} alt="" className="h-full w-full object-cover" /> : null}
        <button type="button" onClick={() => void share()} aria-label="مشاركة" className="absolute left-3 top-3 rounded-full bg-[var(--codiq-surface)] p-2 text-[var(--codiq-text)] shadow" data-testid="market-store-share"><Share2 className="h-4 w-4" /></button>
        {copied ? <span className="absolute left-14 top-4 rounded-full bg-[var(--codiq-surface)] px-2 py-1 text-[11px] font-bold text-[var(--codiq-success)]">نُسخ الرابط</span> : null}
      </div>

      <section className="relative mx-4 -mt-12 space-y-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <div className="flex items-start gap-3">
          {store.logoUrl ? <img src={store.logoUrl} alt="" className="-mt-10 h-20 w-20 shrink-0 rounded-[22px] border-4 border-[var(--codiq-surface)] bg-[var(--codiq-surface)] object-cover shadow" />
            : <span className="-mt-10 flex h-20 w-20 shrink-0 items-center justify-center rounded-[22px] border-4 border-[var(--codiq-surface)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)] shadow"><Store className="h-8 w-8" /></span>}
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-1 text-lg font-black text-[var(--codiq-text)]" data-testid="market-store-name">
              <span className="truncate">{store.name}</span>
              {store.marks.includes("verified") ? <BadgeCheck className="h-5 w-5 shrink-0 text-[var(--codiq-accent)]" aria-label="متجر موثّق" /> : null}
            </h1>
            <p className="truncate text-xs text-[var(--codiq-text-muted)]">{[store.businessType, place].filter(Boolean).join(" · ")}</p>
          </div>
          <FollowStoreButton storeSlug={store.slug} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RatingInline rating={store.rating} count={store.ratingCount} />
          {reputation.tier ? <TierChip tier={reputation.tier} /> : <span className="text-[11px] text-[var(--codiq-text-muted)]">التقييم العامّ لم يُحتسب بعد</span>}
          <MarkChips marks={store.marks} limit={4} />
        </div>
        {store.headline ? <p className="text-sm font-semibold text-[var(--codiq-text)]">{store.headline}</p> : null}
        {store.closedForOrders ? <p className="rounded-2xl bg-[var(--codiq-warning-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-warning)]">{store.closedForOrders}</p> : null}

        <dl className="grid grid-cols-3 gap-2 text-center">
          <Stat icon={Clock3} label="وقت الاستجابة" value={store.medianResponseMinutes !== null ? `${store.medianResponseMinutes.toLocaleString("ar-IQ")} دقيقة` : "—"} />
          <Stat icon={Eye} label="المشاهدات (٣٠ يوماً)" value={store.views30d.toLocaleString("ar-IQ")} />
          <Stat icon={Package} label="المنتجات" value={store.productCount.toLocaleString("ar-IQ")} />
        </dl>

        <a href={store.storefrontPath} className="flex w-full items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-bold text-[var(--codiq-surface)]" data-testid="market-store-visit">
          <Store className="h-4 w-4" /> تسوّق من المتجر
        </a>
      </section>

      <section className="mx-4 space-y-2 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-store-badges">
        <button type="button" onClick={() => setBadgeSheet(true)} className="flex w-full items-center justify-between" data-testid="market-store-badges-open">
          <span className="text-sm font-black text-[var(--codiq-text)]">شارات المتجر</span>
          <span className="flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]">{earned.length.toLocaleString("ar-IQ")} من {data.badges.length.toLocaleString("ar-IQ")} <ChevronLeft className="h-4 w-4" /></span>
        </button>
        {earned.length ? (
          <div className="flex flex-wrap gap-2">{earned.map((badge) => <BadgePill key={badge.code} badge={badge} />)}</div>
        ) : <p className="text-xs text-[var(--codiq-text-muted)]">لم يكسب المتجر شارات بعد.</p>}
      </section>

      <div className="mx-4 space-y-5" data-testid="market-store-products">
        <ProductShelf testId="market-store-newest" title="أحدث المنتجات" url={`/api/market/products?store=${encodeURIComponent(store.slug)}&sort=newest&limit=10`} action={<Link href={`/s/${encodeURIComponent(store.slug)}/products`} className="text-xs font-bold text-[var(--codiq-accent)]" data-testid="market-store-all-products">عرض الكل</Link>} />
        <ProductShelf testId="market-store-discounts" title="التخفيضات" url={`/api/market/products?store=${encodeURIComponent(store.slug)}&discount=any&sort=discount&limit=10`} />
        <ProductShelf testId="market-store-trending" title="الأكثر رواجاً" url={`/api/market/products?store=${encodeURIComponent(store.slug)}&sort=trending&limit=10`} />
        <ProductShelf testId="market-store-preorders" title="الطلب المسبق" url={`/api/market/products?store=${encodeURIComponent(store.slug)}&preorder=1&limit=10`} />
      </div>

      <section className="mx-4 space-y-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-store-hours">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black text-[var(--codiq-text)]">أوقات الدوام</h2>
          {hours.openNow === null ? null : (
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${hours.openNow ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"}`} data-testid="market-store-open-now">
              {hours.openNow ? "مفتوح الآن" : "مغلق الآن"}
            </span>
          )}
        </div>
        {hours.openNow === null ? <p className="text-xs text-[var(--codiq-text-muted)]">لم يحدّد المتجر أوقات الدوام بعد.</p> : (
          <ul className="space-y-1.5">
            {hours.days.map((day) => (
              <li key={day.weekday} className={`flex justify-between text-xs ${day.weekday === today ? "font-bold text-[var(--codiq-text)]" : "text-[var(--codiq-text-secondary)]"}`}>
                <span>{WEEKDAYS[day.weekday]}</span>
                <span dir="ltr">{day.opensAt ? `${day.opensAt} – ${day.closesAt}` : "مغلق"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mx-4 space-y-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-store-details">
        <h2 className="text-sm font-black text-[var(--codiq-text)]">عن المتجر</h2>
        {store.about ? <p className="text-sm leading-6 text-[var(--codiq-text-secondary)]">{store.about}</p> : null}
        <Detail icon={CreditCard} label="طرق الدفع" value={data.paymentMethods.length ? data.paymentMethods.map((method) => method.displayName).join(" · ") : "الدفع عند الاستلام"} />
        {place ? <Detail icon={MapPin} label="منطقة المتجر" value={[place, store.addressLine].filter(Boolean).join(" — ")} /> : null}
        {store.pickupEnabled ? <Detail icon={Package} label="الاستلام" value="يمكنك استلام طلبك من المتجر" /> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {store.location ? (
            <a href={`https://www.openstreetmap.org/?mlat=${store.location.latitude}&mlon=${store.location.longitude}#map=17/${store.location.latitude}/${store.location.longitude}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full border border-[var(--codiq-border)] px-3 py-2 text-xs font-bold text-[var(--codiq-text)]" data-testid="market-store-directions">
              <ExternalLink className="h-3.5 w-3.5" /> الاتجاهات إلى المتجر
            </a>
          ) : null}
          {store.whatsapp ? (
            <a href={`https://wa.me/${store.whatsapp.replace(/[^\d]/g, "")}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full border border-[var(--codiq-border)] px-3 py-2 text-xs font-bold text-[var(--codiq-text)]">
              <MessageCircle className="h-3.5 w-3.5" /> تواصل مع المتجر
            </a>
          ) : null}
        </div>
      </section>

      <section className="mx-4 space-y-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-store-reviews">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black text-[var(--codiq-text)]">تقييمات المتجر</h2>
          {store.ratingCount ? <RatingInline rating={store.rating} count={store.ratingCount} /> : null}
        </div>
        {!reviews ? <p className="text-xs text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>
          : reviews.reviews.length === 0 ? <p className="text-xs text-[var(--codiq-text-muted)]">لا توجد تقييمات بعد.</p>
          : <ul className="space-y-3">{reviews.reviews.map((review) => <ReviewItem key={review.id} review={review} />)}</ul>}
        {reviews?.nextCursor ? <Link href={`/s/${encodeURIComponent(store.slug)}/reviews`} className="block text-center text-xs font-bold text-[var(--codiq-accent)]" data-testid="market-store-reviews-more">عرض المزيد من التقييمات</Link> : null}
      </section>

      {badgeSheet ? <BadgeSheet badges={data.badges} tier={reputation.tier ? TIER_LABELS[reputation.tier] : null} score={reputation.score} onClose={() => setBadgeSheet(false)} /> : null}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Clock3; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-2 py-2.5">
      <dt className="flex items-center justify-center gap-1 text-[10px] text-[var(--codiq-text-muted)]"><Icon className="h-3 w-3" /> {label}</dt>
      <dd className="mt-1 text-sm font-black text-[var(--codiq-text)]">{value}</dd>
    </div>
  );
}

function Detail({ icon: Icon, label, value }: { icon: typeof Clock3; label: string; value: string }) {
  return (
    <p className="flex items-start gap-2 text-xs">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--codiq-accent)]" />
      <span><span className="font-bold text-[var(--codiq-text)]">{label}: </span><span className="text-[var(--codiq-text-secondary)]">{value}</span></span>
    </p>
  );
}

function BadgePill({ badge }: { badge: BadgeView }) {
  const Icon = BADGE_ICONS[badge.code];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${badge.level ? TIER_CLASSES[badge.level] : "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"}`}>
      <Icon className="h-3.5 w-3.5" /> {badge.title}
    </span>
  );
}

export function ReviewItem({ review }: { review: Review }) {
  return (
    <li className="space-y-1 border-b border-[var(--codiq-border)] pb-3 last:border-0 last:pb-0">
      <div className="flex items-center justify-between text-xs">
        <span className="font-bold text-[var(--codiq-text)]">{review.author}</span>
        <span className="inline-flex items-center gap-0.5 text-[var(--codiq-rating)]" aria-label={`${review.rating} من 5`}>
          {Array.from({ length: 5 }, (_, index) => <Star key={index} className={`h-3 w-3 ${index < review.rating ? "fill-[var(--codiq-rating)]" : "text-[var(--codiq-rating-empty)]"}`} />)}
        </span>
      </div>
      {review.body ? <p className="text-xs leading-5 text-[var(--codiq-text-secondary)]">{review.body}</p> : null}
      <p className="text-[10px] text-[var(--codiq-text-muted)]">{review.product.name} · {new Date(review.createdAt).toLocaleDateString("ar-IQ")}</p>
    </li>
  );
}

function BadgeSheet({ badges, tier, score, onClose }: { badges: BadgeView[]; tier: string | null; score: number | null; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--codiq-text)]/40" role="dialog" aria-modal="true" aria-label="شارات المتجر" onClick={onClose} data-testid="market-badge-sheet">
      <div className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-t-[28px] bg-[var(--codiq-surface)] p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-base font-black text-[var(--codiq-text)]">شارات المتجر</p>
          <button type="button" aria-label="إغلاق" className="rounded-full p-2 text-[var(--codiq-text-muted)]" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <p className="mb-4 text-xs text-[var(--codiq-text-muted)]">
          {score !== null ? `النتيجة العامّة ${Math.round(score).toLocaleString("ar-IQ")} من ١٠٠${tier ? `، المستوى ${tier}` : ""}` : "النتيجة العامّة لم تُحتسب بعد"} — {badges.filter((badge) => badge.earned).length.toLocaleString("ar-IQ")} من {badges.length.toLocaleString("ar-IQ")} شارة
        </p>
        <ul className="space-y-2">
          {badges.map((badge) => {
            const Icon = BADGE_ICONS[badge.code];
            return (
              <li key={badge.code} className={`flex items-start gap-3 rounded-2xl p-3 ${badge.earned ? "bg-[var(--codiq-surface-sunken)]" : "opacity-55"}`} data-testid={`market-badge-${badge.code}`}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${badge.level ? TIER_CLASSES[badge.level] : "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"}`}><Icon className="h-4 w-4" /></span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--codiq-text)]">{badge.title}{badge.level ? ` · ${TIER_LABELS[badge.level]}` : ""}</p>
                  <p className="text-xs leading-5 text-[var(--codiq-text-muted)]">{badge.description}</p>
                  <p className={`mt-0.5 text-[10px] font-bold ${badge.earned ? "text-[var(--codiq-success)]" : "text-[var(--codiq-text-muted)]"}`}>{badge.earned ? "محقّقة" : "غير محقّقة بعد"}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

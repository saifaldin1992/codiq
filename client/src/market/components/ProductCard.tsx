/** A product in a grid or a shelf: picture with its badges, name, price (and the price before), stars, store. */
import { Link } from "wouter";
import { BadgeCheck, Clock, Flame, Package, Star, Zap } from "lucide-react";
import { iqd, TAG_LABELS, type MarketProductCard } from "../market-products";
import { FavouriteHeart } from "./FavouriteButtons";

export function ProductCard({ product, width }: { product: MarketProductCard; width?: string }) {
  const tag = product.tags.find((code) => code === "free_delivery" || code === "original" || code === "warranty");
  return (
    <Link href={`/p/${product.id}`} className={`block overflow-hidden rounded-[20px] bg-[var(--codiq-surface)] shadow-sm ${width ?? ""}`} data-testid={`market-product-card-${product.id}`}>
      <div className="relative aspect-square bg-[var(--codiq-surface-sunken)]">
        {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-[var(--codiq-text-muted)]"><Package className="h-8 w-8" /></span>}
        {product.deal ? <span className="absolute right-2 top-2 inline-flex items-center gap-0.5 rounded-full bg-[var(--codiq-danger)] px-2 py-0.5 text-[10px] font-black text-[var(--codiq-surface)]" data-testid={`market-product-deal-${product.id}`}><Zap className="h-3 w-3" /> عرض الساعة {product.deal.percentOff.toLocaleString("ar-IQ")}%</span>
          : product.discountPercent > 0 ? <span className="absolute right-2 top-2 rounded-full bg-[var(--codiq-danger)] px-2 py-0.5 text-[10px] font-black text-[var(--codiq-surface)]">خصم {product.discountPercent.toLocaleString("ar-IQ")}%</span> : null}
        {product.isPreorder ? <span className="absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-full bg-[var(--codiq-accent)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-surface)]"><Clock className="h-3 w-3" /> طلب مسبق</span>
          : product.sellsFast ? <span className="absolute bottom-2 right-2 inline-flex items-center gap-0.5 rounded-full bg-[var(--codiq-warning-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-warning)]"><Flame className="h-3 w-3" /> ينفد قريباً</span> : null}
        <FavouriteHeart productId={product.id} className="absolute left-2 top-2" />
        {!product.isAvailable ? <span className="absolute inset-0 flex items-center justify-center bg-[var(--codiq-surface)]/60 text-xs font-black text-[var(--codiq-text)]">نفد</span> : null}
      </div>
      <div className="space-y-1 p-2.5">
        <p className="line-clamp-2 min-h-[2.5rem] text-xs font-semibold leading-5 text-[var(--codiq-text)]">{product.name}</p>
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-sm font-black text-[var(--codiq-text)]">{product.hasOptions && product.maxPriceIqd > product.priceIqd ? "من " : ""}{iqd(product.priceIqd)}</span>
          {product.compareAtPriceIqd ? <span className="text-[11px] text-[var(--codiq-text-muted)] line-through">{iqd(product.compareAtPriceIqd)}</span> : null}
        </div>
        <div className="flex items-center justify-between gap-1 text-[10px] text-[var(--codiq-text-muted)]">
          {product.rating !== null ? <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3 fill-[var(--codiq-rating)] text-[var(--codiq-rating)]" /> {product.rating.toLocaleString("ar-IQ", { maximumFractionDigits: 1 })} ({product.ratingCount.toLocaleString("ar-IQ")})</span> : <span>لا تقييمات</span>}
          {product.matchPercent !== null ? <span className="font-bold text-[var(--codiq-accent)]">مطابقة {product.matchPercent.toLocaleString("ar-IQ")}%</span> : tag ? <span className="font-semibold text-[var(--codiq-success)]">{TAG_LABELS[tag]}</span> : null}
        </div>
        <p className="flex items-center gap-0.5 truncate text-[10px] text-[var(--codiq-text-secondary)]">{product.store.name}{product.store.verified ? <BadgeCheck className="h-3 w-3 shrink-0 text-[var(--codiq-accent)]" /> : null}</p>
      </div>
    </Link>
  );
}

/**
 * Marketplace M10 — «ريلز»: short videos from the stores. A vertical feed that
 * snaps one video to the screen, plays the one in view (muted until tapped),
 * counts a view once it has played a moment, and carries the tagged product
 * with a door to its page. `/reels/:id` opens one reel first (a shared link);
 * `/reels?store=slug` is one store's reels.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import {
  Clapperboard,
  Eye,
  Heart,
  LoaderCircle,
  Share2,
  ShoppingBag,
  Volume2,
  VolumeX,
} from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { marketGet } from "../market-api";
import { iqd, type MarketProductCard } from "../market-products";
import { useMarketList } from "../use-market-list";
import { MarketEmptyState } from "../MarketEmptyState";

export type MarketReel = {
  id: string;
  caption: string | null;
  videoUrl: string;
  posterUrl: string | null;
  store: { slug: string; name: string; logoUrl: string | null };
  product: MarketProductCard | null;
  views: number;
  likes: number;
  liked: boolean;
  publishedAt: string;
};

const counted = new Set<string>();
const VIEW_AFTER_MS = 2000;

function ReelSlide({
  reel,
  muted,
  onToggleMute,
}: {
  reel: MarketReel;
  muted: boolean;
  onToggleMute: () => void;
}) {
  const { shopper } = useShopper();
  const [, navigate] = useLocation();
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [likes, setLikes] = useState({ liked: reel.liked, count: reel.likes });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let timer: number | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const player = video.current;
        if (!player) return;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          void player.play().catch(() => undefined);
          if (!counted.has(reel.id)) {
            timer = window.setTimeout(() => {
              counted.add(reel.id);
              void fetch(`/api/market/reels/${encodeURIComponent(reel.id)}/view`, {
                method: "POST",
                credentials: "include",
              }).catch(() => undefined);
            }, VIEW_AFTER_MS);
          }
        } else {
          player.pause();
          window.clearTimeout(timer);
        }
      },
      { threshold: [0, 0.6, 1] }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [reel.id]);

  async function like() {
    if (!shopper) {
      navigate("/account");
      return;
    }
    const next = !likes.liked;
    setLikes((current) => ({ liked: next, count: current.count + (next ? 1 : -1) }));
    try {
      const body = await accountCall<{ liked: boolean; likes: number }>(
        `/api/market/reels/${encodeURIComponent(reel.id)}/like`,
        { method: "PUT", body: JSON.stringify({ liked: next }) }
      );
      setLikes({ liked: body.liked, count: body.likes });
    } catch (error) {
      setLikes({ liked: !next, count: likes.count });
      setNotice((error as Error).message);
    }
  }
  async function share() {
    const url = `${location.origin}/market/reels/${reel.id}`;
    if (navigator.share) {
      await navigator
        .share({ title: reel.store.name, text: reel.caption ?? undefined, url })
        .catch(() => undefined);
      return;
    }
    await navigator.clipboard
      ?.writeText(url)
      .then(() => setNotice("نُسخ الرابط"))
      .catch(() => setNotice(url));
  }

  return (
    <div
      ref={box}
      className="relative h-[calc(100dvh-9rem)] min-h-[420px] w-full snap-start overflow-hidden rounded-[24px] bg-[var(--codiq-text)]"
      data-testid="market-reel"
      data-reel-id={reel.id}
    >
      <video
        ref={video}
        src={`/api/market/reels/${encodeURIComponent(reel.id)}/video`}
        poster={reel.posterUrl ?? undefined}
        muted={muted}
        loop
        playsInline
        preload="metadata"
        className="h-full w-full object-contain"
        onClick={onToggleMute}
        aria-label={reel.caption ?? `فيديو من ${reel.store.name}`}
      />
      <button
        type="button"
        onClick={onToggleMute}
        className="absolute left-3 top-3 rounded-full bg-[var(--codiq-surface)]/80 p-2 text-[var(--codiq-text)]"
        aria-label={muted ? "تشغيل الصوت" : "كتم الصوت"}
        data-testid="market-reel-mute"
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </button>
      <div className="absolute bottom-24 left-3 flex flex-col items-center gap-4 text-[var(--codiq-surface)]">
        <button
          type="button"
          onClick={() => void like()}
          aria-pressed={likes.liked}
          className="flex flex-col items-center text-xs font-bold"
          data-testid="market-reel-like"
        >
          <Heart
            className={`h-7 w-7 ${likes.liked ? "fill-[var(--codiq-danger)] text-[var(--codiq-danger)]" : ""}`}
          />
          <span data-testid="market-reel-likes">{likes.count}</span>
        </button>
        <span className="flex flex-col items-center text-xs font-bold">
          <Eye className="h-6 w-6" />
          {reel.views}
        </span>
        <button
          type="button"
          onClick={() => void share()}
          className="flex flex-col items-center text-xs font-bold"
          data-testid="market-reel-share"
        >
          <Share2 className="h-6 w-6" />
          مشاركة
        </button>
      </div>
      <div className="absolute inset-x-0 bottom-0 space-y-2 bg-gradient-to-t from-[var(--codiq-text)] to-transparent p-3 pt-10 text-[var(--codiq-surface)]">
        <Link
          href={`/s/${reel.store.slug}`}
          className="flex items-center gap-2 text-sm font-black"
          data-testid="market-reel-store"
        >
          {reel.store.logoUrl ? (
            <img src={reel.store.logoUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
          ) : null}
          {reel.store.name}
        </Link>
        {reel.caption ? (
          <p className="text-xs leading-5" data-testid="market-reel-caption">
            {reel.caption}
          </p>
        ) : null}
        {reel.product ? (
          <Link
            href={`/p/${reel.product.id}`}
            className="flex items-center gap-3 rounded-2xl bg-[var(--codiq-surface)] p-2 text-[var(--codiq-text)]"
            data-testid="market-reel-product"
          >
            {reel.product.imageUrl ? (
              <img
                src={reel.product.imageUrl}
                alt=""
                className="h-12 w-12 rounded-xl object-cover"
              />
            ) : (
              <ShoppingBag className="h-8 w-8 text-[var(--codiq-accent)]" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-bold">{reel.product.name}</span>
              <span className="text-sm font-black text-[var(--codiq-accent)]">
                {iqd(reel.product.priceIqd)}
              </span>
            </span>
            <span className="rounded-full bg-[var(--codiq-accent)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-surface)]">
              تسوّق
            </span>
          </Link>
        ) : null}
        {notice ? (
          <p className="text-xs font-semibold" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ReelsFeed({ first }: { first?: MarketReel | null }) {
  const store = new URLSearchParams(useSearch()).get("store");
  const list = useMarketList<MarketReel>(
    store ? `/api/market/reels?store=${encodeURIComponent(store)}` : "/api/market/reels",
    "reels"
  );
  const [muted, setMuted] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const { loadMore, nextCursor } = list;
  useEffect(() => {
    const element = end.current;
    if (!element || !nextCursor) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void loadMore();
      },
      { rootMargin: "600px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  if (list.failure && !list.items)
    return <MarketEmptyState icon={Clapperboard} title="تعذّر تحميل الريلز" body={list.failure} />;
  if (!list.items)
    return (
      <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );
  const reels = first ? [first, ...list.items.filter((reel) => reel.id !== first.id)] : list.items;
  if (!reels.length)
    return (
      <MarketEmptyState
        icon={Clapperboard}
        title="لا ريلز بعد"
        body="المتاجر تنشر فيديوهات قصيرة لمنتجاتها — ارجع قريباً."
        testId="market-reels-empty"
      />
    );
  return (
    <div className="space-y-3" data-testid="market-reels">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">
        ريلز{store && reels[0]?.store.slug === store ? ` ${reels[0].store.name}` : ""}
      </h1>
      <div
        className="h-[calc(100dvh-9rem)] min-h-[420px] snap-y snap-mandatory space-y-3 overflow-y-auto"
        data-testid="market-reels-scroller"
      >
        {reels.map((reel) => (
          <ReelSlide
            key={reel.id}
            reel={reel}
            muted={muted}
            onToggleMute={() => setMuted((value) => !value)}
          />
        ))}
        <div ref={end} aria-hidden="true" />
        {list.loadingMore ? (
          <p className="py-4 text-center text-xs text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
        ) : null}
      </div>
    </div>
  );
}

export function MarketReelsPage() {
  return <ReelsFeed />;
}

/** A shared link: that reel first, the feed after it. */
export function MarketReelPage() {
  const { id } = useParams<{ id: string }>();
  const [reel, setReel] = useState<MarketReel | null | undefined>(undefined);
  useEffect(() => {
    setReel(undefined);
    void marketGet<{ reel: MarketReel }>(`/api/market/reels/${encodeURIComponent(id)}`)
      .then((body) => setReel(body.reel))
      .catch(() => setReel(null));
  }, [id]);
  if (reel === undefined)
    return (
      <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]">
        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
      </p>
    );
  if (reel === null)
    return (
      <MarketEmptyState
        icon={Clapperboard}
        title="هذا الفيديو لم يعد متاحاً"
        body="ربما حذفه المتجر — شوف بقيّة الريلز."
        testId="market-reel-gone"
      />
    );
  return <ReelsFeed first={reel} />;
}

/** «ريلز المتجر» on the store page, and «ريلز» on the front page: a row of posters. */
export function ReelsShelf({ storeSlug, title }: { storeSlug?: string; title: string }) {
  const [reels, setReels] = useState<MarketReel[] | null>(null);
  useEffect(() => {
    void marketGet<{ reels: MarketReel[] }>(
      storeSlug
        ? `/api/market/reels?store=${encodeURIComponent(storeSlug)}&limit=8`
        : "/api/market/reels?limit=8"
    )
      .then((body) => setReels(body.reels))
      .catch(() => setReels([]));
  }, [storeSlug]);
  if (!reels?.length) return null;
  const all = storeSlug ? `/reels?store=${encodeURIComponent(storeSlug)}` : "/reels";
  return (
    <section className="space-y-2" data-testid="market-reels-shelf">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-black text-[var(--codiq-text)]">{title}</h2>
        <Link href={all} className="text-xs font-bold text-[var(--codiq-accent)]">
          الكل
        </Link>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {reels.map((reel) => (
          <Link
            key={reel.id}
            href={`/reels/${reel.id}`}
            className="relative h-48 w-28 shrink-0 overflow-hidden rounded-2xl bg-[var(--codiq-text)]"
            data-testid="market-reels-shelf-item"
          >
            {reel.posterUrl ? (
              <img
                src={`/api/market/reels/${encodeURIComponent(reel.id)}/poster`}
                alt={reel.caption ?? ""}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <Clapperboard className="m-auto mt-16 h-8 w-8 text-[var(--codiq-surface)]" />
            )}
            <span className="absolute bottom-1 right-1 flex items-center gap-1 rounded-full bg-[var(--codiq-text)]/70 px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-surface)]">
              <Eye className="h-3 w-3" />
              {reel.views}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

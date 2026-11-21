/**
 * Swipeable banners. Each one is counted once per page view when at least half
 * of it is on screen, and again when tapped — the owner's numbers come from
 * what shoppers actually saw, not from what was rendered off-screen.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { marketHref } from "../market-links";

export type MarketBanner = { id: string; title: string; subtitle: string | null; imageUrl: string | null; link: { kind: string; target: string } | null; isAd: boolean };

const seen = new Set<string>();
function report(id: string, kind: "view" | "click") {
  void fetch(`/api/market/banners/${encodeURIComponent(id)}/events`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }), keepalive: true }).catch(() => undefined);
}

export function BannerCarousel({ banners, testId }: { banners: MarketBanner[]; testId: string }) {
  const track = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const root = track.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.bannerId;
        if (!id || !entry.isIntersecting) continue;
        setIndex(Number((entry.target as HTMLElement).dataset.index ?? 0));
        if (!seen.has(id)) { seen.add(id); report(id, "view"); }
      }
    }, { root, threshold: 0.5 });
    root.querySelectorAll("[data-banner-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [banners]);

  if (!banners.length) return null;
  return (
    <section className="space-y-2" data-testid={testId}>
      <div ref={track} className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 [scrollbar-width:none]">
        {banners.map((banner, at) => {
          const href = marketHref(banner.link);
          const body = (
            <div className="relative aspect-[2/1] w-full overflow-hidden rounded-[24px] bg-[var(--codiq-accent)] text-[var(--codiq-surface)] shadow-sm">
              {banner.imageUrl ? <img src={banner.imageUrl} alt={banner.title} className="h-full w-full object-cover" loading={at ? "lazy" : "eager"} /> : (
                <div className="flex h-full flex-col justify-end p-5">
                  <p className="text-xl font-black leading-tight">{banner.title}</p>
                  {banner.subtitle ? <p className="mt-1 text-sm opacity-85">{banner.subtitle}</p> : null}
                </div>
              )}
              {banner.isAd ? <span className="absolute left-3 top-3 rounded-full bg-[var(--codiq-surface)]/85 px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-text)]">إعلان</span> : null}
            </div>
          );
          return (
            <div key={banner.id} data-banner-id={banner.id} data-index={at} className="w-full shrink-0 snap-center" data-testid={`market-banner-${banner.id}`}>
              {href ? <Link href={href} onClick={() => report(banner.id, "click")} aria-label={banner.title}>{body}</Link> : body}
            </div>
          );
        })}
      </div>
      {banners.length > 1 ? (
        <div className="flex justify-center gap-1.5" aria-hidden="true">
          {banners.map((banner, at) => <span key={banner.id} className={`h-1.5 rounded-full transition-all ${at === index ? "w-5 bg-[var(--codiq-accent)]" : "w-1.5 bg-[var(--codiq-border-strong)]"}`} />)}
        </div>
      ) : null}
    </section>
  );
}

/**
 * ق-203 — the storefront's front page, in the reference shop's arrangement:
 * the merchant's slides, his headline, the categories, «وصل حديثاً»,
 * «الأكثر مبيعاً», the middle promo strip (ق-210), «الأعلى تقييماً», and
 * «آراء العملاء» — every section in the order he chose, under the title he
 * chose, and only when it has something to show. There is no celebrities
 * section, by the owner's decision.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ChevronLeft, ChevronRight, FolderTree, Quote } from "lucide-react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "@/components/ui/carousel";
import { useStorefront } from "@/components/StorefrontProvider";
import { ProductRail, SectionTitle } from "@/components/ProductRail";
import { Stars } from "@/components/ProductReviews";
import { LoadingState } from "@/components/StorefrontStates";
import { buildCategoryTree } from "@/lib/category-tree";
import {
  errorMessage,
  HomeSection,
  ProductSort,
  StoreBanner,
  StorefrontProduct,
  StoreReview,
  storefrontApi,
} from "@/lib/storefront-api";
import { trackAddToCart } from "@/lib/storefront-pixels";

const RAIL_SIZE = 8;
/** D-98: a «top rated» rail with three products is a rail that embarrasses the shop. */
const TOP_RATED_MINIMUM = 4;
const SLIDE_INTERVAL_MS = 6000;

/**
 * ق-210 — ONE slider for both placements.
 *
 * The opening slider is full-bleed and tall; the middle strip is inset and short,
 * the way a promotional band between two rails is. Everything else about them is
 * the same — autoplay, pause on hover, the arrows, the optional link — so they are
 * one component with a `variant`, and not two that drift apart.
 */
function BannerSlider({
  banners,
  name,
  variant,
  label,
}: {
  banners: StoreBanner[];
  name: string;
  variant: "hero" | "mid";
  label: string;
}) {
  const [api, setApi] = useState<CarouselApi>();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!api || banners.length < 2 || paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => api.scrollNext(), SLIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [api, banners.length, paused]);
  const hero = variant === "hero";
  const slide = (banner: StoreBanner) => {
    const image = (
      <img
        src={banner.url}
        alt={banner.altText ?? ""}
        className="h-full w-full object-cover"
        loading={hero ? "eager" : "lazy"}
      />
    );
    const frame = `block w-full overflow-hidden bg-[var(--storefront-accent-soft)] ${hero ? "aspect-[16/9] sm:aspect-[21/9]" : "aspect-[16/6] sm:aspect-[32/9]"}`;
    return banner.linkUrl ? (
      <a href={banner.linkUrl} className={frame} aria-label={banner.altText ?? name}>
        {image}
      </a>
    ) : (
      <div className={frame}>{image}</div>
    );
  };
  return (
    <section
      aria-label={label}
      data-testid={hero ? "storefront-hero" : "storefront-banners-mid"}
      className={
        hero
          ? "relative -mx-3 overflow-hidden sm:mx-0 sm:rounded-[28px]"
          : "relative overflow-hidden rounded-[24px]"
      }
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Carousel setApi={setApi} opts={{ direction: "rtl", loop: true }}>
        <CarouselContent className="ml-0">
          {banners.map((banner) => (
            <CarouselItem key={banner.id} className="pl-0">
              {slide(banner)}
            </CarouselItem>
          ))}
        </CarouselContent>
        {banners.length > 1 ? (
          <>
            <button
              type="button"
              aria-label="الشريحة السابقة"
              onClick={() => api?.scrollPrev()}
              className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-[var(--storefront-text)] shadow hover:bg-white"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="الشريحة التالية"
              onClick={() => api?.scrollNext()}
              className="absolute left-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-[var(--storefront-text)] shadow hover:bg-white"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          </>
        ) : null}
      </Carousel>
    </section>
  );
}

function ReviewsRail({ title, reviews }: { title: string; reviews: StoreReview[] }) {
  if (!reviews.length) return null;
  return (
    <section data-testid="home-reviews" className="space-y-5" aria-label={title}>
      <SectionTitle title={title} />
      <Carousel opts={{ direction: "rtl", align: "start", dragFree: true }}>
        <CarouselContent className="-ml-3">
          {reviews.map((review) => (
            <CarouselItem key={review.id} className="basis-[85%] pl-3 sm:basis-1/2 lg:basis-1/3">
              <figure className="flex h-full flex-col rounded-[22px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-5">
                <Quote className="h-5 w-5 text-[var(--storefront-accent)]" aria-hidden="true" />
                <Stars rating={review.rating} />
                <blockquote className="mt-3 flex-1 text-sm leading-7 text-[var(--storefront-text)]">
                  {review.body}
                </blockquote>
                <figcaption className="mt-4 text-xs text-[var(--storefront-muted)]">
                  <span className="font-bold text-[var(--storefront-text)]">{review.author}</span> ·
                  عن <span className="font-semibold">{review.product.name}</span>
                </figcaption>
              </figure>
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
    </section>
  );
}

const SORT_OF: Record<"newest" | "best_selling" | "top_rated", ProductSort> = {
  newest: "newest",
  best_selling: "best_selling",
  top_rated: "top_rated",
};

export default function StorefrontHomePage() {
  const { slug, config, categories, setCart, setNotice } = useStorefront();
  const [banners, setBanners] = useState<StoreBanner[] | null>(null);
  const [rails, setRails] = useState<Partial<Record<ProductSort, StorefrontProduct[]>>>({});
  const [reviews, setReviews] = useState<StoreReview[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const sections: HomeSection[] = config?.homeSections ?? [];

  useEffect(() => {
    let cancelled = false;
    storefrontApi
      .banners(slug)
      .then((data) => {
        if (!cancelled) setBanners(data.banners);
      })
      .catch(() => {
        if (!cancelled) setBanners([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    for (const section of config.homeSections) {
      if (
        section.key === "newest" ||
        section.key === "best_selling" ||
        section.key === "top_rated"
      ) {
        const sort = SORT_OF[section.key];
        storefrontApi
          .listProducts(slug, { sort, limit: RAIL_SIZE })
          .then((data) => {
            if (!cancelled) setRails((current) => ({ ...current, [sort]: data.products }));
          })
          .catch(() => undefined);
      }
      if (section.key === "reviews")
        storefrontApi
          .storeReviews(slug, 8)
          .then((data) => {
            if (!cancelled) setReviews(data.reviews);
          })
          .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [slug, config]);

  const add = useCallback(
    async (productId: string) => {
      setAdding(productId);
      try {
        const data = await storefrontApi.addCartItem(slug, productId, 1);
        setCart(data.cart);
        setNotice("تمت إضافة المنتج إلى السلة.");
        const added = Object.values(rails)
          .flat()
          .find((product) => product?.id === productId);
        if (added) trackAddToCart(added.minPriceIqd ?? added.priceIqd);
      } catch (error) {
        setNotice(errorMessage(error));
      } finally {
        setAdding(null);
      }
    },
    [slug, rails, setCart, setNotice]
  );

  if (!config || banners === null) return <LoadingState label="جارٍ تحميل المتجر…" />;
  const roots = buildCategoryTree(categories);

  // The headline sits under the slides, as on the reference — and stands alone
  // when there are none. The name is the fallback, so the page never opens blank.
  const headline = (
    <header key="headline" data-testid="home-headline" className="text-center">
      <h1 className="text-2xl font-black tracking-tight text-[var(--storefront-text)] sm:text-3xl">
        {config.headline ?? config.name}
      </h1>
      {config.subline ? (
        <p className="mx-auto mt-2 max-w-2xl text-sm leading-7 text-[var(--storefront-muted)] sm:text-base">
          {config.subline}
        </p>
      ) : null}
    </header>
  );
  // ق-210: one payload, two sliders. A slide whose placement the storefront does
  // not know is drawn at the top, which is where every slide uploaded before this
  // existed belongs.
  const heroBanners = banners.filter((banner) => banner.placement !== "mid");
  const midBanners = banners.filter((banner) => banner.placement === "mid");
  const bannersOn = sections.some((section) => section.key === "banners" && section.enabled);
  return (
    <div className="space-y-12">
      {!bannersOn || !heroBanners.length ? headline : null}
      {sections.map((section) => {
        if (section.key === "banners") {
          return heroBanners.length ? (
            <div key="banners" className="space-y-8">
              <BannerSlider
                banners={heroBanners}
                name={config.name}
                variant="hero"
                label={section.title || "عروض المتجر"}
              />
              {headline}
            </div>
          ) : null;
        }
        if (section.key === "banners_mid") {
          return midBanners.length ? (
            <BannerSlider
              key="banners_mid"
              banners={midBanners}
              name={config.name}
              variant="mid"
              label={section.title || "عروض المتجر"}
            />
          ) : null;
        }
        if (section.key === "categories") {
          if (!roots.length) return null;
          return (
            <section
              key="categories"
              data-testid="home-categories"
              className="space-y-5"
              aria-label={section.title}
            >
              <SectionTitle title={section.title} href={`/store/${slug}/products`} />
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {roots.map((node) => (
                  <li key={node.category.id}>
                    <Link
                      href={`/store/${slug}/categories/${node.category.id}`}
                      className="flex h-full items-center justify-between gap-3 rounded-[20px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] px-4 py-4 transition hover:border-[var(--storefront-accent)] hover:shadow-sm"
                    >
                      <span className="flex items-center gap-2.5">
                        <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--storefront-accent-soft)] text-[var(--storefront-accent)]">
                          <FolderTree className="h-4 w-4" />
                        </span>
                        <span>
                          <span className="block text-sm font-bold text-[var(--storefront-text)]">
                            {node.category.name}
                          </span>
                          {node.children.length ? (
                            <span className="block text-[11px] text-[var(--storefront-muted)]">
                              {node.children
                                .map((child) => child.category.name)
                                .slice(0, 3)
                                .join(" · ")}
                              {node.children.length > 3 ? " …" : ""}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <ArrowLeft className="h-4 w-4 shrink-0 text-[var(--storefront-muted)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        }
        if (section.key === "reviews")
          return <ReviewsRail key="reviews" title={section.title} reviews={reviews} />;
        const sort = SORT_OF[section.key];
        const products = rails[sort] ?? [];
        if (sort === "top_rated" && products.length < TOP_RATED_MINIMUM) return null;
        return (
          <ProductRail
            key={section.key}
            testId={`home-rail-${section.key}`}
            slug={slug}
            title={section.title}
            href={`/store/${slug}/products?sort=${sort}`}
            products={products}
            adding={adding}
            onAdd={(id) => void add(id)}
          />
        );
      })}
      {/* The headline sits under the slides, as on the reference — and stands alone when there are none. */}
    </div>
  );
}

/**
 * ق-203 — a titled horizontal rail of product cards with arrows and «عرض الكل».
 *
 * ONE component for the three home sections (and the product page's siblings),
 * over the already-installed embla carousel. The shell forces `dir="rtl"` and
 * embla is LTR-first, so `direction: "rtl"` is passed explicitly — without it
 * the «التالي» arrow scrolls backwards.
 */
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { ProductCard } from "@/components/ProductCard";
import type { StorefrontProduct } from "@/lib/storefront-api";

export function SectionTitle({
  title,
  href,
  hrefLabel = "عرض الكل",
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="relative flex items-end justify-between gap-4">
      <div className="mx-auto text-center">
        <h2 className="text-xl font-black text-[var(--storefront-text)] sm:text-2xl">{title}</h2>
        <span
          aria-hidden="true"
          className="mx-auto mt-2 block h-1 w-14 rounded-full bg-[var(--storefront-accent)]"
        />
      </div>
      {href ? (
        <Link
          href={href}
          className="absolute left-0 bottom-0 inline-flex items-center gap-1 text-sm font-bold text-[var(--storefront-accent)] hover:underline"
        >
          {hrefLabel}
          <ArrowLeft className="h-4 w-4" />
        </Link>
      ) : null}
    </div>
  );
}

export function ProductRail({
  slug,
  title,
  href,
  products,
  adding,
  onAdd,
  testId,
}: {
  slug: string;
  title: string;
  href?: string;
  products: StorefrontProduct[];
  adding: string | null;
  onAdd: (productId: string) => void;
  testId?: string;
}) {
  if (!products.length) return null;
  return (
    <section data-testid={testId} className="space-y-5" aria-label={title}>
      <SectionTitle title={title} href={href} />
      <Carousel opts={{ direction: "rtl", align: "start", dragFree: true }} className="px-1">
        <CarouselContent className="-ml-3">
          {products.map((product) => (
            <CarouselItem
              key={product.id}
              className="basis-[78%] pl-3 sm:basis-1/2 md:basis-1/3 lg:basis-1/4"
            >
              <ProductCard
                slug={slug}
                product={product}
                adding={adding === product.id}
                onAdd={onAdd}
              />
            </CarouselItem>
          ))}
        </CarouselContent>
        {products.length > 4 ? (
          <>
            <CarouselPrevious className="-left-3 hidden md:flex" />
            <CarouselNext className="-right-3 hidden md:flex" />
          </>
        ) : null}
      </Carousel>
    </section>
  );
}

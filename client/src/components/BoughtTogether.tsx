/**
 * CD-4 «يُشترى معه عادة».
 *
 * The section is ABSENT when nothing clears the bar, not empty and not padded.
 * A shopper who is shown one coincidence dressed as a habit learns the whole
 * strip is noise, and then the genuine recommendations are worth nothing either.
 *
 * Each card carries how many orders the pairing rests on. That number is what
 * makes «عادة» a claim rather than a decoration — and it lets a shopper weigh a
 * pairing seen in three orders differently from one seen in ninety.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { storefrontApi } from "@/lib/storefront-api";

type Recommendation = { productId: string; name: string; priceIqd: number; ordersTogether: number; imageId: string | null };

const money = new Intl.NumberFormat("ar-IQ");

export function BoughtTogether({ slug, productId }: { slug: string; productId: string }) {
  const [items, setItems] = useState<Recommendation[] | null>(null);

  useEffect(() => {
    let alive = true;
    void storefrontApi.recommendations(slug, productId)
      .then((data) => { if (alive) setItems(data.recommendations); })
      // A failed recommendation strip must never break a product page: the page
      // sells, this only suggests.
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [slug, productId]);

  if (!items || items.length === 0) return null;

  return (
    <section className="space-y-3" aria-labelledby="bought-together-heading">
      <h2 id="bought-together-heading" className="text-lg font-black text-[var(--storefront-text)]">يُشترى معه عادة</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.productId}>
            <Link
              href={`/store/${slug}/products/${item.productId}`}
              className="block h-full rounded-2xl bg-[var(--storefront-surface)] p-3 transition hover:shadow-md"
            >
              <div className="grid h-32 place-items-center overflow-hidden rounded-xl bg-[var(--storefront-accent-soft)]">
                {item.imageId ? (
                  <img
                    src={`/api/store/${encodeURIComponent(slug)}/products/${item.productId}/images/${item.imageId}?v=thumb`}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <p className="mt-2 line-clamp-2 text-sm font-bold text-[var(--storefront-text)]">{item.name}</p>
              <p className="mt-0.5 text-sm font-black tabular-nums text-[var(--storefront-text)]">{money.format(item.priceIqd)} د.ع</p>
              {/* The evidence, not just the claim. */}
              <p className="mt-0.5 text-[11px] text-[var(--storefront-muted)]">اشتراه معه {money.format(item.ordersTogether)} زبوناً</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A titled sideways row of products from one market query; hidden when empty. */
import type { ReactNode } from "react";
import { useMarketList } from "../use-market-list";
import type { MarketProductCard } from "../market-products";
import { ProductCard } from "./ProductCard";

export function ProductShelf({
  title,
  url,
  action,
  testId,
}: {
  title: string;
  url: string | null;
  action?: ReactNode;
  testId: string;
}) {
  const { items } = useMarketList<MarketProductCard>(url, "products");
  if (!items || items.length === 0) return null;
  return (
    <section className="space-y-2" data-testid={testId}>
      <div className="flex items-end justify-between gap-2">
        <h2 className="text-base font-black text-[var(--codiq-text)]">{title}</h2>
        {action}
      </div>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {items.map((product) => (
          <ProductCard key={product.id} product={product} width="w-[150px] shrink-0" />
        ))}
      </div>
    </section>
  );
}

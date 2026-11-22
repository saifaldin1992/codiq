/**
 * The price a storefront card shows — and the one number format every storefront screen uses.
 * Pure (no network, no React), so it is tested directly (review batch 2, م-٢).
 */
import type { StorefrontProduct } from "./storefront-api";

export const formatIqd = new Intl.NumberFormat("ar-IQ");

export function priceLabel(
  product: Pick<StorefrontProduct, "priceIqd" | "minPriceIqd" | "maxPriceIqd">
) {
  if (
    typeof product.minPriceIqd === "number" &&
    typeof product.maxPriceIqd === "number" &&
    product.minPriceIqd !== product.maxPriceIqd
  ) {
    return `${formatIqd.format(product.minPriceIqd)}–${formatIqd.format(product.maxPriceIqd)}`;
  }
  // The variants' LIVE price when the list carries it — during an hourly deal that is the
  // price at checkout, not the stored one (م-٢). An older payload without it: the stored price.
  return formatIqd.format(product.minPriceIqd ?? product.priceIqd);
}

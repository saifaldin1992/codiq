/**
 * Marketplace M7 — the hearts. One shared set of saved product ids and
 * followed store slugs for the page, filled in batches as cards appear
 * (at most 48 ids per request), changed optimistically on tap.
 */
import { useEffect, useSyncExternalStore } from "react";
import { accountCall, useShopper } from "./market-shopper";

const products = new Map<string, boolean>();
const stores = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;
const pending = { products: new Set<string>(), stores: new Set<string>() };
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function changed() { version += 1; listeners.forEach((listener) => listener()); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

function flush() {
  flushTimer = null;
  const productIds = Array.from(pending.products).slice(0, 48);
  const storeSlugs = Array.from(pending.stores).slice(0, 48);
  productIds.forEach((id) => pending.products.delete(id));
  storeSlugs.forEach((slug) => pending.stores.delete(slug));
  if (!productIds.length && !storeSlugs.length) return;
  const search = new URLSearchParams();
  if (productIds.length) search.set("products", productIds.join(","));
  if (storeSlugs.length) search.set("stores", storeSlugs.join(","));
  void accountCall<{ products: string[]; stores: string[] }>(`/api/market/favourites/flags?${search.toString()}`).then((flags) => {
    productIds.forEach((id) => products.set(id, flags.products.includes(id)));
    storeSlugs.forEach((slug) => stores.set(slug, flags.stores.includes(slug)));
    changed();
  }).catch(() => undefined);
  if (pending.products.size || pending.stores.size) flushTimer = setTimeout(flush, 0);
}

function want(kind: "products" | "stores", key: string) {
  const known = kind === "products" ? products : stores;
  if (known.has(key)) return;
  pending[kind].add(key);
  flushTimer ??= setTimeout(flush, 30);
}

let owner: string | null = null;

function useFlag(kind: "products" | "stores", key: string): boolean {
  const { shopper } = useShopper();
  // Another account (or none): the answers were his, not this one's.
  if ((shopper?.id ?? null) !== owner) { owner = shopper?.id ?? null; products.clear(); stores.clear(); pending.products.clear(); pending.stores.clear(); }
  useEffect(() => { if (shopper) want(kind, key); }, [shopper, kind, key]);
  useSyncExternalStore(subscribe, () => version);
  return Boolean(shopper) && Boolean((kind === "products" ? products : stores).get(key));
}

export const useIsFavourite = (productId: string) => useFlag("products", productId);
export const useIsFollowing = (storeSlug: string) => useFlag("stores", storeSlug);

export async function toggleFavourite(productId: string, on: boolean) {
  products.set(productId, on); changed();
  try {
    await accountCall(`/api/market/favourites/products/${encodeURIComponent(productId)}`, { method: on ? "PUT" : "DELETE" });
  } catch (error) {
    products.set(productId, !on); changed();
    throw error;
  }
}

export async function toggleFollow(storeSlug: string, on: boolean): Promise<number | null> {
  stores.set(storeSlug, on); changed();
  try {
    const result = await accountCall<{ followers: number }>(`/api/market/stores/${encodeURIComponent(storeSlug)}/follow`, { method: on ? "PUT" : "DELETE" });
    return result.followers;
  } catch (error) {
    stores.set(storeSlug, !on); changed();
    throw error;
  }
}

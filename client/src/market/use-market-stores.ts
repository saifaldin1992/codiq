/** One paged directory query: first page on mount or when the query changes, more on demand. */
import { useCallback, useEffect, useRef, useState } from "react";
import { marketGet } from "./market-api";
import type { MarketStoreCard, MarketStoresPage } from "./market-types";

export function marketStoresUrl(
  params: Record<string, string | number | boolean | undefined | null>
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, value === true ? "1" : String(value));
  }
  return `/api/market/stores?${search.toString()}`;
}

export function useMarketStores(url: string | null) {
  const [stores, setStores] = useState<MarketStoreCard[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!url) {
      setStores(null);
      return;
    }
    const mine = ++generation.current;
    const controller = new AbortController();
    setStores(null);
    setFailure(null);
    marketGet<MarketStoresPage>(url, { signal: controller.signal })
      .then((page) => {
        if (mine === generation.current) {
          setStores(page.stores);
          setNextCursor(page.nextCursor);
        }
      })
      .catch((error: Error) => {
        if (mine === generation.current && error.name !== "AbortError") setFailure(error.message);
      });
    return () => controller.abort();
  }, [url]);

  const loadMore = useCallback(async () => {
    if (!url || !nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await marketGet<MarketStoresPage>(
        `${url}&cursor=${encodeURIComponent(nextCursor)}`
      );
      if (mine !== generation.current) return;
      setStores((current) => [...(current ?? []), ...page.stores]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [url, nextCursor, loadingMore]);

  return { stores, nextCursor, failure, loadMore, loadingMore };
}

/** A paged market list under one key (`products`, `stores`…): first page when the URL changes, more on demand. */
import { useCallback, useEffect, useRef, useState } from "react";
import { marketGet } from "./market-api";

export function useMarketList<T>(url: string | null, key: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!url) {
      setItems(null);
      setNextCursor(null);
      return;
    }
    const mine = ++generation.current;
    const controller = new AbortController();
    setItems(null);
    setFailure(null);
    marketGet<Record<string, unknown>>(url, { signal: controller.signal })
      .then((page) => {
        if (mine === generation.current) {
          setItems((page[key] as T[]) ?? []);
          setNextCursor((page.nextCursor as string | null) ?? null);
        }
      })
      .catch((error: Error) => {
        if (mine === generation.current && error.name !== "AbortError") setFailure(error.message);
      });
    return () => controller.abort();
  }, [url, key]);

  const loadMore = useCallback(async () => {
    if (!url || !nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await marketGet<Record<string, unknown>>(
        `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`
      );
      if (mine !== generation.current) return;
      setItems((current) => [...(current ?? []), ...((page[key] as T[]) ?? [])]);
      setNextCursor((page.nextCursor as string | null) ?? null);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [url, key, nextCursor, loadingMore]);

  return { items, nextCursor, failure, loadMore, loadingMore };
}

export function queryString(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(name, value === true ? "1" : String(value));
  }
  return search.toString();
}

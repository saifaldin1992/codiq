/**
 * Where the shopper wants things delivered — chosen once in the header, used by
 * every market list to filter and sort. Kept in the browser only: it is a
 * convenience, never a fact the server relies on (checkout asks for a real
 * address). Every storage access is guarded: private windows and blocked site
 * data throw on read.
 */
import { useCallback, useEffect, useState } from "react";

export type MarketLocation = {
  governorateKey: string;
  governorateName: string;
  districtId: number | null;
  districtName: string | null;
};

const STORAGE_KEY = "codiq.market.location";
const CHANGE_EVENT = "codiq:market-location";

export function readMarketLocation(): MarketLocation | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MarketLocation>;
    if (typeof parsed.governorateKey !== "string" || typeof parsed.governorateName !== "string")
      return null;
    return {
      governorateKey: parsed.governorateKey,
      governorateName: parsed.governorateName,
      districtId: typeof parsed.districtId === "number" ? parsed.districtId : null,
      districtName: typeof parsed.districtName === "string" ? parsed.districtName : null,
    };
  } catch {
    return null;
  }
}

export function writeMarketLocation(location: MarketLocation | null) {
  try {
    if (location) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: location }));
}

export function useMarketLocation(): [
  MarketLocation | null,
  (location: MarketLocation | null) => void,
] {
  const [location, setLocation] = useState<MarketLocation | null>(() => readMarketLocation());
  useEffect(() => {
    const onChange = (event: Event) =>
      setLocation((event as CustomEvent<MarketLocation | null>).detail ?? null);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  const update = useCallback((next: MarketLocation | null) => writeMarketLocation(next), []);
  return [location, update];
}

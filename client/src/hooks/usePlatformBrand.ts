import { useEffect, useState } from "react";

/**
 * P27-20 (ق-107) — the owner's uploaded logo, read once per page load.
 *
 * The fetch is cached at MODULE level rather than per component. `<BrandMark/>`
 * renders in the header of all three dashboards, on the landing page, on the
 * sign-in card and in the storefront footer, and a hook that fetched per mount
 * would fire the same request five times on one screen.
 *
 * Failure is silent ON PURPOSE. If the request fails — offline, storage
 * unconfigured on this environment, a malformed stored row — every surface falls
 * back to the vector mark compiled into the code. A missing logo must never be a
 * broken page, and the default is always a correct answer.
 */
export interface PlatformBrand {
  logo: { url: string; contentType: string; version: string } | null;
}

const DEFAULT_BRAND: PlatformBrand = { logo: null };

let cached: PlatformBrand | null = null;
let inFlight: Promise<PlatformBrand> | null = null;

async function loadBrand(): Promise<PlatformBrand> {
  if (cached) return cached;
  inFlight ??= fetch("/api/public/brand", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : DEFAULT_BRAND))
    .then((payload: PlatformBrand) => {
      cached = payload?.logo ? payload : DEFAULT_BRAND;
      return cached;
    })
    .catch(() => DEFAULT_BRAND)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Call after an upload or a revert so the running page shows the change. */
export function invalidatePlatformBrand() {
  cached = null;
  inFlight = null;
}

export function usePlatformBrand(): PlatformBrand {
  const [brand, setBrand] = useState<PlatformBrand>(cached ?? DEFAULT_BRAND);
  useEffect(() => {
    let alive = true;
    void loadBrand().then((next) => {
      if (alive) setBrand(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  return brand;
}

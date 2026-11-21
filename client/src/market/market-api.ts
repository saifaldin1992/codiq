/** The market's one fetch helper: same-origin, JSON, and the server's Arabic error message when it has one. */
export class MarketApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

export async function marketGet<T>(url: string, init?: { signal?: AbortSignal }): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", signal: init?.signal, headers: { accept: "application/json" } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new MarketApiError(body?.error?.message ?? "تعذّر الاتصال بالخادم، حاول مرة أخرى", response.status, body?.error?.code ?? null);
  }
  return body as T;
}

export type MarketGeography = {
  governorates: { key: string; name: string; districts: { id: number; name: string }[] }[];
};

let geographyRequest: Promise<MarketGeography> | null = null;
/** One request per page load: the tree is the same for everyone and the server caches it for an hour. */
export function loadMarketGeography(): Promise<MarketGeography> {
  geographyRequest ??= marketGet<MarketGeography>("/api/market/geo").catch((error) => {
    geographyRequest = null;
    throw error;
  });
  return geographyRequest;
}

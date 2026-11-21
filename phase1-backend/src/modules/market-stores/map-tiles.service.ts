/**
 * Marketplace M11 — the map's background tiles, through this server.
 *
 * WHY A PROXY. A tile provider (MapTiler, Stadia, a self-hosted server…) is
 * reached with a key in its URL. Pointed at directly from the browser, the key
 * ships to every visitor and every tile request tells the provider where a
 * shopper is looking, from the shopper's own address. Through here the key
 * stays in `CODIQ_MAP_TILE_URL`, the provider sees only this server, the CSP
 * stays `img-src 'self'`, and a CDN in front caches tiles for everyone.
 *
 * SAFETY. The upstream is the one template the operator configured; the only
 * values put into it are three integers checked against the tile grid, so no
 * request can be steered elsewhere (no SSRF). Redirects are refused, answers
 * must be an image of at most 512 KB, and a slow provider is cut at 6 s.
 * A bounded in-memory cache (and one fetch per tile at a time) keeps a crowd
 * of shoppers from becoming a crowd of upstream requests.
 *
 * Unset, the map still works: pins on a plain background, and the config
 * route says so.
 */
import { HttpError } from "../../auth/auth.errors.js";

const MAX_TILE_BYTES = 512 * 1024;
const CACHE_MAX_ENTRIES = 3000;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 6000;
const TILE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type Tile = { body: Buffer; type: string; at: number };
const cache = new Map<string, Tile>();
let cacheBytes = 0;
const inflight = new Map<string, Promise<Tile>>();

function template(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CODIQ_MAP_TILE_URL?.trim();
  if (!raw || !raw.includes("{z}") || !raw.includes("{x}") || !raw.includes("{y}")) return null;
  let url: URL;
  try {
    url = new URL(raw.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && url.protocol === "http:"))
    return null;
  return raw;
}

const maxZoom = (env: NodeJS.ProcessEnv = process.env) =>
  Math.min(Math.max(Number.parseInt(env.CODIQ_MAP_MAX_ZOOM ?? "19", 10) || 19, 1), 22);

export function mapConfig() {
  return {
    tiles: template() ? "/api/market/map/tiles/{z}/{x}/{y}" : null,
    attribution: process.env.CODIQ_MAP_TILE_ATTRIBUTION?.trim() || null,
    maxZoom: maxZoom(),
    /** Baghdad, where the map opens before it knows the shopper. */
    center: { latitude: 33.3152, longitude: 44.3661, zoom: 12 },
  };
}

function remember(key: string, tile: Tile) {
  const old = cache.get(key);
  if (old) {
    cacheBytes -= old.body.length;
    cache.delete(key);
  }
  cache.set(key, tile);
  cacheBytes += tile.body.length;
  for (const [oldest, value] of Array.from(cache.entries())) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(oldest);
    cacheBytes -= value.body.length;
  }
}

async function fetchTile(url: string): Promise<Tile> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: "image/png,image/jpeg,image/webp" },
    });
  } catch {
    throw new HttpError(502, "MAP_TILE_UPSTREAM", "تعذّر جلب الخريطة الآن.");
  }
  if (response.status === 404)
    throw new HttpError(404, "MAP_TILE_NOT_FOUND", "لا خريطة لهذا المكان.");
  if (!response.ok) throw new HttpError(502, "MAP_TILE_UPSTREAM", "تعذّر جلب الخريطة الآن.");
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!TILE_TYPES.has(type))
    throw new HttpError(502, "MAP_TILE_UPSTREAM", "تعذّر جلب الخريطة الآن.");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_TILE_BYTES)
    throw new HttpError(502, "MAP_TILE_UPSTREAM", "تعذّر جلب الخريطة الآن.");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_TILE_BYTES)
    throw new HttpError(502, "MAP_TILE_UPSTREAM", "تعذّر جلب الخريطة الآن.");
  return { body, type, at: Date.now() };
}

/** One tile, from the cache or the provider. z/x/y arrive as strings from the path. */
export async function mapTile(
  rawZ: string,
  rawX: string,
  rawY: string
): Promise<{ body: Buffer; type: string }> {
  const source = template();
  if (!source) throw new HttpError(404, "MAP_TILES_OFF", "خلفيّة الخريطة غير مفعّلة.");
  const [z, x, y] = [rawZ, rawX, rawY].map((value) =>
    /^\d{1,7}$/.test(value) ? Number(value) : Number.NaN
  );
  if (
    !Number.isInteger(z) ||
    z > maxZoom() ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x >= 2 ** z ||
    y >= 2 ** z
  ) {
    throw new HttpError(404, "MAP_TILE_NOT_FOUND", "لا خريطة لهذا المكان.");
  }
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchTile(
      source.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y))
    )
      .then((tile) => {
        remember(key, tile);
        return tile;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/** Tests only. */
export function clearMapTileCacheForTests() {
  cache.clear();
  cacheBytes = 0;
  inflight.clear();
}

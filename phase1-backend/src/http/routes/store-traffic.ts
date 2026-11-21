/**
 * ق-202 — the storefront's visit beacon.
 *
 * `POST /store/:slug/visit` once per page view, with the product id when the
 * page is a product's. The cookie `codiq_visit_<slug>` holds ONLY the Baghdad
 * day the browser was last counted on — no id, nothing to correlate — so a
 * reload is one visitor and many visits. Origin-checked like every storefront
 * write, and ceilinged per address so a script cannot inflate a shop's numbers
 * cheaply.
 */
import type { Express as ExpressApp, Request } from "express";
import { config } from "../../config.js";
import {
  asyncRoute,
  requireTrustedWriteOrigin,
  resolveStorefrontStore,
  storefrontCookiePath,
} from "../shared.js";
import { parseOrThrow } from "../validate.js";
import { visitSchema } from "../schemas/store-traffic.schema.js";
import { baghdadDay, recordVisit } from "../../services/store-traffic.service.js";

import { clientIp } from "../client-ip.js";
import { HttpError } from "../../auth/auth.errors.js";

/**
 * SCALE — the beacon used the database-backed limiter, i.e. one more write per
 * page view on top of the counter itself. For an approximate counter a
 * per-instance ceiling is enough: 300 beacons per 10 minutes per (store, address),
 * held in memory and swept with each window. Login, checkout and every other
 * write keep the shared database limiter.
 */
const VISIT_WINDOW_MS = 10 * 60 * 1000;
const VISIT_LIMIT = 300;
const VISIT_MAX_KEYS = 100_000;
let visitWindowStart = Date.now();
let visitCounts = new Map<string, number>();
function limitVisitBeacon(storeSlug: string, ip: string) {
  const now = Date.now();
  if (now - visitWindowStart >= VISIT_WINDOW_MS || visitCounts.size >= VISIT_MAX_KEYS) {
    visitWindowStart = now;
    visitCounts = new Map();
  }
  const key = `${storeSlug}:${ip}`;
  const count = (visitCounts.get(key) ?? 0) + 1;
  visitCounts.set(key, count);
  if (count > VISIT_LIMIT)
    throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please try again later.");
}
export function visitCookieName(storeSlug: string) {
  return `codiq_visit_${storeSlug}`;
}

function cookie(request: Request, name: string): string | undefined {
  const header = request.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function registerStoreTrafficRoutes(app: ExpressApp) {
  app.post(
    "/store/:storeSlug/visit",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const store = await resolveStorefrontStore(request.params.storeSlug);
      limitVisitBeacon(store.slug, clientIp(request));
      const body = parseOrThrow(visitSchema, request.body ?? {});
      const day = baghdadDay();
      const newVisitor = cookie(request, visitCookieName(store.slug)) !== day;
      await recordVisit(store.id, { day, newVisitor, productId: body.productId ?? null });
      if (newVisitor) {
        response.cookie(visitCookieName(store.slug), day, {
          httpOnly: true,
          sameSite: "lax",
          secure: config.cookieSecure,
          path: storefrontCookiePath(store.slug),
          maxAge: 24 * 60 * 60 * 1000,
        });
      }
      response.status(204).end();
    })
  );
}

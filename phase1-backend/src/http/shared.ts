import { config } from "../config.js";
import { effectiveStoreState } from "../services/availability.service.js";
import { touchSession } from "../services/session.service.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Options as MulterOptions } from "multer";
import { HttpError } from "../auth/auth.errors.js";
import { verifyTypedSession } from "../auth/identity.js";
import { assertMerchantOwnsHisPassword } from "../auth/staff-permissions.js";
import type { IdentityKind } from "../auth/redirects.js";
import { prisma } from "../db/prisma.js";
import {
  consumeStorefrontRateLimit,
  refundStorefrontRateLimit,
} from "../services/storefront.service.js";

import { clientIp } from "./client-ip.js";
import { WEB_SESSION_COOKIE, cookieValue, readWebSessionCookie } from "./session-cookie.js";

// Re-exported so every caller keeps importing its cookie helper from one place;
// the implementation moved to `session-cookie.ts` because `staff-permissions.ts`
// needs it too and cannot import this module (this one imports *it*).
export { cookieValue };

export const asyncRoute =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };

export function bearerToken(request: Request): string {
  const header = request.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const sessionCookie = readWebSessionCookie(request);
  if (sessionCookie) return sessionCookie;
  throw new HttpError(401, "MISSING_SESSION", "A session is required.");
}

export function customerCookieName(storeSlug: string) {
  return `codiq_customer_session_${storeSlug}`;
}
export function guestCartCookieName(storeSlug: string) {
  return `codiq_cart_${storeSlug}`;
}
export function storefrontCookiePath(storeSlug: string) {
  return `/api/store/${encodeURIComponent(storeSlug)}`;
}

export function customerToken(request: Request): string {
  const header = request.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const token = cookieValue(request, customerCookieName(request.params.storeSlug));
  if (token) return decodeURIComponent(token);
  throw new HttpError(401, "CUSTOMER_SESSION_REQUIRED", "A customer session is required.");
}

export function guestCartToken(request: Request): string | undefined {
  const token = cookieValue(request, guestCartCookieName(request.params.storeSlug));
  return token ? decodeURIComponent(token) : undefined;
}

export function setWebSession(response: Response, accessToken: string) {
  response.cookie(WEB_SESSION_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: 1000 * 60 * 60 * 8,
  });
}

/**
 * Phase 19: clears the dashboard cookie on sign-out.
 *
 * The attributes MUST match `setWebSession` exactly — a browser matches a
 * clear by name, path and domain, so a mismatched path leaves the cookie in
 * place and the person keeps sending a revoked token that answers 401 on every
 * request, with nothing on screen to explain why. D-63 added the NAME to that
 * list: both sides read `WEB_SESSION_COOKIE`, so the prefix cannot be on one
 * and off the other.
 */
export function clearWebSession(response: Response) {
  response.clearCookie(WEB_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
  });
}

export function setCustomerSession(response: Response, storeSlug: string, accessToken: string) {
  response.cookie(customerCookieName(storeSlug), accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: storefrontCookiePath(storeSlug),
    maxAge: 1000 * 60 * 60 * 8,
  });
}

export function setGuestCartCookie(
  response: Response,
  storeSlug: string,
  token: string,
  expiresAt: Date | null | undefined
) {
  response.cookie(guestCartCookieName(storeSlug), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: storefrontCookiePath(storeSlug),
    maxAge: Math.max(0, (expiresAt?.valueOf() ?? Date.now() + 7 * 86400000) - Date.now()),
  });
}

export function clearGuestCartCookie(response: Response, storeSlug: string) {
  response.clearCookie(guestCartCookieName(storeSlug), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: storefrontCookiePath(storeSlug),
  });
}

/**
 * ق-229 — the one branch of this guard that failed OPEN.
 *
 * `if (!origin) return;` was the whole hole: every write route on the platform
 * calls this function, and a request with no `Origin` header walked past all of
 * them. A browser omits `Origin` on some navigations and form posts, and an
 * attacker's page can arrange for one — so the guard that exists to stop
 * cross-site writes had a documented way around it.
 *
 * `Sec-Fetch-Site` is the answer OWASP's CSRF cheat sheet gives for exactly this
 * case, and it is a better header than `Origin` for the purpose: it is set by the
 * browser itself, is on the forbidden-header list so no script can forge it, and
 * every browser this platform serves sends it. When it says the request came from
 * another site, the write is refused whatever `Origin` did or did not say.
 *
 * Both absent is still allowed, deliberately: that is not a browser. The till's
 * offline queue, the integration suites, the owner's own curl and any future
 * server-to-server caller send neither header, and none of them is a CSRF victim
 * — CSRF is an attack ON a browser session, carried out THROUGH a browser.
 */
export function requireTrustedWriteOrigin(request: Request) {
  const origin = request.header("origin");
  if (!origin) {
    const fetchSite = request.header("sec-fetch-site");
    // `none` is the user himself: a typed address or a bookmark. `same-origin`
    // is our own page. Anything else — `cross-site`, `same-site` (a sibling
    // subdomain, which on this platform is another merchant's storefront) — is
    // refused.
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw new HttpError(
        403,
        "CSRF_ORIGIN_DENIED",
        "This write request did not originate from the trusted store origin."
      );
    }
    return;
  }
  const host = request.header("host");
  try {
    if (!host || new URL(origin).host !== host) throw new Error("mismatch");
  } catch {
    throw new HttpError(
      403,
      "CSRF_ORIGIN_DENIED",
      "This write request did not originate from the trusted store origin."
    );
  }
}

export async function limitStorefrontWrite(
  request: Request,
  scope: string,
  rawKey: string,
  limit: number
) {
  await consumeStorefrontRateLimit({
    scope,
    rawKey: `${request.params.storeSlug}:${rawKey}`,
    limit,
    windowMs: 10 * 60 * 1000,
  });
}

/**
 * ق-194 — a ceiling for callers who choose their own name.
 *
 * The anonymous storefront routes keyed their bucket on `guestCartToken`, which
 * is an unsigned cookie the CALLER sends. So the caller chose his own bucket:
 * rotate the cookie, get a fresh count of one, and the limit stopped existing.
 * That gave an unauthenticated actor unbounded `shopping_carts` inserts and
 * unbounded coupon-code enumeration against every store on the platform.
 *
 * Keying on the address alone was the obvious fix and is the wrong one here.
 * Iraqi mobile networks put a whole neighbourhood behind one address, and a
 * per-IP ceiling tight enough to stop a script would refuse real shoppers on a
 * busy evening — the failure this platform can least afford.
 *
 * So BOTH buckets are consumed. The caller's own token keeps its ordinary,
 * generous ceiling — useful because it separates honest shoppers from each other
 * — and a second, much wider bucket keyed on the ADDRESS, which the caller
 * cannot change, is the wall a rotating script actually hits. Neither alone is
 * enough: the first is forgeable, the second is shared.
 */
export async function limitStorefrontWriteWithAddressCeiling(
  request: Request,
  scope: string,
  rawKey: string,
  limit: number,
  addressLimit: number
) {
  await limitStorefrontWrite(request, scope, rawKey, limit);
  await consumeStorefrontRateLimit({
    scope: `${scope}_addr`,
    rawKey: `${request.params.storeSlug}:${clientIp(request)}`,
    limit: addressLimit,
    windowMs: 10 * 60 * 1000,
  });
}

/**
 * ق-224 — the two buckets above, given back.
 *
 * Built for the idempotent checkout REPLAY: a shopper on a 3G connection who
 * taps «تأكيد الطلب», loses the response, and taps again is asking to be shown
 * the order that already exists — Stripe's rule is that a replay is a read of a
 * saved result, not a new creation attempt. The bucket was consumed before the
 * request could reach the replay branch, so honest retries spent real budget
 * and the thirteenth was answered 429 instead of being handed his own order.
 * Same idiom as `refundStorefrontRateLimit`'s other callers: consume first, so
 * the ceiling still stands against a flood, and give it back when the request
 * turns out to be the one the ceiling was never meant to count.
 */
export async function refundStorefrontWriteWithAddressCeiling(
  request: Request,
  scope: string,
  rawKey: string
) {
  await refundStorefrontRateLimit({ scope, rawKey: `${request.params.storeSlug}:${rawKey}` });
  await refundStorefrontRateLimit({
    scope: `${scope}_addr`,
    rawKey: `${request.params.storeSlug}:${clientIp(request)}`,
  });
}

/**
 * 19-د (ATTACK-SURFACE) — how many uploads one authenticated actor may push
 * through an upload route in ten minutes.
 *
 * Deliberately generous: this is not a permission, it is the ceiling that stops
 * ONE credential from being the whole DoS. A merchant photographing a catalogue
 * uploads in the tens; sixty in ten minutes is far past any human pace and far
 * below what it takes to hurt the container.
 */
export const UPLOAD_ATTEMPT_LIMIT = 60;

/**
 * D-67 / CVE-2026-82333 — THE UPGRADE ALONE DOES NOT CLOSE IT.
 *
 * multer parses bracket notation in FIELD NAMES, so `items[4294967294]` makes
 * `append-field` allocate a sparse array of maximum length; a second field with
 * a non-numeric key on the same base then converts it to an object by iterating
 * that whole length, synchronously, on the event loop. One multipart request —
 * no account, no session, a few hundred bytes — and the single container that
 * serves the API, every dashboard and every storefront stops answering anyone.
 *
 * multer 2.3.0 added the two limits below but enforces each ONLY when the
 * option is present: `hasOwnProperty(limits, "fieldArrayIndexLimit")`. Bumping
 * the version and stopping there leaves the platform exactly as exposed as it
 * was, which is the trap this helper exists to remove — there are six multer
 * instances in the backend and «remember to add two keys to each» is not a rule
 * anybody keeps.
 *
 * ZERO IS CORRECT HERE, not a compromise. Every multipart field the platform
 * sends is a plain identifier — `file`, `image`, `images`, `prescription`,
 * `linkUrl`, `altText`, `placement` — and nothing anywhere sends a bracket. A
 * name with no bracket passes both checks (`0 > 0` is false); any bracketed
 * name at all is refused as a 422 by the MulterError branch in `errors.ts`.
 *
 * The type is written out because `@types/multer@1.4.13` predates both options,
 * and an object literal carrying them would be an excess-property error at each
 * call site. Returning a typed object rather than a literal is what lets the
 * six callers pass it straight to `limits`.
 */
export function uploadLimits(limits: {
  fileSize: number;
  files: number;
}): NonNullable<MulterOptions["limits"]> & {
  fieldArrayIndexLimit: number;
  fieldNestingDepth: number;
} {
  return { ...limits, fieldArrayIndexLimit: 0, fieldNestingDepth: 0 };
}

export async function limitUpload(scope: string, rawKey: string) {
  await consumeStorefrontRateLimit({
    scope,
    rawKey,
    limit: UPLOAD_ATTEMPT_LIMIT,
    windowMs: 10 * 60 * 1000,
  });
}

/**
 * 19-د (ATTACK-SURFACE) — authenticate BEFORE a single byte is buffered.
 *
 * multer reads the WHOLE multipart body into memory and only then calls
 * `next()`, so a guard written as the first line of the route HANDLER cannot
 * run until the bytes are already resident. On all four upload routes that
 * ordering meant an anonymous stranger — no account, no session, a store slug
 * and a product id he invented — could make the server hold up to 40 MB per
 * connection (8 files × 5 MB on the product-image route) and only then be told
 * 401. Twenty such connections OOM-kill the single container that serves the
 * API, the dashboard and every storefront at once.
 *
 * Lowering the byte cap would not have fixed it; the ORDER is the defect. So
 * the authorization moves into its own middleware slot ahead of the upload one.
 * An unauthenticated request is now refused having read nothing, and Node drops
 * the socket carrying the rest instead of buffering it.
 *
 * The handler keeps its own guard call. That is not duplicated bookkeeping: it
 * is where the route gets the resolved store/actor it actually works with, and
 * it means neither layer can be deleted later on the assumption that the other
 * one covers it. Both reads are idempotent.
 */
export function authenticatedUpload(
  authorize: (request: Request) => Promise<void>,
  upload: RequestHandler
): RequestHandler {
  return (request, response, next) => {
    // `.catch(next)` after the `.then`, not a second argument to it: written as
    // `.then(run, next)` a synchronous throw from `upload` would reject a
    // promise nobody is holding, and the request would hang until the socket
    // timed out instead of answering. Same reason `asyncRoute` is shaped this way.
    authorize(request)
      .then(() => {
        upload(request, response, next);
      })
      .catch(next);
  };
}

export function requireKind(expectedKind: IdentityKind) {
  return asyncRoute(async (request, response) => {
    const claims = await verifyTypedSession(bearerToken(request), expectedKind);
    response.status(200).json({ area: expectedKind, subjectId: claims.subjectId });
  });
}

export async function requirePlatformOwner(request: Request) {
  const claims = await verifyTypedSession(bearerToken(request), "platform_owner");
  // Phase 19: records that this session was used, and from what browser, so its
  // owner can recognise it in his own list. Fire-and-forget by design — a
  // bookkeeping write must never fail the request that triggered it.
  touchSession(claims, request);
  return claims;
}

export async function resolveStore(storeSlug: string) {
  const store = await prisma.store.findUnique({
    where: { slug: storeSlug },
    select: {
      id: true,
      slug: true,
      merchantId: true,
      isActive: true,
      status: true,
      statusMessage: true,
      maintenanceUntil: true,
      merchant: { select: { isActive: true } },
    },
  });
  if (!store) throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
  return store;
}

// Storefront surfaces must vanish entirely when the store or its merchant is disabled.
// ق-249: a store in MAINTENANCE still exists — its shell must draw the message —
// so the public config, logo and policy routes pass `allowMaintenance`; every
// other shopper route answers 423 STORE_IN_MAINTENANCE with the merchant's words.
export async function resolveStorefrontStore(
  storeSlug: string,
  options: { allowMaintenance?: boolean } = {}
) {
  const store = await resolveStore(storeSlug);
  if (!store.isActive || !store.merchant.isActive)
    throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
  // ق-250: the clock decides — a scheduled window that began closes the shop; an «until» that passed reopens it.
  const state = await effectiveStoreState(store);
  const effective = {
    ...store,
    status: state.status,
    statusMessage: state.message,
    maintenanceUntil: state.until,
  };
  if (effective.status === "maintenance" && !options.allowMaintenance) {
    throw new HttpError(
      423,
      "STORE_IN_MAINTENANCE",
      effective.statusMessage?.trim() || "المتجر مغلق للصيانة.",
      { until: effective.maintenanceUntil?.toISOString() ?? null }
    );
  }
  return effective;
}

export async function requireStorefrontCustomer(request: Request) {
  const claims = await verifyTypedSession(customerToken(request), "customer");
  const store = await resolveStorefrontStore(request.params.storeSlug);
  const customer = await prisma.customer.findFirst({
    where: { id: claims.subjectId, storeId: store.id, isActive: true },
    select: {
      id: true,
      storeId: true,
      fullName: true,
      email: true,
      phoneNormalized: true,
      isGuest: true,
    },
  });
  if (!customer)
    throw new HttpError(
      403,
      "STORE_BOUNDARY_DENIED",
      "This customer session does not belong to the requested store."
    );
  return { claims, store, customer };
}

/** Every merchant-session route that is not store-scoped enters through here (ق-218 — the gate itself lives in `auth/staff-permissions.ts`). */
export async function requireMerchantSession(request: Request) {
  const claims = await verifyTypedSession(bearerToken(request), "merchant");
  await assertMerchantOwnsHisPassword(claims.subjectId);
  return claims;
}

export async function requireMerchantStore(request: Request) {
  const claims = await verifyTypedSession(bearerToken(request), "merchant");
  await assertMerchantOwnsHisPassword(claims.subjectId);
  const store = await resolveStore(request.params.storeSlug);
  if (store.id !== claims.storeId || store.merchantId !== claims.subjectId) {
    throw new HttpError(
      403,
      "STORE_BOUNDARY_DENIED",
      "This merchant session is not authorized for the requested store."
    );
  }
  if (!store.merchant.isActive) {
    throw new HttpError(403, "MERCHANT_DISABLED", "This merchant account is disabled.");
  }
  return store;
}

export const requireCustomerStoreAccess = asyncRoute(async (request, response) => {
  const claims = await verifyTypedSession(bearerToken(request), "customer");
  const customer = await prisma.customer.findUnique({
    where: { id: claims.subjectId },
    select: { store: { select: { slug: true } } },
  });
  if (!customer || customer.store.slug !== request.params.storeSlug) {
    throw new HttpError(
      403,
      "STORE_BOUNDARY_DENIED",
      "This customer session does not belong to the requested store."
    );
  }
  response
    .status(200)
    .json({ area: "customer", storeSlug: customer.store.slug, subjectId: claims.subjectId });
});

/**
 * SCALE — the storefront's public reads, cacheable at the edge.
 *
 * These answers depend on the store and the URL only, never on who asks, so a
 * CDN (Cloudflare) may serve one copy to every shopper. Without it every page
 * view of every shop reached the database: `public-config` alone is seven
 * queries. Browsers keep it for `browserSeconds`, the edge for `edgeSeconds`,
 * and the edge may serve a stale copy for five minutes while it refreshes.
 *
 * Staleness is bounded and harmless by construction: stock, price, vacation
 * mode and maintenance are all re-checked by the server at checkout. A merchant
 * edit becomes visible to shoppers within `edgeSeconds`.
 *
 * NEVER use this on a route that reads a session — the reviews list marks the
 * viewer's own row, so it is deliberately not on this list.
 */
export function cachePublicStorefront(response: Response, edgeSeconds = 60, browserSeconds = 15) {
  response.setHeader(
    "cache-control",
    `public, max-age=${browserSeconds}, s-maxage=${edgeSeconds}, stale-while-revalidate=300`
  );
}

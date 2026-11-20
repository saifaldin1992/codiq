/**
 * المرحلة 20-4 — بادئة `/api/v1` بجوار `/api`، لا بدلاً منها.
 *
 * ONE APP, TWO DOORS. `server/index.ts` mounts the SAME `createApp()` instance
 * at both `API_MOUNT_V1` and `API_MOUNT_LEGACY`. Not two instances: one object
 * with two mount paths, so there is no universe in which the two prefixes can
 * answer differently. Every existing client keeps working byte-for-byte because
 * nothing about `/api` changed — a prefix was ADDED, not moved.
 *
 * ORDER MATTERS AND IS NOT A STYLE CHOICE. `/api/v1` must be mounted FIRST.
 * Express strips the mount path and matches the remainder, so a `/api` mount
 * registered first would claim `/api/v1/orders`, hand the app `/v1/orders`,
 * match no route, and answer the 404 net — a working prefix that 404s
 * everything, which is worse than no prefix at all.
 *
 * THE STOREFRONT IS NOT VERSIONED, PERMANENTLY. `/api/store/*` keeps exactly
 * one address. Three reasons, and the third is the one that actually forces it:
 *
 *   1. The audience is shoppers' browsers, not integrators. Nobody pins a
 *      version they never chose, and nobody upgrades one either.
 *   2. The offline till precaches storefront URLs into a service worker. A
 *      second address for the same data is a second cache key and a shop that
 *      sells the wrong stock after a deploy.
 *   3. THE CUSTOMER COOKIE IS PATH-SCOPED. `storefrontCookiePath()` scopes it
 *      to `/api/store/<slug>`, so a session opened through `/api/v1/store/<slug>`
 *      would set a cookie the browser then refuses to send back to that same
 *      `/api/v1/...` URL. The shopper would sign in, be told he succeeded, and
 *      be anonymous on the very next request. Widening the cookie path to `/`
 *      to «fix» it would hand every store on the platform every other store's
 *      customer cookie, which is the tenancy wall itself.
 *
 * So `/api/v1/store/*` is refused with the ordinary 404 envelope rather than
 * quietly working. A door that half-works is the failure mode this phase exists
 * to stop.
 */

/** The versioned mount. New integrations use this one. */
export const API_MOUNT_V1 = "/api/v1";

/**
 * The original mount. NOT deprecated and NOT scheduled for removal: it is the
 * only address of the public storefront, it is hard-coded in 130 places in the
 * dashboard bundle, and it is what every offline till already holds. See
 * `docs/API_VERSIONING.md` for the full posture.
 */
export const API_MOUNT_LEGACY = "/api";

/** The storefront prefix, as it appears INSIDE the app (mount path stripped). */
export const STOREFRONT_PREFIX = "/store";

/**
 * True for the public storefront surface only.
 *
 * `/stores/...` (plural) is deliberately NOT matched: it is a dashboard-cookie
 * probe, not a shopper route, and it carries no path-scoped cookie.
 */
export function isStorefrontPath(pathWithinApp: string): boolean {
  return pathWithinApp === STOREFRONT_PREFIX || pathWithinApp.startsWith(`${STOREFRONT_PREFIX}/`);
}

/**
 * 19-د (ATTACK-SURFACE) — the labels a merchant may not claim.
 *
 * THE ATTACK THIS CLOSES. `storeForHost` resolves a visitor's hostname by taking
 * its FIRST LABEL and matching it against `stores.default_subdomain`, and
 * `createStoreFoundation` copies the merchant's chosen slug into that column
 * verbatim. Deployment wires a wildcard `*.codiq.iq` at the app, and the SPA
 * redirects the root path of any non-app host to `/store/<slug>`. So a stranger
 * who posted `storeSlug: "www"` at the open registration endpoint owned
 * `www.codiq.iq`: every visitor who typed it was silently delivered to HIS
 * storefront — his name, his products, in CODIQ's own chrome — ending at a
 * cash-on-delivery form that collects the visitor's real name, phone and home
 * address. `codiq` took the apex the same way, since its first label is `codiq`.
 *
 * And the damage outlived the redirect: the slug is unique, so once squatted the
 * platform could never use that hostname again without surgery on the database.
 * Even in `manual` registration mode the store row is created inside the
 * transaction and only then deactivated — the name is burned while the redirect
 * sleeps.
 *
 * WHAT IS ON THE LIST, AND WHY THOSE. Three groups:
 *   1. hosts a browser or a person reaches by habit — `www`, and the apex label
 *      of the platform's own domain;
 *   2. names the platform serves itself from, now or plausibly next — the API,
 *      the dashboard, the admin surface, staging and the demo;
 *   3. names infrastructure answers to — mail, CDN and static asset hosts.
 *      A merchant holding `mail` is a merchant who can be handed traffic meant
 *      for the platform's own mail hostname.
 *
 * WHAT IS DELIBERATELY *NOT* ON IT: anything a real Iraqi shop might plausibly
 * be called. A deny-list that swallows ordinary shop names is a deny-list the
 * next person quietly shortens. Every entry here is infrastructure vocabulary.
 *
 * WHERE IT IS ENFORCED — four places, on purpose:
 *   · `registerMerchantWithStore` and `normalizedStoreSlug`, so the stranger and
 *     the merchant each meet a named Arabic refusal rather than a generic one;
 *   · `createStoreFoundation`, the single chokepoint every slug write passes
 *     through, so a future caller cannot forget;
 *   · a database trigger (`codiq_guard_reserved_store_slug`), which also covers
 *     the RENAME that no application path performs today but SQL always could.
 *   · plus `storeForHost`, which refuses to resolve a reserved label at all —
 *     the belt to those braces, and the half that protects a database where a
 *     squat was already planted before this shipped.
 *
 * EXISTING STORES ARE NOT RENAMED. The trigger fires on INSERT and on a slug
 * that actually CHANGES, so a row already carrying a reserved slug keeps it. A
 * platform that renames a merchant's public address behind his back to fix its
 * own oversight has traded one broken promise for another; the right answer is
 * to find such a store and talk to its owner.
 */
import { HttpError } from "../auth/auth.errors.js";

export const RESERVED_STORE_SLUGS: ReadonlySet<string> = new Set([
  // 1 — reached by habit, and the platform's own apex label.
  "www",
  "codiq",
  // 2 — surfaces the platform serves itself from.
  "api",
  "app",
  "admin",
  "dashboard",
  "platform",
  "staging",
  "demo",
  "status",
  "support",
  "help",
  "account",
  "accounts",
  "auth",
  "login",
  "register",
  "billing",
  "docs",
  "blog",
  // 3 — names infrastructure answers to.
  "mail",
  "smtp",
  "imap",
  "webmail",
  "cdn",
  "static",
  "assets",
  "media",
  "img",
  "images",
  "files",
  "ftp",
  "ns",
  "ns1",
  "ns2",
  "mx",
  "vpn",
  "test",
  "dev",
  "localhost",
]);

export function isReservedStoreSlug(value: string): boolean {
  return RESERVED_STORE_SLUGS.has(value.trim().toLowerCase());
}

/**
 * The one refusal. 422 rather than 409: the slug is not TAKEN by another
 * merchant — it is not on offer, and the difference is what the merchant needs
 * to hear so he picks a different name instead of contacting support about a
 * store he thinks exists.
 */
export function assertStoreSlugNotReserved(value: string): void {
  if (isReservedStoreSlug(value)) {
    throw new HttpError(422, "RESERVED_STORE_SLUG", "هذا الرابط محجوز للمنصة — اختر رابطاً آخر لمتجرك.");
  }
}

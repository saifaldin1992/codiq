/**
 * MD-1 «البحث الشامل الواحد» — one command-palette search for the merchant
 * dashboard. PG-6 (ق-74) moved its six ad-hoc `ILIKE` queries onto the Arabic
 * search engine.
 *
 * Security contract:
 *  - the ONLY input is the raw query string; every read is scoped by the
 *    `storeId` the route guard resolved from the session. No id, slug, or store
 *    hint from the client is ever trusted, so a cross-store lookup is
 *    structurally impossible.
 *  - PER-DOMAIN AUTHORIZATION. This endpoint spans three permission domains, so
 *    ONE guard cannot speak for all three: orders need `orders.view`, customers
 *    need `customers.view`, products need `catalog.products.view`. The route
 *    resolves the actor's full permission set once and passes the authorized
 *    scopes in; a scope that is not authorized is never queried and its key is
 *    absent from the payload entirely. The response declares which sections it
 *    carries in `scopes`, so "not permitted" can never be misread as "no
 *    results" (an empty array would say the opposite of the truth).
 *  - each kind returns at most 5 rows with exactly the fields the palette
 *    renders plus a dashboard-relative link target; nothing else leaks.
 *  - the minimum query length is 2 (shorter queries are refused with 422 rather
 *    than scanning the store), and the query is capped at 120 characters.
 *  - PG-6 / owner decision 2: the phone is MASKED to its last four digits here.
 *    The palette is the widest customer surface in the dashboard — it answers
 *    on every keystroke, to anyone holding `customers.view` — and the full
 *    number belongs on the customer's own record page, not in a dropdown. The
 *    deep link carries the same four digits, which the directory's phone probe
 *    accepts, so «click the palette row» still lands on the match.
 *
 * WHAT PG-6 CHANGED, AND WHY IT IS NOT A REWRITE. The queries now go through
 * `services/search`, which returns IDS AND RANKS ONLY; this file still owns the
 * hydration, the `select`, the PG-2 `...LIVE`, the per-kind cap, the `scopes` /
 * `truncated` contract and the response shape. The payload is byte-identical
 * apart from the masked phone. That is the whole point of the engine's
 * contract: 20-2 can sweep this envelope later without touching search.
 *
 * The Arabic fold is what the merchant actually notices: «احمد» now finds
 * «أحمد», «فاطمه» finds «فاطمة», «مصطفي» finds «مصطفى», a name pasted out of
 * WhatsApp with an embedded ZWNJ finds itself, and «٠٠١» finds `ORD-001`.
 * Ranking is `exact DESC, rank DESC, id DESC` — an exact substring always
 * outranks a fuzzy hit, so typo tolerance can never push the row the merchant
 * literally typed off the list.
 *
 * Index use — MEASURED, not assumed. Every statement is single-column and rides
 * a `GIN (<column> gin_trgm_ops)` index over the generated `search_*` column
 * (migration 20260904090000). `name ILIKE q OR sku ILIKE q` was measured on
 * 8,013 products at 39.4 ms with a Seq Scan against 1.0 ms with a Bitmap Index
 * Scan for the split query, which is why each column is its own statement and
 * the heads are merged here. `store_id` stays in every WHERE clause and is
 * applied as a heap filter over the trigram matches, so the work scales with
 * MATCHES rather than with store size.
 */
import type { PermissionCode } from "../auth/staff-permissions.js";
import { HttpError } from "../auth/auth.errors.js";
import { toE164 } from "../auth/identity.js";
import { prisma } from "../db/prisma.js";
import { maskPhoneToLastFour } from "../logging/redact.js";
import { LIVE } from "./soft-delete/constants.js";
import { inSearchOrder, mergeSearchPages, searchEngine, type SearchPage } from "./search/index.js";

export const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_MAX_QUERY_LENGTH = 120;
const SEARCH_LIMIT_PER_KIND = 5;

export const SEARCH_SCOPES = ["products", "orders", "customers"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** The single permission that authorizes each section of the payload. */
export const SEARCH_SCOPE_PERMISSIONS: Record<SearchScope, PermissionCode> = {
  products: "catalog.products.view",
  orders: "orders.view",
  customers: "customers.view",
};

/** An actor holding none of these has nothing to search and is refused outright. */
export const SEARCH_PERMISSIONS: readonly PermissionCode[] = SEARCH_SCOPES.map(
  (scope) => SEARCH_SCOPE_PERMISSIONS[scope]
);

export function authorizedSearchScopes(permissions: ReadonlySet<PermissionCode>): SearchScope[] {
  return SEARCH_SCOPES.filter((scope) => permissions.has(SEARCH_SCOPE_PERMISSIONS[scope]));
}

export function searchQuery(value: unknown): string {
  if (typeof value !== "string")
    throw new HttpError(422, "INVALID_SEARCH_QUERY", `أدخل حرفين على الأقل للبحث.`);
  const trimmed = value.trim();
  if (trimmed.length < SEARCH_MIN_QUERY_LENGTH)
    throw new HttpError(422, "INVALID_SEARCH_QUERY", "أدخل حرفين على الأقل للبحث.");
  if (trimmed.length > SEARCH_MAX_QUERY_LENGTH)
    throw new HttpError(
      422,
      "INVALID_SEARCH_QUERY",
      `الحد الأقصى لطول البحث ${SEARCH_MAX_QUERY_LENGTH} حرفاً.`
    );
  return trimmed;
}

/**
 * Prisma does NOT escape LIKE metacharacters inside `contains`, so a raw `%` or
 * `_` in the merchant's own query would act as a wildcard: `%%` would match the
 * whole store and «خصم 50%» would behave as a prefix search. This is not SQL
 * injection (no raw SQL exists here) — it is simply the wrong answer.
 *
 * PG-6: the search path no longer needs this, because `codiq_like_escape`
 * escapes the needle INSIDE the database, after normalization, where it can
 * never be forgotten. It stays exported for the Prisma `contains` filters that
 * are not search (and as the specification its SQL twin mirrors).
 */
export function escapeLikeNeedle(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Digits-only view of the query — but ONLY when the query actually looks like a
 * phone number. Stripping non-digits from *any* query made every two-digit run
 * inside ordinary text a phone probe: `AB-0001` used to surface the customer
 * whose phone merely contains `0001`. A phone-shaped query is an optional `+`
 * followed by digits and phone punctuation, carrying at least four digits.
 *
 * PG-6 / owner decision 2: EXPORTED, because this gate was added after a real
 * bug and the customer directory never had it — `phone: { contains: q }` on any
 * string. Every phone surface now calls this one function; carrying the gate
 * everywhere is the point, and re-implementing it is how the bug comes back.
 */
const PHONE_SHAPED_QUERY = /^\+?[0-9][0-9\s().-]*$/;
export const PHONE_MIN_DIGITS = 4;

export function phoneNeedle(query: string): string | null {
  if (!PHONE_SHAPED_QUERY.test(query)) return null;
  const digits = query.replace(/[^0-9]/g, "");
  if (digits.length < PHONE_MIN_DIGITS) return null;
  // ق-213 — THE FULL NUMBER AN IRAQI ACTUALLY WRITES MUST MATCH.
  //
  // Every column this needle is compared against holds E.164 —
  // `customers.phone_normalized` and `store_orders.recipient_phone` are both
  // written through `toE164`. The needle was the raw digits of what the merchant
  // typed, so `07701234567` (the form on the courier sheet, in the WhatsApp
  // thread, and the one the caller reads out) was compared against
  // `9647701234567` and matched NOTHING: the leading `0` is not in the stored
  // string. Partial needles worked, which is why this survived — the one query a
  // merchant is most likely to paste was the one query that silently failed, and
  // a silent miss is indistinguishable from «this customer is not in our system»,
  // which is how the duplicate rows get created.
  //
  // So the needle is produced by the SAME function the write path uses, and
  // falls back to the raw digits when the query is a fragment rather than a
  // whole number (`0770`, the last four digits) — those already match.
  const normalized = toE164(query);
  return normalized ? normalized.replace(/[^0-9]/g, "") : digits;
}

/**
 * Owner decision 2: the palette shows the last four digits and nothing else.
 * Four digits is what a merchant needs to recognise the courier's caller ID;
 * the full number is a `customers.view` field on the record page.
 *
 * D-41 (phase 24-أ) moved the implementation to `logging/redact.ts` and left
 * this re-export so every caller keeps its import. It is the SAME function, not
 * a copy: the structured logger has to mask a phone to exactly this shape, and
 * two implementations of «what a masked phone looks like» would drift — with
 * the drift landing as a full customer phone number on stdout.
 */
export { maskPhoneToLastFour };

export interface StoreSearchResults {
  query: string;
  /** Exactly the sections present in this payload — the authorized ones. */
  scopes: SearchScope[];
  /** Sections where more rows matched than the per-kind cap returned. */
  truncated: SearchScope[];
  products?: Array<{
    id: string;
    sku: string;
    name: string;
    priceIqd: number;
    isActive: boolean;
    href: string;
  }>;
  orders?: Array<{
    id: string;
    orderNumber: string;
    status: string;
    customerName: string;
    totalIqd: number;
    createdAt: Date;
    href: string;
  }>;
  customers?: Array<{ id: string; fullName: string; phone: string | null; href: string }>;
}

/** `null` means «this domain was not authorized at all», which is different from «no rows». */
type MaybePage = SearchPage | null;

async function merged(pages: readonly MaybePage[]): Promise<MaybePage> {
  const present = pages.filter((page): page is SearchPage => page !== null);
  if (!present.length) return null;
  return mergeSearchPages(present, SEARCH_LIMIT_PER_KIND);
}

export async function searchStore(
  store: { id: string; slug: string },
  rawQuery: unknown,
  scopes: readonly SearchScope[]
): Promise<StoreSearchResults> {
  const query = searchQuery(rawQuery);
  const phone = phoneNeedle(query);
  const dashboard = `/merchant/stores/${encodeURIComponent(store.slug)}/dashboard`;
  const allowed = new Set(scopes);
  // One extra row per kind is fetched purely to learn whether the cap hid
  // anything, so the palette can say so instead of implying "that is all".
  const request = { storeId: store.id, needle: query, limit: SEARCH_LIMIT_PER_KIND };

  const [
    productsByName,
    productsBySku,
    ordersByNumber,
    ordersByCustomerName,
    ordersByPhone,
    customersByName,
    customersByPhone,
  ] = await Promise.all([
    allowed.has("products") ? searchEngine.search("products.name", request) : null,
    allowed.has("products") ? searchEngine.search("products.sku", request) : null,
    allowed.has("orders") ? searchEngine.search("orders.orderNumber", request) : null,
    // PG-6, NEW CAPABILITY: until now nothing searched the customer's name on an
    // order, so a merchant holding a name and no order number could not find it.
    allowed.has("orders") ? searchEngine.search("orders.customerName", request) : null,
    allowed.has("orders") && phone
      ? searchEngine.search("orders.recipientPhone", { ...request, needle: phone })
      : null,
    allowed.has("customers") ? searchEngine.search("customers.fullName", request) : null,
    allowed.has("customers") && phone
      ? searchEngine.search("customers.phone", { ...request, needle: phone })
      : null,
  ]);

  const productPage = await merged([productsByName, productsBySku]);
  const orderPage = await merged([ordersByNumber, ordersByCustomerName, ordersByPhone]);
  const customerPage = await merged([customersByName, customersByPhone]);

  // Hydration. The engine handed over ids and ranks; the `select`, the store
  // scoping (again — belt and braces) and the PG-2 LIVE filter are this file's.
  const [products, orders, customers] = await Promise.all([
    productPage
      ? prisma.product.findMany({
          where: { id: { in: productPage.hits.map((hit) => hit.id) }, storeId: store.id, ...LIVE },
          select: { id: true, sku: true, name: true, priceIqd: true, isActive: true },
        })
      : null,
    orderPage
      ? prisma.storeOrder.findMany({
          where: { id: { in: orderPage.hits.map((hit) => hit.id) }, storeId: store.id },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            customerName: true,
            totalIqd: true,
            createdAt: true,
          },
        })
      : null,
    customerPage
      ? prisma.customer.findMany({
          where: { id: { in: customerPage.hits.map((hit) => hit.id) }, storeId: store.id },
          select: { id: true, fullName: true, phoneNormalized: true },
        })
      : null,
  ]);

  const truncated: SearchScope[] = [];
  const results: StoreSearchResults = {
    query,
    scopes: SEARCH_SCOPES.filter((scope) => allowed.has(scope)),
    truncated,
  };

  if (productPage && products) {
    if (productPage.hasMore) truncated.push("products");
    results.products = inSearchOrder(productPage.hits, products).map((product) => ({
      ...product,
      href: `${dashboard}/products?q=${encodeURIComponent(product.sku)}`,
    }));
  }
  if (orderPage && orders) {
    if (orderPage.hasMore) truncated.push("orders");
    results.orders = inSearchOrder(orderPage.hits, orders).map((order) => ({
      ...order,
      href: `${dashboard}/orders/${order.id}`,
    }));
  }
  if (customerPage && customers) {
    if (customerPage.hasMore) truncated.push("customers");
    results.customers = inSearchOrder(customerPage.hits, customers).map((customer) => {
      const masked = maskPhoneToLastFour(customer.phoneNormalized);
      // The deep link carries the LAST FOUR digits, not the whole number: they
      // are enough for the directory's 4-digit phone probe to land on this exact
      // customer, and putting the full number in an href would undo the mask a
      // line above it.
      const deepLink = customer.phoneNormalized
        ? customer.phoneNormalized.replace(/[^0-9]/g, "").slice(-PHONE_MIN_DIGITS)
        : customer.fullName;
      return {
        id: customer.id,
        fullName: customer.fullName,
        phone: masked,
        href: `${dashboard}/customers?q=${encodeURIComponent(deepLink)}`,
      };
    });
  }
  return results;
}

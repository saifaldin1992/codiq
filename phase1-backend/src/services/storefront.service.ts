import { commitLoyaltyRedemption, previewLoyaltyRedemption } from "./loyalty.service.js";
import { effectiveStoreState } from "./availability.service.js";
// ق-193: the one reason a release may still be settled at completion. Imported
// rather than re-typed so the sweep and the settlement can never disagree about
// the string — `reservation-expiry-job.ts` imports nothing from the services, so
// this direction carries no cycle.
import { RESERVATION_EXPIRY_RELEASE_REASON } from "./reservation-expiry-job.js";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  SERIALIZABLE_ATTEMPTS,
  isRetryableTransactionError,
  sleepBeforeRetry,
} from "../db/serializable-retry.js";
import { HttpError } from "../auth/auth.errors.js";
import { normalizePhone } from "../auth/identity.js";
import { prisma } from "../db/prisma.js";
import {
  enqueueLowStockIfCrossed,
  enqueueOrderCreated,
} from "../notifications/notification-outbox.service.js";
import {
  computeCouponDiscount,
  lockCouponForCheckout,
  normalizeCouponCode,
} from "./coupon.service.js";
import { assertWithinPlanLimit } from "./entitlement.service.js";
import { paymentMethodForCheckout } from "./payment-methods.service.js";
// 19-د: UUID_PATTERN moved out of this file so every keyset list validates its
// cursor the same way — see services/keyset-cursor.ts. 20-2 replaced the cursor
// helpers themselves with the one dialect in services/list-page.ts.
import { UUID_PATTERN } from "./keyset-cursor.js";
import { GOVERNORATE_KEYS, governorateLabel, toGovernorateKey } from "./governorates.js";
import {
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
  type ListCursor,
} from "./list-page.js";
import { searchEngine } from "./search/index.js";
import { LIVE } from "./soft-delete/constants.js";
import { domainEvents } from "../events/domain-events.js";
import { livePriceOf, livePrices } from "./live-price.js";
import {
  lockPlatformCouponForCheckout,
  markPlatformCouponUsed,
} from "./platform-rewards.service.js";

const GUEST_CART_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CART_QUANTITY = 99;
const CART_STATUS_ACTIVE = "active";

/**
 * What every cart read returns its lines with: the product with its first image, the
 * variant, the lines in the order they were added. One definition, not ten copies
 * (review batch 2, ر-٥ — three copies had lost the ordering).
 */
const CART_WITH_ITEMS = {
  items: {
    include: {
      product: {
        include: { images: { select: { id: true }, orderBy: { sortOrder: "asc" }, take: 1 } },
      },
      variant: true,
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.ShoppingCartInclude;

type CartContext = { customerId?: string; guestToken?: string };
type CheckoutInput = {
  idempotencyKey?: unknown;
  cartVersion?: unknown;
  addressId?: unknown;
  address?: unknown;
  paymentMethodCode?: unknown;
  couponCode?: unknown;
  note?: unknown;
  loyaltyPoints?: unknown;
  fulfilment?: unknown;
  platformCouponWalletId?: unknown;
  /** Marketplace M13a: set by the market's checkout only. */
  marketPayment?: "card" | "instalments" | "partner";
};

/**
 * PG-5 (ق-73) — what the customer asks for at checkout: «اتصل قبل الوصول»,
 * «هدية، لا تضع الفاتورة», «الشقة فوق الصيدلية». Daily requests in this market,
 * and today he has nowhere to put them — so he calls, or the courier arrives to
 * a locked door.
 *
 * Absent and empty are the SAME thing here (null), so a customer who opens the
 * field and types nothing is not different from one who never opened it. That
 * matters for the fingerprint below.
 */
export function normalizeCustomerNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new HttpError(422, "INVALID_ORDER_NOTE", "الملاحظة يجب أن تكون نصاً.");
  const note = value.trim();
  if (!note) return null;
  if (note.length > 500)
    throw new HttpError(422, "INVALID_ORDER_NOTE", "الملاحظة يجب ألا تتجاوز 500 حرف.");
  return note;
}

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function randomGuestToken() {
  return crypto.randomBytes(32).toString("base64url");
}
function nowPlusGuestLifetime() {
  return new Date(Date.now() + GUEST_CART_LIFETIME_MS);
}
function requiredText(value: unknown, field: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new HttpError(400, "INVALID_ADDRESS", `${field} is invalid.`);
  return value.trim();
}
function quantity(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CART_QUANTITY)
    throw new HttpError(
      422,
      "INVALID_CART_QUANTITY",
      `quantity must be an integer between 1 and ${MAX_CART_QUANTITY}.`
    );
  return parsed;
}
function expectedCartVersion(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new HttpError(400, "INVALID_CART_VERSION", "cartVersion must be a positive integer.");
  return parsed;
}
function idempotencyKey(value: unknown) {
  if (typeof value !== "string" || value.length < 16 || value.length > 200)
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 16 to 200 characters."
    );
  return value;
}
/**
 * PG-6 / owner decision 6: the public storefront search gets the SAME
 * two-character floor the merchant palette has had since MD-1, and the same
 * Arabic sentence (ق-96 — masculine address).
 *
 * It had a ceiling and no floor, on an UNAUTHENTICATED endpoint: a single
 * character carries no full trigram, so the index cannot serve it and the query
 * degrades to a scan of the store. That is the exact reason the palette's floor
 * exists; the shopper-facing surface had simply never been given one.
 */
function optionalProductQuery(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > 120)
    throw new HttpError(400, "INVALID_PRODUCT_FILTER", "Search query is invalid.");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < 2)
    throw new HttpError(422, "INVALID_SEARCH_QUERY", "أدخل حرفين على الأقل للبحث.");
  return trimmed;
}
function optionalCategoryId(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !UUID_PATTERN.test(value))
    throw new HttpError(400, "INVALID_PRODUCT_FILTER", "Category filter is invalid.");
  return value;
}
// 19-د: the shape rule this function WAS is now the shared one every list uses;
// the public product cursor keeps its own error code because the storefront
// client already distinguishes it from a bad page cursor.
/** The cursor's list kinds. One per list, so a cursor cannot cross lists. */
const PUBLIC_PRODUCTS_KIND = "storefront.products";
const PUBLIC_SEARCH_KIND = "storefront.products.search";
const CUSTOMER_ORDERS_KIND = "storefront.account.orders";

/**
 * How many ranked matches a storefront `q` may reach in total.
 *
 * Before 20-2 a search answered with ONE page and `nextCursor: null`, so a shop
 * with 300 shirts showed a shopper searching «قميص» the first 24 and told him
 * that was all of them. The engine's ranking is total and stable (its `id DESC`
 * tiebreaker makes it so, asserted by pg6 §8), so the ranked list can be
 * re-derived identically on every request and paged by POSITION — which is what
 * keeps relevance order, the one thing a shopper's search must not lose.
 */
const STOREFRONT_SEARCH_CAP = 200;

// ق-200: the front page's rails. Each is an ORDERING of the public list: ids are
// ranked here, then re-read through the same projection as every other card.
// Own cursor kinds, so a cursor from one rail can never page another.
const PUBLIC_BEST_SELLING_KIND = "storefront.products.best_selling";
const PUBLIC_TOP_RATED_KIND = "storefront.products.top_rated";
/** Nobody scrolls past four dozen of «the best» — and a rail is a handful anyway. */
const PUBLIC_RAIL_CAP = 48;
type PublicProductSort = "newest" | "best_selling" | "top_rated";

function optionalProductSort(raw: unknown): PublicProductSort {
  if (raw === undefined || raw === null || raw === "" || raw === "newest") return "newest";
  if (raw === "best_selling" || raw === "top_rated") return raw;
  throw new HttpError(
    422,
    "INVALID_PRODUCT_SORT",
    "sort must be newest, best_selling or top_rated."
  );
}

function categorySql(categoryIds: readonly string[] | undefined) {
  return categoryIds
    ? Prisma.sql`AND p.category_id IN (${Prisma.join(categoryIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
}

/**
 * Units sold per product, all time, platform-carried orders only — the same
 * two exclusions `analytics.service` applies: a cancelled or rejected order is
 * not a sale, and a counter sale (POS) never had a storefront.
 */
async function bestSellingIds(
  storeId: string,
  categoryIds: readonly string[] | undefined,
  cap: number
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string }>>(Prisma.sql`
    SELECT oi.product_id
      FROM order_items oi
      JOIN store_orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id AND p.store_id = o.store_id
     WHERE o.store_id = ${storeId}::uuid
       AND o.status NOT IN ('cancelled', 'rejected')
       AND o.source <> 'pos'
       AND oi.product_id IS NOT NULL
       AND p.is_active = true AND p.deleted_at IS NULL
       ${categorySql(categoryIds)}
     GROUP BY oi.product_id
     ORDER BY SUM(oi.quantity) DESC, MAX(p.name) ASC
     LIMIT ${cap}`);
  return rows.map((row) => row.product_id);
}

/**
 * Average rating per product (D-98): a withdrawn review does not count; a
 * hidden review's TEXT is hidden but its rating still counts, exactly as the
 * product page's own summary counts it. Ties break on how many rated it.
 */
async function topRatedIds(
  storeId: string,
  categoryIds: readonly string[] | undefined,
  cap: number
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ product_id: string }>>(Prisma.sql`
    SELECT r.product_id
      FROM product_reviews r
      JOIN products p ON p.id = r.product_id AND p.store_id = r.store_id
     WHERE r.store_id = ${storeId}::uuid
       AND r.withdrawn_at IS NULL
       AND p.is_active = true AND p.deleted_at IS NULL
       ${categorySql(categoryIds)}
     GROUP BY r.product_id
     ORDER BY AVG(r.rating) DESC, COUNT(*) DESC, MAX(p.name) ASC
     LIMIT ${cap}`);
  return rows.map((row) => row.product_id);
}
function cartPayload(cart: any) {
  return {
    id: cart.id,
    status: cart.status,
    version: cart.version,
    expiresAt: cart.expiresAt,
    ownerKind: cart.ownerKind,
    items: (cart.items ?? []).map((item: any) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      priceSnapshotIqd: item.priceSnapshotIqd,
      product: item.product
        ? {
            id: item.product.id,
            name: item.product.name,
            sku: item.product.sku,
            isActive: item.product.isActive,
            priceIqd: item.product.priceIqd,
            stockQuantity: item.product.stockQuantity,
            image: item.product.images?.[0] ?? null,
          }
        : null,
      variant: item.variant
        ? {
            id: item.variant.id,
            name: item.variant.name,
            sku: item.variant.sku,
            isActive: item.variant.isActive,
            priceIqd: item.variant.priceIqd,
            isDefault: item.variant.isDefault,
          }
        : null,
    })),
  };
}

/**
 * Refunds one attempt to a bucket, down to a floor of ONE — the table carries a
 * CHECK that the count stays >= 1, which the database enforced the first time
 * this ran. That floor is harmless: thirty successful sign-ins leave the bucket
 * at 1 instead of 30, which is the whole point.
 *
 * Used when the guarded action SUCCEEDED: a budget meant to slow guessing must
 * not be spent by people who guessed right.
 * Without this, one shared address — the ordinary case on Iraqi mobile networks
 * and in a shopping centre — locks out an honest merchant after thirty of his
 * neighbours sign in correctly.
 */
export async function refundStorefrontRateLimit(input: { scope: string; rawKey: string }) {
  const keyHash = hash(input.rawKey);
  await prisma.$executeRaw`
    UPDATE storefront_rate_limits SET attempt_count = GREATEST(attempt_count - 1, 1), updated_at = NOW()
    WHERE scope = ${input.scope} AND key_hash = ${keyHash}`;
}

/**
 * 19-د (ATTACK-SURFACE) — the ceiling on the two «prove you know the current
 * password» gates: `POST /auth/password` and `POST /platform/security/totp/disable`.
 *
 * Both re-verify a password and NEITHER had any ceiling at all: 60 consecutive
 * wrong guesses on a live session returned zero 429s. That voids the platform's
 * own written safety argument for its 8-character floor — password-policy.ts
 * says guessing «is bounded by the rate limit already on every login route» —
 * on precisely the two routes that re-verify a password and are not login
 * routes. And the second gate removes the owner's TOTP, the compensating
 * control that same note names as the reason the floor is acceptable for him.
 *
 * KEYED ON THE SUBJECT, NOT THE ADDRESS. The attacker in both cases already
 * HOLDS the victim's session — a borrowed unlocked laptop, a lifted token — so
 * an IP-keyed bucket throttles the wrong thing entirely.
 *
 * TEN, WITH A REFUND ON SUCCESS. The consume/refund pair `/auth/merchant/login`
 * uses: a person who types his own password correctly never spends budget, so
 * ten is generous for the honest case and ruinous for a grinder. It also caps
 * the second impact the finding carried — unmetered cost-12 bcrypt is a
 * CPU-exhaustion DoS against every tenant at once, reachable from any one
 * session of any identity kind. (Until D-36 it also BLOCKED the event loop;
 * now it burns the threadpool. The limiter is the answer in both worlds.)
 */
export const REAUTH_ATTEMPT_LIMIT = 10;
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export async function consumeStorefrontRateLimit(input: {
  scope: string;
  rawKey: string;
  limit: number;
  windowMs: number;
}) {
  const keyHash = hash(input.rawKey);
  const rows = await prisma.$queryRaw<Array<{ attempt_count: number }>>(Prisma.sql`
    INSERT INTO storefront_rate_limits (scope, key_hash, window_started_at, attempt_count, updated_at)
    VALUES (${input.scope}, ${keyHash}, NOW(), 1, NOW())
    ON CONFLICT (scope, key_hash) DO UPDATE
    SET window_started_at = CASE
          WHEN storefront_rate_limits.window_started_at <= NOW() - (${input.windowMs} * INTERVAL '1 millisecond') THEN NOW()
          ELSE storefront_rate_limits.window_started_at
        END,
        attempt_count = CASE
          WHEN storefront_rate_limits.window_started_at <= NOW() - (${input.windowMs} * INTERVAL '1 millisecond') THEN 1
          ELSE storefront_rate_limits.attempt_count + 1
        END,
        updated_at = NOW()
    RETURNING attempt_count
  `);
  if ((rows[0]?.attempt_count ?? input.limit + 1) > input.limit)
    throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please try again later.");
}

async function expireGuestCartIfNeeded(cart: any) {
  if (
    cart?.ownerKind === "guest" &&
    cart.status === CART_STATUS_ACTIVE &&
    cart.expiresAt &&
    cart.expiresAt <= new Date()
  ) {
    await prisma.shoppingCart.updateMany({
      where: { id: cart.id, status: CART_STATUS_ACTIVE },
      data: { status: "expired", version: { increment: 1 } },
    });
    return null;
  }
  return cart;
}

async function activeCartForContext(
  storeId: string,
  context: CartContext,
  createIfMissing: boolean
) {
  if (context.customerId) {
    let cart = await prisma.shoppingCart.findFirst({
      where: {
        storeId,
        customerId: context.customerId,
        ownerKind: "customer",
        status: CART_STATUS_ACTIVE,
      },
      include: CART_WITH_ITEMS,
    });
    if (!cart && createIfMissing)
      cart = await prisma.shoppingCart.create({
        data: { storeId, ownerKind: "customer", customerId: context.customerId },
        include: CART_WITH_ITEMS,
      });
    return { cart, issuedGuestToken: undefined as string | undefined };
  }
  const tokenHash = context.guestToken ? hash(context.guestToken) : undefined;
  let cart = tokenHash
    ? await prisma.shoppingCart.findFirst({
        where: {
          storeId,
          ownerKind: "guest",
          sessionTokenHash: tokenHash,
          status: CART_STATUS_ACTIVE,
        },
        include: CART_WITH_ITEMS,
      })
    : null;
  cart = await expireGuestCartIfNeeded(cart);
  if (!cart && createIfMissing) {
    const issuedGuestToken = randomGuestToken();
    cart = await prisma.shoppingCart.create({
      data: {
        storeId,
        ownerKind: "guest",
        sessionTokenHash: hash(issuedGuestToken),
        expiresAt: nowPlusGuestLifetime(),
      },
      include: CART_WITH_ITEMS,
    });
    return { cart, issuedGuestToken };
  }
  return { cart, issuedGuestToken: undefined as string | undefined };
}

function isAvailable(stockQuantity: number, reservedQuantity: number | undefined) {
  return stockQuantity - (reservedQuantity ?? 0) > 0;
}

export async function publicCategories(storeId: string) {
  // Nested category tree (2026-08-26): a category is public when it or any of
  // its descendants (max depth 3) carries an active product, so parents of
  // browsable subcategories stay visible even without direct products. Flat
  // categories keep the exact pre-hierarchy behavior.
  const withActiveProducts = { products: { some: { isActive: true } } } as const;
  return prisma.productCategory.findMany({
    where: {
      storeId,
      OR: [
        withActiveProducts,
        { children: { some: withActiveProducts } },
        { children: { some: { children: { some: withActiveProducts } } } },
      ],
    },
    select: { id: true, name: true, parentCategoryId: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Nested category tree (2026-08-26): a category filter includes the products of
 * every descendant category. Resolved iteratively level by level — store-scoped
 * at each hop and cheap because the service caps the tree at 3 levels.
 */
export async function categoryFilterIds(storeId: string, categoryId: string) {
  const ids = [categoryId];
  const seen = new Set(ids);
  let frontier = ids;
  while (frontier.length) {
    const children = await prisma.productCategory.findMany({
      where: { storeId, parentCategoryId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
    for (const id of frontier) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export async function publicProducts(
  storeId: string,
  rawLimit: unknown,
  rawCursor: unknown,
  rawCategoryId?: unknown,
  rawQuery?: unknown,
  rawSort?: unknown
) {
  const limit = parseListLimit(rawLimit, 100, 24);
  const categoryId = optionalCategoryId(rawCategoryId);
  const query = optionalProductQuery(rawQuery);
  // ق-200: the front page's rails are ORDERINGS of this one list, not lists of
  // their own — «الأكثر مبيعاً» and «الأعلى تقييماً» rank ids first and then
  // re-read them through the projection below, so a card is byte-identical
  // whichever rail it sits on. A search still answers in relevance order.
  const sort = optionalProductSort(rawSort);
  const categoryIds = categoryId ? await categoryFilterIds(storeId, categoryId) : undefined;
  const rankedKind = query
    ? PUBLIC_SEARCH_KIND
    : sort === "best_selling"
      ? PUBLIC_BEST_SELLING_KIND
      : sort === "top_rated"
        ? PUBLIC_TOP_RATED_KIND
        : null;
  // Two lists share this route and they are NOT interchangeable: an unfiltered
  // catalog paged by `(createdAt, id)`, and a ranked search paged by position
  // in the ranking. Each has its own kind, so a cursor cannot be carried from
  // one into the other — which would silently return the wrong page.
  const cursor = rankedKind
    ? await readListCursor(rankedKind, rawCursor)
    : await readListCursor(PUBLIC_PRODUCTS_KIND, rawCursor, {
        legacy: async (id) => {
          const row = await prisma.product.findFirst({
            where: { id, storeId, isActive: true },
            select: { createdAt: true },
          });
          return row ? { value: row.createdAt } : null;
        },
      });
  // PG-6 (ق-74): the `name OR description` filter is split into two
  // single-column engine statements — the planner refuses a BitmapOr across two
  // columns and falls straight back to a sequential scan (39.4 ms vs 1.0 ms on
  // 8,013 products, migration 20260827190000 lines 33-40) — and NAME OUTRANKS
  // DESCRIPTION: a shopper who types a product's name must get that product
  // first, not a different one that happens to mention the word in its blurb.
  // The search takes the WHOLE ranked list up to the cap, then serves the slice
  // this cursor asks for. Recomputing it per page is one indexed statement pair
  // and is what lets the answer stay in relevance order across pages.
  const rankedIds = query
    ? await storefrontSearchIds(storeId, query, STOREFRONT_SEARCH_CAP)
    : sort === "best_selling"
      ? await bestSellingIds(storeId, categoryIds, PUBLIC_RAIL_CAP)
      : sort === "top_rated"
        ? await topRatedIds(storeId, categoryIds, PUBLIC_RAIL_CAP)
        : undefined;
  const offset = rankedIds ? searchOffset(cursor) : 0;
  const searchIds = rankedIds?.slice(offset, offset + limit + 1);
  const where: Prisma.ProductWhereInput = {
    storeId,
    isActive: true,
    ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    ...(searchIds ? { id: { in: searchIds } } : {}),
    ...(searchIds ? {} : keysetWhere("createdAt", "desc", cursor)),
  };
  const rows = await prisma.product.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      category: { select: { id: true, name: true, parentCategoryId: true } },
      images: { select: { id: true, sortOrder: true }, orderBy: { sortOrder: "asc" }, take: 1 },
      variants: {
        where: { isActive: true },
        select: { id: true, priceIqd: true, stockQuantity: true },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  // A search answers in RELEVANCE order; the unfiltered catalog keeps its
  // `(createdAt, id)` keyset scroll byte for byte. One envelope either way.
  const ordered = searchIds ? orderProductsBySearch(searchIds, rows) : rows;
  const cut = pageOf(ordered, limit, (last) =>
    searchIds
      ? encodeListCursor(rankedKind ?? PUBLIC_SEARCH_KIND, offset + limit, last.id)
      : encodeListCursor(PUBLIC_PRODUCTS_KIND, last.createdAt, last.id)
  );
  const page = cut.page;
  // Phase 20A: availability is variant-level — a product is available when ANY
  // active variant still has unreserved stock; prices surface as a min–max range.
  const variantIds = page.flatMap((product) => product.variants.map((variant) => variant.id));
  const reservations = variantIds.length
    ? await prisma.inventoryReservation.groupBy({
        by: ["variantId"],
        where: { storeId, variantId: { in: variantIds }, status: "active" },
        _sum: { quantity: true },
      })
    : [];
  const reservedByVariant = new Map(
    reservations.map((reservation) => [reservation.variantId, reservation._sum.quantity ?? 0])
  );
  // Marketplace M8a: the range is of LIVE prices — an hourly deal shows where it runs.
  const livePriceByVariant = await livePrices(prisma, variantIds);
  return {
    products: page.map((product) => {
      const prices = product.variants.map(
        (variant) => livePriceByVariant.get(variant.id) ?? variant.priceIqd
      );
      return {
        id: product.id,
        name: product.name,
        sku: product.sku,
        description: product.description,
        priceIqd: product.priceIqd,
        minPriceIqd: prices.length ? Math.min(...prices) : product.priceIqd,
        maxPriceIqd: prices.length ? Math.max(...prices) : product.priceIqd,
        category: product.category,
        image: product.images[0] ?? null,
        // ق-200: the «جديد» badge is a client-side age threshold over this —
        // a stored flag goes stale and nobody clears it.
        createdAt: product.createdAt,
        requiresPrescription: product.requiresPrescription,
        isAvailable: product.variants.some((variant) =>
          isAvailable(variant.stockQuantity, reservedByVariant.get(variant.id))
        ),
        // Audit 12-أ: a card's quick «add» puts the DEFAULT variant in the cart.
        // With options to choose, «available» may mean another size is in stock,
        // so the card must send the shopper to choose instead of choosing for him.
        hasOptions: product.variants.length > 1,
      };
    }),
    nextCursor: cut.nextCursor,
  };
}

/**
 * Where in the ranking this page starts.
 *
 * The cursor's value is the offset and its id is the last row of the previous
 * page. The offset is bounded by the cap, so a forged cursor cannot become an
 * arbitrary skip — beyond the cap the list simply ends. A product created or
 * deactivated between two pages shifts the ranking by one row; that is the
 * ordinary cost of a live ranked list, it can repeat or drop a single row, and
 * it can never surface a row the filters exclude.
 */
function searchOffset(cursor: ListCursor | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor.value);
  if (!Number.isInteger(offset) || offset < 0 || offset > STOREFRONT_SEARCH_CAP) {
    throw new HttpError(
      400,
      "INVALID_CURSOR",
      "مؤشر الصفحة غير صالح — أعِد فتح القائمة من بدايتها."
    );
  }
  return offset;
}

/**
 * PG-6: the storefront's two search statements, name ranked above description.
 *
 * Merging by rank alone would let a product whose BLURB mentions «قميص» outrank
 * the product actually called «قميص», because an exact substring scores the
 * same in either column. So the two lists are concatenated rather than merged:
 * every name hit, in engine order, then the description-only hits behind them.
 */
async function storefrontSearchIds(
  storeId: string,
  needle: string,
  limit: number
): Promise<string[]> {
  const [byName, byDescription] = await Promise.all([
    searchEngine.search("products.name", { storeId, needle, limit }),
    searchEngine.search("products.description", { storeId, needle, limit }),
  ]);
  const ids = byName.hits.map((hit) => hit.id);
  const seen = new Set(ids);
  for (const hit of byDescription.hits)
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      ids.push(hit.id);
    }
  return ids.slice(0, limit);
}

/** Restores the engine's ranking after Prisma's `id IN (…)` returned the rows in its own order. */
function orderProductsBySearch<T extends { id: string }>(
  ids: readonly string[],
  rows: readonly T[]
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  // A hit with no row is normal, not an error: `isActive: true` and the category
  // filter legitimately drop rows the engine returned.
  for (const id of ids) {
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}

export async function publicProduct(storeId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, storeId, isActive: true },
    include: {
      category: { select: { id: true, name: true, parentCategoryId: true } },
      images: {
        select: { id: true, contentType: true, byteSize: true, sortOrder: true },
        orderBy: { sortOrder: "asc" },
      },
      variants: {
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!product)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "The requested product was not found in this store."
    );
  // Phase 20A: each variant reports its own availability without exposing raw
  // stock quantities to the public storefront.
  const reservations = product.variants.length
    ? await prisma.inventoryReservation.groupBy({
        by: ["variantId"],
        where: {
          storeId,
          variantId: { in: product.variants.map((variant) => variant.id) },
          status: "active",
        },
        _sum: { quantity: true },
      })
    : [];
  const reservedByVariant = new Map(
    reservations.map((reservation) => [reservation.variantId, reservation._sum.quantity ?? 0])
  );
  // Marketplace M8a: `priceIqd` is what the variant sells at now; `listPriceIqd` is set only while a deal lowers it.
  const livePriceByVariant = await livePrices(
    prisma,
    product.variants.map((variant) => variant.id)
  );
  const variants = product.variants.map((variant) => ({
    id: variant.id,
    name: variant.name,
    sku: variant.sku,
    priceIqd: livePriceByVariant.get(variant.id) ?? variant.priceIqd,
    listPriceIqd:
      (livePriceByVariant.get(variant.id) ?? variant.priceIqd) < variant.priceIqd
        ? variant.priceIqd
        : null,
    options: variant.options,
    position: variant.position,
    isDefault: variant.isDefault,
    isAvailable: isAvailable(variant.stockQuantity, reservedByVariant.get(variant.id)),
  }));
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    description: product.description,
    priceIqd: product.priceIqd,
    category: product.category,
    images: product.images,
    isActive: product.isActive,
    requiresPrescription: product.requiresPrescription,
    isAvailable: variants.some((variant) => variant.isAvailable),
    variants,
    createdAt: product.createdAt,
    attributes: product.attributes,
  };
}

export async function currentCart(storeId: string, context: CartContext) {
  const { cart } = await activeCartForContext(storeId, context, false);
  return cart
    ? cartPayload(cart)
    : {
        id: null,
        status: "empty",
        version: 0,
        expiresAt: null,
        ownerKind: context.customerId ? "customer" : "guest",
        items: [],
      };
}

/**
 * Marketplace M2: the merchant's per-order cap, refused when the shopper adds
 * rather than only at checkout (which re-checks under its lock). Counts every
 * variant of the product already in this cart.
 */
async function assertWithinOrderLimit(
  tx: Prisma.TransactionClient,
  cartId: string,
  productId: string,
  adding: number
) {
  // LIVE: a trashed product has no limit to apply — checkout's lock refuses it anyway.
  const product = await tx.product.findFirst({
    where: { id: productId, ...LIVE },
    select: { maxPerOrder: true },
  });
  if (!product?.maxPerOrder) return;
  const inCart = await tx.cartItem.aggregate({
    where: { cartId, productId },
    _sum: { quantity: true },
  });
  if ((inCart._sum.quantity ?? 0) + adding > product.maxPerOrder) {
    throw new HttpError(
      422,
      "ORDER_LIMIT_EXCEEDED",
      `الحدّ الأقصى لهذا المنتج ${product.maxPerOrder} لكل طلب.`,
      { maxPerOrder: product.maxPerOrder }
    );
  }
}

/**
 * The store's per-order cap, as a yes/no for a best-effort writer (review batch 2, ت-٦):
 * «أعد الطلب» skips a line over the cap instead of adding what checkout would refuse.
 */
async function withinOrderLimit(
  tx: Prisma.TransactionClient,
  cartId: string,
  line: { productId: string; quantity: number }
) {
  try {
    await assertWithinOrderLimit(tx, cartId, line.productId, line.quantity);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.code === "ORDER_LIMIT_EXCEEDED") return false;
    throw error;
  }
}

export async function addCartItem(
  storeId: string,
  context: CartContext,
  input: { productId?: unknown; variantId?: unknown; quantity?: unknown }
) {
  // Phase 20A: the cart line targets a variant. `variantId` is the primary input;
  // a bare `productId` (legacy storefront clients and pre-20A tests) resolves the
  // product's implicit default variant so single-variant products keep working
  // without any client change.
  const requestedVariantId = typeof input.variantId === "string" ? input.variantId : undefined;
  const requestedProductId = typeof input.productId === "string" ? input.productId : undefined;
  if (!requestedVariantId && !requestedProductId)
    throw new HttpError(400, "INVALID_PRODUCT", "productId or variantId is required.");
  const requestedQuantity = quantity(input.quantity);
  const variant = await prisma.productVariant.findFirst({
    where: requestedVariantId
      ? {
          id: requestedVariantId,
          storeId,
          isActive: true,
          ...(requestedProductId ? { productId: requestedProductId } : {}),
          product: { isActive: true },
        }
      : {
          productId: requestedProductId,
          storeId,
          isDefault: true,
          isActive: true,
          product: { isActive: true },
        },
  });
  if (!variant)
    throw new HttpError(
      404,
      "RESOURCE_NOT_FOUND",
      "The requested product was not found in this store."
    );
  const { cart, issuedGuestToken } = await activeCartForContext(storeId, context, true);
  if (!cart) throw new HttpError(500, "CART_CREATION_FAILED", "Cart could not be created.");
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.cartItem.findUnique({
      where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
    });
    const nextQuantity = (existing?.quantity ?? 0) + requestedQuantity;
    if (nextQuantity > MAX_CART_QUANTITY)
      throw new HttpError(
        422,
        "INVALID_CART_QUANTITY",
        `quantity cannot exceed ${MAX_CART_QUANTITY}.`
      );
    await assertWithinOrderLimit(tx, cart.id, variant.productId, requestedQuantity);
    // 19-د: adding to an existing line ALWAYS raises its quantity, so the line
    // is re-priced from the variant that was just read. See `updateCartItem`
    // for the rule and why it is bounded to increases.
    // Marketplace M8a: the snapshot is the LIVE price — an hourly deal's price while it runs.
    const livePrice = await livePriceOf(tx, variant.id, variant.priceIqd);
    if (existing)
      await tx.cartItem.update({
        where: { id: existing.id },
        data: { quantity: nextQuantity, priceSnapshotIqd: livePrice },
      });
    else
      await tx.cartItem.create({
        data: {
          cartId: cart.id,
          storeId,
          productId: variant.productId,
          variantId: variant.id,
          quantity: requestedQuantity,
          priceSnapshotIqd: livePrice,
        },
      });
    return tx.shoppingCart.update({
      where: { id: cart.id },
      data: {
        version: { increment: 1 },
        lastActivityAt: new Date(),
        ...(cart.ownerKind === "guest" ? { expiresAt: nowPlusGuestLifetime() } : {}),
      },
      include: CART_WITH_ITEMS,
    });
  });
  return { cart: cartPayload(updated), issuedGuestToken, guestExpiresAt: updated.expiresAt };
}

export async function updateCartItem(
  storeId: string,
  context: CartContext,
  itemId: string,
  rawQuantity: unknown
) {
  const requestedQuantity = quantity(rawQuantity);
  const { cart } = await activeCartForContext(storeId, context, false);
  if (!cart)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id, storeId } });
  if (!item)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  /**
   * 19-د — THE SNAPSHOT COVERS THE UNITS IT WAS TAKEN FOR.
   *
   * Freezing the price a shopper saw is a documented decision (PHASE9, CART-03:
   * checkout recomputes from `price_snapshot_iqd`, not from the current price),
   * and it stays. What was never decided is what happens when he then RAISES the
   * quantity on that frozen line: the snapshot silently extended a promotional
   * unit price to up to 98 further units he never added at that price, with no
   * cap and no revalidation — and a customer cart has no expiry, so the stale
   * line waits indefinitely for the next price rise. Reproduced at 450,000 IQD
   * taken from the merchant in a single order, under-booking the platform's
   * commission on the same sale.
   *
   * So: raising a line's quantity re-prices it from the live variant; lowering
   * or leaving it does not. Bounded to increases on purpose — a shopper
   * trimming his basket has not asked for anything new, and re-pricing him then
   * would take away the price he was promised for units he already had.
   *
   * A missing variant row leaves the snapshot alone; checkout's FOR UPDATE lock
   * refuses that line anyway (PRODUCT_UNAVAILABLE), which is the honest answer.
   */
  // ...LIVE is not decoration here: a TRASHED variant has no live price to
  // quote. Without it a soft-deleted line would be re-priced from a row the
  // shopper can no longer buy — and checkout's FOR UPDATE lock would then
  // refuse it anyway, after we had already rewritten his snapshot.
  const listed =
    requestedQuantity > item.quantity
      ? await prisma.productVariant.findFirst({
          where: { id: item.variantId, storeId, ...LIVE },
          select: { id: true, priceIqd: true },
        })
      : null;
  const livePriceIqd = listed ? await livePriceOf(prisma, listed.id, listed.priceIqd) : undefined;
  const updated = await prisma.$transaction(async (tx) => {
    if (requestedQuantity > item.quantity)
      await assertWithinOrderLimit(tx, cart.id, item.productId, requestedQuantity - item.quantity);
    await tx.cartItem.update({
      where: { id: item.id },
      data: {
        quantity: requestedQuantity,
        ...(livePriceIqd === undefined ? {} : { priceSnapshotIqd: livePriceIqd }),
      },
    });
    return tx.shoppingCart.update({
      where: { id: cart.id },
      data: {
        version: { increment: 1 },
        lastActivityAt: new Date(),
        ...(cart.ownerKind === "guest" ? { expiresAt: nowPlusGuestLifetime() } : {}),
      },
      include: CART_WITH_ITEMS,
    });
  });
  return cartPayload(updated);
}

export async function removeCartItem(storeId: string, context: CartContext, itemId: string) {
  const { cart } = await activeCartForContext(storeId, context, false);
  if (!cart)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id, storeId } });
  if (!item)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested cart item was not found.");
  await prisma.$transaction(async (tx) => {
    await tx.cartItem.delete({ where: { id: item.id } });
    await tx.shoppingCart.update({
      where: { id: cart.id },
      data: {
        version: { increment: 1 },
        lastActivityAt: new Date(),
        ...(cart.ownerKind === "guest" ? { expiresAt: nowPlusGuestLifetime() } : {}),
      },
    });
  });
}

export async function mergeGuestCartIntoCustomer(
  storeId: string,
  customerId: string,
  guestToken?: string
) {
  if (!guestToken) return currentCart(storeId, { customerId });
  const guestHash = hash(guestToken);
  let lastError: unknown;
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const guest = await tx.shoppingCart.findFirst({
            where: { storeId, ownerKind: "guest", sessionTokenHash: guestHash },
            include: { items: true },
          });
          if (
            !guest ||
            guest.status !== CART_STATUS_ACTIVE ||
            (guest.expiresAt && guest.expiresAt <= new Date())
          ) {
            if (guest?.status === CART_STATUS_ACTIVE)
              await tx.shoppingCart.update({
                where: { id: guest.id },
                data: { status: "expired", version: { increment: 1 } },
              });
            const customerCart = await tx.shoppingCart.findFirst({
              where: { storeId, customerId, ownerKind: "customer", status: CART_STATUS_ACTIVE },
              include: CART_WITH_ITEMS,
            });
            return customerCart
              ? cartPayload(customerCart)
              : {
                  id: null,
                  status: "empty",
                  version: 0,
                  expiresAt: null,
                  ownerKind: "customer",
                  items: [],
                };
          }
          let customerCart = await tx.shoppingCart.findFirst({
            where: { storeId, customerId, ownerKind: "customer", status: CART_STATUS_ACTIVE },
            include: { items: true },
          });
          if (!customerCart)
            customerCart = await tx.shoppingCart.create({
              data: { storeId, customerId, ownerKind: "customer" },
              include: { items: true },
            });
          for (const guestItem of guest.items) {
            const variant = await tx.productVariant.findFirst({
              where: { id: guestItem.variantId, storeId },
              select: {
                id: true,
                isActive: true,
                priceIqd: true,
                product: { select: { isActive: true } },
              },
            });
            const existing = await tx.cartItem.findUnique({
              where: {
                cartId_variantId: { cartId: customerCart.id, variantId: guestItem.variantId },
              },
            });
            const mergedQuantity = (existing?.quantity ?? 0) + guestItem.quantity;
            if (mergedQuantity > MAX_CART_QUANTITY)
              throw new HttpError(
                422,
                "INVALID_CART_QUANTITY",
                `Merged quantity cannot exceed ${MAX_CART_QUANTITY}.`
              );
            const snapshot =
              variant?.isActive && variant.product.isActive
                ? await livePriceOf(tx, variant.id, variant.priceIqd)
                : guestItem.priceSnapshotIqd;
            if (existing)
              await tx.cartItem.update({
                where: { id: existing.id },
                data: { quantity: mergedQuantity, priceSnapshotIqd: snapshot },
              });
            else
              await tx.cartItem.create({
                data: {
                  cartId: customerCart.id,
                  storeId,
                  productId: guestItem.productId,
                  variantId: guestItem.variantId,
                  quantity: guestItem.quantity,
                  priceSnapshotIqd: snapshot,
                },
              });
          }
          await tx.shoppingCart.update({
            where: { id: guest.id },
            data: {
              status: "merged",
              mergedIntoCartId: customerCart.id,
              version: { increment: 1 },
            },
          });
          const refreshed = await tx.shoppingCart.update({
            where: { id: customerCart.id },
            data: { version: { increment: 1 }, lastActivityAt: new Date() },
            include: CART_WITH_ITEMS,
          });
          return cartPayload(refreshed);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      lastError = error;
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && isRetryableTransactionError(error)) {
        await sleepBeforeRetry(attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function listAddresses(storeId: string, customerId: string) {
  return prisma.customerAddress.findMany({
    where: { storeId, customerId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      recipientName: true,
      fullAddress: true,
      city: true,
      governorate: true,
      phoneContactNormalized: true,
      isDefault: true,
      createdAt: true,
    },
  });
}

export async function createAddress(
  storeId: string,
  customerId: string,
  body: Record<string, unknown>
) {
  const recipientName = requiredText(body.recipientName, "recipientName", 240);
  const fullAddress = requiredText(body.fullAddress, "fullAddress", 1000);
  const city = requiredText(body.city, "city", 120);
  const governorate = requiredText(body.governorate, "governorate", 120);
  const phoneContactNormalized = normalizePhone(body.phoneContact);
  const isDefault = body.isDefault === true;
  return prisma.$transaction(async (tx) => {
    if (isDefault)
      await tx.customerAddress.updateMany({
        where: { storeId, customerId, isDefault: true },
        data: { isDefault: false },
      });
    const hasAddress = await tx.customerAddress.count({ where: { storeId, customerId } });
    return tx.customerAddress.create({
      data: {
        storeId,
        customerId,
        recipientName,
        fullAddress,
        city,
        governorate,
        phoneContactNormalized,
        isDefault: isDefault || hasAddress === 0,
      },
    });
  });
}

export async function updateAddress(
  storeId: string,
  customerId: string,
  addressId: string,
  body: Record<string, unknown>
) {
  const existing = await prisma.customerAddress.findFirst({
    where: { id: addressId, storeId, customerId },
  });
  if (!existing)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
  const data: Record<string, unknown> = {};
  if (body.recipientName !== undefined)
    data.recipientName = requiredText(body.recipientName, "recipientName", 240);
  if (body.fullAddress !== undefined)
    data.fullAddress = requiredText(body.fullAddress, "fullAddress", 1000);
  if (body.city !== undefined) data.city = requiredText(body.city, "city", 120);
  if (body.governorate !== undefined)
    data.governorate = requiredText(body.governorate, "governorate", 120);
  if (body.phoneContact !== undefined)
    data.phoneContactNormalized = normalizePhone(body.phoneContact);
  if (body.isDefault === true) {
    return prisma.$transaction(async (tx) => {
      await tx.customerAddress.updateMany({
        where: { storeId, customerId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.customerAddress.update({
        where: { id: existing.id },
        data: { ...data, isDefault: true },
      });
    });
  }
  return prisma.customerAddress.update({ where: { id: existing.id }, data });
}

export async function deleteAddress(storeId: string, customerId: string, addressId: string) {
  const existing = await prisma.customerAddress.findFirst({
    where: { id: addressId, storeId, customerId },
  });
  if (!existing)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
  await prisma.customerAddress.delete({ where: { id: existing.id } });
}

async function addressForCheckout(
  tx: Prisma.TransactionClient,
  storeId: string,
  customerId: string,
  input: CheckoutInput
) {
  if (typeof input.addressId === "string") {
    const address = await tx.customerAddress.findFirst({
      where: { id: input.addressId, storeId, customerId },
    });
    if (!address)
      throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
    return address;
  }
  if (!input.address || typeof input.address !== "object")
    throw new HttpError(400, "INVALID_ADDRESS", "A saved address or address payload is required.");
  const address = input.address as Record<string, unknown>;
  return tx.customerAddress.create({
    data: {
      storeId,
      customerId,
      recipientName: requiredText(address.recipientName, "recipientName", 240),
      fullAddress: requiredText(address.fullAddress, "fullAddress", 1000),
      city: requiredText(address.city, "city", 120),
      governorate: requiredText(address.governorate, "governorate", 120),
      phoneContactNormalized: normalizePhone(address.phoneContact),
      isDefault: false,
    },
  });
}

/**
 * ق-162 — the governorates THIS store delivers to, for an anonymous shopper.
 *
 * Public on purpose: a person choosing where to have something delivered has
 * not signed in yet, and asking him to register before he can see whether the
 * shop reaches his city is a door that loses him.
 *
 * It answers only what is ENABLED, which makes a second thing visible that used
 * to be silent: a brand-new store publishes its products the moment they are
 * created but delivers nowhere until the merchant sets his fees. The storefront
 * can now say that out loud instead of accepting a cart and refusing it at the
 * last step.
 */
export async function publicDeliveryAreas(storeId: string) {
  const rates = await prisma.deliveryRate.findMany({
    where: { storeId, isEnabled: true },
    select: { governorate: true, amountIqd: true },
  });
  const order = new Map(GOVERNORATE_KEYS.map((key, index) => [key, index]));
  return rates
    .map((rate) => ({
      key: rate.governorate,
      name: governorateLabel(rate.governorate),
      amountIqd: rate.amountIqd,
    }))
    .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
}

/**
 * ق-162 — resolves whatever was stored on the address to the KEY the rates use.
 *
 * The shopper now picks from a list, so new addresses already carry the key.
 * But an address saved before that carries whatever he typed — «بغداد», or
 * «بصرة» without its article — and refusing those would break checkout for the
 * very people the fix is for. `toGovernorateKey` maps them; anything it does
 * not recognise is passed through unchanged, so the failure stays «this store
 * does not deliver there» rather than «we could not read your address».
 */
async function deliveryRateForGovernorate(
  tx: Prisma.TransactionClient,
  storeId: string,
  governorate: string
) {
  const key = toGovernorateKey(governorate) ?? governorate;
  const rate = await tx.deliveryRate.findFirst({
    where: { storeId, governorate: key, isEnabled: true },
    select: { governorate: true, amountIqd: true },
  });
  if (!rate) {
    throw new HttpError(
      422,
      "DELIVERY_UNAVAILABLE_FOR_GOVERNORATE",
      `هذا المتجر لا يوصّل إلى ${governorateLabel(key)} حالياً. اختر محافظة أخرى أو تواصل مع المتجر.`
    );
  }
  return rate;
}

export async function deliveryQuote(storeId: string, customerId: string, addressId: string) {
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, storeId, customerId },
    select: { governorate: true },
  });
  if (!address)
    throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested address was not found.");
  return deliveryRateForGovernorate(prisma, storeId, address.governorate);
}

/**
 * Phase 20B-1: the normalized coupon code joins the fingerprint CONDITIONALLY —
 * the key is entirely ABSENT when no coupon is sent, so every fingerprint
 * computed before this deploy stays byte-identical (idempotent replays of
 * pre-deploy checkouts keep matching). A different coupon under the same
 * idempotency key therefore yields IDEMPOTENCY_KEY_REUSED.
 * Exported for the phase 20B-1 fingerprint unit assertions.
 */
export function checkoutFingerprint(input: CheckoutInput, cartVersion: number) {
  const couponCode = normalizeCouponCode(input.couponCode);
  // PG-5: the note joins CONDITIONALLY, exactly as the coupon code does — the
  // key is absent when no note is sent, so every fingerprint computed before
  // this deploy stays byte-identical and pre-deploy replays keep matching.
  //
  // ⚠️ A deliberate reading of the plan. Its acceptance criterion says the note
  // must be stored «بلا مساس ببصمة idempotency», which taken literally would
  // leave the note OUT. Its stated purpose is that existing fingerprints must not
  // break — and conditional inclusion achieves exactly that, which is why 20B-1
  // chose it for the coupon. Leaving the note out instead would mean a retry
  // carrying a DIFFERENT note silently returns the original order with the
  // original note: the customer would see his correction accepted and the
  // merchant would never receive it. Answering IDEMPOTENCY_KEY_REUSED is the
  // honest response to a genuinely different request.
  const note = normalizeCustomerNote(input.note);
  // CD-5: joins CONDITIONALLY, for the same reason the coupon and the note do —
  // a fingerprint computed before this deploy stays byte-identical, so replays
  // of pre-deploy checkouts keep matching. And a retry that redeems a DIFFERENT
  // number of points is a genuinely different request: answering
  // IDEMPOTENCY_KEY_REUSED is honest, where silently returning the original
  // order would spend points the shopper did not agree to spend this time.
  const loyaltyPoints =
    Number.isInteger(Number(input.loyaltyPoints)) && Number(input.loyaltyPoints) > 0
      ? Number(input.loyaltyPoints)
      : 0;
  // Marketplace M5: pick-up joins CONDITIONALLY too — delivery, the default, leaves every earlier fingerprint unchanged.
  const pickup = input.fulfilment === "pickup";
  // Marketplace M8b: a platform coupon joins CONDITIONALLY, like every term before it.
  const platformCoupon =
    typeof input.platformCouponWalletId === "string" && input.platformCouponWalletId
      ? input.platformCouponWalletId
      : null;
  return hash(
    JSON.stringify({
      cartVersion,
      addressId: typeof input.addressId === "string" ? input.addressId : null,
      address: input.address ?? null,
      paymentMethodCode: input.paymentMethodCode ?? "cod",
      ...(couponCode ? { couponCode } : {}),
      ...(note ? { note } : {}),
      ...(loyaltyPoints ? { loyaltyPoints } : {}),
      ...(pickup ? { fulfilment: "pickup" } : {}),
      ...(platformCoupon ? { platformCoupon } : {}),
    })
  );
}

/**
 * What an order's payment status is the moment it is placed (review batch 2, ر-٢ — this
 * was a five-level nested condition inside the order write).
 *   - a manual transfer waits for the merchant to confirm it;
 *   - the market's card waits for the gateway's signed notification;
 *   - the market's instalments are covered by the lender (delivery is cash);
 *   - the partner app has already taken the money;
 *   - everything else (cash at the door) is unpaid until delivery.
 */
const MARKET_PAYMENT_STATUS: Record<string, string> = {
  market_card: "awaiting_payment",
  market_instalments: "instalments",
  market_partner: "paid",
};
function initialPaymentStatus(method: { kind: string; code: string }): string {
  if (method.kind === "manual_transfer") return "awaiting_transfer";
  return MARKET_PAYMENT_STATUS[method.code] ?? "unpaid";
}

function orderNumber() {
  return `SF-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/** ق-221 — one refused cart line, in the words the shopper needs to fix it. */
export interface RefusedCartLine {
  cartItemId: string;
  variantId: string;
  productName: string | null;
  /** null for the default variant, which has no name a shopper would recognise. */
  variantName: string | null;
  requested: number;
  available: number;
  /** `order_limit`: the merchant caps this product per order (Marketplace M2); `available` is the cap. */
  reason: "unavailable" | "insufficient_stock" | "order_limit";
}

function refusedLine(
  item: { id: string; variantId: string; quantity: number },
  variant: { productName: string; name: string; isDefault: boolean } | undefined,
  reason: RefusedCartLine["reason"],
  available: number
): RefusedCartLine {
  return {
    cartItemId: item.id,
    variantId: item.variantId,
    productName: variant?.productName ?? null,
    variantName: variant && !variant.isDefault ? variant.name : null,
    requested: item.quantity,
    available,
    reason,
  };
}

/**
 * 19-د — internal signal, never an HTTP shape.
 *
 * The price check runs INSIDE the serializable transaction, because the only
 * price worth trusting is the one read under the same `FOR UPDATE` lock that
 * already guards the stock. But the correction it implies — writing the true
 * price back onto the cart — must survive, and that transaction is about to
 * roll back. So the transaction throws this, the retry loop recognises it, and
 * the correction plus the shopper-facing refusal happen outside.
 *
 * It is deliberately NOT an HttpError: `isRetryableTransactionError` must never
 * see it as a serialization failure and silently retry into the same refusal.
 */
export class CartPriceMoved extends Error {
  constructor(
    readonly cartId: string,
    readonly lines: { id: string; livePriceIqd: number; liveAddonsIqd: number }[]
  ) {
    super("CART_PRICE_CHANGED");
    this.name = "CartPriceMoved";
  }
}

/**
 * Writes the live price back onto the stale lines and bumps the cart version.
 *
 * This is what makes the refusal ACTIONABLE rather than a dead end (ق-132's
 * principle at the checkout button): the shopper is told the prices moved, and
 * the very next read of his cart shows what they moved to, so his second tap
 * confirms a number he has actually seen. Without it he would be refused,
 * re-read the same stale total, and be refused again.
 *
 * The version bump is the honest signal that the cart changed underneath him —
 * the client already refreshes and mints a new idempotency key on exactly that
 * class of refusal (`CART_VERSION_CONFLICT`).
 */
async function repriceStaleCartLines(
  storeId: string,
  cartId: string,
  lines: { id: string; livePriceIqd: number; liveAddonsIqd: number }[]
) {
  await prisma.$transaction(async (tx) => {
    for (const line of lines) {
      await tx.cartItem.updateMany({
        where: { id: line.id, cartId, storeId },
        data: { priceSnapshotIqd: line.livePriceIqd, addonsSnapshotIqd: line.liveAddonsIqd },
      });
    }
    await tx.shoppingCart.update({
      where: { id: cartId },
      data: { version: { increment: 1 }, lastActivityAt: new Date() },
    });
  });
}

/**
 * ق-201: the order an idempotency key already produced, or null. Guest checkout
 * asks this BEFORE merging the guest cart, because the merge bumps the cart
 * version the fingerprint below was computed with — a second tap on «تأكيد
 * الطلب» would otherwise read as different data under the same key.
 */
export async function priorSucceededCheckout(
  storeId: string,
  customerId: string,
  rawIdempotencyKey: unknown
) {
  const keyHash = hash(idempotencyKey(rawIdempotencyKey));
  const prior = await prisma.checkoutRequest.findUnique({
    where: { storeId_customerId_keyHash: { storeId, customerId, keyHash } },
    include: { order: { include: { items: true, statusEvents: true } } },
  });
  return prior?.status === "succeeded" && prior.order ? prior.order : null;
}

export async function checkout(storeId: string, customerId: string, input: CheckoutInput) {
  const cartVersion = expectedCartVersion(input.cartVersion);
  const rawKey = idempotencyKey(input.idempotencyKey);
  const keyHash = hash(rawKey);
  const couponCodeNormalized = normalizeCouponCode(input.couponCode);
  const fingerprint = checkoutFingerprint(input, cartVersion);
  let lastError: unknown;
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma
        .$transaction(
          async (tx) => {
            const prior = await tx.checkoutRequest.findUnique({
              where: { storeId_customerId_keyHash: { storeId, customerId, keyHash } },
              include: { order: { include: { items: true, statusEvents: true } } },
            });
            if (prior?.status === "succeeded" && prior.order) {
              if (prior.requestFingerprint !== fingerprint)
                throw new HttpError(
                  409,
                  "IDEMPOTENCY_KEY_REUSED",
                  "This idempotency key was used with different checkout data."
                );
              return { replayed: true, order: prior.order };
            }
            // MD-1: vacation mode refuses NEW checkouts only — browsing, the cart, and
            // idempotent replays of already-succeeded checkouts (returned above) stay
            // untouched. No money math or locking changes.
            //
            // KNOWN, ACCEPTED RACE (documented deliberately, not fixed). This read is
            // not serialized against `updateStoreVacation`: a checkout that reaches this
            // line microseconds before the merchant flips the switch commits, so the
            // merchant can see one extra order arrive right after turning vacation on.
            // It is benign — the failure mode is "one more order", never wrong money,
            // wrong stock, or a lost order — and closing it would mean locking the store
            // row inside the hot checkout path for every single checkout, for a window
            // measured in milliseconds. The merchant's own mental model ("orders already
            // in flight still land") matches the behaviour.
            // ق-249: the named status decides; `paused` keeps the MD-1 answer word for word.
            const gateRow = await tx.store.findFirst({
              where: { id: storeId },
              select: { id: true, status: true, statusMessage: true, maintenanceUntil: true },
            });
            // ق-250: the same clock the shell reads — a window that began refuses checkout with its own sentence.
            const gate = gateRow ? await effectiveStoreState(gateRow, new Date(), tx) : null;
            if (gate?.status === "paused")
              throw new HttpError(
                422,
                "STORE_ON_VACATION",
                "المتجر في إجازة مؤقتة ولا يستقبل طلبات جديدة حالياً."
              );
            if (gate?.status === "maintenance")
              throw new HttpError(
                423,
                "STORE_IN_MAINTENANCE",
                gate.message?.trim() || "المتجر مغلق للصيانة.",
                { until: gate.until?.toISOString() ?? null }
              );
            if (gate && gate.status !== "active")
              throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
            if (prior && prior.requestFingerprint !== fingerprint)
              throw new HttpError(
                409,
                "IDEMPOTENCY_KEY_REUSED",
                "This idempotency key was used with different checkout data."
              );
            const request =
              prior ??
              (await tx.checkoutRequest.create({
                data: {
                  storeId,
                  customerId,
                  keyHash,
                  requestFingerprint: fingerprint,
                  status: "processing",
                },
              }));
            const cart = await tx.shoppingCart.findFirst({
              where: { storeId, customerId, ownerKind: "customer", status: CART_STATUS_ACTIVE },
              include: { items: true },
            });
            if (!cart)
              throw new HttpError(
                409,
                "CART_ALREADY_CHECKED_OUT",
                "No active customer cart is available for checkout."
              );
            if (cart.version !== cartVersion)
              throw new HttpError(
                409,
                "CART_VERSION_CONFLICT",
                "The cart was changed by another request."
              );
            if (!cart.items.length) throw new HttpError(422, "CART_EMPTY", "Cart is empty.");
            // Phase 16: monthly order volume is a plan entitlement enforced server-side.
            //
            // ق-222 — CHECKED HERE, BEFORE ANY LOCK IS TAKEN. This used to run AFTER the
            // coupon row and every variant in the cart were locked FOR UPDATE, and
            // `merchantUsage` behind it fires six aggregates across every store the
            // merchant owns. Every millisecond a hot variant stays locked multiplies the
            // serialization retries of every other checkout on it — the Ramadan and
            // flash-sale pattern this platform will meet — until the six-attempt budget
            // runs out and a shopper sees TRANSACTION_CONTENTION. A read-only capacity
            // check belongs before the write locks, the same discipline the coupon
            // lock-order comment below applies to itself.
            const storeOwner = await tx.store.findUnique({
              where: { id: storeId },
              select: { merchantId: true },
            });
            if (!storeOwner)
              throw new HttpError(404, "STORE_NOT_FOUND", "The requested store does not exist.");
            // ق-216 — THE SHOPPER MUST NOT BE HANDED THE MERCHANT'S INVOICE.
            //
            // `assertWithinPlanLimit` throws 403 PLAN_LIMIT_EXCEEDED with a sentence
            // written for the merchant («تجاوزت حدّ خطتك… رقِّ اشتراكك»). Here the reader
            // is a stranger standing at the checkout of a shop that has hit its plan's
            // monthly order ceiling: he is told to upgrade a subscription he does not
            // have, and given no way forward. And this fires on the FIRST merchant who
            // succeeds — the 201st order of a good month — which is the merchant the
            // platform can least afford to lose. So the audience is split at the throw:
            // the shopper is told, in his own terms, that the shop is not taking orders
            // right now and to contact it. What the merchant is told is his own screens'
            // job, and every one of them still reads the true reason.
            try {
              await assertWithinPlanLimit(tx, storeOwner.merchantId, "max_monthly_orders");
            } catch (error) {
              if (error instanceof HttpError && error.code === "PLAN_LIMIT_EXCEEDED") {
                throw new HttpError(
                  409,
                  "STORE_NOT_ACCEPTING_ORDERS",
                  "المتجر لا يستقبل طلبات جديدة حالياً — تواصل مع المتجر."
                );
              }
              throw error;
            }
            const address = await addressForCheckout(tx, storeId, customerId, input);
            // Marketplace M5: a counter pick-up needs no courier — no rate, no fee — and
            // only a store that offers it (stores.pickup_enabled, which itself requires
            // the store's place on the map) may take one. The address still carries the
            // shopper's name and phone, which is how the store calls him to collect.
            const pickup = input.fulfilment === "pickup";
            if (
              input.fulfilment !== undefined &&
              input.fulfilment !== "pickup" &&
              input.fulfilment !== "delivery"
            )
              throw new HttpError(422, "INVALID_FULFILMENT", "طريقة الاستلام غير معروفة.");
            if (pickup) {
              const offers = await tx.store.findUnique({
                where: { id: storeId },
                select: { pickupEnabled: true },
              });
              if (!offers?.pickupEnabled)
                throw new HttpError(
                  422,
                  "PICKUP_NOT_AVAILABLE",
                  "هذا المتجر لا يتيح الاستلام من المتجر."
                );
            }
            const deliveryRate = pickup
              ? {
                  governorate: toGovernorateKey(address.governorate) ?? address.governorate,
                  amountIqd: 0,
                }
              : await deliveryRateForGovernorate(tx, storeId, address.governorate);
            // ق-209: any method the merchant switched on — cash at the door, or a
            // manual wallet transfer he named. `undefined` still means cash.
            const paymentMethod = await paymentMethodForCheckout(
              tx,
              storeId,
              input.paymentMethodCode,
              input.marketPayment
            );
            // Phase 20B-1 — FIXED GLOBAL LOCK ORDER: the coupon row is locked FOR UPDATE
            // BEFORE the ordered variant locks below. Every checkout acquires locks in
            // the same coupon→variants sequence, so no deadlock is possible. The
            // exactly-one-last-use guarantee is load-bearing on SERIALIZABLE isolation
            // (SSI aborts the losing reader with 40001, which the retry loop converts
            // to a clean re-read); the row lock alone would NOT be enough — do not
            // lower the isolation level. No coupon sent → this line is a no-op and
            // the transaction is byte-identical to 20A.
            const coupon = couponCodeNormalized
              ? await lockCouponForCheckout(tx, storeId, customerId, couponCodeNormalized)
              : null;
            // Phase 20A: stock, price, and the FOR UPDATE lock live on the variant. The
            // JOIN locks the variant AND its parent product together (FOR UPDATE OF v, p)
            // so the parent's is_active is a lock-fresh read — a concurrent deactivation
            // either waits for this checkout or forces a serialization retry that sees it.
            // Phase 20B-1: requires_prescription rides this SAME lock query (the only
            // checkout read the prescription feature adds).
            // PG-2: the `deleted_at IS NULL` predicates below are REDUNDANT with the
            // `*_deleted_implies_inactive` CHECK constraints — a trashed row can never
            // be is_active — and they are written out anyway so the protection is
            // VISIBLE where it is used instead of implicit two files away. A missing
            // row here lands in the same 422 PRODUCT_UNAVAILABLE as a deactivated one,
            // which is exactly what a shopper checking out mid-delete must see.
            const variantIds = [...cart.items.map((item) => item.variantId)].sort();
            // Marketplace M8a: `price_iqd` here is the LIVE price (codiq_live_price): the list
            // price, or an approved hourly deal's while its hour runs. A cart priced during
            // the hour and paid after it fails the snapshot check below and is re-priced.
            // 19-د: `v.price_iqd` joins the columns this lock already fetches. The price
            // that decides money must be read under the SAME lock as the stock that
            // decides availability — a price read outside it is a price that can move
            // between the read and the order.
            const lockedVariants = await tx.$queryRaw<
              Array<{
                id: string;
                product_id: string;
                sku: string;
                name: string;
                is_default: boolean;
                product_name: string;
                variant_active: boolean;
                product_active: boolean;
                requires_prescription: boolean;
                stock_quantity: number;
                price_iqd: number;
                max_per_order: number | null;
                is_preorder: boolean;
              }>
            >(Prisma.sql`
      SELECT v.id, v.product_id, v.sku, v.name, v.is_default, p.name AS product_name, v.is_active AS variant_active, p.is_active AS product_active, p.requires_prescription, v.stock_quantity, codiq_live_price(v.product_id, v.price_iqd, now()) AS price_iqd, p.max_per_order, p.is_preorder
      FROM product_variants v
      JOIN products p ON p.id = v.product_id AND p.store_id = v.store_id
      WHERE v.store_id = ${storeId}::uuid
        AND v.id IN (${Prisma.join(variantIds.map((variantId) => Prisma.sql`${variantId}::uuid`))})
        AND v.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY v.product_id ASC, v.id ASC
      FOR UPDATE OF v, p
    `);
            const variants = lockedVariants.map((variant) => ({
              id: variant.id,
              productId: variant.product_id,
              sku: variant.sku,
              name: variant.name,
              isDefault: variant.is_default,
              productName: variant.product_name,
              variantActive: variant.variant_active,
              productActive: variant.product_active,
              requiresPrescription: variant.requires_prescription,
              stockQuantity: variant.stock_quantity,
              priceIqd: variant.price_iqd,
              maxPerOrder: variant.max_per_order,
              isPreorder: variant.is_preorder,
            }));
            const variantById = new Map(variants.map((variant) => [variant.id, variant]));
            // ق-221 — THE REFUSAL NAMES THE LINE.
            //
            // «One or more cart products are unavailable» to a shopper with ten lines is
            // an instruction to fix something without being told what. A COD shopper
            // refused at the last step with nothing to act on does not edit his cart; he
            // closes the tab — there is no saved card pulling him back and no receipt
            // trail. So every refusal below carries `lines`: the product, the variant,
            // what he asked for and what is left, for EVERY offending line at once rather
            // than the first one found — the same shape `reorderIntoCart` already returns
            // as `skipped[]`. The codes and the sentences are unchanged; only `details`
            // grew, so no caller that read the code breaks.
            const unavailable = cart.items.filter((item) => {
              const variant = variantById.get(item.variantId);
              return !variant || !variant.productActive || !variant.variantActive;
            });
            if (unavailable.length) {
              throw new HttpError(
                422,
                "PRODUCT_UNAVAILABLE",
                "One or more cart products are unavailable.",
                {
                  lines: unavailable.map((item) =>
                    refusedLine(item, variantById.get(item.variantId), "unavailable", 0)
                  ),
                }
              );
            }
            const activeReservations = await tx.inventoryReservation.groupBy({
              by: ["variantId"],
              where: { storeId, variantId: { in: variantIds }, status: "active" },
              _sum: { quantity: true },
            });
            const reservedByVariant = new Map(
              activeReservations.map((reservation) => [
                reservation.variantId,
                reservation._sum.quantity ?? 0,
              ])
            );
            const short = cart.items.flatMap((item) => {
              const variant = variantById.get(item.variantId)!;
              // Marketplace M5: a pre-order is ordered BEFORE the stock arrives — that is
              // what it is. Its reservation is still written, so the units are spoken
              // for, and the order completes only once the merchant has the stock.
              if (variant.isPreorder) return [];
              const available = Math.max(
                0,
                variant.stockQuantity - (reservedByVariant.get(item.variantId) ?? 0)
              );
              return available < item.quantity
                ? [refusedLine(item, variant, "insufficient_stock", available)]
                : [];
            });
            if (short.length) {
              throw new HttpError(
                422,
                "INSUFFICIENT_AVAILABLE_STOCK",
                "One or more products do not have enough available stock.",
                { lines: short }
              );
            }
            // Marketplace M2: the merchant's per-order cap counts every variant of the
            // product together («حدّ أقصى ٢ لكل طلب» means two phones, whatever colour).
            // Read under the same lock as the stock, so a cap set mid-checkout applies.
            const unitsByProduct = new Map<string, number>();
            for (const item of cart.items) {
              const variant = variantById.get(item.variantId)!;
              unitsByProduct.set(
                variant.productId,
                (unitsByProduct.get(variant.productId) ?? 0) + item.quantity
              );
            }
            const overCap = cart.items.flatMap((item) => {
              const variant = variantById.get(item.variantId)!;
              return variant.maxPerOrder !== null &&
                (unitsByProduct.get(variant.productId) ?? 0) > variant.maxPerOrder
                ? [refusedLine(item, variant, "order_limit", variant.maxPerOrder)]
                : [];
            });
            if (overCap.length) {
              throw new HttpError(
                422,
                "ORDER_LIMIT_EXCEEDED",
                "One or more products exceed the quantity allowed per order.",
                { lines: overCap }
              );
            }
            /**
             * 19-د — THE SNAPSHOT IS RECONCILED WITH THE LOCKED PRICE BEFORE ANY MONEY
             * IS DECIDED.
             *
             * `priceSnapshotIqd` was captured when the line was created and NOTHING
             * revalidated it here: checkout summed the snapshot and stamped it as
             * `unitPriceIqd`, and the lock query above deliberately never selected
             * `v.price_iqd`. A customer cart has no expiry, so a line bought during a
             * promotion waited indefinitely for the merchant to restore his price —
             * and with the quantity raisable on that stale line, one order took
             * 450,000 IQD of goods for 50,000 and under-booked the platform's
             * commission on the same sale. The cart writers now re-price a line whose
             * quantity they raise, but a rule enforced only by three call sites is a
             * rule the fourth one breaks: this is the single place money is decided,
             * so this is where it is checked.
             *
             * IT REFUSES RATHER THAN RE-PRICING SILENTLY, in BOTH directions. Charging
             * the live price without asking would take more money than the shopper was
             * shown; honouring a snapshot below the live price takes it from the
             * merchant. Neither party may be moved without seeing the number, so the
             * order stops, the cart is corrected, and he confirms what he will pay.
             * That is not a failure and must not read like one: it is a named 422 with
             * a sentence naming the action, and `repriceStaleCartLines` has already
             * made the next tap succeed.
             */
            // Marketplace M5: paid add-ons, read inside the same transaction and held to
            // the same rule as the price — a removed add-on refuses the line by name, a
            // re-priced one is a moved price.
            const addonIds = Array.from(new Set(cart.items.flatMap((item) => item.addonIds)));
            const addonRows = addonIds.length
              ? await tx.productAddon.findMany({
                  where: { id: { in: addonIds }, storeId, isActive: true },
                  select: { id: true, productId: true, name: true, priceIqd: true },
                })
              : [];
            const addonById = new Map(addonRows.map((row) => [row.id, row]));
            const missingAddons = cart.items.filter((item) =>
              item.addonIds.some((id) => addonById.get(id)?.productId !== item.productId)
            );
            if (missingAddons.length) {
              throw new HttpError(
                422,
                "ADDON_UNAVAILABLE",
                "لم تعد بعض الإضافات المختارة متاحة. عدّل خياراتك ثم أكّد الطلب.",
                {
                  lines: missingAddons.map((item) =>
                    refusedLine(item, variantById.get(item.variantId), "unavailable", 0)
                  ),
                }
              );
            }
            const liveAddons = (item: { addonIds: string[] }) =>
              item.addonIds.reduce((sum, id) => sum + (addonById.get(id)?.priceIqd ?? 0), 0);
            const movedLines = cart.items
              .map((item) => ({
                id: item.id,
                snapshotIqd: item.priceSnapshotIqd,
                livePriceIqd: variantById.get(item.variantId)!.priceIqd,
                addonsSnapshotIqd: item.addonsSnapshotIqd,
                liveAddonsIqd: liveAddons(item),
              }))
              .filter(
                (line) =>
                  line.livePriceIqd !== line.snapshotIqd ||
                  line.liveAddonsIqd !== line.addonsSnapshotIqd
              );
            if (movedLines.length) throw new CartPriceMoved(cart.id, movedLines);
            // The add-ons are inside the line's unit price: one number the ledger, the
            // commission and every receipt already know how to read.
            const unitPrice = (item: { priceSnapshotIqd: number; addonsSnapshotIqd: number }) =>
              item.priceSnapshotIqd + item.addonsSnapshotIqd;
            const subtotalIqd = cart.items.reduce(
              (sum, item) => sum + item.quantity * unitPrice(item),
              0
            );
            // Phase 20B-1: discount = floor(subtotal*p/100) | min(amount, subtotal) | 0.
            // free_shipping zeroes the delivery fee ONLY (the waived amount is
            // snapshotted on the redemption) and never touches discount_iqd.
            const couponResult = coupon
              ? computeCouponDiscount(coupon, subtotalIqd)
              : { discountIqd: 0, freeShipping: false };
            const discountIqd = couponResult.discountIqd;
            const deliveryFeeIqd = couponResult.freeShipping ? 0 : deliveryRate.amountIqd;
            // CD-5: the redemption is priced and WRITTEN inside this transaction, after
            // the coupon, so points can never buy what the coupon already discounted.
            // The order id is not minted yet, so the spend row is written just below
            // with the order — see `redeemLoyaltyPoints`, which is called there.
            const loyaltyRequest =
              Number.isInteger(Number(input.loyaltyPoints)) && Number(input.loyaltyPoints) > 0
                ? Number(input.loyaltyPoints)
                : 0;
            const loyaltyPreview =
              loyaltyRequest > 0
                ? await previewLoyaltyRedemption(tx, {
                    storeId,
                    customerId,
                    requestedPoints: loyaltyRequest,
                    subtotalIqd,
                    couponDiscountIqd: discountIqd,
                  })
                : { points: 0, discountIqd: 0 };
            // Marketplace M8b: a PLATFORM coupon, on what is left after the store's own
            // coupon and points. The platform's cost — kept out of `discountIqd`, so it
            // lowers neither the commission base nor the store's payout. Its wallet row
            // is locked here, so two checkouts cannot both spend one coupon.
            const platformWalletId =
              typeof input.platformCouponWalletId === "string" && input.platformCouponWalletId
                ? input.platformCouponWalletId
                : null;
            const platformCoupon = platformWalletId
              ? await lockPlatformCouponForCheckout(tx, {
                  walletId: platformWalletId,
                  shopperId:
                    (
                      await tx.customer.findFirst({
                        where: { id: customerId, storeId },
                        select: { shopperId: true },
                      })
                    )?.shopperId ?? null,
                  storeId,
                  baseIqd: subtotalIqd - discountIqd - loyaltyPreview.discountIqd,
                  now: new Date(),
                })
              : null;
            const platformDiscountIqd = platformCoupon?.discountIqd ?? 0;
            // The delivery fee is deliberately OUTSIDE what points may cover: a courier
            // is paid in money whatever the shopper redeems.
            const totalIqd =
              subtotalIqd -
              discountIqd -
              loyaltyPreview.discountIqd -
              platformDiscountIqd +
              deliveryFeeIqd;
            // ASVS 5.0 V1.4.2: 99 units of a very expensive item can exceed the 32-bit
            // order columns; refuse it plainly instead of failing inside the write.
            if (subtotalIqd > 2_147_483_647 || totalIqd > 2_147_483_647) {
              throw new HttpError(
                422,
                "ORDER_TOTAL_TOO_LARGE",
                "مبلغ الطلب أكبر من المسموح لطلبٍ واحد — قسّمه على أكثر من طلب."
              );
            }
            const customer = await tx.customer.findFirst({
              where: { id: customerId, storeId },
              select: { fullName: true, email: true },
            });
            if (!customer)
              throw new HttpError(
                403,
                "STORE_BOUNDARY_DENIED",
                "Customer does not belong to this store."
              );
            // Phase 20B-1: a product requiring a prescription stamps the order into the
            // pending_upload state at creation; the upload itself happens after checkout.
            const requiresPrescription = variants.some((variant) => variant.requiresPrescription);
            const order = await tx.storeOrder.create({
              data: {
                storeId,
                customerId,
                loyaltyPointsSpent: loyaltyPreview.points,
                loyaltyDiscountIqd: loyaltyPreview.discountIqd,
                orderNumber: orderNumber(),
                status: "new",
                fulfilment: pickup ? "pickup" : "delivery",
                customerName: address.recipientName || customer.fullName,
                customerEmail: customer.email,
                customerNote: normalizeCustomerNote(input.note),
                recipientPhone: address.phoneContactNormalized,
                shippingGovernorate: address.governorate,
                shippingAddressLine1: address.fullAddress,
                shippingAddressLine2: address.city,
                subtotalIqd,
                deliveryFeeIqd,
                discountIqd,
                platformDiscountIqd,
                platformCouponWalletId:
                  platformCoupon && platformDiscountIqd > 0 ? platformCoupon.walletId : null,
                couponId: coupon?.id ?? null,
                couponCode: coupon?.code ?? null,
                prescriptionStatus: requiresPrescription ? "pending_upload" : null,
                totalIqd,
                paymentStatus: initialPaymentStatus(paymentMethod),
                paymentMethodCode: paymentMethod.code,
                source: "storefront",
                updatedByKind: "customer",
                items: {
                  create: cart.items.map((item) => {
                    const variant = variantById.get(item.variantId)!;
                    return {
                      productId: item.productId,
                      variantId: item.variantId,
                      sku: variant.sku,
                      productName: variant.productName,
                      variantName: variant.name,
                      quantity: item.quantity,
                      unitPriceIqd: unitPrice(item),
                      lineTotalIqd: item.quantity * unitPrice(item),
                      addons: item.addonIds.map((id) => {
                        const addon = addonById.get(id)!;
                        return { id, name: addon.name, priceIqd: addon.priceIqd };
                      }),
                    };
                  }),
                },
                statusEvents: {
                  create: {
                    storeId,
                    fromStatus: null,
                    toStatus: "new",
                    actorKind: "customer",
                    actorId: customerId,
                    note: null,
                  },
                },
              },
              include: { items: true, statusEvents: true },
            });
            // CD-5: the spend row is written the moment the order it belongs to exists,
            // inside the same transaction that priced it — so a checkout that fails
            // later can never leave a shopper charged points for an order he has not got.
            await commitLoyaltyRedemption(tx, {
              storeId,
              customerId,
              orderId: order.id,
              redemption: loyaltyPreview,
            });
            // Marketplace M8b: the platform coupon is spent with the order or not at all.
            if (platformCoupon && platformDiscountIqd > 0)
              await markPlatformCouponUsed(tx, platformCoupon.walletId, order.id, new Date());
            // Phase 20B-1: the append-only redemption commits or rolls back with the
            // order; UNIQUE(order_id) makes "one coupon per order" structural.
            if (coupon)
              await tx.couponRedemption.create({
                data: {
                  storeId,
                  couponId: coupon.id,
                  orderId: order.id,
                  customerId,
                  discountIqd,
                  waivedDeliveryFeeIqd: couponResult.freeShipping ? deliveryRate.amountIqd : 0,
                },
              });
            await tx.inventoryReservation.createMany({
              data: cart.items.map((item) => ({
                storeId,
                orderId: order.id,
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                status: "active",
              })),
            });
            const converted = await tx.shoppingCart.updateMany({
              where: {
                id: cart.id,
                storeId,
                customerId,
                status: CART_STATUS_ACTIVE,
                version: cartVersion,
              },
              data: { status: "converted", convertedOrderId: order.id, version: { increment: 1 } },
            });
            if (converted.count !== 1)
              throw new HttpError(
                409,
                "CART_VERSION_CONFLICT",
                "The cart was changed by another request."
              );
            await tx.checkoutRequest.update({
              where: { id: request.id },
              data: { status: "succeeded", orderId: order.id },
            });
            // Phase 15: the notification row commits or rolls back with the order itself.
            await enqueueOrderCreated(tx, {
              storeId,
              orderId: order.id,
              orderNumber: order.orderNumber,
              totalIqd: order.totalIqd,
              customerName: order.customerName,
              customerEmail: order.customerEmail,
            });
            return { replayed: false, order };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        )
        .then((result) => {
          // After commit, and only for a NEW order — an idempotent replay announces nothing.
          if (!result.replayed)
            domainEvents.emit("order.created", {
              storeId,
              orderId: result.order.id,
              orderNumber: result.order.orderNumber,
              source: "storefront",
              totalIqd: result.order.totalIqd,
            });
          return result;
        });
    } catch (error) {
      lastError = error;
      // 19-د: a price that moved is not a busy server, so it never enters the
      // retry budget — retrying would only reach the same refusal three times.
      // The cart is corrected first so the refusal below is one tap from done.
      if (error instanceof CartPriceMoved) {
        await repriceStaleCartLines(storeId, error.cartId, error.lines);
        throw new HttpError(
          422,
          "CART_PRICE_CHANGED",
          "تغيّرت أسعار بعض منتجات سلتك قبل التأكيد. حدّثنا السلة بالأسعار الحالية — راجع الملخص ثم أكّد الطلب."
        );
      }
      // A shopper who taps «تأكيد الطلب» during a busy minute must not be told
      // the server failed. Same budget and jitter as the till (ق-132's
      // principle applies to the checkout button too).
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && isRetryableTransactionError(error)) {
        await sleepBeforeRetry(attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function customerOrders(
  storeId: string,
  customerId: string,
  rawLimit: unknown,
  rawCursor: unknown
) {
  const limit = parseListLimit(rawLimit);
  // 20-2: an opaque `(createdAt, id)` keyset. This was the door that needed no
  // merchant permission at all — any signed-in shopper could turn one query
  // parameter into an unhandled 500 — and with the keyset there is no anchor
  // read left to mishandle. `legacy:` still resolves a pre-20-2 bare order id
  // inside THIS shopper own orders, so it proves nothing about anyone else.
  const cursor = await readListCursor(CUSTOMER_ORDERS_KIND, rawCursor, {
    legacy: async (id) => {
      const row = await prisma.storeOrder.findFirst({
        where: { id, storeId, customerId },
        select: { createdAt: true },
      });
      return row ? { value: row.createdAt } : null;
    },
  });
  const rows = await prisma.storeOrder.findMany({
    where: { storeId, customerId, ...keysetWhere("createdAt", "desc", cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalIqd: true,
      createdAt: true,
      statusUpdatedAt: true,
    },
  });
  const { page, nextCursor } = pageOf(rows, limit, (last) =>
    encodeListCursor(CUSTOMER_ORDERS_KIND, last.createdAt, last.id)
  );
  return { orders: page, nextCursor };
}

export async function customerOrder(storeId: string, customerId: string, orderId: string) {
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId, customerId },
    include: {
      items: {
        select: {
          id: true,
          productName: true,
          variantId: true,
          variantName: true,
          sku: true,
          quantity: true,
          unitPriceIqd: true,
          lineTotalIqd: true,
        },
      },
      statusEvents: {
        select: { fromStatus: true, toStatus: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found.");
  return order;
}

/**
 * CD-1c — «اطلبه مجدداً»: one-click reorder from the customer's own history.
 *
 * BEST-EFFORT BY CONTRACT. A reorder never fails as a whole because one line
 * went stale; every line that cannot be added is reported honestly in `skipped`
 * with the reason, and everything else lands in the cart. The three reasons are:
 *
 *   product_unavailable — the variant (or its parent product) was deleted or
 *                         deactivated since the order, or the historical line
 *                         carries no variant at all (legacy/manual orders);
 *   insufficient_stock  — available stock (stock minus active reservations) is
 *                         below the line quantity;
 *   quantity_limit      — the cart already holds this variant and the combined
 *                         quantity would exceed MAX_CART_QUANTITY.
 *
 * The names in `skipped` come from the LIVE variant when it still exists and
 * from the order-line snapshot when it does not, so a deleted product is still
 * nameable to the customer.
 *
 * Checkout is untouched and remains the sole authority on availability: this is
 * a cart convenience, and its stock read is advisory exactly like the catalog's.
 * Prices use the CURRENT variant price, matching addCartItem.
 */
export type ReorderSkipReason = "product_unavailable" | "insufficient_stock" | "quantity_limit";
export type ReorderSkip = {
  productName: string;
  variantName: string | null;
  reason: ReorderSkipReason;
};

export async function reorderIntoCart(storeId: string, customerId: string, orderId: string) {
  // Ownership AND store scope are part of the same equality match, so another
  // customer's order and another store's order are both a plain 404.
  const order = await prisma.storeOrder.findFirst({
    where: { id: orderId, storeId, customerId },
    select: {
      id: true,
      items: {
        select: { variantId: true, quantity: true, productName: true, variantName: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The requested order was not found.");

  const skipped: ReorderSkip[] = [];
  // Historical orders can, in principle, carry the same variant twice; merge
  // them so the cart line is computed once against stock.
  const requested = new Map<
    string,
    { variantId: string; quantity: number; productName: string; variantName: string | null }
  >();
  for (const item of order.items) {
    if (!item.variantId) {
      skipped.push({
        productName: item.productName,
        variantName: item.variantName,
        reason: "product_unavailable",
      });
      continue;
    }
    const merged = requested.get(item.variantId);
    if (merged) merged.quantity += item.quantity;
    else
      requested.set(item.variantId, {
        variantId: item.variantId,
        quantity: item.quantity,
        productName: item.productName,
        variantName: item.variantName,
      });
  }

  const variantIds = Array.from(requested.keys());
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: variantIds }, storeId },
        select: {
          id: true,
          productId: true,
          name: true,
          isActive: true,
          priceIqd: true,
          stockQuantity: true,
          product: { select: { name: true, isActive: true } },
        },
      })
    : [];
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const reservations = variantIds.length
    ? await prisma.inventoryReservation.groupBy({
        by: ["variantId"],
        where: { storeId, variantId: { in: variantIds }, status: "active" },
        _sum: { quantity: true },
      })
    : [];
  const reservedByVariant = new Map(
    reservations.map((reservation) => [reservation.variantId, reservation._sum.quantity ?? 0])
  );

  const additions: Array<{
    variantId: string;
    productId: string;
    priceIqd: number;
    quantity: number;
    productName: string;
    variantName: string | null;
  }> = [];
  const livePriceByVariant = await livePrices(prisma, Array.from(variantById.keys()));
  for (const line of Array.from(requested.values())) {
    const variant = variantById.get(line.variantId);
    if (!variant || !variant.isActive || !variant.product.isActive) {
      skipped.push({
        productName: variant?.product.name ?? line.productName,
        variantName: variant?.name ?? line.variantName,
        reason: "product_unavailable",
      });
      continue;
    }
    if (variant.stockQuantity - (reservedByVariant.get(variant.id) ?? 0) < line.quantity) {
      skipped.push({
        productName: variant.product.name,
        variantName: variant.name,
        reason: "insufficient_stock",
      });
      continue;
    }
    additions.push({
      variantId: variant.id,
      productId: variant.productId,
      priceIqd: livePriceByVariant.get(variant.id) ?? variant.priceIqd,
      quantity: line.quantity,
      productName: variant.product.name,
      variantName: variant.name,
    });
  }

  // Everything went stale: report honestly against the cart the customer already
  // has, without creating an empty one.
  if (!additions.length)
    return { cart: await currentCart(storeId, { customerId }), skipped, addedCount: 0 };

  const { cart } = await activeCartForContext(storeId, { customerId }, true);
  if (!cart) throw new HttpError(500, "CART_CREATION_FAILED", "Cart could not be created.");
  const result = await prisma.$transaction(async (tx) => {
    const limitSkips: ReorderSkip[] = [];
    let addedCount = 0;
    for (const addition of additions) {
      const existing = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId: addition.variantId } },
      });
      const nextQuantity = (existing?.quantity ?? 0) + addition.quantity;
      if (nextQuantity > MAX_CART_QUANTITY || !(await withinOrderLimit(tx, cart.id, addition))) {
        limitSkips.push({
          productName: addition.productName,
          variantName: addition.variantName,
          reason: "quantity_limit",
        });
        continue;
      }
      // LOY-1: a reorder onto an EXISTING line re-prices it, exactly as
      // `addCartItem` does. The product call 19-د deferred is made: reorder was
      // the last route by which a stale snapshot could be stretched over more
      // units, and it is closed.
      //
      // The money argument was already settled by 19-د — checkout refuses any
      // line whose snapshot no longer matches the live price (CART_PRICE_CHANGED)
      // — so what is left is the shopper's experience, and it is the whole
      // reason to change this. He taps «أعد الطلب», is handed a cart built on a
      // price that no longer exists, and is refused at the till with no way to
      // see what went wrong. Re-pricing here gives him a cart that is simply
      // correct, priced from the same read that decided the line was available.
      if (existing)
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity: nextQuantity, priceSnapshotIqd: addition.priceIqd },
        });
      else
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            storeId,
            productId: addition.productId,
            variantId: addition.variantId,
            quantity: addition.quantity,
            priceSnapshotIqd: addition.priceIqd,
          },
        });
      addedCount += 1;
    }
    // Nothing was actually added (every addition hit the quantity cap): read the
    // cart back untouched instead of bumping its version, which would look like
    // success to the client and could break a concurrent checkout's cartVersion.
    if (!addedCount) {
      const unchanged = await tx.shoppingCart.findUniqueOrThrow({
        where: { id: cart.id },
        include: CART_WITH_ITEMS,
      });
      return { updated: unchanged, limitSkips, addedCount };
    }
    const updated = await tx.shoppingCart.update({
      where: { id: cart.id },
      data: { version: { increment: 1 }, lastActivityAt: new Date() },
      include: CART_WITH_ITEMS,
    });
    return { updated, limitSkips, addedCount };
  });
  return {
    cart: cartPayload(result.updated),
    skipped: [...skipped, ...result.limitSkips],
    addedCount: result.addedCount,
  };
}

export async function settleStorefrontReservations(
  tx: Prisma.TransactionClient,
  storeId: string,
  order: { id: string; source: string },
  toStatus: string
) {
  if (order.source !== "storefront") return;
  const reservations = await tx.inventoryReservation.findMany({
    where: { storeId, orderId: order.id },
  });
  if (!reservations.length) return;
  const now = new Date();
  if (toStatus === "cancelled" || toStatus === "rejected") {
    await tx.inventoryReservation.updateMany({
      where: { storeId, orderId: order.id, status: "active" },
      data: { status: "released", releaseReason: toStatus, releasedAt: now },
    });
    return;
  }
  if (toStatus === "returned") {
    // ق-215 — ONLY A RESERVATION WITH SOMETHING TO INSPECT ENTERS THE QUEUE.
    //
    // The queue means «goods to physically decide about»: units still held
    // (`active`) or already taken off the shelf (`consumed`). A reservation the
    // D-46 sweep RELEASED as `expired` holds neither — the units never left
    // `stockQuantity` — and `resolveReturnInspection` refuses it by design
    // («حالة هذا الحجز لا تقبل الفحص»). Queuing it anyway produced a row the
    // merchant could see, press, and never clear: order on Thursday night,
    // confirmation on Monday, reservation expired over the weekend, refused at
    // the door — the path ق-193's own comment calls normal here. A queue a
    // merchant learns he cannot empty is a queue he stops opening, and the
    // genuinely actionable returns get buried behind the ones he cannot resolve.
    await tx.inventoryReservation.updateMany({
      where: {
        storeId,
        orderId: order.id,
        returnDisposition: "not_returned",
        status: { in: ["active", "consumed"] },
      },
      data: { returnDisposition: "pending_inspection", returnedAt: now },
    });
    return;
  }
  if (toStatus !== "completed") return;
  // Phase 20A: the decrement-only-at-completion invariant now settles against the
  // reserved VARIANT with the same atomic stock >= quantity condition.
  //
  // ق-193 — AN EXPIRED RESERVATION IS STILL A SALE, AND IT MUST STILL COST STOCK.
  //
  // D-46's sweep releases the reservations of an order that is STILL `new` after
  // 72 hours, which is right: abandoned COD orders must stop hiding stock. But
  // this loop used to read `status === "active"` alone, so an order the sweep had
  // touched completed with NO decrement at all — no movement row, no error, and
  // the `stock >= quantity` guard below never even consulted.
  //
  // That is not an exotic path in Iraq. A shopper orders on Thursday night; the
  // merchant makes the confirmation call when he is back; on Monday he walks the
  // order to `completed` and the courier collects the cash. Three days is normal
  // fulfilment here, not neglect — so the platform was quietly minting phantom
  // stock once per weekend order, compounding forever, and every availability
  // figure on the storefront, the product page and the till kept offering units
  // that had already left the shelf. The next shopper's oversell is discovered at
  // his door. `reservation-expiry-job.ts` warns in its own header against minting
  // inventory the merchant does not own; this reached the same place from the
  // other side — not by adding stock on release, but by never removing it on
  // completion.
  //
  // ONLY `expired` qualifies. A reservation released by `cancelled` or `rejected`
  // must never be consumed — and cannot be, since both are terminal statuses that
  // can never reach `completed`; the reason check makes that structural rather
  // than incidental.
  //
  // The stock guard below is deliberately NOT relaxed for these. If the units were
  // sold to someone else while the reservation was lapsed, completion fails with
  // INSUFFICIENT_AVAILABLE_STOCK — which is the honest answer: the merchant is
  // told he no longer has what he just delivered, and must correct his inventory.
  // Silently allowing a negative would hide the very oversell this exists to stop.
  const settleable = reservations.filter(
    (row) =>
      row.status === "active" ||
      (row.status === "released" && row.releaseReason === RESERVATION_EXPIRY_RELEASE_REASON)
  );
  for (const reservation of settleable) {
    const before = await tx.productVariant.findFirst({
      where: { id: reservation.variantId, storeId },
      select: {
        name: true,
        sku: true,
        stockQuantity: true,
        lowStockThreshold: true,
        product: { select: { name: true } },
      },
    });
    const changed = await tx.productVariant.updateMany({
      where: { id: reservation.variantId, storeId, stockQuantity: { gte: reservation.quantity } },
      data: { stockQuantity: { decrement: reservation.quantity } },
    });
    if (changed.count !== 1)
      throw new HttpError(
        422,
        "INSUFFICIENT_AVAILABLE_STOCK",
        "Reserved stock is no longer available for completion."
      );
    await tx.inventoryMovement.create({
      data: {
        storeId,
        productId: reservation.productId,
        variantId: reservation.variantId,
        delta: -reservation.quantity,
        reason: "storefront_cod_completed",
      },
    });
    if (before) {
      await enqueueLowStockIfCrossed(tx, {
        storeId,
        productId: reservation.productId,
        variantId: reservation.variantId,
        productName: before.product.name,
        variantName: before.name,
        sku: before.sku,
        previousQuantity: before.stockQuantity,
        stockQuantity: before.stockQuantity - reservation.quantity,
        lowStockThreshold: before.lowStockThreshold,
      });
    }
  }
  // ق-193: the same set that was decremented is the set that is consumed — by id,
  // not by re-describing the predicate. A second `where` here that drifted from
  // the filter above would decrement rows it then failed to mark, and the next
  // completion of the same order would decrement them again.
  await tx.inventoryReservation.updateMany({
    where: { storeId, orderId: order.id, id: { in: settleable.map((row) => row.id) } },
    data: { status: "consumed", consumedAt: now },
  });
}

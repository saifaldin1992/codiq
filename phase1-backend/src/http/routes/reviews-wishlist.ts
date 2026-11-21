/**
 * CD-2 routes — reviews, the wishlist, and the merchant's moderation.
 *
 * Three audiences, three guards, and they are not interchangeable:
 *
 *   - the review LIST and SUMMARY are public: a shopper deciding whether to buy
 *     has no account yet, and a rating he must sign in to read is a rating that
 *     does not do its job;
 *   - writing a review, and the whole wishlist, need a customer session scoped
 *     to THIS store (`requireStorefrontCustomer`);
 *   - hiding a review needs `catalog.products.update` in the merchant's store —
 *     moderating what is said about a product is the same authority as changing
 *     the product, and deliberately not `orders.view`, which a packer holds.
 */
import type { Express } from "express";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
import {
  asyncRoute,
  customerToken,
  limitStorefrontWrite,
  requireStorefrontCustomer,
  requireTrustedWriteOrigin,
  resolveStorefrontStore,
  cachePublicStorefront,
} from "../shared.js";
import { verifyTypedSession } from "../../auth/identity.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { parseOrThrow } from "../validate.js";
import { reviewHiddenSchema, reviewUpsertSchema } from "../schemas/reviews.schema.js";
import { loyaltySettingsSchema } from "../schemas/loyalty.schema.js";
import { wishlistItemSchema } from "../schemas/wishlist.schema.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import {
  deleteOwnReview,
  listProductReviews,
  listStoreReviews,
  publicStoreReviews,
  reviewSummary,
  setReviewHidden,
  upsertProductReview,
} from "../../services/product-review.service.js";
import {
  addToWishlist,
  listWishlist,
  removeFromWishlist,
} from "../../services/wishlist.service.js";
import { boughtTogether, relatedByCategory } from "../../services/recommendation.service.js";
import {
  loyaltySettings,
  loyaltyStatement,
  updateLoyaltySettings,
} from "../../services/loyalty.service.js";
import { prisma } from "../../db/prisma.js";

export function registerReviewAndWishlistRoutes(app: Express) {
  // ---------------------------------------------------------------- public
  app.get(
    "/store/:storeSlug/products/:productId/reviews",
    asyncRoute(async (request, response) => {
      const store = await resolveStorefrontStore(request.params.storeSlug);
      // ق-175: reading is public and stays so. A valid CUSTOMER session, if one is
      // present, only marks the reader's own row as `mine`; no session, an expired
      // one, or another identity's token all read as a guest — never as an error.
      // A customer of another store carries an id no row here can equal.
      let viewer: string | null = null;
      try {
        viewer = (await verifyTypedSession(customerToken(request), "customer")).subjectId;
      } catch {
        viewer = null;
      }
      const [summary, page] = await Promise.all([
        reviewSummary(store.id, request.params.productId),
        listProductReviews(
          store.id,
          request.params.productId,
          request.query as Record<string, unknown>,
          viewer
        ),
      ]);
      response.status(200).json({ storeSlug: store.slug, summary, ...page });
    })
  );

  // CD-4: public, like the reviews above — a shopper weighing a purchase has no
  // account yet, and «يُشترى معه عادة» is part of that decision.
  app.get(
    "/store/:storeSlug/products/:productId/recommendations",
    asyncRoute(async (request, response) => {
      const store = await resolveStorefrontStore(request.params.storeSlug);
      cachePublicStorefront(response);
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await boughtTogether(store.id, request.params.productId, {
            limit: Number(request.query.limit) || undefined,
          })),
        });
    })
  );
  // ق-200: same-category siblings — «عناصر قد تعجبك», a separate rail that
  // claims no evidence, for the product page that would otherwise just end.
  app.get(
    "/store/:storeSlug/products/:productId/related",
    asyncRoute(async (request, response) => {
      const store = await resolveStorefrontStore(request.params.storeSlug);
      cachePublicStorefront(response);
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await relatedByCategory(store.id, request.params.productId, {
            limit: Number(request.query.limit) || undefined,
          })),
        });
    })
  );
  // ق-200: the front page's «آراء العملاء» — store-wide, shopper-visible rows only.
  app.get(
    "/store/:storeSlug/reviews",
    asyncRoute(async (request, response) => {
      const store = await resolveStorefrontStore(request.params.storeSlug);
      cachePublicStorefront(response);
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await publicStoreReviews(store.id, request.query.limit)),
        });
    })
  );

  // ------------------------------------------------------- customer: reviews
  app.put(
    "/store/:storeSlug/products/:productId/reviews/mine",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, customer } = await requireStorefrontCustomer(request);
      await assertCapabilityAvailable("cx.reviews", store);
      // Throttled per customer: the purchase check already bounds who may write,
      // but nothing bounds how fast he may rewrite, and each write is a row the
      // merchant's queue has to be read through.
      await limitStorefrontWrite(request, "review_write", `customer:${customer.id}`, 30);
      const input = parseOrThrow(reviewUpsertSchema, request.body ?? {});
      response
        .status(200)
        .json({
          review: await upsertProductReview(store.id, customer.id, request.params.productId, input),
        });
    })
  );

  app.delete(
    "/store/:storeSlug/reviews/:reviewId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, customer } = await requireStorefrontCustomer(request);
      await deleteOwnReview(store.id, customer.id, request.params.reviewId);
      response.status(204).end();
    })
  );

  // CD-5: his own points, and where they came from. Needs his session — a
  // balance is nobody else's business.
  app.get(
    "/store/:storeSlug/account/loyalty",
    asyncRoute(async (request, response) => {
      const { store, customer } = await requireStorefrontCustomer(request);
      const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await loyaltyStatement(store.id, customer.id, limit, cursor)),
        });
    })
  );

  // CD-5: the merchant's programme settings. `settings.manage`, because
  // changing the earn rate changes what every future order costs him.
  app.get(
    "/merchant/stores/:storeSlug/loyalty",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "settings.manage");
      await assertCapabilityAvailable("offers.loyalty", store);
      response.status(200).json({ loyalty: await loyaltySettings(prisma, store.id) });
    })
  );
  app.put(
    "/merchant/stores/:storeSlug/loyalty",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "settings.manage");
      await assertCapabilityAvailable("offers.loyalty", store);
      const settings = parseOrThrow(loyaltySettingsSchema, request.body ?? {});
      response.status(200).json({ loyalty: await updateLoyaltySettings(store.id, settings) });
    })
  );

  // ----------------------------------------------------- customer: wishlist
  app.get(
    "/store/:storeSlug/account/wishlist",
    asyncRoute(async (request, response) => {
      const { store, customer } = await requireStorefrontCustomer(request);
      const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listWishlist(store.id, customer.id, limit, cursor)),
        });
    })
  );

  app.post(
    "/store/:storeSlug/account/wishlist",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, customer } = await requireStorefrontCustomer(request);
      await assertCapabilityAvailable("cx.wishlist", store);
      await limitStorefrontWrite(request, "wishlist_write", `customer:${customer.id}`, 60);
      const input = parseOrThrow(wishlistItemSchema, request.body ?? {});
      response.status(201).json({ item: await addToWishlist(store.id, customer.id, input) });
    })
  );

  app.delete(
    "/store/:storeSlug/account/wishlist/:variantId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, customer } = await requireStorefrontCustomer(request);
      await removeFromWishlist(store.id, customer.id, request.params.variantId);
      response.status(204).end();
    })
  );

  // ------------------------------------------------------ merchant: moderation
  app.get(
    "/merchant/stores/:storeSlug/reviews",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listStoreReviews(store.id, request.query as Record<string, unknown>)),
        });
    })
  );

  app.put(
    "/merchant/stores/:storeSlug/reviews/:reviewId/hidden",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "catalog.products.update");
      const decision = parseOrThrow(reviewHiddenSchema, request.body ?? {});
      response
        .status(200)
        .json({
          review: await setReviewHidden(store.id, actor, request.params.reviewId, decision),
        });
    })
  );
}

/**
 * Marketplace M7a routes.
 *
 *   shopper  /market/favourites(/products|/stores|/flags) · /market/stores/:storeSlug/follow · /market/me/purchased-from
 *            /market/inbox(/unread|/read|/read-all)
 *   anyone   /market/help · /market/contact (signed in or not) · /market/feedback/options
 *   shopper  /market/feedback
 *   owner    /platform/market/help(/sections|/articles|/contacts)  (brand.manage)
 *            /platform/market/contact-messages · /platform/market/feedback  (orders.oversee)
 */
import type { Express } from "express";
import { asyncRoute, requireTrustedWriteOrigin } from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { clientIp } from "../../http/client-ip.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { optionalShopper, requireShopper } from "../market-account/shopper-auth.js";
import { addFavouriteProduct, favouriteFlags, favouriteProducts, followStore, followedStores, purchasedFromStores, removeFavouriteProduct, unfollowStore } from "./favourites.service.js";
import { inboxPage, markAllRead, markRead, unreadCount } from "./inbox.service.js";
import {
  CONTACT_KINDS, FEEDBACK_LIKES, contactMessages, createHelpArticle, createHelpSection, deleteHelpArticle, deleteHelpSection, feedbackSummary,
  handleContactMessage, helpAdmin, helpCenter, setSupportContacts, submitContactMessage, submitFeedback, updateHelpArticle, updateHelpSection,
} from "./help.service.js";
import {
  contactHandleSchema, contactSchema, favouriteFlagsQuerySchema, feedbackSchema, helpArticleSchema, helpQuerySchema, helpSectionCreateSchema,
  helpSectionUpdateSchema, inboxReadSchema, supportContactsSchema,
} from "./schema.js";

export function registerMarketHelpRoutes(app: Express) {
  // ── «المفضّلة» ──────────────────────────────────────────────────────────
  app.get("/market/favourites/products", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await favouriteProducts(shopper.id, request.query.cursor, request.query.limit));
  }));
  app.get("/market/favourites/stores", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await followedStores(shopper.id, request.query.cursor, request.query.limit));
  }));
  app.get("/market/favourites/flags", asyncRoute(async (request, response) => {
    const shopper = await optionalShopper(request);
    const query = parseOrThrow(favouriteFlagsQuerySchema, request.query ?? {});
    response.status(200).json(shopper ? await favouriteFlags(shopper.id, query.products, query.stores) : { products: [], stores: [] });
  }));
  app.put("/market/favourites/products/:productId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await addFavouriteProduct(shopper.id, request.params.productId));
  }));
  app.delete("/market/favourites/products/:productId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await removeFavouriteProduct(shopper.id, request.params.productId));
  }));
  app.put("/market/stores/:storeSlug/follow", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await followStore(shopper.id, request.params.storeSlug));
  }));
  app.delete("/market/stores/:storeSlug/follow", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await unfollowStore(shopper.id, request.params.storeSlug));
  }));
  app.get("/market/me/purchased-from", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await purchasedFromStores(shopper.id));
  }));

  // ── الإشعارات ───────────────────────────────────────────────────────────
  app.get("/market/inbox", asyncRoute(async (request, response) => {
    const { shopper } = await requireShopper(request);
    response.status(200).json(await inboxPage(shopper.id, request.query.cursor, request.query.limit));
  }));
  app.get("/market/inbox/unread", asyncRoute(async (request, response) => {
    const shopper = await optionalShopper(request);
    response.status(200).json(shopper ? await unreadCount(shopper.id) : { unread: 0 });
  }));
  app.post("/market/inbox/read", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await markRead(shopper.id, parseOrThrow(inboxReadSchema, request.body ?? {}).key));
  }));
  app.post("/market/inbox/read-all", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(200).json(await markAllRead(shopper.id));
  }));

  // ── المساعدة ────────────────────────────────────────────────────────────
  app.get("/market/help", asyncRoute(async (request, response) => {
    const query = parseOrThrow(helpQuerySchema, request.query ?? {});
    response.status(200).json({ ...(await helpCenter(query.q)), contactKinds: CONTACT_KINDS });
  }));
  app.post("/market/contact", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const shopper = await optionalShopper(request);
    response.status(201).json(await submitContactMessage(parseOrThrow(contactSchema, request.body ?? {}), shopper?.id ?? null, clientIp(request)));
  }));
  app.get("/market/feedback/options", asyncRoute(async (_request, response) => {
    response.status(200).json({ liked: FEEDBACK_LIKES });
  }));
  app.post("/market/feedback", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { shopper } = await requireShopper(request);
    response.status(201).json(await submitFeedback(shopper.id, parseOrThrow(feedbackSchema, request.body ?? {})));
  }));

  // ── المالك ──────────────────────────────────────────────────────────────
  app.get("/platform/market/help", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json(await helpAdmin());
  }));
  app.post("/platform/market/help/sections", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(201).json(await createHelpSection(parseOrThrow(helpSectionCreateSchema, request.body ?? {})));
  }));
  app.put("/platform/market/help/sections/:sectionId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json(await updateHelpSection(request.params.sectionId, parseOrThrow(helpSectionUpdateSchema, request.body ?? {})));
  }));
  app.delete("/platform/market/help/sections/:sectionId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json(await deleteHelpSection(request.params.sectionId));
  }));
  app.post("/platform/market/help/articles", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(201).json(await createHelpArticle(parseOrThrow(helpArticleSchema, request.body ?? {})));
  }));
  app.put("/platform/market/help/articles/:articleId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json(await updateHelpArticle(request.params.articleId, parseOrThrow(helpArticleSchema, request.body ?? {})));
  }));
  app.delete("/platform/market/help/articles/:articleId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json(await deleteHelpArticle(request.params.articleId));
  }));
  app.put("/platform/market/help/contacts", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "brand.manage");
    response.status(200).json({ contacts: await setSupportContacts(parseOrThrow(supportContactsSchema, request.body ?? {})) });
  }));
  app.get("/platform/market/contact-messages", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "orders.oversee");
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    response.status(200).json(await contactMessages(status, request.query.cursor, request.query.limit));
  }));
  app.post("/platform/market/contact-messages/:messageId/handled", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    await requirePlatformActor(request, "orders.oversee");
    response.status(200).json(await handleContactMessage(request.params.messageId, parseOrThrow(contactHandleSchema, request.body ?? {}).note));
  }));
  app.get("/platform/market/feedback", asyncRoute(async (request, response) => {
    await requirePlatformActor(request, "orders.oversee");
    response.status(200).json(await feedbackSummary(request.query.cursor, request.query.limit));
  }));
}

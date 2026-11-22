import { config } from "../../config.js";
import type { Express } from "express";
import multer from "multer";
import { HttpError } from "../../auth/auth.errors.js";
import { loginCustomer, registerCustomer, setGuestPassword } from "../../auth/auth.service.js";
import { guestCheckout, guestCustomerFor } from "../../services/guest-checkout.service.js";
import { createTypedSession, verifyTypedSession } from "../../auth/identity.js";
import { prisma } from "../../db/prisma.js";
import { customerPrescriptionFile, uploadOrderPrescription } from "../../services/prescription.service.js";
import { getProductImageBytes, prescriptionImageConstraints, productImageConstraints } from "../../services/product-image-storage.service.js";
import { DEFAULT_SERVED_VARIANT, isVariantName, variantObjectKey } from "../../services/image-variants.service.js";
import { addCartItem, checkout, createAddress, currentCart, customerOrder, customerOrders, deleteAddress, deliveryQuote, listAddresses, mergeGuestCartIntoCustomer, publicCategories, publicDeliveryAreas, publicProduct, publicProducts, removeCartItem, updateAddress, updateCartItem } from "../../services/storefront.service.js";
import {
  addCartItemSchema,
  checkoutSchema,
  createAddressSchema,
  guestCheckoutSchema,
  loginCustomerSchema,
  registerCustomerSchema,
  setGuestPasswordSchema,
  updateAddressSchema,
  updateCartItemSchema,
} from "../schemas/storefront.schema.js";
import { requestCustomerPasswordResetSchema } from "../schemas/password-reset.schema.js";
import { reviewSummary } from "../../services/product-review.service.js";
import { requestPasswordReset } from "../../services/password-reset.service.js";
import { parseOrThrow } from "../validate.js";
import { asyncRoute, authenticatedUpload, clearGuestCartCookie, customerCookieName, guestCartToken, limitStorefrontWrite, limitStorefrontWriteWithAddressCeiling, limitUpload, uploadLimits, refundStorefrontWriteWithAddressCeiling, requireStorefrontCustomer, requireTrustedWriteOrigin, resolveStorefrontStore, setCustomerSession, setGuestCartCookie, storefrontCookiePath, cachePublicStorefront } from "../shared.js";


import { clientIp } from "../client-ip.js";
import { customerPreferencesView } from "../../services/config.service.js";
// Phase 20B-1: prescription uploads reuse the product-image constraints (same
// max size, same content types) — validation authority is the magic-byte check
// inside the service, exactly like product images.
// ق-238: the PRESCRIPTION ceiling, not the product one. Product uploads were
// raised to 15 MB because they are re-encoded on the way in; a prescription is
// stored exactly as sent, so its limit is still a storage limit and stays at 5.
const prescriptionUpload = multer({ storage: multer.memoryStorage(), limits: uploadLimits({ fileSize: prescriptionImageConstraints.maxBytes, files: 1 }) });

/**
 * 19-د (ATTACK-SURFACE): the customer is proven to own a session on THIS store
 * before multer buffers a byte — see `authenticatedUpload` in http/shared.ts.
 * The bucket is keyed on the customer, which is also the missing ceiling the
 * prescription route was the only storefront write to lack.
 */
async function guardPrescriptionUpload(request: import("express").Request) {
  requireTrustedWriteOrigin(request);
  const { store, customer } = await requireStorefrontCustomer(request);
  await limitUpload("prescription_upload", `${store.id}:${customer.id}`);
}

export function registerStorefrontRoutes(app: Express) {
  app.get("/store/:storeSlug/categories", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    cachePublicStorefront(response);
    response.status(200).json({ storeSlug: store.slug, categories: await publicCategories(store.id) });
  }));
  // ق-162: which governorates this store delivers to, and for how much. No
  // session — a shopper decides where before he decides who he is.
  app.get("/store/:storeSlug/delivery-areas", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    cachePublicStorefront(response);
    response.status(200).json({ storeSlug: store.slug, areas: await publicDeliveryAreas(store.id) });
  }));
  app.get("/store/:storeSlug/products", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    // ق-200: `sort` picks a rail — newest (default), best_selling, top_rated.
    cachePublicStorefront(response);
    response.status(200).json({ storeSlug: store.slug, ...(await publicProducts(store.id, request.query.limit, request.query.cursor, request.query.categoryId, request.query.q, request.query.sort)) });
  }));
  app.get("/store/:storeSlug/products/:productId", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    // ق-200: the star row under the product's name needs the summary on THIS
    // fetch — a second round trip above the fold is a visible flash of nothing.
    const [product, rating] = await Promise.all([publicProduct(store.id, request.params.productId), reviewSummary(store.id, request.params.productId)]);
    cachePublicStorefront(response);
    response.status(200).json({ storeSlug: store.slug, product: { ...product, rating: { average: rating.average, count: rating.count } } });
  }));
  /**
   * ق-238 — THE HEAVIEST ROUTE ON THE PLATFORM, AND IT USED TO COST THREE
   * QUERIES AND CARRY NO CACHE DIRECTIVE AT ALL.
   *
   * A catalog page asks for twenty-four of these. It used to run
   * `resolveStorefrontStore` → `publicProduct` → `productImage.findFirst` for
   * EACH — seventy-two round trips to Neon to serve one grid of pictures — and
   * `publicProduct` is the fat read: category, every image row, every variant,
   * plus a reservation groupBy, all discarded. One statement now carries every
   * condition the three carried: the store is live and its merchant is live (via
   * the image's own `storeId`), and the product is live (via its own row; the
   * `*_deleted_implies_inactive` CHECK makes `isActive` cover deletion — see
   * `soft-delete/constants.ts`).
   *
   * AND THE HEADER. The key ends in a uuid the upload minted, so the bytes at
   * one id can never change — the same argument `store-banners.ts` has made
   * since ق-198, and the same one this route was somehow never given. Without
   * it every shopper re-fetched every picture on every page, and no CDN could
   * hold a single one.
   *
   * `?v=` picks the size. Absent, the CARD is served — the catalog is the
   * caller that matters, and a client that forgets the parameter should fail
   * toward the small picture, never toward the 1600px one.
   */
  app.get("/store/:storeSlug/products/:productId/images/:imageId", asyncRoute(async (request, response) => {
    const image = await prisma.productImage.findFirst({
      where: {
        id: request.params.imageId,
        productId: request.params.productId,
        store: { slug: request.params.storeSlug, isActive: true, merchant: { isActive: true } },
        product: { isActive: true },
      },
      select: { objectKey: true, contentType: true, variantSet: true },
    });
    if (!image) throw new HttpError(404, "RESOURCE_NOT_FOUND", "صورة المنتج غير موجودة.");
    const variant = isVariantName(request.query.v) ? request.query.v : DEFAULT_SERVED_VARIANT;
    const objectKey = image.variantSet ? variantObjectKey(image.objectKey, variant) : image.objectKey;
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.type(image.contentType).send(await getProductImageBytes(objectKey));
  }));
  app.get("/store/:storeSlug/cart", asyncRoute(async (request, response) => {
    const store = await resolveStorefrontStore(request.params.storeSlug);
    let customerId: string | undefined;
    try { customerId = (await requireStorefrontCustomer(request)).customer.id; } catch (error) { if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error; }
    response.status(200).json({ cart: await currentCart(store.id, { customerId, guestToken: guestCartToken(request) }) });
  }));
  app.post("/store/:storeSlug/cart/items", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    let customerId: string | undefined;
    try { customerId = (await requireStorefrontCustomer(request)).customer.id; } catch (error) { if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error; }
    // 19-ج: parsed AFTER the limiter, at the point the body was already being
    // read. Validating first would let an unauthenticated caller probe the
    // storefront without spending an attempt.
    await limitStorefrontWriteWithAddressCeiling(request, "cart_write", customerId ?? guestCartToken(request) ?? clientIp(request), 60, 600);
    const body = parseOrThrow(addCartItemSchema, request.body ?? {});
    const result = await addCartItem(store.id, { customerId, guestToken: guestCartToken(request) }, body);
    if (result.issuedGuestToken) setGuestCartCookie(response, store.slug, result.issuedGuestToken, result.guestExpiresAt);
    response.status(200).json({ cart: result.cart });
  }));
  app.patch("/store/:storeSlug/cart/items/:itemId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    let customerId: string | undefined;
    try { customerId = (await requireStorefrontCustomer(request)).customer.id; } catch (error) { if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error; }
    await limitStorefrontWriteWithAddressCeiling(request, "cart_write", customerId ?? guestCartToken(request) ?? clientIp(request), 60, 600);
    const { quantity } = parseOrThrow(updateCartItemSchema, request.body ?? {});
    response.status(200).json({ cart: await updateCartItem(store.id, { customerId, guestToken: guestCartToken(request) }, request.params.itemId, quantity) });
  }));
  app.delete("/store/:storeSlug/cart/items/:itemId", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    let customerId: string | undefined;
    try { customerId = (await requireStorefrontCustomer(request)).customer.id; } catch (error) { if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error; }
    await limitStorefrontWriteWithAddressCeiling(request, "cart_write", customerId ?? guestCartToken(request) ?? clientIp(request), 60, 600);
    await removeCartItem(store.id, { customerId, guestToken: guestCartToken(request) }, request.params.itemId);
    response.status(204).end();
  }));
  app.post("/store/:storeSlug/account/register", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    await limitStorefrontWrite(request, "customer_register", clientIp(request), 8);
    const { fullName, phone, password, email } = parseOrThrow(registerCustomerSchema, request.body ?? {});
    const account = await registerCustomer({ storeSlug: store.slug, fullName, phone, password, email });
    const accessToken = await createTypedSession("customer", account.id);
    setCustomerSession(response, store.slug, accessToken);
    const cart = await mergeGuestCartIntoCustomer(store.id, account.id, guestCartToken(request));
    clearGuestCartCookie(response, store.slug);
    response.status(201).json({ account, accessToken, cart });
  }));
  app.post("/store/:storeSlug/account/login", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    await limitStorefrontWrite(request, "customer_login", clientIp(request), 12);
    const { phone, password } = parseOrThrow(loginCustomerSchema, request.body ?? {});
    const session = await loginCustomer({ storeSlug: store.slug, phone, password });
    setCustomerSession(response, store.slug, session.accessToken);
    const claims = await verifyTypedSession(session.accessToken, "customer");
    const cart = await mergeGuestCartIntoCustomer(store.id, claims.subjectId, guestCartToken(request));
    clearGuestCartCookie(response, store.slug);
    response.status(200).json({ ...session, cart });
  }));
  // PR-1 — the shopper's own «نسيت كلمة السر», and the ONE reset door that must
  // be store-scoped. `customers_store_email_present_uq` is UNIQUE(store_id,
  // email), so the same address is a different person at a different shop: the
  // store is resolved from the PATH and handed to the service as an id, never as
  // the slug the caller typed. Consuming the link is the shared
  // `/auth/password/reset/consume` — the token already knows whose it is.
  //
  // He signs in with a PHONE and his email is optional, so this can only reach a
  // shopper who left one. That limit is stated on the screen; it cannot be
  // stated in the RESPONSE, which has to be identical for every address.
  app.post("/store/:storeSlug/account/password/reset/request", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    const { email } = parseOrThrow(requestCustomerPasswordResetSchema, request.body ?? {});
    response.status(202).json(await requestPasswordReset({ kind: "customer", email, storeId: store.id, ip: clientIp(request) }));
  }));
  app.post("/store/:storeSlug/account/logout", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { claims, store } = await requireStorefrontCustomer(request);
    await prisma.customerSession.updateMany({ where: { id: claims.sessionId, customerId: claims.subjectId, revokedAt: null }, data: { revokedAt: new Date() } });
    response.clearCookie(customerCookieName(store.slug), { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: storefrontCookiePath(store.slug) });
    response.status(204).end();
  }));
  app.get("/store/:storeSlug/account", asyncRoute(async (request, response) => { const { customer } = await requireStorefrontCustomer(request); response.status(200).json({ customer }); }));
  // ق-251: what applies to THIS customer and why — marketing mail (his own last word), guest checkout, loyalty.
  app.get("/store/:storeSlug/account/preferences", asyncRoute(async (request, response) => { const { store, customer } = await requireStorefrontCustomer(request); response.status(200).json({ storeSlug: store.slug, preferences: await customerPreferencesView({ id: store.id, merchantId: store.merchantId }, customer.email ?? null) }); }));
  app.get("/store/:storeSlug/account/addresses", asyncRoute(async (request, response) => { const { store, customer } = await requireStorefrontCustomer(request); response.status(200).json({ storeSlug: store.slug, addresses: await listAddresses(store.id, customer.id) }); }));
  app.get("/store/:storeSlug/account/addresses/:addressId/delivery-quote", asyncRoute(async (request, response) => { const { store, customer } = await requireStorefrontCustomer(request); response.status(200).json({ delivery: await deliveryQuote(store.id, customer.id, request.params.addressId) }); }));
  app.post("/store/:storeSlug/account/addresses", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); const { store, customer } = await requireStorefrontCustomer(request); response.status(201).json({ address: await createAddress(store.id, customer.id, parseOrThrow(createAddressSchema, request.body ?? {})) }); }));
  app.patch("/store/:storeSlug/account/addresses/:addressId", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); const { store, customer } = await requireStorefrontCustomer(request); response.status(200).json({ address: await updateAddress(store.id, customer.id, request.params.addressId, parseOrThrow(updateAddressSchema, request.body ?? {})) }); }));
  app.delete("/store/:storeSlug/account/addresses/:addressId", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); const { store, customer } = await requireStorefrontCustomer(request); await deleteAddress(store.id, customer.id, request.params.addressId); response.status(204).end(); }));
  app.post("/store/:storeSlug/checkout", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, customer } = await requireStorefrontCustomer(request);
    // ق-196 — twelve per SHOPPER bounds one shopper, and bounds nothing else.
    //
    // Registration is eight per address per ten minutes, and each of those eight
    // accounts then gets its own fresh twelve — so one address could mint 96 real
    // cash-on-delivery orders every ten minutes. Every one is a row in the
    // merchant's dashboard, a reservation against his stock, and (on a pharmacy
    // store) a prescription upload charged to his storage plan. A shop drowning
    // in fake COD orders cannot tell which ones to phone, which is the whole of
    // his working day.
    //
    // Forty per address is deliberately loose: an Iraqi mobile network puts a
    // neighbourhood behind one address, so this must never be the ceiling an
    // ordinary evening meets — it is the wall a script hits.
    await limitStorefrontWriteWithAddressCeiling(request, "checkout", customer.id, 12, 40);
    // ⚠ `address` reaches the service byte-identical: `checkoutFingerprint`
    // hashes the object as it arrived, so stripping an unrecognised key inside
    // it would turn a shopper's second tap on «تأكيد الطلب» into 409
    // IDEMPOTENCY_KEY_REUSED instead of a replay. See storefront.schema.ts.
    const body = parseOrThrow(checkoutSchema, request.body ?? {});
    const result = await checkout(store.id, customer.id, { ...body, idempotencyKey: request.header("idempotency-key") });
    // ق-224: a replay is a read of a saved result, not a creation attempt — the
    // budget it just spent goes back, so a shopper retrying over a dropped
    // connection is never told «كثرت المحاولات» about his own existing order.
    if (result.replayed) await refundStorefrontWriteWithAddressCeiling(request, "checkout", customer.id);
    response.status(result.replayed ? 200 : 201).json({ order: result.order, replayed: result.replayed });
  }));
  // ق-201 — buying without an account. The shopper's phone becomes a shadow
  // customer row (see guest-checkout.service.ts), his guest cart is merged into
  // it, and the SAME checkout runs. The session is issued BEFORE the checkout:
  // whatever happens next, the cart the merge just consumed stays reachable.
  app.post("/store/:storeSlug/checkout/guest", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const store = await resolveStorefrontStore(request.params.storeSlug);
    // The same twelve-and-forty ceiling as the signed-in door (ق-196), keyed on
    // the guest's cart token — or on his address when he has no cart yet.
    await limitStorefrontWriteWithAddressCeiling(request, "checkout", `guest:${guestCartToken(request) ?? clientIp(request)}`, 12, 40);
    const body = parseOrThrow(guestCheckoutSchema, request.body ?? {});
    const { customer, created } = await guestCustomerFor(store.id, body);
    // ق-232: a session — and the row itself — only for a row this request
    // created. A phone that already has history here places its order and gets
    // the order back, nothing else: the number was never proof of the person.
    const accessToken = created ? await createTypedSession("customer", customer.id) : null;
    if (accessToken) setCustomerSession(response, store.slug, accessToken);
    const result = await guestCheckout(store.id, customer, guestCartToken(request), { ...body, idempotencyKey: request.header("idempotency-key") });
    clearGuestCartCookie(response, store.slug);
    response.status(result.replayed ? 200 : 201).json({ order: result.order, replayed: result.replayed, account: created ? customer : null, accessToken });
  }));
  // ق-201 — a guest chooses a password and becomes an account, orders included.
  app.post("/store/:storeSlug/account/password", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { customer } = await requireStorefrontCustomer(request);
    const { password } = parseOrThrow(setGuestPasswordSchema, request.body ?? {});
    response.status(200).json({ account: await setGuestPassword(customer.id, password) });
  }));
  app.get("/store/:storeSlug/account/orders", asyncRoute(async (request, response) => { const { store, customer } = await requireStorefrontCustomer(request); response.status(200).json({ storeSlug: store.slug, ...(await customerOrders(store.id, customer.id, request.query.limit, request.query.cursor)) }); }));
  app.get("/store/:storeSlug/account/orders/:orderId", asyncRoute(async (request, response) => { const { store, customer } = await requireStorefrontCustomer(request); response.status(200).json({ order: await customerOrder(store.id, customer.id, request.params.orderId) }); }));
  app.get("/store/:storeSlug/account/orders/:orderId/history", asyncRoute(async (request, response) => { const { store, customer } = await requireStorefrontCustomer(request); const order = await customerOrder(store.id, customer.id, request.params.orderId); response.status(200).json({ events: order.statusEvents }); }));
  // Phase 20B-1: prescription upload happens AFTER order creation (decision
  // §8.10) and streaming is strictly private — the order owner only. Appended
  // after every pre-existing route so the legacy registration order is intact.
  app.post("/store/:storeSlug/account/orders/:orderId/prescription", authenticatedUpload(guardPrescriptionUpload, prescriptionUpload.single("prescription")), asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, customer } = await requireStorefrontCustomer(request);
    response.status(201).json(await uploadOrderPrescription(store.id, customer.id, request.params.orderId, request.file));
  }));
  app.get("/store/:storeSlug/account/orders/:orderId/prescription", asyncRoute(async (request, response) => {
    const { store, customer } = await requireStorefrontCustomer(request);
    const file = await customerPrescriptionFile(store.id, customer.id, request.params.orderId);
    response.setHeader("Cache-Control", "private, no-store");
    response.type(file.contentType).send(file.bytes);
  }));
}

import { orderPrintSheet, parsePrintIds } from "../../services/order-print.service.js";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
import type { Express, Response } from "express";
import { HttpError } from "../../auth/auth.errors.js";
import { verifyTypedSession } from "../../auth/identity.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { requireStoreActor, requireStoreActorAny, requireStoreStaff } from "../../auth/staff-permissions.js";
import { prisma } from "../../db/prisma.js";
import { exportOrdersCsv } from "../../services/csv-transfer.service.js";
import { codReconciliation, courierManifestCsv, listCourierNames, markCodCollected, updateOrderDelivery } from "../../services/delivery.service.js";
import { listDeliveryRates, updateDeliveryRate } from "../../services/delivery-rates.service.js";
import { SEARCH_PERMISSIONS, authorizedSearchScopes, searchStore } from "../../services/merchant-search.service.js";
import { bulkTransitionOrderStatus } from "../../services/order-bulk.service.js";
import { listPlatformOrders, listStoreOrders, orderForStore, orderHistoryForStore, platformOrder, transitionOrderStatus } from "../../services/order-lifecycle.service.js";
import { createOrderNote, listOrderNotes, listOrderTags, replaceOrderTags } from "../../services/order-notes.service.js";
import { merchantPrescriptionFile, reviewOrderPrescription } from "../../services/prescription.service.js";
import { recordWhatsappSend, whatsappPanelForOrder } from "../../services/whatsapp-manual.service.js";
import { recordWhatsappSendSchema } from "../schemas/whatsapp.schema.js";
import { listSearchQuerySchema } from "../schemas/search.schema.js";
import { bulkOrderStatusSchema, codCollectedSchema, createOrderNoteSchema, orderDeliverySchema, replaceOrderTagsSchema, reviewPrescriptionSchema, transitionOrderStatusSchema, updateDeliveryRateSchema } from "../schemas/orders.schema.js";
import { parseOrThrow } from "../validate.js";
import { LIVE } from "../../services/soft-delete/constants.js";
import { encodeListCursor, keysetWhere, pageOf, readListCursor } from "../../services/list-page.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import { asyncRoute, bearerToken, requireCustomerStoreAccess, requireKind, requireMerchantStore, requireTrustedWriteOrigin, resolveStore , requireMerchantSession} from "../shared.js";

const requireMerchantStoreAccess = asyncRoute(async (request, response) => {
  const claims = await requireMerchantSession(request);
  await requireMerchantStore(request);
  response.status(200).json({ area: "merchant", storeSlug: request.params.storeSlug, subjectId: claims.subjectId });
});

function productResponse(product: { id: string; sku: string; name: string; description: string | null; priceIqd: number; isActive: boolean }) {
  return { id: product.id, sku: product.sku, name: product.name, description: product.description, priceIqd: product.priceIqd, isActive: product.isActive };
}

/**
 * D-18, the first of the two literals the debt register named: this returned
 * EVERY live product in the store in one query, ordered by SKU, with no limit
 * and no cursor. It serves two routes — the legacy merchant product view and
 * the platform owner's view of a store — and the first merchant with a thousand
 * products would have paid for both.
 *
 * The keyset is `(sku, id)` ASCENDING, because the SKU order is what these two
 * views are for: a merchant reading down a SKU-sorted list must not have it
 * silently re-sorted by creation date underneath him. SKU is unique per live
 * product, so the id tiebreaker is belt to that braces — and it is what keeps
 * the predicate correct across a delete-and-recreate, where a trashed row and a
 * live one may legitimately carry the same SKU.
 */
const STORE_PRODUCTS_KIND = "store.products";

async function sendProductsForStore(response: Response, store: { id: string; slug: string }, query: unknown) {
  const { limit, cursor: rawCursor } = parseOrThrow(paginationQuerySchema, query ?? {});
  const cursor = await readListCursor(STORE_PRODUCTS_KIND, rawCursor);
  // PG-2 LIVE: without it a merchant could raise a manual order against a product
  // sitting in the trash bin, minting an order_item that blocks its purge forever.
  const rows = await prisma.product.findMany({ where: { storeId: store.id, ...LIVE, ...keysetWhere("sku", "asc", cursor, "text") }, select: { id: true, sku: true, name: true, description: true, priceIqd: true, isActive: true }, orderBy: [{ sku: "asc" }, { id: "asc" }], take: limit + 1 });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(STORE_PRODUCTS_KIND, last.sku, last.id));
  response.status(200).json({ storeSlug: store.slug, products: page.map(productResponse), nextCursor });
}

async function sendProductForStore(response: Response, store: { id: string; slug: string }, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, storeId: store.id, ...LIVE }, select: { id: true, sku: true, name: true, description: true, priceIqd: true, isActive: true } });
  if (!product) throw new HttpError(404, "RESOURCE_NOT_FOUND", "المنتج غير موجود في هذا المتجر.");
  response.status(200).json({ storeSlug: store.slug, product: productResponse(product) });
}

/**
 * D-18, the second literal: every order the store has ever taken, in one query,
 * ordered by order number. Orders only accumulate.
 *
 * `(orderNumber, id)` ASCENDING, for the same reason as the products above —
 * the order-number sequence is the point of this view.
 */
const STORE_ORDERS_KIND = "store.orders";

async function sendOrdersForStore(response: Response, store: { id: string; slug: string }, query: unknown) {
  const { limit, cursor: rawCursor } = parseOrThrow(paginationQuerySchema, query ?? {});
  const cursor = await readListCursor(STORE_ORDERS_KIND, rawCursor);
  const rows = await prisma.storeOrder.findMany({ where: { storeId: store.id, ...keysetWhere("orderNumber", "asc", cursor, "text") }, select: { id: true, orderNumber: true, status: true, customerName: true, totalIqd: true, createdAt: true }, orderBy: [{ orderNumber: "asc" }, { id: "asc" }], take: limit + 1 });
  const { page, nextCursor } = pageOf(rows, limit, (last) => encodeListCursor(STORE_ORDERS_KIND, last.orderNumber, last.id));
  response.status(200).json({ storeSlug: store.slug, orders: page, nextCursor });
}

async function sendOrderForStore(response: Response, store: { id: string; slug: string }, orderId: string) {
  const order = await prisma.storeOrder.findFirst({ where: { id: orderId, storeId: store.id }, select: { id: true, orderNumber: true, status: true, customerName: true, totalIqd: true, createdAt: true, items: { select: { id: true, productId: true, productName: true, quantity: true, unitPriceIqd: true, lineTotalIqd: true } } } });
  if (!order) throw new HttpError(404, "RESOURCE_NOT_FOUND", "الطلب غير موجود في هذا المتجر.");
  response.status(200).json({ storeSlug: store.slug, order });
}

// This module preserves a contiguous run of the pre-split app.ts registration
// sequence: delivery-rates, dashboard/account guard routes, the legacy merchant
// product views, merchant order routes, and the platform store/order views.
// The guard routes and platform views live here (not in platform.ts) because
// the global registration order must stay identical.
export function registerOrderRoutes(app: Express) {
  app.get("/merchant/stores/:storeSlug/delivery-rates", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("delivery.rates", store);
    response.status(200).json({ storeSlug: store.slug, rates: await listDeliveryRates(store.id) });
  }));
  app.put("/merchant/stores/:storeSlug/delivery-rates/:governorate", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("delivery.rates", store);
    const body = parseOrThrow(updateDeliveryRateSchema, request.body ?? {});
    response.status(200).json({ rate: await updateDeliveryRate(store.id, request.params.governorate, body) });
  }));

  app.get("/platform/dashboard", requireKind("platform_owner"));
  app.get("/merchant/stores/:storeSlug/dashboard", requireMerchantStoreAccess);
  app.get("/staff/stores/:storeSlug/dashboard", asyncRoute(async (request, response) => {
    const context = await requireStoreStaff(request);
    response.status(200).json({ area: "staff", storeSlug: context.store.slug, subjectId: context.staff.id });
  }));
  app.get("/stores/:storeSlug/account", requireCustomerStoreAccess);
  app.get("/merchant/stores/:storeSlug/products", asyncRoute(async (request, response) => { const { store } = await requireStoreActor(request, "catalog.products.view"); await sendProductsForStore(response, store, request.query); }));
  // PG-6 (ق-74): `q` widened from order-number-only to order number + customer
  // name + gated recipient phone, and gained the two-character floor it lacked.
  app.get("/merchant/stores/:storeSlug/orders", asyncRoute(async (request, response) => { const { store } = await requireStoreActor(request, "orders.view"); const { q } = parseOrThrow(listSearchQuerySchema, { q: request.query.q }); response.status(200).json({ storeSlug: store.slug, ...(await listStoreOrders(store.id, { ...request.query, q }) ) }); }));
  // Phase 20B-3 (D-25): the orders CSV export must be registered BEFORE the
  // `:orderId` detail route — Express matches in order and `export.csv` would
  // otherwise be captured as an order id. The literal path previously errored
  // inside orderForStore, so no pre-existing behavior changes.
  app.get("/merchant/stores/:storeSlug/orders/export.csv", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    await assertCapabilityAvailable("data.csv", store);
    response.setHeader("Content-Disposition", `attachment; filename="orders-${store.slug}.csv"`);
    await exportOrdersCsv(store.id, request.query, (chunk) => response.write(chunk));
    response.end();
  }));
  // MD-2: the print sheet is READ-ONLY and needs `orders.view` -- printing a
  // label is not a change to the order, and a packer must not need write rights.
  // It is declared BEFORE `orders/:orderId`-shaped routes so "print" is never
  // swallowed as an order id.
  app.get("/merchant/stores/:storeSlug/orders/print/sheet", asyncRoute(async (request, response) => { const { store } = await requireStoreActor(request, "orders.view"); response.status(200).json(await orderPrintSheet(store.id, parsePrintIds(request.query.ids))); }));
  // ق-246 — the parcel after the shelf. The three literal paths sit BEFORE the
  // `:orderId` routes for the same reason `export.csv` and `print/sheet` do.
  // Reads ride `orders.view`; recording a handover or receiving cash is an
  // `orders.update` act — the same code the transition itself needs.
  app.get("/merchant/stores/:storeSlug/orders/manifest.csv", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    await assertCapabilityAvailable("delivery.manifest", store);
    response.setHeader("Content-Disposition", `attachment; filename="manifest-${store.slug}.csv"`);
    await courierManifestCsv(store.id, request.query, (chunk) => response.write(chunk));
    response.end();
  }));
  app.get("/merchant/stores/:storeSlug/orders/couriers", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("delivery.handover", store);
    response.status(200).json({ storeSlug: store.slug, couriers: await listCourierNames(store.id) });
  }));
  app.get("/merchant/stores/:storeSlug/orders/cod-reconciliation", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    await assertCapabilityAvailable("delivery.cod_reconciliation", store);
    response.status(200).json({ storeSlug: store.slug, ...(await codReconciliation(store.id, request.query)) });
  }));
  app.post("/merchant/stores/:storeSlug/orders/cod-collected", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "orders.update");
    await assertCapabilityAvailable("delivery.cod_reconciliation", store);
    response.status(200).json(await markCodCollected(store.id, parseOrThrow(codCollectedSchema, request.body ?? {})));
  }));
  app.patch("/merchant/stores/:storeSlug/orders/:orderId/delivery", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "orders.update");
    await assertCapabilityAvailable("delivery.handover", store);
    response.status(200).json({ order: await updateOrderDelivery(store.id, request.params.orderId, parseOrThrow(orderDeliverySchema, request.body ?? {})) });
  }));
  app.get("/merchant/stores/:storeSlug/orders/:orderId", asyncRoute(async (request, response) => { const { store } = await requireStoreActor(request, "orders.view"); response.status(200).json({ storeSlug: store.slug, order: await orderForStore(store.id, request.params.orderId) }); }));
  app.post("/merchant/stores/:storeSlug/orders/:orderId/status", asyncRoute(async (request, response) => { requireTrustedWriteOrigin(request); const { store, actor } = await requireStoreActor(request, "orders.update"); response.status(200).json({ order: await transitionOrderStatus(store.id, { kind: actor.kind, id: actor.id }, request.params.orderId, parseOrThrow(transitionOrderStatusSchema, request.body ?? {})) }); }));
  app.get("/merchant/stores/:storeSlug/orders/:orderId/history", asyncRoute(async (request, response) => { const { store } = await requireStoreActor(request, "orders.view"); response.status(200).json({ storeSlug: store.slug, events: await orderHistoryForStore(store.id, request.params.orderId) }); }));
  // 19-ب: the platform-wide order/product READS ride orders.oversee. The
  // kind-probe GET /platform/dashboard above stays requireKind("platform_owner")
  // on purpose — it answers «is this an OWNER session», and admitting staff
  // there would misroute every owner-only client shell.
  app.get("/platform/stores/:storeSlug/products", asyncRoute(async (request, response) => { await requirePlatformActor(request, "orders.oversee"); await sendProductsForStore(response, await resolveStore(request.params.storeSlug), request.query); }));
  app.get("/platform/stores/:storeSlug/products/:productId", asyncRoute(async (request, response) => { await requirePlatformActor(request, "orders.oversee"); await sendProductForStore(response, await resolveStore(request.params.storeSlug), request.params.productId); }));
  app.get("/platform/stores/:storeSlug/orders", asyncRoute(async (request, response) => { await requirePlatformActor(request, "orders.oversee"); await sendOrdersForStore(response, await resolveStore(request.params.storeSlug), request.query); }));
  app.get("/platform/stores/:storeSlug/orders/:orderId", asyncRoute(async (request, response) => { await requirePlatformActor(request, "orders.oversee"); await sendOrderForStore(response, await resolveStore(request.params.storeSlug), request.params.orderId); }));
  app.get("/platform/orders", asyncRoute(async (request, response) => { await requirePlatformActor(request, "orders.oversee"); const { q } = parseOrThrow(listSearchQuerySchema, { q: request.query.q }); response.status(200).json(await listPlatformOrders({ ...request.query, q })); }));
  app.get("/platform/orders/:orderId", asyncRoute(async (request, response) => { await requirePlatformActor(request, "orders.oversee"); response.status(200).json({ order: await platformOrder(request.params.orderId) }); }));
  app.get("/platform/orders/:orderId/history", asyncRoute(async (request, response) => { await requirePlatformActor(request, "orders.oversee"); const order = await platformOrder(request.params.orderId); response.status(200).json({ events: order.statusEvents ?? [] }); }));
  // Phase 20B-1: prescription viewing streams behind orders.view (decision
  // §8.12) and the review decision behind orders.update — NO public route
  // exists for these objects. Appended after every pre-existing route so the
  // legacy registration order is intact.
  app.get("/merchant/stores/:storeSlug/orders/:orderId/prescription", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    const file = await merchantPrescriptionFile(store.id, request.params.orderId);
    response.setHeader("Cache-Control", "private, no-store");
    response.type(file.contentType).send(file.bytes);
  }));
  app.post("/merchant/stores/:storeSlug/orders/:orderId/prescription/review", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "orders.update");
    const body = parseOrThrow(reviewPrescriptionSchema, request.body ?? {});
    response.status(200).json(await reviewOrderPrescription(store.id, { kind: actor.kind, id: actor.id }, request.params.orderId, body.decision));
  }));
  // ---------- MD-1 «راحة اليوم» — appended after every pre-existing route so
  // the legacy registration order is intact. `orders/bulk-status` is one segment
  // deep while `orders/:orderId/status` is two, and `stores/:storeSlug/search`
  // shares no pattern with any route above, so nothing above can be shadowed.
  app.get("/merchant/stores/:storeSlug/search", asyncRoute(async (request, response) => {
    // Store-scoped unified search. The guard resolves the store from the session;
    // the query string is the ONLY client input that reaches the service.
    //
    // This route spans THREE permission domains, so it deliberately does not
    // hide behind one code: `requireStoreActorAny` admits an actor holding at
    // least one of them, and the resolved set then decides which sections are
    // queried at all. A staff member without `customers.view` gets no customer
    // rows here, exactly as they get none from /customers; without
    // `catalog.products.view`, no product rows. An actor holding none of the
    // three is refused outright.
    const { store, permissions } = await requireStoreActorAny(request, SEARCH_PERMISSIONS);
    response.status(200).json({ storeSlug: store.slug, ...(await searchStore(store, request.query.q, authorizedSearchScopes(permissions))) });
  }));
  app.get("/merchant/stores/:storeSlug/orders/:orderId/notes", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json({ storeSlug: store.slug, ...(await listOrderNotes(store.id, request.params.orderId, limit, cursor)) });
  }));
  app.post("/merchant/stores/:storeSlug/orders/:orderId/notes", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "orders.update");
    const body = parseOrThrow(createOrderNoteSchema, request.body ?? {});
    response.status(201).json({ note: await createOrderNote(store.id, { kind: actor.kind, id: actor.id }, request.params.orderId, body) });
  }));
  app.get("/merchant/stores/:storeSlug/orders/:orderId/tags", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    response.status(200).json({ storeSlug: store.slug, ...(await listOrderTags(store.id, request.params.orderId)) });
  }));
  app.put("/merchant/stores/:storeSlug/orders/:orderId/tags", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "orders.update");
    const body = parseOrThrow(replaceOrderTagsSchema, request.body ?? {});
    response.status(200).json(await replaceOrderTags(store.id, request.params.orderId, body));
  }));
  app.post("/merchant/stores/:storeSlug/orders/bulk-status", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "orders.update");
    const body = parseOrThrow(bulkOrderStatusSchema, request.body ?? {});
    response.status(200).json(await bulkTransitionOrderStatus(store.id, { kind: actor.kind, id: actor.id }, body));
  }));
  // ---------- WA-1 (ق-131/ق-139) — appended after every pre-existing route so
  // the legacy registration order is intact; `orders/:orderId/whatsapp*` shadows
  // nothing above. Reading the panel needs `orders.view` (the phone is already
  // visible to those actors on the detail card and the print sheet — the link
  // adds no data exposure); RECORDING the tap sits behind `orders.update`, which
  // store_staff holds — the staff member sending the message IS the v1 flow.
  // Template editing rides the notifications settings PUT (settings.manage).
  app.get("/merchant/stores/:storeSlug/orders/:orderId/whatsapp", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "orders.view");
    response.status(200).json(await whatsappPanelForOrder(store.id, request.params.orderId));
  }));
  app.post("/merchant/stores/:storeSlug/orders/:orderId/whatsapp/sends", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "orders.update");
    const body = parseOrThrow(recordWhatsappSendSchema, request.body ?? {});
    response.status(201).json({ send: await recordWhatsappSend(store.id, { kind: actor.kind, id: actor.id }, request.params.orderId, body) });
  }));
}

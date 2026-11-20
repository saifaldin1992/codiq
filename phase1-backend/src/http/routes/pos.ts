/**
 * الكاشير (ق-132) — the till's HTTP surface.
 *
 * TWO TRUST LEVELS, DELIBERATELY SPLIT. Selling needs only `pos.sell` — the
 * permission a counter cashier holds, which buys him the sale endpoint and the
 * device list and nothing else: no reports, no other people's takings, no
 * order editing. Managing devices and reconciling shortfalls are MANAGEMENT
 * acts (`settings.manage`, `inventory.update`): pairing a till decides who can
 * write sales into this store, and a shortfall review rewrites what the shelf
 * count means. The price-deviation queue is the OWNER's (`settings.manage`):
 * it is how he checks what his cashiers charged, so a cashier — whose default
 * role holds `inventory.update` — must not be the one to clear it.
 *
 * KNOWN LIMIT — devices are NAMED, not AUTHENTICATED. Any pos.sell holder
 * in the store can submit tickets under any of the store's device ids, so
 * revocation stops honest clients and per-till attribution trusts the till.
 * Offline v1 shipped WITHOUT pairing tokens, deliberately: binding a session
 * to a device is its own auth-surface work, and half of it would be worse
 * than none. Until a dedicated pairing-token PR lands, per-device takings
 * remain bookkeeping, not evidence — flagged by the adversarial review,
 * DEFERRED openly rather than half-built.
 *
 * Every guard is `requireStoreActor`, so the store boundary and the live
 * membership resolver stand between every request and every row — the same
 * wall the whole merchant surface stands behind.
 */
import type { Express } from "express";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
import { asyncRoute, requireTrustedWriteOrigin } from "../shared.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { parseOrThrow } from "../validate.js";
import { posDeviceSchema, posTicketSchema } from "../schemas/pos.schema.js";
import { posProductSearchQuerySchema } from "../schemas/search.schema.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import { searchPosProducts } from "../../services/product-catalog.service.js";
import {
  createPosDevice,
  ingestPosTicket,
  listPosDevices,
  listPosPriceDeviations,
  listPosShortfalls,
  reviewPosPriceDeviation,
  reviewPosShortfall,
  revokePosDevice,
} from "../../services/pos.service.js";

export function registerPosRoutes(app: Express) {
  // ---- devices: pairing is management, listing is any till operator ----
  app.post("/merchant/stores/:storeSlug/pos/devices", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const actor = await requireStoreActor(request, "settings.manage");
    await assertCapabilityAvailable("pos.devices", actor.store);
    const body = parseOrThrow(posDeviceSchema, request.body ?? {});
    response.status(201).json(await createPosDevice(actor.store.id, body));
  }));

  app.get("/merchant/stores/:storeSlug/pos/devices", asyncRoute(async (request, response) => {
    const actor = await requireStoreActor(request, "pos.sell");
    await assertCapabilityAvailable("pos.devices", actor.store);
    // `seller` is who this session is: the till stamps it on every sale it
    // queues and sends a queued sale only under the session that rang it, so an
    // offline sale is never credited to the next cashier who signs in.
    response.status(200).json({ storeSlug: actor.store.slug, seller: { kind: actor.actor.kind, id: actor.actor.id }, ...(await listPosDevices(actor.store.id)) });
  }));

  app.post("/merchant/stores/:storeSlug/pos/devices/:deviceId/revoke", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const actor = await requireStoreActor(request, "settings.manage");
    await revokePosDevice(actor.store.id, request.params.deviceId);
    response.status(204).end();
  }));

  // ---- PG-6 (ق-74): the till's ONLINE product search ----
  // Appended after the device routes; `pos/products` shares no pattern with
  // `pos/devices/:deviceId/revoke`, so nothing above can be shadowed.
  //
  // `pos.sell` and not `catalog.products.view`: a counter cashier must be able
  // to find what he is selling, and that is the whole permission he holds. The
  // payload carries no cost, no supplier and no margin — only what the till
  // already caches offline.
  //
  // A NEW route, so it is schema-validated from the start (the rule
  // `validation-adoption.guard.mjs` states). It is a GET, so there is no write
  // to guard with `requireTrustedWriteOrigin`.
  app.get("/merchant/stores/:storeSlug/pos/products", asyncRoute(async (request, response) => {
    const actor = await requireStoreActor(request, "pos.sell");
    await assertCapabilityAvailable("pos.sell", actor.store);
    const { q, limit } = parseOrThrow(posProductSearchQuerySchema, { q: request.query.q, limit: request.query.limit });
    response.status(200).json({ storeSlug: actor.store.slug, ...(await searchPosProducts(actor.store.id, q, limit)) });
  }));

  // ---- the sale ----
  app.post("/merchant/stores/:storeSlug/pos/tickets", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const actor = await requireStoreActor(request, "pos.sell");
    await assertCapabilityAvailable("pos.sell", actor.store);
    const body = parseOrThrow(posTicketSchema, request.body ?? {});
    const result = await ingestPosTicket(
      actor.store.id,
      { kind: actor.actor.kind === "merchant" ? "merchant" : "staff", id: actor.actor.id },
      body,
    );
    // 200 for a replay, 201 for a fresh sale: the till can tell «سُجّلت» from
    // «كانت مسجّلة أصلاً» without parsing anything.
    response.status(result.replayed ? 200 : 201).json(result);
  }));

  // ---- shortfalls: the reconciliation queue ----
  app.get("/merchant/stores/:storeSlug/pos/shortfalls", asyncRoute(async (request, response) => {
    const actor = await requireStoreActor(request, "inventory.update");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json({ storeSlug: actor.store.slug, ...(await listPosShortfalls(actor.store.id, limit, cursor)) });
  }));

  app.post("/merchant/stores/:storeSlug/pos/shortfalls/:shortfallId/review", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const actor = await requireStoreActor(request, "inventory.update");
    await reviewPosShortfall(actor.store.id, request.params.shortfallId);
    response.status(204).end();
  }));

  // ---- price deviations: what the till charged against the catalog ----
  app.get("/merchant/stores/:storeSlug/pos/price-deviations", asyncRoute(async (request, response) => {
    const actor = await requireStoreActor(request, "settings.manage");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json({ storeSlug: actor.store.slug, ...(await listPosPriceDeviations(actor.store.id, limit, cursor)) });
  }));

  app.post("/merchant/stores/:storeSlug/pos/price-deviations/:deviationId/review", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const actor = await requireStoreActor(request, "settings.manage");
    await reviewPosPriceDeviation(actor.store.id, request.params.deviationId);
    response.status(204).end();
  }));
}

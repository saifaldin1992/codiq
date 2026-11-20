/**
 * RI-1 «فحص المرتجعات» — the goods decision, behind inventory authority.
 *
 * Deliberately `inventory.update`, NOT orders.*: CD-3's returns queue answers
 * the MONEY question (approve the refund) and ends where this begins — what
 * physically happens to the units. The shortfalls-review precedent (pos.ts)
 * put reconciliation of physical stock behind the same code.
 */
import type { Express } from "express";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { listInspectedReturns, listPendingReturnInspections, resolveReturnInspection } from "../../services/return-inspection.service.js";
import { resolveReturnInspectionSchema } from "../schemas/return-inspection.schema.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import { asyncRoute, requireTrustedWriteOrigin } from "../shared.js";
import { parseOrThrow } from "../validate.js";

export function registerReturnInspectionRoutes(app: Express) {
  app.get("/merchant/stores/:storeSlug/inventory/returns", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "inventory.update");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json({ storeSlug: store.slug, ...(await listPendingReturnInspections(store.id, limit, cursor)) });
  }));
  // ق-177: the decisions already taken — registered BEFORE the `:reservationId`
  // resolve route below only by habit; the methods differ, so Express would not
  // confuse them either way.
  app.get("/merchant/stores/:storeSlug/inventory/returns/inspected", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "inventory.update");
    const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
    response.status(200).json({ storeSlug: store.slug, ...(await listInspectedReturns(store.id, limit, cursor)) });
  }));
  app.post("/merchant/stores/:storeSlug/inventory/returns/:reservationId/resolve", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store, actor } = await requireStoreActor(request, "inventory.update");
    const body = parseOrThrow(resolveReturnInspectionSchema, request.body ?? {});
    response.status(200).json({ resolution: await resolveReturnInspection(store.id, { kind: actor.kind, id: actor.id }, request.params.reservationId, body) });
  }));
}

/**
 * CD-3 routes — the shopper's returns portal and the merchant's queue.
 *
 * Deciding a return needs `orders.update`: approving one moves the order to
 * `returned` and reverses money, which is precisely the authority that
 * permission names. Reading the queue needs only `orders.view`, so a packer can
 * see what is coming back without being able to settle it.
 */
import type { Express } from "express";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
import {
  asyncRoute,
  limitStorefrontWrite,
  requireStorefrontCustomer,
  requireTrustedWriteOrigin,
} from "../shared.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { decideReturnRequestSchema } from "../schemas/returns.schema.js";
import { paginationQuerySchema } from "../schemas/list.schema.js";
import { parseOrThrow } from "../validate.js";
import {
  decideReturnRequest,
  listCustomerReturnRequests,
  listStoreReturnRequests,
  requestReturn,
  withdrawReturnRequest,
} from "../../services/return-request.service.js";

export function registerReturnRoutes(app: Express) {
  app.get(
    "/store/:storeSlug/account/returns",
    asyncRoute(async (request, response) => {
      const { store, customer } = await requireStorefrontCustomer(request);
      const { limit, cursor } = parseOrThrow(paginationQuerySchema, request.query);
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listCustomerReturnRequests(store.id, customer.id, limit, cursor)),
        });
    })
  );

  app.post(
    "/store/:storeSlug/account/orders/:orderId/returns",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, customer } = await requireStorefrontCustomer(request);
      await assertCapabilityAvailable("cx.returns", store);
      await limitStorefrontWrite(request, "return_request", `customer:${customer.id}`, 20);
      response
        .status(201)
        .json({
          request: await requestReturn(
            store.id,
            customer.id,
            request.params.orderId,
            request.body ?? {}
          ),
        });
    })
  );

  app.post(
    "/store/:storeSlug/account/returns/:requestId/withdraw",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, customer } = await requireStorefrontCustomer(request);
      response
        .status(200)
        .json({
          request: await withdrawReturnRequest(store.id, customer.id, request.params.requestId),
        });
    })
  );

  app.get(
    "/merchant/stores/:storeSlug/returns",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "orders.view");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listStoreReturnRequests(store.id, request.query as Record<string, unknown>)),
        });
    })
  );

  app.post(
    "/merchant/stores/:storeSlug/returns/:requestId/decision",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "orders.update");
      const decision = parseOrThrow(decideReturnRequestSchema, request.body ?? {});
      response
        .status(200)
        .json({
          request: await decideReturnRequest(store.id, actor, request.params.requestId, decision),
        });
    })
  );
}

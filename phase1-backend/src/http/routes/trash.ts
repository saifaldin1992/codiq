/**
 * PG-2 — the trash bin and the activity log (plan §4).
 *
 * Three read/write surfaces behind three NEW permissions, all store_manager-only:
 *   GET  …/trash?entityType=&limit=&cursor= → catalog.trash.view
 *   POST …/trash/:entityType/:id/restore    → catalog.trash.restore
 *   GET  …/audit-events                     → catalog.audit.view
 *
 * ح-3 — those three codes are the ENTRY fee, not the whole price. A coupon
 * additionally answers to `settings.manage` and a team seat to `team.manage`
 * (TRASH_GOVERNING_PERMISSION), because restoring one is the same act as
 * creating it and must not become reachable through a looser door.
 *
 * Plus one read that belongs to the DELETE, not to the bin, and therefore rides
 * the delete permission of each entity instead of one of the three above:
 *   GET  …/trash/preview/:entityType/:id → see DELETE_PREVIEW_PERMISSION
 *
 * The restore body may carry the overrides that resolve a 409 in the SAME call:
 *   { "sku": "SKU-100-1", "variantSkus": { "<variantId>": "…" }, "categoryId": "…"|null }
 * — there is never a silent rename, because a SKU is the merchant's own key.
 *
 * The audit log is read by the MERCHANT ONLY in v1 (plan §6.4): the platform
 * owner dashboard has no per-store audit surface today and adding one is scope
 * this mandate did not buy.
 *
 * Deleting is NOT here: each entity keeps its delete on its own resource route
 * (`catalog/products/:id`, `catalog/categories/:id`, `marketing/coupons/:id`,
 * `team/:membershipId`) behind the permission that already governs it.
 */
import type { Express } from "express";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { listAuditEvents } from "../../services/soft-delete/audit-log.service.js";
import {
  DELETE_PREVIEW_PERMISSION,
  deletePreview,
} from "../../services/soft-delete/delete-preview.service.js";
import {
  assertMayTouchTrashEntity,
  assertTrashEntityType,
  listTrash,
  restore,
} from "../../services/soft-delete/soft-delete.service.js";
import { restoreTrashSchema } from "../schemas/trash.schema.js";
import { parseOrThrow } from "../validate.js";
import { asyncRoute, requireTrustedWriteOrigin } from "../shared.js";

export function registerTrashRoutes(app: Express) {
  // The pre-delete truth. Plan §4 demands the confirmation sheet state the REAL
  // inventory-movement count «من الخادم», and ق-10 forbids the client inventing
  // one — but the plan's backend section never named an endpoint that serves it.
  // This is that endpoint, and it rides the permission that governs each
  // entity's own DELETE, not `catalog.trash.view`: whoever may delete the row
  // must be able to read the consequences first.
  app.get(
    "/merchant/stores/:storeSlug/trash/preview/:entityType/:id",
    asyncRoute(async (request, response) => {
      const entityType = assertTrashEntityType(request.params.entityType);
      const { store, permissions } = await requireStoreActor(
        request,
        DELETE_PREVIEW_PERMISSION[entityType]
      );
      response
        .status(200)
        .json({
          preview: await deletePreview(entityType, store.id, request.params.id, permissions),
        });
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/trash",
    asyncRoute(async (request, response) => {
      const { store, permissions } = await requireStoreActor(request, "catalog.trash.view");
      response.status(200).json({
        storeSlug: store.slug,
        ...(await listTrash(
          store.id,
          permissions,
          request.query.entityType,
          request.query.limit,
          request.query.cursor
        )),
      });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/trash/:entityType/:id/restore",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor, permissions } = await requireStoreActor(
        request,
        "catalog.trash.restore"
      );
      const entityType = assertTrashEntityType(request.params.entityType);
      assertMayTouchTrashEntity(entityType, permissions);
      // 19-ج: the overrides that resolve a 409 in the same call. The entityType
      // above keeps its own 404 — see the schema header for why it is not modelled.
      const overrides = parseOrThrow(restoreTrashSchema, request.body ?? {});
      response
        .status(200)
        .json({
          restored: await restore(entityType, store.id, request.params.id, actor, overrides),
        });
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/audit-events",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.audit.view");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listAuditEvents(
            store.id,
            request.query.limit,
            request.query.cursor,
            request.query.entityType
          )),
        });
    })
  );
}

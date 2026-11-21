/**
 * Marketplace M7b routes — support tickets.
 *
 *   shopper   /market/tickets(/:ticketId(/replies|/confirm|/attachments(/:attachmentId))) · /market/orders/:orderId/ticket-eligibility
 *   merchant  /merchant/stores/:storeSlug/support-tickets(...)   (orders.view to read, orders.update to answer)
 *   owner     /platform/market/support-tickets(...)               (orders.oversee)
 */
import multer from "multer";
import type { Express, Request } from "express";
import {
  asyncRoute,
  authenticatedUpload,
  limitUpload,
  requireTrustedWriteOrigin,
  uploadLimits,
} from "../../http/shared.js";
import { parseOrThrow } from "../../http/validate.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { storeImageConstraints } from "../../services/product-image-storage.service.js";
import { requireShopper } from "../market-account/shopper-auth.js";
import {
  TICKET_ATTACHMENTS_PER_SIDE,
  TICKET_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_WINDOW_HOURS,
  attachToTicket,
  attachmentBytes,
  closeTicket,
  escalateTicket,
  openTicket,
  setTicketStatus,
  shopperConfirm,
  shopperReply,
  shopperTicket,
  shopperTickets,
  supportReply,
  supportTicket,
  supportTickets,
  ticketEligibility,
} from "./tickets.service.js";
import {
  confirmSchema,
  openTicketSchema,
  replySchema,
  statusSchema,
  supportListQuerySchema,
  supportReplySchema,
} from "./schema.js";

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: storeImageConstraints.maxBytes, files: 1 }),
});

async function guardShopperUpload(request: Request) {
  requireTrustedWriteOrigin(request);
  const { shopper } = await requireShopper(request);
  await limitUpload("ticket_upload_shopper", shopper.id);
}
async function guardStoreUpload(request: Request) {
  requireTrustedWriteOrigin(request);
  const { store, actor } = await requireStoreActor(request, "orders.update");
  await limitUpload("ticket_upload_store", `${store.id}:${actor.id}`);
}
function sendImage(
  response: import("express").Response,
  image: { contentType: string; bytes: Buffer | Uint8Array }
) {
  response.setHeader("cache-control", "private, max-age=3600");
  response.setHeader("content-disposition", "inline");
  response.status(200).contentType(image.contentType).send(Buffer.from(image.bytes));
}

export function registerMarketSupportRoutes(app: Express) {
  app.get(
    "/market/tickets/options",
    asyncRoute(async (_request, response) => {
      response
        .status(200)
        .json({
          types: TICKET_TYPES,
          statuses: TICKET_STATUS_LABELS,
          windowHours: TICKET_WINDOW_HOURS,
          attachmentsPerSide: TICKET_ATTACHMENTS_PER_SIDE,
        });
    })
  );

  // ── the shopper ──────────────────────────────────────────────────────────
  app.get(
    "/market/orders/:orderId/ticket-eligibility",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      const result = await ticketEligibility(shopper.id, request.params.orderId);
      response
        .status(200)
        .json({
          allowed: result.allowed,
          reason: result.reason,
          ticketId: result.ticketId,
          until: result.until,
        });
    })
  );
  app.post(
    "/market/tickets",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(201)
        .json(await openTicket(shopper.id, parseOrThrow(openTicketSchema, request.body ?? {})));
    })
  );
  app.get(
    "/market/tickets",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(
          await shopperTickets(
            shopper.id,
            request.query.tab,
            request.query.cursor,
            request.query.limit
          )
        );
    })
  );
  app.get(
    "/market/tickets/:ticketId",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      response.status(200).json(await shopperTicket(shopper.id, request.params.ticketId));
    })
  );
  app.post(
    "/market/tickets/:ticketId/replies",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(
          await shopperReply(
            shopper.id,
            request.params.ticketId,
            parseOrThrow(replySchema, request.body ?? {}).body
          )
        );
    })
  );
  app.post(
    "/market/tickets/:ticketId/confirm",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(200)
        .json(
          await shopperConfirm(
            shopper.id,
            request.params.ticketId,
            parseOrThrow(confirmSchema, request.body ?? {}).resolved
          )
        );
    })
  );
  app.post(
    "/market/tickets/:ticketId/attachments",
    authenticatedUpload(guardShopperUpload, imageUpload.single("image")),
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { shopper } = await requireShopper(request);
      response
        .status(201)
        .json(
          await attachToTicket(
            { shopperId: shopper.id },
            "shopper",
            request.params.ticketId,
            request.file
          )
        );
    })
  );
  app.get(
    "/market/tickets/:ticketId/attachments/:attachmentId",
    asyncRoute(async (request, response) => {
      const { shopper } = await requireShopper(request);
      sendImage(
        response,
        await attachmentBytes(
          { shopperId: shopper.id },
          request.params.ticketId,
          request.params.attachmentId
        )
      );
    })
  );

  // ── the store ────────────────────────────────────────────────────────────
  app.get(
    "/merchant/stores/:storeSlug/support-tickets",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "orders.view");
      const query = parseOrThrow(supportListQuerySchema, request.query ?? {});
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await supportTickets({ storeId: store.id }, query, query.cursor, query.limit)),
        });
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/support-tickets/:ticketId",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "orders.view");
      response
        .status(200)
        .json(await supportTicket({ storeId: store.id }, request.params.ticketId));
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/support-tickets/:ticketId/replies",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "orders.update");
      response
        .status(200)
        .json(
          await supportReply(
            { storeId: store.id },
            { kind: actor.kind, id: actor.id },
            request.params.ticketId,
            parseOrThrow(supportReplySchema, request.body ?? {})
          )
        );
    })
  );
  app.put(
    "/merchant/stores/:storeSlug/support-tickets/:ticketId/status",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "orders.update");
      response
        .status(200)
        .json(
          await setTicketStatus(
            { storeId: store.id },
            request.params.ticketId,
            parseOrThrow(statusSchema, request.body ?? {}).status
          )
        );
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/support-tickets/:ticketId/attachments",
    authenticatedUpload(guardStoreUpload, imageUpload.single("image")),
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "orders.update");
      response
        .status(201)
        .json(
          await attachToTicket(
            { storeId: store.id },
            actor.kind,
            request.params.ticketId,
            request.file
          )
        );
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/support-tickets/:ticketId/attachments/:attachmentId",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "orders.view");
      sendImage(
        response,
        await attachmentBytes(
          { storeId: store.id },
          request.params.ticketId,
          request.params.attachmentId
        )
      );
    })
  );

  // ── the owner ────────────────────────────────────────────────────────────
  app.get(
    "/platform/market/support-tickets",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "orders.oversee");
      const query = parseOrThrow(supportListQuerySchema, request.query ?? {});
      response
        .status(200)
        .json(await supportTickets({ platform: true }, query, query.cursor, query.limit));
    })
  );
  app.get(
    "/platform/market/support-tickets/:ticketId",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "orders.oversee");
      response.status(200).json(await supportTicket({ platform: true }, request.params.ticketId));
    })
  );
  app.post(
    "/platform/market/support-tickets/:ticketId/replies",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { actor } = await requirePlatformActor(request, "orders.oversee");
      response
        .status(200)
        .json(
          await supportReply(
            { platform: true },
            { kind: "platform", id: actor.id },
            request.params.ticketId,
            parseOrThrow(supportReplySchema, request.body ?? {})
          )
        );
    })
  );
  app.post(
    "/platform/market/support-tickets/:ticketId/escalate",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "orders.oversee");
      response.status(200).json(await escalateTicket(request.params.ticketId));
    })
  );
  app.post(
    "/platform/market/support-tickets/:ticketId/close",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      await requirePlatformActor(request, "orders.oversee");
      response.status(200).json(await closeTicket(request.params.ticketId));
    })
  );
  app.get(
    "/platform/market/support-tickets/:ticketId/attachments/:attachmentId",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "orders.oversee");
      sendImage(
        response,
        await attachmentBytes(
          { platform: true },
          request.params.ticketId,
          request.params.attachmentId
        )
      );
    })
  );
}

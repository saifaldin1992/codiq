import type { Express } from "express";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { listNotificationLog, notificationSettingsView, updateNotificationPreferences } from "../../services/notification-settings.service.js";
import { notificationSettingsUpdateSchema } from "../schemas/notifications.schema.js";
import { parseOrThrow } from "../validate.js";
import { asyncRoute, requireTrustedWriteOrigin } from "../shared.js";

export function registerNotificationRoutes(app: Express) {
  app.get("/merchant/stores/:storeSlug/notifications/settings", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json({ settings: await notificationSettingsView(store.id) });
  }));
  app.put("/merchant/stores/:storeSlug/notifications/settings", asyncRoute(async (request, response) => {
    requireTrustedWriteOrigin(request);
    const { store } = await requireStoreActor(request, "settings.manage");
    const input = parseOrThrow(notificationSettingsUpdateSchema, request.body ?? {});
    response.status(200).json({ settings: await updateNotificationPreferences(store.id, input) });
  }));
  app.get("/merchant/stores/:storeSlug/notifications/log", asyncRoute(async (request, response) => {
    const { store } = await requireStoreActor(request, "settings.manage");
    response.status(200).json({ storeSlug: store.slug, ...(await listNotificationLog(store.id, request.query.limit, request.query.cursor)) });
  }));
}

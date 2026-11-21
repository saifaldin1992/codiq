/**
 * GET /platform/modules — what this installation is made of: every module in
 * mount order, its domain, and the domain events it listens to. Read-only;
 * `services.manage` because it describes the platform's technical shape, the
 * same audience as «الخدمات والإتاحة».
 */
import type { Express } from "express";
import { asyncRoute } from "../../http/shared.js";
import { requirePlatformActor } from "../../auth/platform-permissions.js";
import { installedModules } from "./service.js";

export function registerPlatformModulesRoutes(app: Express) {
  app.get(
    "/platform/modules",
    asyncRoute(async (request, response) => {
      await requirePlatformActor(request, "services.manage");
      response.status(200).json(installedModules());
    })
  );
}

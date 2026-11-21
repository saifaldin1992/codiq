import type { Express } from "express";
import { asyncRoute } from "../shared.js";

/**
 * المرحلة 20-4 — الوثيقة نفسها، على عنوان ثابت.
 *
 * SERVED WITHOUT A SESSION, DELIBERATELY.
 *
 * The document enumerates every admin surface on the platform, which is the
 * argument FOR gating it. That argument does not survive contact with what is
 * already public: the dashboard is one JavaScript bundle served to every
 * visitor, and it hard-codes `/api/platform/...`, `/api/merchant/...` and the
 * rest in a hundred and thirty places. Anyone who wants the path list already
 * has it, in a file the browser downloads before anyone signs in. A gate here
 * would cost every honest integrator a session and buy an attacker one «view
 * source».
 *
 * What the document contains is SHAPES — paths, methods, field names, error
 * codes. No data, no tenant, no secret. Nothing here answers «which stores
 * exist» or «who is signed in»; every one of those questions still needs the
 * door its route names in this very document.
 *
 * The one sentence: it is a map of doors that are all still locked, and the
 * locks are the security — publishing the map costs nothing and refusing to is
 * a gesture, not a control.
 *
 * The import is DYNAMIC on purpose. `openapi.document.ts` is generated FROM a
 * scan that must first import `app.ts`, which imports this module: a static
 * import would close that loop and the generator could never run on a checkout
 * whose document is stale or absent. Deferring it to the first request breaks
 * the cycle and keeps ~700 KB of JSON off the boot path of a server that may
 * never be asked for it.
 */
export function registerOpenApiRoutes(app: Express) {
  app.get(
    "/openapi.json",
    asyncRoute(async (_request, response) => {
      const { openApiDocument } = await import("../openapi.document.js");
      // Long-lived caching is wrong here even though the document only changes on
      // deploy: an integrator debugging a shape must be able to re-fetch and get
      // what this build actually serves, and a stale copy in a proxy is exactly
      // the drift the whole phase exists to remove.
      response.setHeader("cache-control", "no-cache");
      response.status(200).json(openApiDocument);
    })
  );
}

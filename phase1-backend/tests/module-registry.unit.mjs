/**
 * The module registry is the platform's mount order. This pins it.
 *
 *   1. The 28 core modules keep their ids in their original order — Express
 *      matches in registration order, so reordering them changes behaviour.
 *   2. Every extension module comes after the core and registers no path the
 *      core already registers (a shadowing route would silently win or lose).
 *   3. Module ids are unique and kebab-case; the registry refuses a duplicate.
 *   4. Each extension module lives in `src/modules/<id>/` with an index.ts.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.CODIQ_POSTGRES_URL ??= "postgresql://unit:unit@localhost:5432/unit_test";
process.env.SESSION_JWT_SECRET ??= "unit-test-session-secret-not-for-production-0000";
process.env.CODIQ_ENCRYPTION_KEY ??= "unit-test-encryption-root-not-for-production-000";

const { CORE_MODULES } = await import("../src/modules/core-modules.ts");
const { EXTENSION_MODULES, PLATFORM_MODULES, registerModuleRoutes } = await import(
  "../src/modules/registry.ts"
);

const CORE_ORDER = [
  "auth",
  "sessions",
  "owner-security",
  "account-security",
  "pos",
  "return-inspection",
  "storefront",
  "store-banners",
  "platform",
  "public",
  "webhooks",
  "merchant",
  "team",
  "notifications",
  "orders",
  "catalog",
  "marketing",
  "customer-delight",
  "reviews-wishlist",
  "returns",
  "trash",
  "platform-staff",
  "openapi",
  "platform-services",
  "storefront-config",
  "payment-methods",
  "store-traffic",
  "merchant-home",
];
assert.deepEqual(
  CORE_MODULES.map((m) => m.id),
  CORE_ORDER,
  "the core mount order is behaviour; append new modules in registry.ts instead"
);

const ids = PLATFORM_MODULES.map((m) => m.id);
assert.equal(new Set(ids).size, ids.length, "module ids are unique");
for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/, `kebab-case id: ${id}`);
assert.deepEqual(
  PLATFORM_MODULES.slice(0, CORE_MODULES.length).map((m) => m.id),
  CORE_ORDER,
  "extensions are appended, never interleaved"
);

const srcDir = fileURLToPath(new URL("../src/modules/", import.meta.url));
for (const module of EXTENSION_MODULES) {
  assert.ok(
    existsSync(path.join(srcDir, module.id, "index.ts")),
    `extension module «${module.id}» lives in src/modules/${module.id}/index.ts`
  );
}

function routesOf(modules) {
  const app = express();
  for (const module of modules) module.register(app);
  return app._router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
}
const coreRoutes = new Set(routesOf(CORE_MODULES));
for (const module of EXTENSION_MODULES) {
  for (const route of routesOf([module])) {
    assert.ok(
      !coreRoutes.has(route),
      `extension «${module.id}» re-registers a core route: ${route}`
    );
  }
}

assert.throws(
  () => registerModuleRoutes(express(), [EXTENSION_MODULES[0], EXTENSION_MODULES[0]]),
  /registered twice/
);

console.log(
  JSON.stringify(
    {
      suite: "module-registry",
      status: "passed",
      summary: {
        core: CORE_MODULES.length,
        extensions: EXTENSION_MODULES.map((m) => m.id),
        routes: coreRoutes.size,
      },
    },
    null,
    2
  )
);
process.exit(0);

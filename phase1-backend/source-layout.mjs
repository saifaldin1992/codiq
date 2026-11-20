/**
 * WHERE THE BACKEND'S SOURCE LIVES — one answer for every guard and generator.
 *
 * Routes are written in two places: the core files under `src/http/routes/`,
 * and each extension module's `src/modules/<id>/routes.ts` (or `routes/*.ts`).
 * Every repository guard that reads route source (validation adoption, CSRF,
 * list envelope, public cache policy, capability registry, surface reachability)
 * and the OpenAPI generator enumerate files through THIS module, so a feature
 * added as a module is held to exactly the same rules as the core. A guard that
 * listed `http/routes` by hand would let a new module walk past it unseen.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SRC = path.join(BACKEND_ROOT, "src");
export const CORE_ROUTES_DIR = path.join(SRC, "http", "routes");
export const CORE_SCHEMAS_DIR = path.join(SRC, "http", "schemas");
export const MODULES_DIR = path.join(SRC, "modules");

function tsFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".ts")).sort().map((name) => path.join(dir, name));
}

function moduleDirs() {
  if (!existsSync(MODULES_DIR)) return [];
  return readdirSync(MODULES_DIR).sort().map((name) => path.join(MODULES_DIR, name)).filter((dir) => statSync(dir).isDirectory());
}

/** Every file that registers HTTP routes: core first (sorted), then each module's. */
export function routeSourceFiles() {
  const files = [...tsFilesIn(CORE_ROUTES_DIR)];
  for (const dir of moduleDirs()) {
    const single = path.join(dir, "routes.ts");
    if (existsSync(single)) files.push(single);
    files.push(...tsFilesIn(path.join(dir, "routes")));
  }
  return files;
}

/** Every zod schema module: core, then each module's `schema.ts` / `schemas/*.ts`. */
export function schemaSourceFiles() {
  const files = [...tsFilesIn(CORE_SCHEMAS_DIR)];
  for (const dir of moduleDirs()) {
    const single = path.join(dir, "schema.ts");
    if (existsSync(single)) files.push(single);
    files.push(...tsFilesIn(path.join(dir, "schemas")));
  }
  return files;
}

/**
 * The name a route file goes by in allow-lists and reports. Core files keep the
 * bare basename every existing allow-list already uses («catalog.ts»); module
 * files are qualified («modules/platform-modules/routes.ts») so two modules'
 * `routes.ts` can never collide.
 */
export function routeFileLabel(file) {
  const relative = path.relative(SRC, file).replace(/\\/g, "/");
  return relative.startsWith("http/routes/") ? path.basename(file) : relative;
}

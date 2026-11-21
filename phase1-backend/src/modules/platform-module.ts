/**
 * THE UNIT OF EXTENSION.
 *
 * A platform module is one feature area: its HTTP routes, and (optionally) the
 * domain events it reacts to. Adding a feature means writing one module and
 * adding ONE line to `registry.ts` — never editing `http/app.ts`, never editing
 * another feature's code to call yours.
 *
 * Two kinds live in the registry:
 *
 *   · CORE modules wrap the route files under `http/routes/` that existed before
 *     modules did. They are listed in the exact order those files were
 *     registered, because Express matches routes in registration order.
 *   · NEW modules live in `src/modules/<id>/` (see `modules/README.md`). They are
 *     appended AFTER every core module, and their paths must not shadow an
 *     existing route — `module-registry.unit.mjs` refuses a registry that
 *     reorders the core or registers one path twice.
 *
 * Every repository guard (validation, CSRF, list envelope, cache policy,
 * capability, surface, OpenAPI) scans `src/modules/<id>/routes.ts` exactly as it
 * scans `http/routes/` — see `phase1-backend/source-layout.mjs`. A module cannot
 * opt out of the rules by living somewhere new.
 */
import type { Express } from "express";
import type { DomainEventBus } from "../events/domain-events.js";

export type ModuleDomain =
  | "identity"
  | "storefront"
  | "catalog"
  | "orders"
  | "pos"
  | "finance"
  | "marketing"
  | "team"
  | "platform"
  | "operations";

export interface PlatformModule {
  /** Stable kebab-case id; also the folder name for a non-core module. */
  readonly id: string;
  readonly domain: ModuleDomain;
  /** One line, Arabic, for the owner's «الوحدات» list and the docs. */
  readonly title: string;
  /** Mounts the module's routes. Called once, in registry order. */
  register(app: Express): void;
  /** Subscribes to domain events (after-commit). Optional. */
  subscribe?(bus: DomainEventBus): void;
}

export function defineModule(module: PlatformModule): PlatformModule {
  if (!/^[a-z][a-z0-9-]*$/.test(module.id))
    throw new Error(`module id must be kebab-case: ${module.id}`);
  return module;
}

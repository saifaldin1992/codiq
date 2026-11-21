/**
 * THE MODULE REGISTRY — the one list of everything the platform mounts.
 *
 * To add a feature: create `src/modules/<id>/index.ts` exporting a
 * `defineModule({...})`, then add it to `EXTENSION_MODULES` below. That is the
 * whole integration. See `src/modules/README.md`.
 */
import type { Express } from "express";
import { CORE_MODULES } from "./core-modules.js";
import type { PlatformModule } from "./platform-module.js";
import { domainEvents, type DomainEventBus } from "../events/domain-events.js";
import { platformModulesModule } from "./platform-modules/index.js";
import { marketGeoModule } from "./market-geo/index.js";
import { marketStoresModule } from "./market-stores/index.js";
import { marketCatalogModule } from "./market-catalog/index.js";
import { marketHomeModule } from "./market-home/index.js";
import { marketAccountModule } from "./market-account/index.js";
import { marketCartModule } from "./market-cart/index.js";
import { marketOrdersModule } from "./market-orders/index.js";
import { marketHelpModule } from "./market-help/index.js";
import { marketSupportModule } from "./market-support/index.js";

/** New modules, appended after the core so the core's matching order never moves. */
export const EXTENSION_MODULES: readonly PlatformModule[] = [
  platformModulesModule,
  marketGeoModule,
  marketStoresModule,
  marketCatalogModule,
  marketHomeModule,
  marketAccountModule,
  marketCartModule,
  marketOrdersModule,
  marketHelpModule,
  marketSupportModule,
];

export const PLATFORM_MODULES: readonly PlatformModule[] = [...CORE_MODULES, ...EXTENSION_MODULES];

export function registerModuleRoutes(app: Express, modules: readonly PlatformModule[] = PLATFORM_MODULES): void {
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.id)) throw new Error(`module registered twice: ${module.id}`);
    seen.add(module.id);
    module.register(app);
  }
}

const subscribedBuses = new WeakSet<DomainEventBus>();
/**
 * Subscribes every module to the bus ONCE per process. `createApp()` runs many
 * times in the test suites; subscribing on each call would deliver every event
 * to every handler N times.
 */
export function installModuleSubscriptions(bus: DomainEventBus = domainEvents, modules: readonly PlatformModule[] = PLATFORM_MODULES): void {
  if (subscribedBuses.has(bus)) return;
  subscribedBuses.add(bus);
  for (const module of modules) module.subscribe?.(bus);
}

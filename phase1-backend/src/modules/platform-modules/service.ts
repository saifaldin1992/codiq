import { domainEvents } from "../../events/domain-events.js";
import { PLATFORM_MODULES } from "../registry.js";

/** Bounded by the code itself (a few dozen modules), never by data — not a paged list. */
export function installedModules() {
  const subscriptions = domainEvents.subscriptions();
  return {
    modules: PLATFORM_MODULES.map((module, position) => ({
      id: module.id,
      domain: module.domain,
      title: module.title,
      position,
      listensTo: subscriptions.filter((row) => row.module === module.id).map((row) => row.event),
    })),
  };
}

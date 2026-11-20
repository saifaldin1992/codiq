/**
 * DOMAIN EVENTS — how a feature reacts to another feature without editing it.
 *
 * A module subscribes in its manifest (`subscribe(bus)`); the code that owns the
 * moment emits once, AFTER its transaction has committed. So:
 *
 *   · A handler never sees an event for a write that rolled back.
 *   · A handler can never fail the request that produced the event: handlers run
 *     on a later tick, each in isolation, and a throw is logged, not propagated.
 *   · Handlers are BEST-EFFORT and IN-PROCESS. A process that dies between the
 *     commit and the handler loses that call. When an effect MUST happen (a
 *     message to a shopper, money), enqueue it in the same transaction through
 *     the notification outbox instead — that is what the outbox is for. Use
 *     events for integrations, analytics, webhooks-to-merchant, caches.
 *
 * Payloads carry ids and the few facts a handler needs to decide whether it
 * cares; anything else it reads itself. Never put personal data in a payload
 * that a handler could log.
 */
import { logger } from "../logging/logger.js";

export interface DomainEventMap {
  /** A storefront or guest checkout created an order (replays do not re-emit). */
  "order.created": { storeId: string; orderId: string; orderNumber: string; source: "storefront"; totalIqd: number };
  /** A counter (POS) sale was recorded — born completed. */
  "order.pos_sale_recorded": { storeId: string; orderId: string; orderNumber: string; totalIqd: number };
  /** Any status transition through the order state machine. */
  "order.status_changed": { storeId: string; orderId: string; orderNumber: string; from: string; to: string; actorKind: string };
  /** A merchant account and its first store exist (self-registration or manual provisioning). */
  "merchant.registered": { merchantId: string; storeId: string | null; via: "self" | "manual" };
  /** A storefront customer account was created. */
  "customer.registered": { storeId: string; customerId: string };
  /** A settlement was recorded (money transferred to a merchant). */
  "settlement.created": { merchantId: string; settlementId: string; netPayoutIqd: number };
  /** A plan's terms were published as a new version. */
  "plan.version_published": { planId: string; version: number };
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEventHandler<N extends DomainEventName> = (payload: DomainEventMap[N]) => void | Promise<void>;

export class DomainEventBus {
  private readonly handlers = new Map<DomainEventName, Array<{ owner: string; handler: DomainEventHandler<any> }>>();
  private pending = new Set<Promise<void>>();

  /** `owner` names the subscribing module in logs. */
  on<N extends DomainEventName>(name: N, owner: string, handler: DomainEventHandler<N>): void {
    const list = this.handlers.get(name) ?? [];
    list.push({ owner, handler });
    this.handlers.set(name, list);
  }

  /** Call only after the transaction that produced the fact has committed. */
  emit<N extends DomainEventName>(name: N, payload: DomainEventMap[N]): void {
    const list = this.handlers.get(name);
    if (!list?.length) return;
    for (const { owner, handler } of list) {
      const run: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => handler(payload))
        .catch((error) => logger.warn("domain_event.handler_failed", { event: name, module: owner, err: error }))
        .finally(() => { this.pending.delete(run); });
      this.pending.add(run);
    }
  }

  /** Waits for every handler started so far (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all(Array.from(this.pending));
  }

  /** Who listens to what — for the owner's modules screen and the docs. */
  subscriptions(): Array<{ event: DomainEventName; module: string }> {
    return Array.from(this.handlers.entries()).flatMap(([event, list]) => list.map(({ owner }) => ({ event, module: owner })));
  }

  /** Tests only. */
  reset(): void {
    this.handlers.clear();
  }
}

/** The process-wide bus. Modules subscribe once, at startup, through the registry. */
export const domainEvents = new DomainEventBus();

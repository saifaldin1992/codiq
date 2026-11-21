/**
 * Domain events keep three promises (see src/events/domain-events.ts):
 *
 *   1. AFTER COMMIT — a handler sees the committed state, and a write that
 *      fails or rolls back emits nothing.
 *   2. ISOLATION — a throwing handler cannot fail the request that emitted,
 *      and does not stop the other handlers.
 *   3. ONCE — `installModuleSubscriptions` subscribes a bus once however many
 *      times `createApp()` runs; replays (idempotent checkout) do not re-emit.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { domainEvents, DomainEventBus } = await import("../src/events/domain-events.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");
const { registerMerchantWithStore } = await import("../src/services/registration.service.ts");
const { installModuleSubscriptions } = await import("../src/modules/registry.ts");
const { createApp } = await import("../src/http/app.ts");
const { installedModules } = await import("../src/modules/platform-modules/service.ts");

const testId = `evt-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const summary = {};
try {
  // ── once: many createApp() calls, one subscription per bus ───────────────
  const bus = new DomainEventBus();
  let subscribeCalls = 0;
  const probe = {
    id: "probe",
    domain: "operations",
    title: "probe",
    register() {},
    subscribe() {
      subscribeCalls += 1;
    },
  };
  installModuleSubscriptions(bus, [probe]);
  installModuleSubscriptions(bus, [probe]);
  assert.equal(subscribeCalls, 1, "a bus is subscribed once, however many times the app is built");
  createApp();
  createApp();
  summary.subscribedOnce = true;

  // ── fixtures ─────────────────────────────────────────────────────────────
  const merchant = await registerMerchantDirect({
    ownerName: "أحداث",
    businessName: "متجر الأحداث",
    phone: `+96476${suffix}`,
    email: `${testId}@codiq.test`,
    password: "EventsMerchant!2026",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const merchantId = merchant.payload.account.id;
  const store = await prisma.store.create({
    data: {
      merchantId,
      name: "متجر الأحداث",
      slug: `${testId}-s`,
      defaultSubdomain: `${testId}-s`,
    },
  });
  const order = await prisma.storeOrder.create({
    data: {
      storeId: store.id,
      orderNumber: `${testId}-1`,
      status: "new",
      source: "storefront",
      customerName: "زبون",
      paymentMethodCode: "cod",
      subtotalIqd: 1000,
      deliveryFeeIqd: 0,
      totalIqd: 1000,
    },
  });

  const seen = [];
  const observedStatus = [];
  domainEvents.on("order.status_changed", "test-recorder", async (payload) => {
    if (payload.storeId !== store.id) return;
    seen.push(payload);
    observedStatus.push(
      (
        await prisma.storeOrder.findUniqueOrThrow({
          where: { id: payload.orderId },
          select: { status: true },
        })
      ).status
    );
  });
  domainEvents.on("order.status_changed", "test-thrower", () => {
    throw new Error("a broken extension");
  });

  // ── after commit, isolated ──────────────────────────────────────────────
  const actor = { kind: "merchant", id: merchantId };
  const moved = await transitionOrderStatus(store.id, actor, order.id, {
    toStatus: "processing",
    expectedVersion: 1,
  });
  assert.equal(moved.status, "processing", "a throwing handler did not fail the request");
  await domainEvents.drain();
  assert.equal(seen.length, 1);
  assert.deepEqual(
    {
      from: seen[0].from,
      to: seen[0].to,
      orderNumber: seen[0].orderNumber,
      actorKind: seen[0].actorKind,
    },
    { from: "new", to: "processing", orderNumber: `${testId}-1`, actorKind: "merchant" }
  );
  assert.equal(observedStatus[0], "processing", "the handler saw the COMMITTED state");
  summary.afterCommit = true;
  summary.isolatedFromThrowingHandler = true;

  // ── a refused write emits nothing ────────────────────────────────────────
  await assert.rejects(
    transitionOrderStatus(store.id, actor, order.id, { toStatus: "completed", expectedVersion: 1 }),
    (error) => error.code === "ORDER_VERSION_CONFLICT"
  );
  await assert.rejects(
    transitionOrderStatus(store.id, actor, order.id, { toStatus: "new", expectedVersion: 2 }),
    (error) => error.code === "INVALID_ORDER_TRANSITION"
  );
  await domainEvents.drain();
  assert.equal(seen.length, 1, "refused transitions emit nothing");
  summary.refusedWritesSilent = true;

  // ── merchant.registered from the public signup path ─────────────────────
  const registered = [];
  domainEvents.on("merchant.registered", "test-recorder", (payload) => {
    registered.push(payload);
  });
  const signup = await registerMerchantWithStore({
    businessName: "تاجر حدث",
    email: `${testId}.self@codiq.test`,
    password: "EventsSelf!2026Pass",
    storeName: "متجر حدث",
    storeSlug: `${testId}-self`,
    ownerName: "تاجر",
    phone: `+96477${suffix}`,
  });
  await domainEvents.drain();
  const mine = registered.filter((row) => row.merchantId === signup.merchant.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].via, "self");
  assert.ok(mine[0].storeId, "the event names the first store");
  assert.equal(
    signup.store.id,
    undefined,
    "the public response shape is unchanged (no store id leaked into it)"
  );
  summary.merchantRegistered = true;

  // ── the owner's «الوحدات» list reports subscriptions ─────────────────────
  const listed = installedModules();
  assert.equal(listed.modules[0].id, "auth", "listed in mount order");
  assert.ok(
    listed.modules.some((m) => m.id === "platform-modules"),
    "extension modules are listed"
  );
  assert.deepEqual(
    listed.modules.find((m) => m.id === "orders").listensTo,
    [],
    "a module with no subscriptions lists none"
  );
  summary.modulesListed = listed.modules.length;

  console.log(JSON.stringify({ suite: "domain-events", ok: true, summary }, null, 2));
} finally {
  await prisma.$disconnect();
}

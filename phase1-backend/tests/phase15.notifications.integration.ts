/**
 * codiq phase 15 acceptance — transactional outbox, worker, provider abstraction,
 * merchant notification settings + log. Gate coverage per the approved plan:
 * atomic enqueue with rollback proof, status-change and low-stock events with
 * crossing dedupe, worker success/retry/dead-letter/claim-concurrency, tenancy
 * and permission isolation for the new API surfaces (settings.manage finally
 * has HTTP endpoints), and secret-free responses.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTypedSession } from "../src/auth/identity.js";
import { prisma } from "../src/db/prisma.js";
import { createApp } from "../src/http/app.js";
import { enqueueOrderCreated } from "../src/notifications/notification-outbox.service.js";
import { OUTBOX_MAX_ATTEMPTS, processOutboxBatch, retryDelaySeconds } from "../src/notifications/outbox-worker.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";
import { FakeNotificationProvider } from "./helpers/fake-notification-provider.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";

const port = 3151;
const base = `http://127.0.0.1:${port}`;

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const { cookie, ...rest } = init;
  const response = await fetch(`${base}${path}`, { ...rest, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(rest.headers ?? {}) } });
  const raw = await response.text();
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: response.status, body, setCookie: response.headers.get("set-cookie") };
}

function bearer(accessToken: string) { return { authorization: `Bearer ${accessToken}` }; }

const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
if (process.env.DATABASE_URL !== testDatabaseUrl || process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl) {
  throw new Error("Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL.");
}

await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

const server = createServer(createApp());
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

const summary: Record<string, unknown> = { phase: 15 };

try {
  // ---------- fixtures ----------
  const merchantA = await prisma.merchant.create({ data: { email: "merchant.a.phase15@codiq.test", passwordHash: "unused", businessName: "تاجر المرحلة 15 A" } });
  const merchantB = await prisma.merchant.create({ data: { email: "merchant.b.phase15@codiq.test", passwordHash: "unused", businessName: "تاجر المرحلة 15 B" } });
  // Phase 16: gated writes require an active plan for directly-created test merchants.
  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  await prisma.merchantSubscription.createMany({ data: [merchantA, merchantB].map((merchant) => ({ merchantId: merchant.id, planId: freePlan.id, status: "active" })) });
  const storeA = await createStoreFoundation({ merchantId: merchantA.id, name: "متجر 15 ألف", slug: "phase15-a-one", defaultSubdomain: "phase15-a-one" });
  const storeB = await createStoreFoundation({ merchantId: merchantB.id, name: "متجر 15 باء", slug: "phase15-b-one", defaultSubdomain: "phase15-b-one" });
  await prisma.deliveryRate.update({ where: { storeId_governorate: { storeId: storeA.id, governorate: "Baghdad" } }, data: { amountIqd: 2500, isEnabled: true } });
  const product = await prisma.product.create({ data: { storeId: storeA.id, sku: "P15-MAIN", name: "منتج المرحلة 15", priceIqd: 4000, stockQuantity: 10, lowStockThreshold: 3 } });
  const tokenMerchantA = await createTypedSession("merchant", merchantA.id, storeA.id);
  const tokenMerchantB = await createTypedSession("merchant", merchantB.id, storeB.id);

  // ---------- settings API: defaults, allowlist, and enabling ----------
  const defaults = await request("/merchant/stores/phase15-a-one/notifications/settings", { headers: bearer(tokenMerchantA) });
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.settings.isEnabled, false);
  assert.deepEqual(defaults.body.settings.preferences, { orderCreated: true, orderStatusChanged: true, lowStock: true });
  assert.equal("apiKey" in defaults.body.settings, false, "provider secrets must never be returned");

  const badKey = await request("/merchant/stores/phase15-a-one/notifications/settings", { method: "PUT", headers: bearer(tokenMerchantA), body: JSON.stringify({ preferences: { apiKey: true } }) });
  assert.equal(badKey.status, 422);
  const enable = await request("/merchant/stores/phase15-a-one/notifications/settings", { method: "PUT", headers: bearer(tokenMerchantA), body: JSON.stringify({ isEnabled: true }) });
  assert.equal(enable.status, 200);
  assert.equal(enable.body.settings.isEnabled, true);
  summary.settingsApi = { defaults: defaults.status, unknownKeyRejected: badKey.status, enabled: enable.status };

  // ---------- atomic outbox through the real checkout transaction ----------
  const register = await request("/store/phase15-a-one/account/register", { method: "POST", body: JSON.stringify({ phone: "+9647701500001", password: "Phase15CustomerPass!", fullName: "زبون المرحلة 15", email: "customer.phase15@codiq.test" }) });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  const customerToken: string = register.body.accessToken;
  const addItem = await request("/store/phase15-a-one/cart/items", { method: "POST", headers: bearer(customerToken), body: JSON.stringify({ productId: product.id, quantity: 2 }) });
  assert.equal(addItem.status, 200);
  const address = await request("/store/phase15-a-one/account/addresses", { method: "POST", headers: bearer(customerToken), body: JSON.stringify({ recipientName: "زبون المرحلة 15", fullAddress: "شارع الاختبار 15", city: "Baghdad", governorate: "Baghdad", phoneContact: "+9647701500001", isDefault: true }) });
  assert.equal(address.status, 201, JSON.stringify(address.body));
  const checkout = await request("/store/phase15-a-one/checkout", { method: "POST", headers: { ...bearer(customerToken), "idempotency-key": "phase15-checkout-key-0001" }, body: JSON.stringify({ cartVersion: addItem.body.cart.version, addressId: address.body.address.id, paymentMethodCode: "cod" }) });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
  const order = checkout.body.order;

  const createdRows = await prisma.notificationOutbox.findMany({ where: { orderId: order.id, eventType: "order.created" }, orderBy: { recipientKind: "asc" } });
  assert.equal(createdRows.length, 2, "merchant + customer order.created rows must exist");
  assert.deepEqual(createdRows.map((row) => row.recipientKind).sort(), ["customer", "merchant"]);
  assert.equal(createdRows.every((row) => row.status === "pending"), true);
  const merchantRow = createdRows.find((row) => row.recipientKind === "merchant")!;
  assert.equal(merchantRow.recipient, merchantA.email);

  // Idempotent replay must not enqueue again.
  const replay = await request("/store/phase15-a-one/checkout", { method: "POST", headers: { ...bearer(customerToken), "idempotency-key": "phase15-checkout-key-0001" }, body: JSON.stringify({ cartVersion: addItem.body.cart.version, addressId: address.body.address.id, paymentMethodCode: "cod" }) });
  assert.equal(replay.status, 200);
  assert.equal(await prisma.notificationOutbox.count({ where: { orderId: order.id, eventType: "order.created" } }), 2);

  // Rollback proof: an aborted transaction leaves no outbox row behind.
  const beforeRollback = await prisma.notificationOutbox.count();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await enqueueOrderCreated(tx, { storeId: storeA.id, orderId: order.id, orderNumber: "ROLLBACK-0001", totalIqd: 1, customerName: "لن يبقى", customerEmail: "rollback@codiq.test" });
    const inTx = await tx.notificationOutbox.count();
    assert.equal(inTx, beforeRollback + 2, "rows must be visible inside the transaction");
    throw new Error("forced rollback");
  }));
  assert.equal(await prisma.notificationOutbox.count(), beforeRollback, "rolled-back transaction must leave no outbox rows");
  summary.atomicOutbox = { checkoutRows: createdRows.length, replayAddedRows: 0, rollbackLeftRows: 0 };

  // ---------- status change: authorized enqueues, unauthorized leaves nothing ----------
  const staffCreate = await request("/merchant/stores/phase15-a-one/team", { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ email: "staff.phase15@codiq.test", displayName: "موظفة 15", temporaryPassword: "phase15-staff-pass-01", roleCode: "store_staff" }) });
  assert.equal(staffCreate.status, 201);
  const staffLogin = await request("/auth/staff/stores/phase15-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.phase15@codiq.test", password: "phase15-staff-pass-01" }) });
  assert.equal(staffLogin.status, 200);
  const tokenStaff: string = staffLogin.body.accessToken;

  const transition = await request(`/merchant/stores/phase15-a-one/orders/${order.id}/status`, { method: "POST", headers: bearer(tokenStaff), body: JSON.stringify({ toStatus: "processing", expectedVersion: order.version }) });
  assert.equal(transition.status, 200, JSON.stringify(transition.body));
  const statusRows = await prisma.notificationOutbox.findMany({ where: { orderId: order.id, eventType: "order.status_changed" } });
  // ق-214: the SHOP moved this order — a staff member is the shop — so only the
  // customer is told. The merchant's own copies used to spend the per-recipient
  // operational ceiling (19-د) that exists to protect a shopper from a store,
  // and after about three days' ordinary work the message that got deferred to
  // tomorrow was «طلب جديد» — the trigger for the COD confirmation call. What the
  // owner wants from his staff's day is the daily digest, which already exists;
  // what he must never lose is the alert about a new order. `pg1:test` asserts
  // the other half: a shopper's own cancellation still reaches the merchant.
  assert.equal(statusRows.length, 1, "ق-214: the shop is not mailed about its own click");
  assert.equal(statusRows[0].recipientKind, "customer");

  const outboxBeforeDenied = await prisma.notificationOutbox.count();
  const deniedTransition = await request(`/merchant/stores/phase15-a-one/orders/${order.id}/status`, { method: "POST", headers: bearer(tokenMerchantB), body: JSON.stringify({ toStatus: "preparation", expectedVersion: order.version + 1 }) });
  assert.equal(deniedTransition.status, 403);
  assert.equal(await prisma.notificationOutbox.count(), outboxBeforeDenied, "denied transition must not enqueue");
  summary.statusChange = { authorizedRows: statusRows.length, deniedAddedRows: 0 };

  // ---------- low stock: crossing fires once, repeats and refills behave ----------
  const lowStockCross = await request(`/merchant/stores/phase15-a-one/catalog/products/${product.id}/inventory`, { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ stockQuantity: 2, reason: "phase15-low" }) });
  assert.equal(lowStockCross.status, 200);
  const dropAgain = await request(`/merchant/stores/phase15-a-one/catalog/products/${product.id}/inventory`, { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ stockQuantity: 1, reason: "phase15-still-low" }) });
  assert.equal(dropAgain.status, 200);
  assert.equal(await prisma.notificationOutbox.count({ where: { eventType: "low_stock", productId: product.id } }), 1, "staying low must not re-fire");
  const refill = await request(`/merchant/stores/phase15-a-one/catalog/products/${product.id}/inventory`, { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ stockQuantity: 9, reason: "phase15-refill" }) });
  assert.equal(refill.status, 200);
  const crossAgain = await request(`/merchant/stores/phase15-a-one/catalog/products/${product.id}/inventory`, { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ stockQuantity: 3, reason: "phase15-low-again" }) });
  assert.equal(crossAgain.status, 200);
  assert.equal(await prisma.notificationOutbox.count({ where: { eventType: "low_stock", productId: product.id } }), 2, "a fresh crossing after refill fires again");

  // ق-234: the SAME quantity a second time — the case this block never reached,
  // which is why the defect lived. The dedupe key is
  // `low_stock:<variant>:<quantity>`, so refilling and selling back down to a
  // number already alerted on collides — and the collision was caught with
  // `try/catch (P2002)` INSIDE the transaction, which does not work: the failed
  // INSERT aborts the transaction, so the `return` handed control to a dead one
  // and the inventory write itself died. In the order-completion path that is a
  // COD order that cannot be completed, from a shop merely restocking.
  const refillAgain = await request(`/merchant/stores/phase15-a-one/catalog/products/${product.id}/inventory`, { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ stockQuantity: 9, reason: "phase15-refill-2" }) });
  assert.equal(refillAgain.status, 200);
  const sameQuantityAgain = await request(`/merchant/stores/phase15-a-one/catalog/products/${product.id}/inventory`, { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ stockQuantity: 3, reason: "phase15-same-quantity" }) });
  assert.equal(sameQuantityAgain.status, 200, `ق-234: crossing to a quantity already alerted on must not take the write down with it · ${JSON.stringify(sameQuantityAgain.body)}`);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id }, select: { stockQuantity: true } })).stockQuantity, 3, "ق-234: …and the stock the merchant typed is actually stored — the transaction committed");
  assert.equal(await prisma.notificationOutbox.count({ where: { eventType: "low_stock", productId: product.id } }), 2, "ق-234: the duplicate alert is SKIPPED, not raised — «already alerted» means not queued twice");
  summary.lowStock = { afterFirstCross: 1, afterRefillCross: 2, sameQuantityTwice: "skipped, write survives" };

  // ---------- preference gating ----------
  const prefOff = await request("/merchant/stores/phase15-a-one/notifications/settings", { method: "PUT", headers: bearer(tokenMerchantA), body: JSON.stringify({ preferences: { orderStatusChanged: false } }) });
  assert.equal(prefOff.status, 200);
  const gatedTransition = await request(`/merchant/stores/phase15-a-one/orders/${order.id}/status`, { method: "POST", headers: bearer(tokenMerchantA), body: JSON.stringify({ toStatus: "preparation", expectedVersion: order.version + 1 }) });
  assert.equal(gatedTransition.status, 200, JSON.stringify(gatedTransition.body));
  const gatedRows = await prisma.notificationOutbox.findMany({ where: { orderId: order.id, eventType: "order.status_changed", payload: { path: ["toStatus"], equals: "preparation" } } });
  assert.equal(gatedRows.length, 1, "merchant pref off => customer row only (and ق-214 would have suppressed it anyway: the merchant moved it himself)");
  assert.equal(gatedRows[0].recipientKind, "customer");
  await request("/merchant/stores/phase15-a-one/notifications/settings", { method: "PUT", headers: bearer(tokenMerchantA), body: JSON.stringify({ preferences: { orderStatusChanged: true } }) });
  summary.preferenceGating = { merchantRowSuppressed: true };

  // ---------- worker: success, retry backoff, dead letter, no-provider skip, claims ----------
  const fake = new FakeNotificationProvider();
  // ق-184: the reply path is decided per audience at send time, so it is set
  // before the batch that proves it.
  const SUPPORT_EMAIL = "support@codiq.test";
  process.env.CODIQ_SUPPORT_EMAIL = SUPPORT_EMAIL;
  const firstBatch = await processOutboxBatch(fake, { batchSize: 50 });
  assert.equal(firstBatch.claimed > 0, true);
  assert.equal(firstBatch.sent, firstBatch.claimed, JSON.stringify(firstBatch));
  assert.equal(await prisma.notificationOutbox.count({ where: { status: { in: ["pending", "retry_scheduled", "processing"] } } }), 0);
  assert.equal(fake.sent.length, firstBatch.sent);
  const sentSample = await prisma.notificationOutbox.findFirst({ where: { id: merchantRow.id } });
  assert.equal(sentSample?.status, "sent");
  assert.ok(sentSample?.sentAt);

  // ق-184 — the SAME event, both copies, one batch: the reply path splits by
  // audience and nothing else. The merchant's copy can be replied to, because
  // the trial notice and the recovery mail are answered by a merchant who is
  // locked out and a bounce there loses him. The shopper's copy cannot, because
  // «متى يوصل طلبي؟» belongs to the shop — routing it here would make the
  // platform the support desk for every store on it. The store's own address
  // is P27-2's; until it exists, no path beats the wrong path.
  const customerRow = createdRows.find((row) => row.recipientKind === "customer")!;
  assert.notEqual(customerRow.recipient, merchantRow.recipient, "the two copies must go to different addresses for this to measure anything");
  assert.equal(fake.sent.find((entry) => entry.to === merchantRow.recipient)?.replyTo, SUPPORT_EMAIL, "ق-184: the merchant's reply reaches a human");
  assert.equal(fake.sent.find((entry) => entry.to === customerRow.recipient)?.replyTo, undefined, "ق-184: the shopper's reply must never land on the platform");
  summary.replyPath = { merchant: SUPPORT_EMAIL, customer: null };

  // Retry with exponential backoff on a fresh failing row.
  // Synthetic rows pin nextAttemptAt in the past so container/host clock skew cannot defer them.
  const failingRow = await prisma.notificationOutbox.create({ data: { storeId: storeA.id, eventType: "low_stock", recipientKind: "merchant", channel: "email", recipient: merchantA.email, nextAttemptAt: new Date(Date.now() - 5000), payload: { productName: "retry", sku: "R", stockQuantity: 1, lowStockThreshold: 2, storeName: storeA.name } } });
  fake.failNext = 1;
  const retryBatch = await processOutboxBatch(fake, { batchSize: 10 });
  assert.equal(retryBatch.retried, 1);
  const afterFail = await prisma.notificationOutbox.findUnique({ where: { id: failingRow.id } });
  assert.equal(afterFail?.status, "retry_scheduled");
  assert.equal(afterFail?.attemptCount, 1);
  const expectedDelayMs = retryDelaySeconds(1) * 1000;
  assert.ok(afterFail!.nextAttemptAt.valueOf() > Date.now() + expectedDelayMs - 5000, "backoff must schedule the next attempt in the future");
  const notDue = await processOutboxBatch(fake, { batchSize: 10 });
  assert.equal(notDue.claimed, 0, "a scheduled retry is not claimable before its time");
  const dueBatch = await processOutboxBatch(fake, { batchSize: 10, now: new Date(Date.now() + expectedDelayMs + 1000) });
  assert.equal(dueBatch.sent, 1, "the retry succeeds once due");

  // Dead letter after OUTBOX_MAX_ATTEMPTS.
  const doomedRow = await prisma.notificationOutbox.create({ data: { storeId: storeA.id, eventType: "low_stock", recipientKind: "merchant", channel: "email", recipient: merchantA.email, nextAttemptAt: new Date(Date.now() - 5000), payload: { productName: "doomed", sku: "D", stockQuantity: 0, lowStockThreshold: 1, storeName: storeA.name } } });
  fake.failAlways = true;
  let cursorNow = Date.now();
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
    await processOutboxBatch(fake, { batchSize: 10, now: new Date(cursorNow) });
    cursorNow += retryDelaySeconds(i + 1) * 1000 + 1000;
  }
  fake.failAlways = false;
  const doomed = await prisma.notificationOutbox.findUnique({ where: { id: doomedRow.id } });
  assert.equal(doomed?.status, "dead_letter");
  assert.equal(doomed?.attemptCount, OUTBOX_MAX_ATTEMPTS);

  // Two concurrent workers never send the same row twice.
  await prisma.notificationOutbox.createMany({ data: Array.from({ length: 6 }, (_, index) => ({ storeId: storeA.id, eventType: "low_stock" as const, recipientKind: "merchant" as const, channel: "email" as const, recipient: merchantA.email, nextAttemptAt: new Date(Date.now() - 5000), payload: { productName: `race-${index}`, sku: `RACE-${index}`, stockQuantity: 0, lowStockThreshold: 1, storeName: storeA.name } })) });
  const racer = new FakeNotificationProvider();
  racer.delayMs = 25;
  const [batchOne, batchTwo] = await Promise.all([
    processOutboxBatch(racer, { batchSize: 10 }),
    processOutboxBatch(racer, { batchSize: 10 }),
  ]);
  assert.equal(batchOne.sent + batchTwo.sent, 6, JSON.stringify({ batchOne, batchTwo }));
  assert.equal(racer.sent.length, 6, "each row must be delivered exactly once");

  // Without a provider the row is marked skipped, never falsely sent.
  const orphanRow = await prisma.notificationOutbox.create({ data: { storeId: storeA.id, eventType: "low_stock", recipientKind: "merchant", channel: "email", recipient: merchantA.email, nextAttemptAt: new Date(Date.now() - 5000), payload: { productName: "skip", sku: "S", stockQuantity: 0, lowStockThreshold: 1, storeName: storeA.name } } });
  const skippedBatch = await processOutboxBatch(null, { batchSize: 10 });
  assert.equal(skippedBatch.skipped, 1);
  assert.equal((await prisma.notificationOutbox.findUnique({ where: { id: orphanRow.id } }))?.status, "skipped");
  summary.worker = { firstBatchSent: firstBatch.sent, retrySucceeded: dueBatch.sent, deadLetterAttempts: doomed?.attemptCount, concurrencyExactlyOnce: racer.sent.length, noProviderSkipped: skippedBatch.skipped };

  // ---------- log API + tenancy/permission isolation ----------
  const log = await request("/merchant/stores/phase15-a-one/notifications/log?limit=10", { headers: bearer(tokenMerchantA) });
  assert.equal(log.status, 200);
  assert.ok(log.body.notifications.length > 0);
  assert.equal(log.body.notifications.some((row: any) => "payload" in row), false, "raw payloads stay server-side; only safe summaries leave");
  assert.ok(log.body.nextCursor !== undefined);

  const crossMerchantSettings = await request("/merchant/stores/phase15-a-one/notifications/settings", { headers: bearer(tokenMerchantB) });
  assert.equal(crossMerchantSettings.status, 403);
  const crossMerchantLog = await request("/merchant/stores/phase15-a-one/notifications/log", { headers: bearer(tokenMerchantB) });
  assert.equal(crossMerchantLog.status, 403);
  const staffDeniedSettings = await request("/merchant/stores/phase15-a-one/notifications/settings", { headers: bearer(tokenStaff) });
  assert.equal(staffDeniedSettings.status, 403, "store_staff lacks settings.manage");
  assert.equal(staffDeniedSettings.body.error.code, "STAFF_PERMISSION_DENIED");
  const promote = await request(`/merchant/stores/phase15-a-one/team/${staffCreate.body.membership.id}`, { method: "PATCH", headers: bearer(tokenMerchantA), body: JSON.stringify({ roleCode: "store_manager" }) });
  assert.equal(promote.status, 200);
  const staffRelogin = await request("/auth/staff/stores/phase15-a-one/login", { method: "POST", body: JSON.stringify({ email: "staff.phase15@codiq.test", password: "phase15-staff-pass-01" }) });
  const managerSettings = await request("/merchant/stores/phase15-a-one/notifications/settings", { headers: bearer(staffRelogin.body.accessToken) });
  assert.equal(managerSettings.status, 200, "store_manager holds settings.manage");
  summary.isolation = { crossMerchantSettings: crossMerchantSettings.status, crossMerchantLog: crossMerchantLog.status, staffDenied: staffDeniedSettings.status, staffManagerAllowed: managerSettings.status };

  // Store B's log stays empty and unaffected by store A's traffic.
  const storeBLog = await request("/merchant/stores/phase15-b-one/notifications/log", { headers: bearer(tokenMerchantB) });
  assert.equal(storeBLog.status, 200);
  assert.equal(storeBLog.body.notifications.length, 0);

  // Disabled store enqueues nothing at all.
  const productB = await prisma.product.create({ data: { storeId: storeB.id, sku: "P15-B", name: "منتج باء", priceIqd: 1000, stockQuantity: 5, lowStockThreshold: 2 } });
  const disabledDrop = await request(`/merchant/stores/phase15-b-one/catalog/products/${productB.id}/inventory`, { method: "POST", headers: bearer(tokenMerchantB), body: JSON.stringify({ stockQuantity: 1, reason: "phase15-disabled" }) });
  assert.equal(disabledDrop.status, 200);
  assert.equal(await prisma.notificationOutbox.count({ where: { storeId: storeB.id } }), 0, "disabled notifications must not enqueue");
  summary.disabledStore = { outboxRows: 0 };

  // ق-185 — the dedupe key must hold for a message with NO store.
  //
  // Every scanner that relies on `dedupeKey` today passes a real storeId, so
  // UNIQUE(store_id, dedupe_key) has always protected them. It cannot protect a
  // merchant ACCOUNT message: Postgres treats NULLs as distinct, so two
  // (NULL, 'k') rows never collide, and a scanner enqueueing one on every pass
  // would send hundreds of copies of one email while looking exactly like the
  // code that works. Proven here on the two shapes at once — store-less rows
  // MUST collide, and rows carrying no dedupe key at all must still be free to
  // repeat, which is why the fix is a partial index and not NULLS NOT DISTINCT.
  const accountRow = { eventType: "auth.password_reset" as const, recipientKind: "account", channel: "email" as const, recipient: "dedupe.probe@codiq.test", payload: {} };
  await prisma.notificationOutbox.create({ data: { ...accountRow, storeId: null, dedupeKey: "q185_probe" } });
  let storelessDuplicate: string | null = null;
  try {
    await prisma.notificationOutbox.create({ data: { ...accountRow, storeId: null, dedupeKey: "q185_probe" } });
  } catch (error) {
    storelessDuplicate = (error as { code?: string }).code ?? "unknown";
  }
  assert.equal(storelessDuplicate, "P2002", "ق-185: a second store-less row with the same dedupe key must be refused by the database, not by hope");
  const beforeUnkeyed = await prisma.notificationOutbox.count({ where: { storeId: null, dedupeKey: null } });
  await prisma.notificationOutbox.create({ data: { ...accountRow, storeId: null, dedupeKey: null } });
  await prisma.notificationOutbox.create({ data: { ...accountRow, storeId: null, dedupeKey: null } });
  assert.equal(await prisma.notificationOutbox.count({ where: { storeId: null, dedupeKey: null } }), beforeUnkeyed + 2, "ق-185: rows that asked for no dedupe must still be free to repeat");
  summary.storelessDedupe = { duplicateRefused: "P2002", unkeyedStillFree: true };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

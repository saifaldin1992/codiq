import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `phase8a-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "phase8a-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const { Client } = await import("pg");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, payload: response.status === 204 ? null : await response.json().catch(() => null) };
}

async function status(token, storeSlug, orderId, toStatus, expectedVersion, note = undefined) {
  return request(`/merchant/stores/${storeSlug}/orders/${orderId}/status`, { token, method: "POST", body: { toStatus, expectedVersion, ...(note ? { note } : {}) } });
}

try {
  // TRUNCATE intentionally bypasses the append-only row trigger only in this isolated development test setup.
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

  const ownerRegistration = await request("/auth/platform/register", { method: "POST", body: { email: `${testId}.owner@codiq.test`, password: "Phase8OwnerPass123!", displayName: "مالك اختبار 8A" } });
  assert.equal(ownerRegistration.status, 201);
  const ownerLogin = await request("/auth/platform/login", { method: "POST", body: { email: `${testId}.owner@codiq.test`, password: "Phase8OwnerPass123!" } });
  assert.equal(ownerLogin.status, 200);
  const ownerToken = ownerLogin.payload.accessToken;

  const merchantARegistration = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100396501", email: `${testId}.a@codiq.test`, password: "Phase8MerchantPass123!", businessName: "متجر دورة الحياة A" });
  const merchantBRegistration = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100396502", email: `${testId}.b@codiq.test`, password: "Phase8MerchantPass123!", businessName: "متجر دورة الحياة B" });
  assert.equal(merchantARegistration.status, 201); assert.equal(merchantBRegistration.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantARegistration.payload.account.id, name: "متجر دورة الحياة A", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantBRegistration.payload.account.id, name: "متجر دورة الحياة B", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });

  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password: "Phase8MerchantPass123!" } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password: "Phase8MerchantPass123!" } });
  assert.equal(loginA.status, 200); assert.equal(loginB.status, 200);
  const tokenA = loginA.payload.accessToken; const tokenB = loginB.payload.accessToken;

  const customerA = await prisma.customer.create({ data: { storeId: storeA.id, email: `${testId}.customer@codiq.test`, passwordHash: "not-used-in-8a", fullName: "زبون اختبار 8A" } });
  const customerToken = await createTypedSession("customer", customerA.id);
  const productA = await prisma.product.create({ data: { storeId: storeA.id, sku: "LIFE-A", name: "منتج لا تتغير كميته", priceIqd: 12000, stockQuantity: 7, lowStockThreshold: 2 } });
  const initialInventoryCount = await prisma.inventoryMovement.count({ where: { storeId: storeA.id, productId: productA.id } });
  const orderA = await prisma.storeOrder.create({ data: { storeId: storeA.id, customerId: customerA.id, orderNumber: "LIFE-A-001", customerName: customerA.fullName, customerEmail: customerA.email, status: "new", subtotalIqd: 12000, totalIqd: 12000, items: { create: { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 1, unitPriceIqd: 12000, lineTotalIqd: 12000 } } } });
  const orderB = await prisma.storeOrder.create({ data: { storeId: storeB.id, orderNumber: "LIFE-B-001", customerName: "زبون متجر B", status: "new", subtotalIqd: 5000, totalIqd: 5000 } });
  const deliveryOrder = await prisma.storeOrder.create({ data: { storeId: storeA.id, orderNumber: "LIFE-A-DELIVERY", customerName: "اختبار التوصيل", status: "new", subtotalIqd: 1000, totalIqd: 1000 } });
  const concurrentOrder = await prisma.storeOrder.create({ data: { storeId: storeA.id, orderNumber: "LIFE-A-CONCURRENT", customerName: "اختبار التزامن", status: "new", subtotalIqd: 1000, totalIqd: 1000 } });

  const firstList = await request(`/merchant/stores/${storeA.slug}/orders?limit=1`, { token: tokenA });
  assert.equal(firstList.status, 200); assert.equal(firstList.payload.orders.length, 1); assert.ok(firstList.payload.nextCursor);
  const secondList = await request(`/merchant/stores/${storeA.slug}/orders?limit=1&cursor=${encodeURIComponent(firstList.payload.nextCursor)}`, { token: tokenA });
  assert.equal(secondList.status, 200); assert.equal(secondList.payload.orders.some((order) => order.id === firstList.payload.orders[0].id), false);

  const toProcessing = await status(tokenA, storeA.slug, orderA.id, "processing", 1, "بدء المعالجة");
  assert.equal(toProcessing.status, 200); assert.equal(toProcessing.payload.order.status, "processing"); assert.equal(toProcessing.payload.order.version, 2);
  const forbiddenRollback = await status(tokenA, storeA.slug, orderA.id, "new", 2);
  assert.equal(forbiddenRollback.status, 422); assert.equal(forbiddenRollback.payload.error.code, "INVALID_ORDER_TRANSITION");
  const toPreparation = await status(tokenA, storeA.slug, orderA.id, "preparation", 2);
  const toDelivery = await status(tokenA, storeA.slug, orderA.id, "out_for_delivery", 3);
  const toCompleted = await status(tokenA, storeA.slug, orderA.id, "completed", 4);
  const toReturned = await status(tokenA, storeA.slug, orderA.id, "returned", 5);
  assert.equal(toPreparation.status, 200); assert.equal(toDelivery.status, 200); assert.equal(toCompleted.status, 200); assert.equal(toReturned.status, 200); assert.equal(toReturned.payload.order.status, "returned");

  for (const [toStatus, version] of [["processing", 1], ["preparation", 2], ["out_for_delivery", 3]]) {
    const result = await status(tokenA, storeA.slug, deliveryOrder.id, toStatus, version);
    assert.equal(result.status, 200);
  }
  const forbiddenAfterDispatch = await status(tokenA, storeA.slug, deliveryOrder.id, "cancelled", 4);
  assert.equal(forbiddenAfterDispatch.status, 422); assert.equal(forbiddenAfterDispatch.payload.error.code, "INVALID_ORDER_TRANSITION");

  for (const [toStatus, version] of [["processing", 1], ["preparation", 2], ["out_for_delivery", 3]]) {
    const result = await status(tokenA, storeA.slug, concurrentOrder.id, toStatus, version);
    assert.equal(result.status, 200);
  }
  const concurrentResponses = await Promise.all([
    status(tokenA, storeA.slug, concurrentOrder.id, "completed", 4),
    status(tokenA, storeA.slug, concurrentOrder.id, "returned", 4),
  ]);
  assert.equal(concurrentResponses.filter((result) => result.status === 200).length, 1);
  assert.equal(concurrentResponses.filter((result) => result.status === 409 && result.payload.error.code === "ORDER_VERSION_CONFLICT").length, 1);

  const crossStoreTransition = await status(tokenB, storeB.slug, orderA.id, "processing", 1);
  assert.equal(crossStoreTransition.status, 404); assert.equal(crossStoreTransition.payload.error.code, "RESOURCE_NOT_FOUND");
  const customerOrderAccess = await request(`/merchant/stores/${storeA.slug}/orders`, { token: customerToken });
  assert.equal(customerOrderAccess.status, 403); assert.equal(customerOrderAccess.payload.error.code, "IDENTITY_BOUNDARY_DENIED");

  const history = await request(`/merchant/stores/${storeA.slug}/orders/${orderA.id}/history`, { token: tokenA });
  assert.equal(history.status, 200); assert.equal(history.payload.events.length, 5); assert.equal(history.payload.events.at(-1).toStatus, "returned");
  const detail = await request(`/merchant/stores/${storeA.slug}/orders/${orderA.id}`, { token: tokenA });
  assert.equal(detail.status, 200); assert.equal(detail.payload.order.statusEvents.length, 5);

  const platformList = await request("/platform/orders?status=returned", { token: ownerToken });
  const platformDetail = await request(`/platform/orders/${orderA.id}`, { token: ownerToken });
  const platformHistory = await request(`/platform/orders/${orderA.id}/history`, { token: ownerToken });
  assert.equal(platformList.status, 200); assert.ok(platformList.payload.orders.some((order) => order.id === orderA.id));
  assert.equal(platformDetail.status, 200); assert.equal(platformDetail.payload.order.store.slug, storeA.slug);
  assert.equal(platformHistory.status, 200); assert.equal(platformHistory.payload.events.length, 5);

  const inventoryAfterTransitions = await prisma.product.findUniqueOrThrow({ where: { id: productA.id }, select: { stockQuantity: true } });
  const inventoryCountAfterTransitions = await prisma.inventoryMovement.count({ where: { storeId: storeA.id, productId: productA.id } });
  assert.equal(inventoryAfterTransitions.stockQuantity, 7); assert.equal(inventoryCountAfterTransitions, initialInventoryCount);

  const existingEvent = await prisma.orderStatusEvent.findFirstOrThrow({ where: { orderId: orderA.id }, orderBy: { createdAt: "asc" } });
  let immutableTriggerCode = null; let storeGuardTriggerCode = null;
  try { await sql.query("UPDATE order_status_events SET note = $1 WHERE id = $2::uuid", ["محاولة تعديل ممنوعة", existingEvent.id]); } catch (error) { immutableTriggerCode = error?.code ?? null; }
  try { await sql.query("INSERT INTO order_status_events (store_id, order_id, from_status, to_status, actor_kind, actor_id) VALUES ($1::uuid, $2::uuid, 'new', 'processing', 'merchant', $3::uuid)", [storeB.id, orderA.id, merchantBRegistration.payload.account.id]); } catch (error) { storeGuardTriggerCode = error?.code ?? null; }
  assert.equal(immutableTriggerCode, "23514"); assert.equal(storeGuardTriggerCode, "23514");

  console.log(JSON.stringify({
    validTransitions: { newToProcessing: toProcessing.status, completedToReturned: toReturned.status },
    forbiddenTransitions: { processingToNew: forbiddenRollback.status, outForDeliveryToCancelled: forbiddenAfterDispatch.status },
    concurrency: concurrentResponses.map((result) => ({ status: result.status, code: result.payload?.error?.code ?? null })),
    idor: { merchantBCrossStoreUpdate: crossStoreTransition.status, customerOrderEndpoint: customerOrderAccess.status },
    triggers: { immutable: immutableTriggerCode, storeMatch: storeGuardTriggerCode },
    inventory: { stockQuantity: inventoryAfterTransitions.stockQuantity, movementsBefore: initialInventoryCount, movementsAfter: inventoryCountAfterTransitions },
    ownerOversight: { list: platformList.status, detail: platformDetail.status, history: platformHistory.status },
    seededForeignOrder: orderB.id,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

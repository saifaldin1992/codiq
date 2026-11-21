/**
 * codiq phase 20A — product variants core integration proof.
 * Follows the phase9a harness (real HTTP app + raw pg client + the
 * pg_stat_activity lock barrier) and proves, against a real PostgreSQL:
 *  1. concurrency on a variant's LAST unit — one 201, one INSUFFICIENT_AVAILABLE_STOCK,
 *     sibling variants untouched;
 *  2. parent-product deactivation during checkout — the JOIN lock
 *     (FOR UPDATE OF v, p) preserves PRODUCT_UNAVAILABLE with zero side effects;
 *  3. per-variant stock isolation + low-stock fires for the right variant only;
 *  4. IDOR closed at the schema level (23503 composite FK, 23505 second default)
 *     and at the API level (404);
 *  5. no regression for legacy default-only products (5 -> 3 after completed,
 *     reservation consumed, frozen product column mirrors the default variant);
 *  6. idempotency + cartVersion behavior unchanged;
 *  7. public availability is per-variant and never leaks stock quantities.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `phase20a-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "phase20a-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    payload: response.status === 204 ? null : await response.json().catch(() => null),
    response,
  };
}

async function merchantStatus(token, slug, orderId, toStatus, expectedVersion) {
  return request(`/merchant/stores/${slug}/orders/${orderId}/status`, {
    method: "POST",
    token,
    body: { toStatus, expectedVersion },
  });
}

async function completeOrder(token, slug, orderId) {
  for (const [toStatus, version] of [
    ["processing", 1],
    ["preparation", 2],
    ["out_for_delivery", 3],
    ["completed", 4],
  ]) {
    const result = await merchantStatus(token, slug, orderId, toStatus, version);
    assert.equal(
      result.status,
      200,
      `transition to ${toStatus} failed: ${JSON.stringify(result.payload)}`
    );
  }
}

async function waitForCheckoutVariantLock(monitor) {
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const result = await monitor.query(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%' AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting"
    );
    if (result.rows[0].waiting) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Phase 20A synchronization barrier was not reached.");
}

async function variantRow(variantId) {
  return prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
}

async function registerCustomer(slug, phone, fullName) {
  const registered = await request(`/store/${slug}/account/register`, {
    method: "POST",
    body: { phone, password: "Phase20CustomerPass123!", fullName },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const address = await request(`/store/${slug}/account/addresses`, {
    method: "POST",
    token: registered.payload.accessToken,
    body: {
      recipientName: fullName,
      fullAddress: "شارع المتغيرات 20",
      city: "Baghdad",
      governorate: "Baghdad",
      phoneContact: phone,
      isDefault: true,
    },
  });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  return {
    token: registered.payload.accessToken,
    account: registered.payload.account,
    addressId: address.payload.address.id,
  };
}

try {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
  );

  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100651801",
    email: `${testId}.merchant-a@codiq.test`,
    password: "Phase20MerchantPass123!",
    businessName: "متجر 20A ألف",
  });
  const merchantB = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100651802",
    email: `${testId}.merchant-b@codiq.test`,
    password: "Phase20MerchantPass123!",
    businessName: "متجر 20A باء",
  });
  assert.equal(merchantA.status, 201);
  assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.payload.account.id,
      name: "متجر 20A ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.payload.account.id,
      name: "متجر 20A باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  await prisma.deliveryRate.create({
    data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true },
  });
  await prisma.notificationSettings.create({ data: { storeId: storeA.id, isEnabled: true } });
  const merchantLoginA = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}.merchant-a@codiq.test`, password: "Phase20MerchantPass123!" },
  });
  assert.equal(merchantLoginA.status, 200);
  const merchantTokenA = merchantLoginA.payload.accessToken;

  // ---------- default-variant invariant: every creation path materializes one ----------
  const multiProduct = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "P20A-MAIN",
      name: "منتج متعدد المتغيرات",
      priceIqd: 10000,
      stockQuantity: 5,
      lowStockThreshold: 0,
    },
  });
  const defaultVariant = await prisma.productVariant.findFirstOrThrow({
    where: { productId: multiProduct.id, isDefault: true },
  });
  assert.equal(defaultVariant.sku, "P20A-MAIN");
  assert.equal(defaultVariant.priceIqd, 10000);
  assert.equal(defaultVariant.stockQuantity, 5);
  assert.equal(defaultVariant.storeId, storeA.id);
  const productB = await prisma.product.create({
    data: {
      storeId: storeB.id,
      sku: "P20A-B",
      name: "منتج متجر باء",
      priceIqd: 9000,
      stockQuantity: 5,
      lowStockThreshold: 1,
    },
  });
  const defaultVariantB = await prisma.productVariant.findFirstOrThrow({
    where: { productId: productB.id, isDefault: true },
  });

  // ---------- merchant variant CRUD ----------
  const variantsBase = `/merchant/stores/${storeA.slug}/catalog/products/${multiProduct.id}/variants`;
  const redCreate = await request(variantsBase, {
    method: "POST",
    token: merchantTokenA,
    body: {
      sku: "P20A-RED-L",
      name: "أحمر / L",
      priceIqd: 12000,
      stockQuantity: 1,
      lowStockThreshold: 0,
      options: { color: "أحمر", size: "L" },
    },
  });
  assert.equal(redCreate.status, 201, JSON.stringify(redCreate.payload));
  const redVariant = redCreate.payload.variant;
  assert.equal(redVariant.isDefault, false);
  assert.equal(redVariant.stockQuantity, 1);
  const blueCreate = await request(variantsBase, {
    method: "POST",
    token: merchantTokenA,
    body: {
      sku: "P20A-BLUE-M",
      name: "أزرق / M",
      priceIqd: 11000,
      stockQuantity: 3,
      lowStockThreshold: 2,
      options: { color: "أزرق", size: "M" },
    },
  });
  assert.equal(blueCreate.status, 201);
  const blueVariant = blueCreate.payload.variant;
  const duplicateSku = await request(variantsBase, {
    method: "POST",
    token: merchantTokenA,
    body: { sku: "P20A-RED-L", name: "مكرر", priceIqd: 1 },
  });
  assert.equal(duplicateSku.status, 409);
  assert.equal(duplicateSku.payload.error.code, "DUPLICATE_VARIANT_SKU");
  const variantList = await request(variantsBase, { token: merchantTokenA });
  assert.equal(variantList.status, 200);
  assert.equal(variantList.payload.variants.length, 3);
  assert.equal(variantList.payload.variants[0].isDefault, true);
  const deleteDefault = await request(`${variantsBase}/${defaultVariant.id}`, {
    method: "DELETE",
    token: merchantTokenA,
  });
  assert.equal(deleteDefault.status, 409);
  assert.equal(deleteDefault.payload.error.code, "DEFAULT_VARIANT_PROTECTED");
  const variantInventory = await request(`${variantsBase}/${blueVariant.id}/inventory`, {
    method: "POST",
    token: merchantTokenA,
    body: { stockQuantity: 3, reason: "phase20a-noop" },
  });
  assert.equal(variantInventory.status, 200);
  assert.equal(variantInventory.payload.variant.stockQuantity, 3);
  const inventoryMovementsAfterNoop = await prisma.inventoryMovement.count({
    where: { variantId: blueVariant.id },
  });
  assert.equal(
    inventoryMovementsAfterNoop,
    1,
    "initial_stock only — a no-op adjustment must not add a movement"
  );

  // ---------- 7. public availability per variant, no stock leak ----------
  const publicBefore = await request(`/store/${storeA.slug}/products/${multiProduct.id}`);
  assert.equal(publicBefore.status, 200);
  assert.equal(Object.hasOwn(publicBefore.payload.product, "stockQuantity"), false);
  assert.equal(publicBefore.payload.product.variants.length, 3);
  for (const variant of publicBefore.payload.product.variants) {
    assert.equal(
      Object.hasOwn(variant, "stockQuantity"),
      false,
      "public variants must not leak stock quantities"
    );
    assert.equal(variant.isAvailable, true);
  }
  const publicList = await request(`/store/${storeA.slug}/products`);
  const publicListed = publicList.payload.products.find(
    (product) => product.id === multiProduct.id
  );
  assert.equal(publicListed.isAvailable, true);
  assert.equal(publicListed.minPriceIqd, 10000);
  assert.equal(publicListed.maxPriceIqd, 12000);

  // ---------- 1. concurrency on a variant's LAST unit ----------
  const customer1 = await registerCustomer(storeA.slug, "+9647702000001", "زبونة المتغير الأول");
  const customer2 = await registerCustomer(storeA.slug, "+9647702000002", "زبونة المتغير الثاني");
  const cart1 = await request(`/store/${storeA.slug}/cart/items`, {
    method: "POST",
    token: customer1.token,
    body: { variantId: redVariant.id, quantity: 1 },
  });
  assert.equal(cart1.status, 200);
  assert.equal(cart1.payload.cart.items[0].variantId, redVariant.id);
  assert.equal(
    cart1.payload.cart.items[0].priceSnapshotIqd,
    12000,
    "snapshot must come from the VARIANT price"
  );
  const cart2 = await request(`/store/${storeA.slug}/cart/items`, {
    method: "POST",
    token: customer2.token,
    body: { variantId: redVariant.id, quantity: 1 },
  });
  assert.equal(cart2.status, 200);
  const lastUnitRace = await Promise.all([
    request(`/store/${storeA.slug}/checkout`, {
      method: "POST",
      token: customer1.token,
      headers: { "idempotency-key": "phase20a-last-unit-key-0001" },
      body: {
        cartVersion: cart1.payload.cart.version,
        addressId: customer1.addressId,
        paymentMethodCode: "cod",
      },
    }),
    request(`/store/${storeA.slug}/checkout`, {
      method: "POST",
      token: customer2.token,
      headers: { "idempotency-key": "phase20a-last-unit-key-0002" },
      body: {
        cartVersion: cart2.payload.cart.version,
        addressId: customer2.addressId,
        paymentMethodCode: "cod",
      },
    }),
  ]);
  const raceStatuses = lastUnitRace.map((result) => result.status).sort();
  assert.deepEqual(
    raceStatuses,
    [201, 422],
    JSON.stringify(lastUnitRace.map((result) => result.payload))
  );
  const raceLoser = lastUnitRace.find((result) => result.status === 422);
  assert.equal(raceLoser.payload.error.code, "INSUFFICIENT_AVAILABLE_STOCK");
  // ق-221: the loser is told WHICH line lost and how many are left — by the
  // product's name and the VARIANT's, since «قميص» alone would not tell him it
  // was the red one that ran out.
  assert.equal(
    raceLoser.payload.error.lines?.length,
    1,
    `ق-221: the refusal names the line — ${JSON.stringify(raceLoser.payload.error)}`
  );
  assert.deepEqual(
    {
      variantId: raceLoser.payload.error.lines[0].variantId,
      variantName: raceLoser.payload.error.lines[0].variantName,
      requested: raceLoser.payload.error.lines[0].requested,
      available: raceLoser.payload.error.lines[0].available,
      reason: raceLoser.payload.error.lines[0].reason,
    },
    {
      variantId: redVariant.id,
      variantName: redVariant.name,
      requested: 1,
      available: 0,
      reason: "insufficient_stock",
    }
  );
  const raceWinnerOrder = lastUnitRace.find((result) => result.status === 201).payload.order;
  assert.equal(raceWinnerOrder.items[0].variantId, redVariant.id);
  assert.equal(raceWinnerOrder.items[0].variantName, "أحمر / L");
  assert.equal(
    (await variantRow(redVariant.id)).stockQuantity,
    1,
    "stock is decremented only at completion"
  );
  assert.equal(
    (await variantRow(defaultVariant.id)).stockQuantity,
    5,
    "sibling default variant untouched"
  );
  assert.equal(
    (await variantRow(blueVariant.id)).stockQuantity,
    3,
    "sibling blue variant untouched"
  );
  assert.equal(
    await prisma.inventoryReservation.count({
      where: { variantId: redVariant.id, status: "active" },
    }),
    1
  );
  const publicAfterRace = await request(`/store/${storeA.slug}/products/${multiProduct.id}`);
  const redPublic = publicAfterRace.payload.product.variants.find(
    (variant) => variant.id === redVariant.id
  );
  const bluePublic = publicAfterRace.payload.product.variants.find(
    (variant) => variant.id === blueVariant.id
  );
  assert.equal(
    redPublic.isAvailable,
    false,
    "the reserved last unit makes the variant unavailable"
  );
  assert.equal(bluePublic.isAvailable, true);

  // ---------- 2. parent deactivation during checkout (CO-05 with the JOIN lock) ----------
  const customer3 = await registerCustomer(storeA.slug, "+9647702000003", "زبونة تعطيل الأب");
  const cart3 = await request(`/store/${storeA.slug}/cart/items`, {
    method: "POST",
    token: customer3.token,
    body: { variantId: blueVariant.id, quantity: 2 },
  });
  assert.equal(cart3.status, 200);
  const locker = new Client({ connectionString: process.env.DATABASE_URL });
  const monitor = new Client({ connectionString: process.env.DATABASE_URL });
  await locker.connect();
  await monitor.connect();
  await locker.query("BEGIN");
  await locker.query("SELECT id FROM products WHERE id = $1::uuid FOR UPDATE", [multiProduct.id]);
  const co05OrdersBefore = await prisma.storeOrder.count({
    where: { storeId: storeA.id, source: "storefront" },
  });
  const co05ReservationsBefore = await prisma.inventoryReservation.count({
    where: { variantId: blueVariant.id },
  });
  const co05Checkout = request(`/store/${storeA.slug}/checkout`, {
    method: "POST",
    token: customer3.token,
    headers: { "idempotency-key": "phase20a-co05-key-0001" },
    body: {
      cartVersion: cart3.payload.cart.version,
      addressId: customer3.addressId,
      paymentMethodCode: "cod",
    },
  });
  await waitForCheckoutVariantLock(monitor);
  await locker.query("UPDATE products SET is_active = false WHERE id = $1::uuid", [
    multiProduct.id,
  ]);
  await locker.query("COMMIT");
  const co05 = await co05Checkout;
  await locker.end();
  await monitor.end();
  assert.equal(co05.status, 422);
  assert.equal(co05.payload.error.code, "PRODUCT_UNAVAILABLE");
  assert.equal(
    await prisma.storeOrder.count({ where: { storeId: storeA.id, source: "storefront" } }),
    co05OrdersBefore
  );
  assert.equal(
    await prisma.inventoryReservation.count({ where: { variantId: blueVariant.id } }),
    co05ReservationsBefore
  );
  assert.equal((await variantRow(blueVariant.id)).stockQuantity, 3);
  await prisma.product.update({ where: { id: multiProduct.id }, data: { isActive: true } });

  // ---------- 3. per-variant stock isolation + low-stock for the right variant only ----------
  const cart3Retry = await request(`/store/${storeA.slug}/cart`, { token: customer3.token });
  assert.equal(cart3Retry.status, 200);
  const blueCheckout = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST",
    token: customer3.token,
    headers: { "idempotency-key": "phase20a-blue-key-0001" },
    body: {
      cartVersion: cart3Retry.payload.cart.version,
      addressId: customer3.addressId,
      paymentMethodCode: "cod",
    },
  });
  assert.equal(blueCheckout.status, 201, JSON.stringify(blueCheckout.payload));
  await completeOrder(merchantTokenA, storeA.slug, blueCheckout.payload.order.id);
  assert.equal((await variantRow(blueVariant.id)).stockQuantity, 1, "3 - 2 = 1 after completion");
  assert.equal(
    (await variantRow(defaultVariant.id)).stockQuantity,
    5,
    "default variant stock is isolated"
  );
  assert.equal((await variantRow(redVariant.id)).stockQuantity, 1, "red variant stock is isolated");
  const mirroredProduct = await prisma.product.findUniqueOrThrow({
    where: { id: multiProduct.id },
  });
  assert.equal(
    mirroredProduct.stockQuantity,
    5,
    "frozen product column mirrors the DEFAULT variant, not siblings"
  );
  const blueReservation = await prisma.inventoryReservation.findFirstOrThrow({
    where: { orderId: blueCheckout.payload.order.id },
  });
  assert.equal(blueReservation.status, "consumed");
  assert.equal(blueReservation.variantId, blueVariant.id);
  const blueMovement = await prisma.inventoryMovement.findFirstOrThrow({
    where: { variantId: blueVariant.id, reason: "storefront_cod_completed" },
  });
  assert.equal(blueMovement.delta, -2);
  const lowStockRows = await prisma.notificationOutbox.findMany({
    where: { storeId: storeA.id, eventType: "low_stock" },
  });
  assert.equal(lowStockRows.length, 1, "exactly one low-stock crossing — the blue variant");
  assert.equal(lowStockRows[0].dedupeKey, `low_stock:${blueVariant.id}:1`);
  assert.equal(lowStockRows[0].productId, multiProduct.id);
  assert.equal(lowStockRows[0].payload.variantId, blueVariant.id);

  // ---------- 4. IDOR: raw SQL and API ----------
  const customer4 = await registerCustomer(storeA.slug, "+9647702000004", "زبونة الحدود");
  const cart4 = await request(`/store/${storeA.slug}/cart/items`, {
    method: "POST",
    token: customer4.token,
    body: { productId: multiProduct.id, quantity: 1 },
  });
  assert.equal(cart4.status, 200);
  const cart4Id = cart4.payload.cart.id;
  let crossStoreVariantFk = null;
  try {
    await sql.query(
      "INSERT INTO cart_items (cart_id, store_id, product_id, variant_id, quantity, price_snapshot_iqd) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1)",
      [cart4Id, storeA.id, multiProduct.id, defaultVariantB.id]
    );
  } catch (error) {
    crossStoreVariantFk = error?.code ?? null;
  }
  assert.equal(
    crossStoreVariantFk,
    "23503",
    "a variant of another store/product must be rejected by the composite FK"
  );
  let crossProductVariantFk = null;
  try {
    await sql.query(
      "INSERT INTO inventory_reservations (store_id, order_id, product_id, variant_id, quantity, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'active')",
      [storeA.id, raceWinnerOrder.id, multiProduct.id, defaultVariantB.id]
    );
  } catch (error) {
    crossProductVariantFk = error?.code ?? null;
  }
  assert.equal(crossProductVariantFk, "23503");
  let secondDefaultCode = null;
  try {
    await sql.query(
      "INSERT INTO product_variants (store_id, product_id, sku, name, price_iqd, is_default) VALUES ($1::uuid, $2::uuid, 'P20A-SECOND-DEFAULT', 'ثانٍ', 1, true)",
      [storeA.id, multiProduct.id]
    );
  } catch (error) {
    secondDefaultCode = error?.code ?? null;
  }
  assert.equal(
    secondDefaultCode,
    "23505",
    "a second default variant must violate the partial unique index"
  );
  const apiForeignVariant = await request(`/store/${storeA.slug}/cart/items`, {
    method: "POST",
    token: customer4.token,
    body: { variantId: defaultVariantB.id, quantity: 1 },
  });
  assert.equal(apiForeignVariant.status, 404);
  const apiMismatchedPair = await request(`/store/${storeA.slug}/cart/items`, {
    method: "POST",
    token: customer4.token,
    body: { productId: productB.id, variantId: redVariant.id, quantity: 1 },
  });
  assert.equal(
    apiMismatchedPair.status,
    404,
    "a variant that does not belong to the given product must 404"
  );
  const referencedDelete = await request(`${variantsBase}/${redVariant.id}`, {
    method: "DELETE",
    token: merchantTokenA,
  });
  assert.equal(referencedDelete.status, 409);
  assert.equal(referencedDelete.payload.error.code, "VARIANT_REFERENCED_BY_ORDER");

  // ---------- 5 + 6. legacy default-only product: phase9a numbers + idempotency/cartVersion ----------
  const legacyProduct = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "P20A-LEGACY",
      name: "منتج قديم بدون متغيرات",
      priceIqd: 10000,
      stockQuantity: 5,
      lowStockThreshold: 1,
    },
  });
  const legacyDefault = await prisma.productVariant.findFirstOrThrow({
    where: { productId: legacyProduct.id, isDefault: true },
  });
  const customer5 = await registerCustomer(storeA.slug, "+9647702000005", "زبونة الإرث");
  const legacyAdd = await request(`/store/${storeA.slug}/cart/items`, {
    method: "POST",
    token: customer5.token,
    body: { productId: legacyProduct.id, quantity: 2 },
  });
  assert.equal(legacyAdd.status, 200, "productId-only cart adds must keep working");
  assert.equal(
    legacyAdd.payload.cart.items[0].variantId,
    legacyDefault.id,
    "a bare productId resolves the default variant"
  );
  assert.equal(legacyAdd.payload.cart.items[0].priceSnapshotIqd, 10000);
  const staleVersion = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST",
    token: customer5.token,
    headers: { "idempotency-key": "phase20a-stale-version-key" },
    body: {
      cartVersion: legacyAdd.payload.cart.version + 5,
      addressId: customer5.addressId,
      paymentMethodCode: "cod",
    },
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(staleVersion.payload.error.code, "CART_VERSION_CONFLICT");
  const legacyKey = { "idempotency-key": "phase20a-legacy-key-0001" };
  const legacyCheckout = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST",
    token: customer5.token,
    headers: legacyKey,
    body: {
      cartVersion: legacyAdd.payload.cart.version,
      addressId: customer5.addressId,
      paymentMethodCode: "cod",
    },
  });
  assert.equal(legacyCheckout.status, 201, JSON.stringify(legacyCheckout.payload));
  const legacyReplay = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST",
    token: customer5.token,
    headers: legacyKey,
    body: {
      cartVersion: legacyAdd.payload.cart.version,
      addressId: customer5.addressId,
      paymentMethodCode: "cod",
    },
  });
  assert.equal(legacyReplay.status, 200);
  assert.equal(legacyReplay.payload.order.id, legacyCheckout.payload.order.id);
  const legacyMismatch = await request(`/store/${storeA.slug}/checkout`, {
    method: "POST",
    token: customer5.token,
    headers: legacyKey,
    body: {
      cartVersion: legacyAdd.payload.cart.version + 1,
      addressId: customer5.addressId,
      paymentMethodCode: "cod",
    },
  });
  assert.equal(legacyMismatch.status, 409);
  assert.equal(legacyMismatch.payload.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(
    (await prisma.product.findUniqueOrThrow({ where: { id: legacyProduct.id } })).stockQuantity,
    5,
    "no decrement before completion"
  );
  await completeOrder(merchantTokenA, storeA.slug, legacyCheckout.payload.order.id);
  const legacyAfter = await prisma.product.findUniqueOrThrow({ where: { id: legacyProduct.id } });
  assert.equal(legacyAfter.stockQuantity, 3, "phase9a numbers hold: 5 -> 3 after completed");
  assert.equal((await variantRow(legacyDefault.id)).stockQuantity, 3);
  const legacyReservation = await prisma.inventoryReservation.findFirstOrThrow({
    where: { orderId: legacyCheckout.payload.order.id },
  });
  assert.equal(legacyReservation.status, "consumed");
  assert.equal(legacyReservation.variantId, legacyDefault.id);

  console.log(
    JSON.stringify(
      {
        defaultVariantInvariant: {
          trigger: "products_create_default_variant",
          inheritedSku: defaultVariant.sku,
          inheritedStock: 5,
        },
        lastUnitRace: {
          statuses: raceStatuses,
          loserCode: raceLoser.payload.error.code,
          redStock: 1,
          siblingsUntouched: true,
          redPublicAvailable: redPublic.isAvailable,
        },
        parentDeactivation: {
          barrier: "checkout_waited_on_joined_product_lock",
          status: co05.status,
          code: co05.payload.error.code,
          ordersDelta: 0,
          reservationsDelta: 0,
        },
        variantIsolation: {
          blueAfterCompletion: 1,
          defaultUntouched: 5,
          mirrorProductColumn: mirroredProduct.stockQuantity,
          lowStockRows: lowStockRows.length,
          dedupeKey: lowStockRows[0].dedupeKey,
        },
        idor: {
          crossStoreVariantFk,
          crossProductVariantFk,
          secondDefaultCode,
          apiForeignVariant: apiForeignVariant.status,
          apiMismatchedPair: apiMismatchedPair.status,
          referencedDelete: referencedDelete.status,
        },
        legacyNoRegression: {
          addByProductIdOnly: legacyAdd.status,
          resolvedDefaultVariant: true,
          stockAfterCompleted: legacyAfter.stockQuantity,
          reservation: legacyReservation.status,
        },
        idempotency: {
          staleVersion: staleVersion.status,
          replay: legacyReplay.status,
          mismatch: legacyMismatch.payload.error.code,
        },
        crud: {
          duplicateSku: duplicateSku.status,
          deleteDefault: deleteDefault.status,
          variantInventory: variantInventory.status,
          listCount: variantList.payload.variants.length,
        },
      },
      null,
      2
    )
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

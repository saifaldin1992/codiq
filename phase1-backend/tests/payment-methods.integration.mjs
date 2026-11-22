/**
 * ق-209 — payment methods the merchant switches on and off.
 *
 * Cash on delivery is on for every store that never touched the page. Wallet
 * transfers are not offered (owner decision 2026-11-22) and cannot be switched
 * on, a gateway cannot be switched on at all until 25أ, the last enabled method
 * refuses to go off, the storefront's payload carries only what is on, a
 * checkout that picks a method that is not offered is refused, and a
 * neighbouring store sees none of it.
 *
 * Run: pnpm payments:methods
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `pay-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

const summary = {};
try {
  const merchant = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر الدفع",
    phone: `+96471${suffix}`,
    email: `${testId}.merchant@codiq.test`,
    password: "PaymentsMerchant!2026",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر الدفع",
      slug: `${testId}-s`,
      defaultSubdomain: `${testId}-s`,
    },
  });
  const token = await createTypedSession("merchant", merchant.payload.account.id, store.id);
  const neighbour = await registerMerchantDirect({
    ownerName: "تاجر آخر",
    businessName: "متجر الجار",
    phone: `+96472${suffix}`,
    email: `${testId}.b@codiq.test`,
    password: "PaymentsNeighbour!2026",
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: neighbour.payload.account.id,
      name: "متجر الجار",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const tokenB = await createTypedSession("merchant", neighbour.payload.account.id, storeB.id);
  const path = `/merchant/stores/${store.slug}/payment-methods`;
  const byCode = (methods) => Object.fromEntries(methods.map((method) => [method.code, method]));

  // ── 1. a store that never touched the page takes cash, and only cash ──────
  const fresh = await request(path, { token });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.payload));
  const defaults = byCode(fresh.payload.methods);
  assert.equal(
    defaults.cod.enabled,
    true,
    "ق-209: cash on delivery is on by default — every existing store keeps working"
  );
  assert.equal(defaults.zaincash.enabled, false);
  assert.equal(
    defaults.card.available,
    false,
    "a gateway is shown, named, and cannot be switched on before 25أ"
  );
  assert.ok(defaults.card.unavailableReason);
  assert.deepEqual(
    (await request(`/store/${store.slug}/public-config`)).payload.paymentMethods.map(
      (method) => method.code
    ),
    ["cod"],
    "…and the shopper is told exactly that"
  );
  summary.defaults = { cod: true, others: false, gateways: "unavailable" };

  // ── 2. no wallet transfer is offered; a gateway needs 25أ ─────────────────
  // Owner decision 2026-11-22 (review batch 4): the platform does not take wallet transfers —
  // Zain Cash, Asia Hawala and FIB are shown as unavailable and cannot be switched on. They had
  // no «I received it» step either, so a transfer order waited forever and the label asked the
  // shopper to pay again at the door.
  for (const code of ["zaincash", "asiahawala", "fib"]) {
    const refused = await request(`${path}/${code}`, {
      method: "PUT",
      token,
      body: { isEnabled: true, walletNumber: "07801234567" },
    });
    assert.equal(refused.status, 422, `${code} · ${JSON.stringify(refused.payload)}`);
    assert.equal(refused.payload.error.code, "PAYMENT_METHOD_UNAVAILABLE", code);
    assert.equal(defaults[code].available, false, `${code} is shown as unavailable`);
    assert.ok(defaults[code].unavailableReason, `${code} says why`);
  }
  const gateway = await request(`${path}/card`, {
    method: "PUT",
    token,
    body: { isEnabled: true },
  });
  assert.equal(gateway.status, 422);
  assert.equal(gateway.payload.error.code, "PAYMENT_METHOD_UNAVAILABLE");
  assert.equal(
    (await request(`${path}/paypal`, { method: "PUT", token, body: { isEnabled: true } })).status,
    404,
    "an unknown code is not found, not invented"
  );
  // A store that switched Zain Cash on BEFORE the decision keeps its row, but it is offered to
  // nobody: the storefront lists cash only.
  await prisma.paymentMethod.upsert({
    where: { storeId_code: { storeId: store.id, code: "zaincash" } },
    update: { isEnabled: true, configuration: { walletNumber: "07801234567" } },
    create: {
      storeId: store.id,
      code: "zaincash",
      displayName: "زين كاش",
      isEnabled: true,
      configuration: { walletNumber: "07801234567" },
    },
  });
  assert.deepEqual(
    (await request(`/store/${store.slug}/public-config`)).payload.paymentMethods.map(
      (method) => method.code
    ),
    ["cod"],
    "a transfer switched on earlier is no longer offered"
  );
  summary.transfer = { walletMethods: "PAYMENT_METHOD_UNAVAILABLE", gateway: "unavailable" };

  // ── 3. checkout honours the pick ─────────────────────────────────────────
  await prisma.deliveryRate.create({
    data: { storeId: store.id, governorate: "Baghdad", amountIqd: 2000, isEnabled: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: "PAY-1",
      name: "منتج الدفع",
      priceIqd: 10000,
      stockQuantity: 10,
      lowStockThreshold: 0,
    },
  });
  const shopper = await request(`/store/${store.slug}/account/register`, {
    method: "POST",
    body: { fullName: "زبون الدفع", phone: `07${suffix}`, password: "PayShopper!2026" },
  });
  assert.equal(shopper.status, 201, JSON.stringify(shopper.payload));
  const customerToken = shopper.payload.accessToken;
  const address = await request(`/store/${store.slug}/account/addresses`, {
    method: "POST",
    token: customerToken,
    body: {
      recipientName: "زبون الدفع",
      fullAddress: "المنصور",
      city: "بغداد",
      governorate: "Baghdad",
      phoneContact: `07${suffix}`,
      isDefault: true,
    },
  });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  const buy = async (paymentMethodCode, key) => {
    const cart = (
      await request(`/store/${store.slug}/cart/items`, {
        method: "POST",
        token: customerToken,
        body: { productId: product.id, quantity: 1 },
      })
    ).payload.cart;
    return request(`/store/${store.slug}/checkout`, {
      method: "POST",
      token: customerToken,
      headers: { "idempotency-key": `${testId}-${key}` },
      body: { cartVersion: cart.version, addressId: address.payload.address.id, paymentMethodCode },
    });
  };
  const transfer = await buy("zaincash", "zain");
  assert.equal(transfer.status, 422, JSON.stringify(transfer.payload));
  assert.equal(
    transfer.payload.error.code,
    "PAYMENT_METHOD_NOT_SUPPORTED",
    "a transfer switched on before the decision cannot be picked at checkout"
  );
  const notOn = await buy("fib", "fib");
  assert.equal(notOn.status, 422, JSON.stringify(notOn.payload));
  assert.equal(
    notOn.payload.error.code,
    "PAYMENT_METHOD_NOT_SUPPORTED",
    "a method the merchant never switched on cannot be picked"
  );
  const cash = await buy("cod", "cash");
  assert.equal(cash.status, 201, JSON.stringify(cash.payload));
  assert.equal(cash.payload.order.paymentStatus, "unpaid");
  summary.checkout = {
    zaincash: "PAYMENT_METHOD_NOT_SUPPORTED",
    fib: "PAYMENT_METHOD_NOT_SUPPORTED",
    cod: "unpaid",
  };

  // ── 4. the last way to pay refuses to go off ─────────────────────────────
  // Cash is the only method a store can have on today, so it can never go off.
  const lastOff = await request(`${path}/cod`, {
    method: "PUT",
    token,
    body: { isEnabled: false },
  });
  assert.equal(lastOff.status, 422);
  assert.equal(
    lastOff.payload.error.code,
    "LAST_PAYMENT_METHOD",
    "ق-209: a shop can never be left with no way to pay"
  );
  summary.lastMethod = "LAST_PAYMENT_METHOD";

  // ── 5. the neighbour's switches are his own ──────────────────────────────
  const theirs = byCode(
    (await request(`/merchant/stores/${storeB.slug}/payment-methods`, { token: tokenB })).payload
      .methods
  );
  assert.equal(theirs.zaincash.enabled, false, "store B never switched anything on");
  assert.equal(theirs.zaincash.walletNumber, null);
  const cross = await request(`${path}/cod`, {
    method: "PUT",
    token: tokenB,
    body: { isEnabled: false },
  });
  assert.ok([403, 404].includes(cross.status), `B cannot flip A's switches — got ${cross.status}`);
  summary.tenantIsolation = true;

  console.log(JSON.stringify({ suite: "payment-methods", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}

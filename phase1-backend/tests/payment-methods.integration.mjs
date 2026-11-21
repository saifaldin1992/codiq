/**
 * ق-209 — payment methods the merchant switches on and off.
 *
 * Cash on delivery is on for every store that never touched the page. A wallet
 * transfer cannot be switched on without a wallet number, a gateway cannot be
 * switched on at all until 25أ, the last enabled method refuses to go off, the
 * storefront's payload carries only what is on (with the wallet number a
 * shopper needs), a checkout that picks a switched-on transfer is created
 * «بانتظار التحويل», one that picks a switched-off method is refused, and a
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

  // ── 2. a wallet transfer needs a wallet number; a gateway needs 25أ ───────
  const noWallet = await request(`${path}/zaincash`, {
    method: "PUT",
    token,
    body: { isEnabled: true },
  });
  assert.equal(noWallet.status, 422);
  assert.equal(
    noWallet.payload.error.code,
    "WALLET_NUMBER_REQUIRED",
    "ق-209: a transfer the shopper cannot make is not a method"
  );
  const badWallet = await request(`${path}/zaincash`, {
    method: "PUT",
    token,
    body: { isEnabled: true, walletNumber: "abc" },
  });
  assert.equal(badWallet.payload.error.code, "INVALID_WALLET_NUMBER");
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
  const zain = await request(`${path}/zaincash`, {
    method: "PUT",
    token,
    body: {
      isEnabled: true,
      walletNumber: "07801234567",
      holderName: "متجر الدفع",
      instructions: "أرسل صورة الإيصال على واتساب",
    },
  });
  assert.equal(zain.status, 200, JSON.stringify(zain.payload));
  assert.equal(byCode(zain.payload.methods).zaincash.enabled, true);
  const shopperSees = (await request(`/store/${store.slug}/public-config`)).payload.paymentMethods;
  assert.deepEqual(
    shopperSees.map((method) => method.code),
    ["cod", "zaincash"]
  );
  assert.equal(
    shopperSees[1].walletNumber,
    "07801234567",
    "the shopper gets the number he must transfer to"
  );
  assert.equal(shopperSees[1].instructions, "أرسل صورة الإيصال على واتساب");
  summary.transfer = {
    needsWallet: "WALLET_NUMBER_REQUIRED",
    gateway: "PAYMENT_METHOD_UNAVAILABLE",
    enabled: true,
  };

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
  assert.equal(transfer.status, 201, JSON.stringify(transfer.payload));
  assert.equal(transfer.payload.order.paymentMethodCode, "zaincash");
  assert.equal(
    transfer.payload.order.paymentStatus,
    "awaiting_transfer",
    "ق-209: a transfer order waits for the merchant to confirm the money"
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
    zaincash: "awaiting_transfer",
    fib: "PAYMENT_METHOD_NOT_SUPPORTED",
    cod: "unpaid",
  };

  // ── 4. the last way to pay refuses to go off ─────────────────────────────
  const codOff = await request(`${path}/cod`, { method: "PUT", token, body: { isEnabled: false } });
  assert.equal(codOff.status, 200, "cash may go off while a transfer is on");
  assert.deepEqual(
    (await request(`/store/${store.slug}/public-config`)).payload.paymentMethods.map(
      (method) => method.code
    ),
    ["zaincash"]
  );
  const cashRefused = await buy("cod", "cash-off");
  assert.equal(cashRefused.status, 422, "…and cash can no longer be picked");
  const lastOff = await request(`${path}/zaincash`, {
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
  await request(`${path}/cod`, { method: "PUT", token, body: { isEnabled: true } });
  summary.lastMethod = "LAST_PAYMENT_METHOD";

  // ── 5. the neighbour's switches are his own ──────────────────────────────
  const theirs = byCode(
    (await request(`/merchant/stores/${storeB.slug}/payment-methods`, { token: tokenB })).payload
      .methods
  );
  assert.equal(theirs.zaincash.enabled, false, "store B never switched anything on");
  assert.equal(theirs.zaincash.walletNumber, null);
  const cross = await request(`${path}/zaincash`, {
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

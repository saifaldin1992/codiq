/**
 * Marketplace M13b — the partner app, over HTTP. The test plays the partner:
 * it signs what the partner would sign.
 *
 *   A2  a signed handoff signs the shopper in and links the partner account
 *       (created if new, his name taken); forged, stale or replayed handoffs
 *       are refused; a handoff whose phone changed asks him to sign in again.
 *   F10 a linked shopper's payment link pays once, for exactly the cart it was
 *       made for: another account, another amount, a changed cart, a product
 *       gone out of stock, an expired link — refused, and the partner told to
 *       return the money. A shopper cannot claim «paid by the partner» himself.
 *       Cancelling a partner-paid order asks the partner to refund.
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
delete process.env.CODIQ_PARTNER_APP_SECRET;
const SECRET = "test-only-partner-shared-secret-of-48-characters!";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");
const { domainEvents } = await import("../src/events/domain-events.ts");
await prisma.storefrontRateLimit.deleteMany({
  where: {
    OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_partner" } }],
  },
});

const sent = [];
setOtpProviderForTests({
  name: "capture",
  async send(phone, code) {
    sent.push({ phone, code });
  },
});
const testId = `m13p${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  const jar = new Map();
  return async (path, { method = "GET", body, headers = {}, raw } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body || raw ? { "content-type": "application/json" } : {}),
        origin: base,
        ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...headers,
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
    return { status: response.status, payload: await response.json().catch(() => null) };
  };
}
// What the partner app signs.
const handoff = (fields, secret = SECRET) => {
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      iat: Math.floor(Date.now() / 1000),
      nonce: randomBytes(16).toString("hex"),
      ...fields,
    })
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("hex")}`;
};
const report = (fields, secret = SECRET) => {
  const raw = JSON.stringify(fields);
  return client()("/partner/payment-links/complete", {
    method: "POST",
    raw,
    headers: { "x-codiq-signature": createHmac("sha256", secret).update(raw).digest("hex") },
  });
};
const tokenOf = (deepLink) =>
  new URL(deepLink.replace("codiq-partner://", "https://partner.example/")).searchParams.get(
    "token"
  );

const summary = {};
const storeIds = [];
try {
  const merchant = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}8`.slice(0, 14),
    email: `${testId}@codiq.test`,
    password: "MarketPartner!2026",
  });
  const merchantId = merchant.payload.account.id;
  const store = await prisma.store.create({
    data: {
      merchantId,
      name: `بقالة ${testId}`,
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({
    data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
  });
  const rice = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `${testId}-rice`,
      name: "رز",
      priceIqd: 12_000,
      stockQuantity: 20,
    },
  });
  const phone = `+96477${digits}1`.slice(0, 14);

  // ── A2 ───────────────────────────────────────────────────────────────────
  assert.equal(
    (
      await client()("/market/partner/enter", {
        method: "POST",
        body: { token: handoff({ partnerAccountId: "acct-1", phone }) },
      })
    ).payload.error.code,
    "PARTNER_OFF",
    "off until configured"
  );
  process.env.CODIQ_PARTNER_APP_SECRET = SECRET;
  const enter = (api, token) => api("/market/partner/enter", { method: "POST", body: { token } });
  assert.equal(
    (
      await enter(
        client(),
        handoff(
          { partnerAccountId: "acct-1", phone },
          "a-forged-secret-of-the-same-length-48-characters"
        )
      )
    ).payload.error.code,
    "PARTNER_TOKEN_INVALID"
  );
  assert.equal(
    (
      await enter(
        client(),
        handoff({ partnerAccountId: "acct-1", phone, iat: Math.floor(Date.now() / 1000) - 600 })
      )
    ).payload.error.code,
    "PARTNER_TOKEN_EXPIRED"
  );
  const shopper = client();
  const first = handoff({ partnerAccountId: `acct-${testId}`, phone, name: "زينب" });
  const entered = await enter(shopper, first);
  assert.equal(entered.status, 200, JSON.stringify(entered.payload));
  assert.deepEqual(
    [entered.payload.linkedNow, entered.payload.shopper.fullName],
    [true, "زينب"],
    "linked, his name taken from the partner"
  );
  assert.equal(
    (await enter(client(), first)).payload.error.code,
    "PARTNER_TOKEN_USED",
    "a handoff works once"
  );
  const again = await enter(client(), handoff({ partnerAccountId: `acct-${testId}`, phone }));
  assert.equal(again.payload.linkedNow, false, "the link signs him in");
  assert.equal(
    (
      await enter(
        client(),
        handoff({ partnerAccountId: `acct-${testId}`, phone: `+96478${digits}2`.slice(0, 14) })
      )
    ).payload.error.code,
    "PARTNER_PHONE_MISMATCH",
    "a changed phone needs his code again"
  );
  const me = (await shopper("/market/me/partner")).payload.partner;
  assert.equal(me.linked, true);
  assert.ok(new Date(me.lastSyncedAt) >= new Date(me.linkedAt), "«آخر مزامنة»");
  summary.signIn = true;

  // ── F10 ──────────────────────────────────────────────────────────────────
  const karrada = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكرادة" },
  });
  const address = (
    await shopper("/market/me/addresses", {
      method: "POST",
      body: {
        label: "البيت",
        recipientName: "زينب",
        phone,
        altPhone: null,
        governorateKey: "Baghdad",
        districtId: karrada.id,
        addressLine: "شارع ٥٢",
        latitude: null,
        longitude: null,
      },
    })
  ).payload.address;
  assert.ok(address, "address");
  const add = (quantity) =>
    shopper("/market/cart/items", { method: "POST", body: { productId: rice.id, quantity } });
  await add(2);
  const makeLink = () =>
    shopper(`/market/checkout/${store.slug}/partner-link`, {
      method: "POST",
      body: { addressId: address.id },
    });
  const account = `acct-${testId}`;

  let link = (await makeLink()).payload;
  assert.equal(link.amountIqd, 27_000, "2 × 12,000 + 3,000 delivery");
  assert.match(link.deepLink, /^codiq-partner:\/\/pay\?token=/);
  assert.equal(
    (
      await report(
        {
          token: tokenOf(link.deepLink),
          partnerAccountId: account,
          amountIqd: 27_000,
          paymentRef: `${testId}-p-0`,
        },
        "a-forged-secret-of-the-same-length-48-characters"
      )
    ).status,
    401,
    "a forged report"
  );
  assert.equal(
    (
      await report({
        token: tokenOf(link.deepLink),
        partnerAccountId: "someone-else",
        amountIqd: 27_000,
        paymentRef: `${testId}-p-1`,
      })
    ).payload.reason,
    "ACCOUNT_MISMATCH",
    "another account's link"
  );
  link = (await makeLink()).payload;
  assert.equal(
    (
      await report({
        token: tokenOf(link.deepLink),
        partnerAccountId: account,
        amountIqd: 1,
        paymentRef: `${testId}-p-2`,
      })
    ).payload.reason,
    "AMOUNT_MISMATCH"
  );
  link = (await makeLink()).payload;
  await add(1);
  assert.equal(
    (
      await report({
        token: tokenOf(link.deepLink),
        partnerAccountId: account,
        amountIqd: 27_000,
        paymentRef: `${testId}-p-3`,
      })
    ).payload.reason,
    "CART_CHANGED",
    "the cart is not what the link was made for"
  );
  link = (await makeLink()).payload;
  assert.equal(link.amountIqd, 39_000);
  await prisma.product.update({ where: { id: rice.id }, data: { stockQuantity: 1 } });
  await prisma.productVariant.updateMany({
    where: { productId: rice.id },
    data: { stockQuantity: 1 },
  });
  const short = await report({
    token: tokenOf(link.deepLink),
    partnerAccountId: account,
    amountIqd: 39_000,
    paymentRef: `${testId}-p-4`,
  });
  assert.equal(short.payload.refund, true, "out of stock: the partner returns the money");
  await prisma.product.update({ where: { id: rice.id }, data: { stockQuantity: 20 } });
  await prisma.productVariant.updateMany({
    where: { productId: rice.id },
    data: { stockQuantity: 20 },
  });
  link = (await makeLink()).payload;
  await prisma.checkoutToken.update({
    where: { id: link.linkId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (
      await report({
        token: tokenOf(link.deepLink),
        partnerAccountId: account,
        amountIqd: 39_000,
        paymentRef: `${testId}-p-5`,
      })
    ).payload.reason,
    "LINK_EXPIRED"
  );

  link = (await makeLink()).payload;
  const paid = await report({
    token: tokenOf(link.deepLink),
    partnerAccountId: account,
    amountIqd: 39_000,
    paymentRef: `${testId}-p-6`,
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.payload));
  const order = await prisma.storeOrder.findUniqueOrThrow({ where: { id: paid.payload.orderId } });
  assert.deepEqual(
    [order.paymentMethodCode, order.paymentStatus, order.totalIqd],
    ["market_partner", "paid", 39_000]
  );
  const replay = await report({
    token: tokenOf(link.deepLink),
    partnerAccountId: account,
    amountIqd: 39_000,
    paymentRef: `${testId}-p-6`,
  });
  assert.deepEqual(
    [replay.payload.reason, replay.payload.orderId],
    ["LINK_USED", order.id],
    "a link pays once"
  );
  // Two reports at once for one link: one pays, the other is told to retry — never «paid» twice, never «used» without an order.
  await add(1);
  const twin = (await makeLink()).payload;
  const both = await Promise.all(
    [1, 2].map((n) =>
      report({
        token: tokenOf(twin.deepLink),
        partnerAccountId: account,
        amountIqd: twin.amountIqd,
        paymentRef: `${testId}-p-twin-${n}`,
      })
    )
  );
  assert.equal(
    both.filter((r) => r.payload.ok).length,
    1,
    JSON.stringify(both.map((r) => r.payload))
  );
  assert.ok(
    both.every(
      (r) =>
        r.payload.ok ||
        r.payload.reason === "LINK_IN_PROGRESS" ||
        (r.payload.reason === "LINK_USED" && r.payload.orderId)
    ),
    "the other one is told the truth"
  );
  assert.deepEqual(
    [
      (await shopper(`/market/partner-links/${link.linkId}`)).payload.link.status,
      (await shopper(`/market/partner-links/${link.linkId}`)).payload.link.orderId,
    ],
    ["used", order.id],
    "the checkout page sees it paid"
  );
  assert.equal(
    await prisma.marketCartItem.count({
      where: { cart: { shopperId: entered.payload.shopper.id }, storeId: store.id },
    }),
    0,
    "bought: out of the cart"
  );
  summary.paymentLink = true;

  // a shopper cannot say «the partner paid»
  await add(1);
  assert.equal(
    (
      await shopper(`/market/checkout/${store.slug}`, {
        method: "POST",
        body: { addressId: address.id, paymentMethodCode: "market_partner" },
        headers: { "idempotency-key": `${testId}-self-claim-idempotency` },
      })
    ).payload.error.code,
    "PAYMENT_METHOD_NOT_SUPPORTED"
  );
  // an unlinked shopper gets no link
  const plain = client();
  const asked = await plain("/market/auth/code", {
    method: "POST",
    body: { phone: `+96479${digits}3`.slice(0, 14) },
  });
  await plain("/market/auth/verify", {
    method: "POST",
    body: { challengeId: asked.payload.challengeId, code: sent.at(-1).code },
  });
  assert.equal(
    (
      await plain(`/market/checkout/${store.slug}/partner-link`, {
        method: "POST",
        body: { addressId: address.id },
      })
    ).payload.error.code,
    "PARTNER_NOT_LINKED"
  );
  summary.refusals = true;

  // cancelling a partner-paid order asks the partner to refund
  await transitionOrderStatus(store.id, { kind: "merchant", id: merchantId }, order.id, {
    toStatus: "cancelled",
    expectedVersion: order.version,
  });
  await domainEvents.drain();
  const payment = await prisma.marketPayment.findUniqueOrThrow({
    where: { orderId: order.id },
    include: { events: true },
  });
  assert.deepEqual(
    [
      payment.method,
      payment.status,
      payment.refundedIqd,
      payment.events.some((event) => event.kind === "refund_requested"),
    ],
    ["partner", "refunded", 39_000, true]
  );
  summary.refund = true;

  // unlinking ends the link and its open payment links
  const open = (await makeLink()).payload;
  assert.equal(
    (await shopper("/market/me/partner", { method: "DELETE" })).payload.partner.linked,
    false
  );
  assert.equal(
    (await prisma.checkoutToken.findUniqueOrThrow({ where: { id: open.linkId } })).status,
    "replaced"
  );
  summary.unlink = true;

  console.log(JSON.stringify({ suite: "market-partner", ok: true, summary }, null, 2));
} finally {
  delete process.env.CODIQ_PARTNER_APP_SECRET;
  setOtpProviderForTests(null);
  await prisma.store
    .updateMany({
      where: { id: { in: storeIds } },
      data: { marketStatus: "unlisted", marketStatusAt: new Date() },
    })
    .catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}

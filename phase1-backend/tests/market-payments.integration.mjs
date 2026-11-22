/**
 * Marketplace M13a — card payment and instalments, over HTTP, with the TEST providers.
 *
 *   1. Checkout offers: a card, and each lender's answer (capacity, the fewest
 *      months, the monthly amount; a product not sold in instalments says so).
 *   2. Card: the order waits «بانتظار الدفع» and the store cannot accept it;
 *      only a correctly SIGNED notification with the right amount pays it, once;
 *      cancelling a paid order refunds it.
 *   3. Card not paid in 30 minutes: the order is cancelled and its stock returns.
 *   4. Instalments: a term below the lender's minimum is refused; a wrong code
 *      is refused; the right code approves the plan and places the order; the
 *      plan covers the goods, the delivery fee stays cash; a return brings the
 *      plan to 0 (G8). No account, too little capacity, the amount changed: refused.
 *   5. E6 on the product page; and with payments off, nothing online exists.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
process.env.CODIQ_PAYMENTS_PROVIDER = "fake";
process.env.CODIQ_PAYMENTS_WEBHOOK_SECRET = "test-only-webhook-secret-of-at-least-32-chars";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");
const { domainEvents } = await import("../src/events/domain-events.ts");
const { fakeCodeForTests } = await import("../src/modules/market-payments/providers.ts");
await prisma.storefrontRateLimit.deleteMany({
  where: {
    OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_instalment" } }],
  },
});

const sent = [];
setOtpProviderForTests({
  name: "capture",
  async send(phone, code) {
    sent.push({ phone, code });
  },
});
const testId = `m13${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-6);
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
async function signIn(lastDigit) {
  const shopper = client();
  const phone = `+96477${digits}${lastDigit}`.slice(0, 13) + lastDigit;
  const asked = await shopper("/market/auth/code", { method: "POST", body: { phone } });
  assert.equal(asked.status, 200, JSON.stringify(asked.payload));
  const verified = await shopper("/market/auth/verify", {
    method: "POST",
    body: { challengeId: asked.payload.challengeId, code: sent.at(-1).code },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.payload));
  return { api: shopper, id: verified.payload.shopper.id, phone };
}
const sign = (raw) =>
  createHmac("sha256", process.env.CODIQ_PAYMENTS_WEBHOOK_SECRET).update(raw).digest("hex");
const settle = () => domainEvents.drain();

const summary = {};
const storeIds = [];
try {
  const merchant = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}39`,
    email: `${testId}@codiq.test`,
    password: "MarketPay!2026Strong",
  });
  const merchantId = merchant.payload.account.id;
  const store = await prisma.store.create({
    data: {
      merchantId,
      name: `إلكترونيّات ${testId}`,
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({
    data: { storeId: store.id, governorate: "Baghdad", amountIqd: 5000, isEnabled: true },
  });
  const make = (name, priceIqd, extra = {}) =>
    prisma.product.create({
      data: {
        storeId: store.id,
        sku: `${testId}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        priceIqd,
        stockQuantity: 10,
        ...extra,
      },
    });
  const phone = await make("هاتف", 600_000);
  const cable = await make("سلك شحن", 20_000, { instalmentsEligible: false });
  const tv = await make("تلفاز", 1_200_000, { instalmentsCashPrice: true });
  const owner = client();
  await owner("/auth/platform/register", {
    method: "POST",
    body: {
      email: `${testId}.owner@codiq.test`,
      password: "OwnerPass123!Strong",
      displayName: "مالك",
    },
  });
  const ownerToken = (
    await owner("/auth/platform/login", {
      method: "POST",
      body: { email: `${testId}.owner@codiq.test`, password: "OwnerPass123!Strong" },
    })
  ).payload.accessToken;

  const shopper = await signIn("5");
  const karrada = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكرادة" },
  });
  const created = await shopper.api("/market/me/addresses", {
    method: "POST",
    body: {
      label: "البيت",
      recipientName: "سارة",
      phone: shopper.phone,
      altPhone: null,
      governorateKey: "Baghdad",
      districtId: karrada.id,
      addressLine: "شارع ٦٢",
      latitude: null,
      longitude: null,
    },
  });
  assert.ok(created.payload?.address, JSON.stringify(created.payload));
  const address = created.payload.address;
  const fill = async (api, lines) => {
    for (const [product, quantity] of lines)
      assert.equal(
        (
          await api("/market/cart/items", {
            method: "POST",
            body: { productId: product.id, quantity },
          })
        ).status,
        200
      );
  };
  const summaryOf = (api) =>
    api(`/market/checkout/${store.slug}?addressId=${address.id}`).then((r) => r.payload);
  const place = (api, body, label) =>
    api(`/market/checkout/${store.slug}`, {
      method: "POST",
      body: { addressId: address.id, ...body },
      headers: { "idempotency-key": `${testId}-${label}-idempotency` },
    });
  const order = (id) => prisma.storeOrder.findUniqueOrThrow({ where: { id } });
  const accept = async (id) => {
    const { version } = await order(id);
    return transitionOrderStatus(store.id, { kind: "merchant", id: merchantId }, id, {
      toStatus: "processing",
      expectedVersion: version,
    });
  };
  const move = async (id, toStatus) => {
    const { version } = await order(id);
    await transitionOrderStatus(store.id, { kind: "merchant", id: merchantId }, id, {
      toStatus,
      expectedVersion: version,
    });
    await settle();
  };

  // ── 1. offers ────────────────────────────────────────────────────────────
  await fill(shopper.api, [[phone, 1]]);
  let offer = (await summaryOf(shopper.api)).online;
  assert.equal(offer.card.id, "fake-card");
  const [lenderA, lenderB] = offer.instalments.lenders;
  assert.deepEqual(
    [lenderA.available, lenderB.available, offer.instalments.goodsIqd],
    [true, true, 600_000]
  );
  assert.deepEqual(
    lenderA.terms.map((term) => term.months),
    [3, 6, 10, 12]
  );
  assert.deepEqual(
    lenderA.terms[1],
    { months: 6, feeIqd: 24_000, totalIqd: 624_000, monthlyIqd: 104_000 },
    "4% over six months"
  );
  await fill(shopper.api, [[cable, 1]]);
  offer = (await summaryOf(shopper.api)).online;
  assert.match(
    offer.instalments.lenders[0].reason,
    /غير متاحة بالتقسيط/,
    "a product not sold in instalments says so"
  );
  await shopper.api(
    `/market/cart/items/${(await prisma.marketCartItem.findFirstOrThrow({ where: { productId: cable.id, cart: { shopperId: shopper.id } } })).id}`,
    { method: "DELETE" }
  );
  summary.offers = true;

  // ── 2. card ──────────────────────────────────────────────────────────────
  const card = await place(shopper.api, { paymentMethodCode: "market_card" }, "card-1");
  assert.equal(card.status, 201, JSON.stringify(card.payload));
  const cardPayment = await prisma.marketPayment.findUniqueOrThrow({
    where: { id: card.payload.payment.paymentId },
  });
  assert.equal(card.payload.payment.redirectUrl, `/market/pay/${cardPayment.id}`);
  assert.deepEqual(
    [(await order(card.payload.order.id)).paymentStatus, cardPayment.amountIqd],
    ["awaiting_payment", 605_000],
    "the whole total, delivery included"
  );
  await assert.rejects(
    accept(card.payload.order.id),
    (error) => error.code === "ORDER_PAYMENT_PENDING",
    "the store cannot accept before the money"
  );
  const notify = (body, signature) =>
    client()("/payments/webhooks/card", {
      method: "POST",
      raw: JSON.stringify(body),
      headers: { "x-codiq-signature": signature ?? sign(JSON.stringify(body)) },
    });
  const good = {
    eventId: "evt-1",
    type: "payment.succeeded",
    providerRef: cardPayment.providerRef,
    amountIqd: 605_000,
  };
  assert.equal((await notify(good, "0".repeat(64))).status, 401, "a forged signature");
  assert.equal(
    (await notify({ ...good, eventId: "evt-x", amountIqd: 1 })).status,
    422,
    "the wrong amount"
  );
  assert.equal((await order(card.payload.order.id)).paymentStatus, "awaiting_payment");
  assert.equal((await notify(good)).payload.status, "paid");
  assert.equal((await notify(good)).payload.duplicate, true, "the same notification twice is one");
  assert.equal((await order(card.payload.order.id)).paymentStatus, "paid");
  await accept(card.payload.order.id);
  await move(card.payload.order.id, "cancelled");
  const refunded = await prisma.marketPayment.findUniqueOrThrow({ where: { id: cardPayment.id } });
  assert.deepEqual(
    [refunded.status, refunded.refundedIqd, (await order(card.payload.order.id)).paymentStatus],
    ["refunded", 605_000, "refunded"],
    "cancelled after paying: refunded"
  );
  summary.card = true;

  // decline then approve on the test gateway's page
  await fill(shopper.api, [[phone, 1]]);
  const card2 = (await place(shopper.api, { paymentMethodCode: "market_card" }, "card-2")).payload;
  assert.equal(
    (
      await shopper.api(`/market/payments/${card2.payment.paymentId}/test-provider`, {
        method: "POST",
        body: { outcome: "decline" },
      })
    ).payload.payment.status,
    "failed"
  );
  assert.equal(
    (
      await shopper.api(`/market/payments/${card2.payment.paymentId}/test-provider`, {
        method: "POST",
        body: { outcome: "approve" },
      })
    ).payload.payment.status,
    "paid",
    "he may try again"
  );
  assert.equal(
    (await client()(`/market/payments/${card2.payment.paymentId}`)).status,
    401,
    "his payment is his"
  );
  summary.testGateway = true;

  // ── 3. not paid in time ──────────────────────────────────────────────────
  await fill(shopper.api, [[phone, 2]]);
  const late = (await place(shopper.api, { paymentMethodCode: "market_card" }, "card-3")).payload;
  const held = () =>
    prisma.inventoryReservation.findMany({
      where: { orderId: late.order.id },
      select: { status: true, quantity: true },
    });
  assert.deepEqual(
    (await held()).map((row) => [row.status, row.quantity]),
    [["active", 2]],
    "the stock is held while he pays"
  );
  await prisma.marketPayment.update({
    where: { id: late.payment.paymentId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (await shopper.api(`/market/payments/${late.payment.paymentId}`)).payload.payment.status,
    "expired"
  );
  await settle();
  assert.equal((await order(late.order.id)).status, "cancelled");
  assert.ok(
    (await held()).every((row) => row.status !== "active"),
    "the hold is released"
  );
  // The money arrives anyway, late: recorded and given back, not lost.
  const lateRow = await prisma.marketPayment.findUniqueOrThrow({
    where: { id: late.payment.paymentId },
  });
  assert.equal(
    (
      await notify({
        eventId: "evt-late",
        type: "payment.succeeded",
        providerRef: lateRow.providerRef,
        amountIqd: lateRow.amountIqd,
      })
    ).payload.status,
    "refunded"
  );
  const lateAfter = await prisma.marketPayment.findUniqueOrThrow({ where: { id: lateRow.id } });
  assert.deepEqual(
    [lateAfter.status, lateAfter.refundedIqd],
    ["refunded", lateRow.amountIqd],
    "a late payment is refunded"
  );
  summary.expiry = true;

  // ── 4. instalments ───────────────────────────────────────────────────────
  await fill(shopper.api, [[tv, 1]]);
  const start = (body) =>
    shopper.api(`/market/checkout/${store.slug}/instalments`, {
      method: "POST",
      body: { addressId: address.id, ...body },
    });
  assert.equal(
    (await start({ lender: "fake-instalments-a", months: 3 })).payload.error.code,
    "INSTALMENT_TERM_INVALID",
    "1.2M needs six months or more at lender A"
  );
  const plan = await start({ lender: "fake-instalments-a", months: 6 });
  assert.equal(plan.status, 201, JSON.stringify(plan.payload));
  assert.deepEqual(
    [plan.payload.feeIqd, plan.payload.monthlyIqd, plan.payload.months],
    [0, 200_000, 6],
    "«أقساط بسعر الكاش»: no fee"
  );
  const row = await prisma.marketPayment.findUniqueOrThrow({
    where: { id: plan.payload.paymentId },
  });
  assert.equal(
    (
      await place(
        shopper.api,
        {
          paymentMethodCode: "market_instalments",
          instalmentPaymentId: row.id,
          instalmentCode: "000000" === fakeCodeForTests(row.providerRef) ? "111111" : "000000",
        },
        "inst-wrong"
      )
    ).payload.error.code,
    "INSTALMENT_CODE_WRONG"
  );
  const placed = await place(
    shopper.api,
    {
      paymentMethodCode: "market_instalments",
      instalmentPaymentId: row.id,
      instalmentCode: fakeCodeForTests(row.providerRef),
    },
    "inst-1"
  );
  assert.equal(placed.status, 201, JSON.stringify(placed.payload));
  const instOrder = await order(placed.payload.order.id);
  const approved = await prisma.marketPayment.findUniqueOrThrow({ where: { id: row.id } });
  assert.deepEqual(
    [
      instOrder.paymentStatus,
      approved.status,
      approved.orderId,
      approved.amountIqd,
      instOrder.totalIqd,
    ],
    ["instalments", "approved", instOrder.id, 1_200_000, 1_205_000],
    "the plan covers the goods; the 5,000 delivery is cash"
  );
  await accept(instOrder.id);
  for (const step of ["preparation", "out_for_delivery", "completed", "returned"])
    await move(instOrder.id, step);
  const adjusted = await prisma.marketPayment.findUniqueOrThrow({ where: { id: row.id } });
  assert.deepEqual(
    [adjusted.status, adjusted.refundedIqd],
    ["adjusted", 1_200_000],
    "G8: returned, the plan covers nothing"
  );
  assert.ok(
    await prisma.marketPaymentEvent.findFirst({
      where: { paymentId: row.id, kind: "plan_adjusted" },
    })
  );
  summary.instalments = true;

  // amount changed between the term and the code
  await fill(shopper.api, [[phone, 1]]);
  const plan2 = (await start({ lender: "fake-instalments-b", months: 12 })).payload;
  await fill(shopper.api, [[phone, 1]]);
  const row2 = await prisma.marketPayment.findUniqueOrThrow({ where: { id: plan2.paymentId } });
  assert.equal(
    (
      await place(
        shopper.api,
        {
          paymentMethodCode: "market_instalments",
          instalmentPaymentId: row2.id,
          instalmentCode: fakeCodeForTests(row2.providerRef),
        },
        "inst-2"
      )
    ).payload.error.code,
    "INSTALMENT_AMOUNT_CHANGED"
  );

  // no account at lender A (phone ending 0); too little capacity (ending 9)
  const noAccount = await signIn("0");
  await fill(noAccount.api, [[phone, 1]]);
  const naOffer = (await noAccount.api(`/market/checkout/${store.slug}`)).payload.online.instalments
    .lenders;
  assert.match(naOffer[0].reason, /لا يوجد حساب/);
  assert.equal(naOffer[1].available, true, "lender B still answers");
  const small = await signIn("9");
  await fill(small.api, [[phone, 1]]);
  assert.match(
    (await small.api(`/market/checkout/${store.slug}`)).payload.online.instalments.lenders[0]
      .reason,
    /سعتك المتاحة/
  );
  summary.refusals = true;

  // ── 4b. review batch 2: money that must move once, and only once ─────────
  // م-٧: an instalment order cancelled before delivery — the plan is recorded as cancelled.
  await fill(shopper.api, [[phone, 1]]);
  const plan3 = (await start({ lender: "fake-instalments-a", months: 6 })).payload;
  const row3 = await prisma.marketPayment.findUniqueOrThrow({ where: { id: plan3.paymentId } });
  const inst3 = await place(
    shopper.api,
    {
      paymentMethodCode: "market_instalments",
      instalmentPaymentId: row3.id,
      instalmentCode: fakeCodeForTests(row3.providerRef),
    },
    "inst-3"
  );
  assert.equal(inst3.status, 201, JSON.stringify(inst3.payload));
  await move(inst3.payload.order.id, "cancelled");
  assert.equal(
    (await prisma.marketPayment.findUniqueOrThrow({ where: { id: row3.id } })).status,
    "cancelled",
    "a cancelled instalment order cancels its plan here too, not only at the lender"
  );
  // ح-١: the code approves the plan ONCE — a second order cannot ride the same plan.
  const svc = await import("../src/modules/market-payments/payments.service.ts");
  const me = { id: shopper.id, phoneNormalized: shopper.phone };
  await fill(shopper.api, [[phone, 1]]);
  const solo = await svc.startInstalmentPlan(me, store.id, 600_000, {
    lender: "fake-instalments-a",
    months: 6,
  });
  const soloCode = fakeCodeForTests(
    (await prisma.marketPayment.findUniqueOrThrow({ where: { id: solo.paymentId } })).providerRef
  );
  await svc.confirmInstalmentPlan(me, store.id, solo.paymentId, soloCode, 600_000);
  await assert.rejects(
    svc.confirmInstalmentPlan(me, store.id, solo.paymentId, soloCode, 600_000),
    (error) => error.code === "INSTALMENT_PLAN_REQUIRED",
    "one approved plan pays for one order, not two"
  );
  await svc.abandonInstalmentPlan(solo.paymentId);
  assert.equal(
    (await prisma.marketPayment.findUniqueOrThrow({ where: { id: solo.paymentId } })).status,
    "cancelled",
    "a claimed plan whose order failed is let go"
  );
  // م-٥: a cancellation and a late notice at the same moment refund the card ONCE.
  await fill(shopper.api, [[phone, 1]]);
  const card4 = (await place(shopper.api, { paymentMethodCode: "market_card" }, "card-4")).payload;
  const row4 = await prisma.marketPayment.findUniqueOrThrow({
    where: { id: card4.payment.paymentId },
  });
  await notify({
    eventId: "evt-4",
    type: "payment.succeeded",
    providerRef: row4.providerRef,
    amountIqd: row4.amountIqd,
  });
  await transitionOrderStatus(store.id, { kind: "merchant", id: merchantId }, card4.order.id, {
    toStatus: "cancelled",
    expectedVersion: (await order(card4.order.id)).version,
  });
  await Promise.all([
    svc.onOrderStatusChanged({ orderId: card4.order.id, to: "cancelled" }),
    svc.onOrderStatusChanged({ orderId: card4.order.id, to: "cancelled" }),
  ]);
  await settle();
  assert.equal(
    await prisma.marketPaymentEvent.count({ where: { paymentId: row4.id, kind: "refunded" } }),
    1,
    "refunded once, not twice"
  );
  // م-٦: an expired order whose cancellation failed is tried again, not left holding stock.
  await fill(shopper.api, [[phone, 1]]);
  const card5 = (await place(shopper.api, { paymentMethodCode: "market_card" }, "card-5")).payload;
  await prisma.marketPayment.update({
    where: { id: card5.payment.paymentId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const refuse = `m13_refuse_${testId}`;
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${refuse}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
      `IF NEW.id = '${card5.order.id}' AND NEW.status = 'cancelled' THEN ` +
      `RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${refuse} BEFORE UPDATE ON store_orders FOR EACH ROW EXECUTE FUNCTION ${refuse}()`
  );
  try {
    await svc.expireStalePayments();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${refuse} ON store_orders`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${refuse}()`);
  }
  const card5Now = async () => [
    (await order(card5.order.id)).status,
    (await prisma.marketPayment.findUniqueOrThrow({ where: { id: card5.payment.paymentId } }))
      .status,
  ];
  assert.deepEqual(await card5Now(), ["new", "pending"], "not cancelled, so not expired yet");
  await svc.expireStalePayments();
  assert.deepEqual(await card5Now(), ["cancelled", "expired"], "the next sweep finishes it");
  summary.once = true;
  await fill(shopper.api, [[phone, 1]]); // what section 5 checks out with

  // ── 5. the product page; and with payments off ───────────────────────────
  const page = (id) =>
    client()(`/market/products/${id}`).then((r) => r.payload.product.instalments);
  assert.deepEqual(
    await page(phone.id),
    { fromMonthlyIqd: 30_000, months: 24, maxMonths: 24, cashPrice: false },
    "the lowest monthly amount on offer: 600,000 + 20% over 24 months"
  );
  assert.equal(await page(cable.id), null, "not sold in instalments");
  assert.equal((await page(tv.id)).cashPrice, true);
  const ownerList = await fetch(`${base}/platform/market/payments?limit=50`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  }).then((r) => r.json());
  assert.ok(ownerList.payments.some((entry) => entry.id === row.id) && ownerList.mode === "fake");
  process.env.CODIQ_PAYMENTS_PROVIDER = "";
  assert.equal(await page(phone.id), null);
  assert.deepEqual((await summaryOf(shopper.api)).online, { card: null, instalments: null });
  assert.equal(
    (await place(shopper.api, { paymentMethodCode: "market_card" }, "off-1")).payload.error.code,
    "PAYMENT_METHOD_NOT_SUPPORTED"
  );
  assert.equal(
    (
      await shopper.api(`/market/payments/${card2.payment.paymentId}/test-provider`, {
        method: "POST",
        body: { outcome: "approve" },
      })
    ).status,
    404,
    "the test gateway does not exist when off"
  );
  summary.off = true;

  console.log(JSON.stringify({ suite: "market-payments", ok: true, summary }, null, 2));
} finally {
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

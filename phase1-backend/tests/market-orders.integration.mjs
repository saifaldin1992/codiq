/**
 * Marketplace M6 — after the order. Over HTTP, with real orders through the
 * store's own checkout and the store's own status screen.
 *
 *   1. Cancel with a reason while the store has not started; refused after; the
 *      reason recorded and shown; another shopper's order is a 404.
 *   2. The receipt code: the shopper sees four digits once the store accepts;
 *      the store's own order payload and market view never carry them.
 *   3. Delivery stages the store reports while the order is out, shown to the
 *      shopper; refused for a pick-up.
 *   4. Hand-over: a wrong code counts down; the right one completes the order
 *      through the state machine; the code is then spent. Five wrong codes lock it.
 *   5. A pick-up handed over straight from «قيد التجهيز».
 *   6. Rating: store, delivery, tags, a note and per-product stars (into the
 *      product reviews); a product not on the order refused; «بانتظار تقييمك»
 *      and «تقييماتي»; the store sees it; closed after the window.
 *   7. Return: asked with a reason, withdrawn, asked again, approved by the
 *      store through its own returns screen — the order is returned and the
 *      shopper sees the answer.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");

const sent = [];
setOtpProviderForTests({
  name: "capture",
  async send(phone, code) {
    sent.push({ phone, code });
  },
});
const testId = `m6${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

function client(bearer) {
  const jar = new Map();
  return {
    async request(path, { method = "GET", body, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          origin: base,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(jar.size
            ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
      return { status: response.status, payload: await response.json().catch(() => null) };
    },
  };
}
async function signIn(phone) {
  const shopper = client();
  const asked = await shopper.request("/market/auth/code", { method: "POST", body: { phone } });
  assert.equal(asked.status, 200, JSON.stringify(asked.payload));
  const verified = await shopper.request("/market/auth/verify", {
    method: "POST",
    body: { challengeId: asked.payload.challengeId, code: sent.at(-1).code },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.payload));
  return { shopper, id: verified.payload.shopper.id };
}

const created = { stores: [] };
try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  const phone = `+96477${digits}4`.slice(0, 14);
  const password = "MarketOrders!2026Strong";
  const merchantReg = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}6`.slice(0, 14),
    email: `${testId}@codiq.test`,
    password,
  });
  assert.equal(merchantReg.status, 201, JSON.stringify(merchantReg.payload));
  const A = await prisma.store.create({
    data: {
      merchantId: merchantReg.payload.account.id,
      name: `سوق ${testId}`,
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
      latitude: 33.3,
      longitude: 44.4,
      pickupEnabled: true,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  created.stores.push(A.id);
  await prisma.deliveryRate.create({
    data: { storeId: A.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
  });
  const product = (data) =>
    prisma.product.create({
      data: {
        storeId: A.id,
        sku: `${testId}-${Math.random().toString(36).slice(2, 8)}`,
        stockQuantity: 50,
        ...data,
      },
    });
  const perfume = await product({ name: "عطر", priceIqd: 10000 });
  const watch = await product({ name: "ساعة", priceIqd: 30000 });
  const other = await product({ name: "شيء آخر", priceIqd: 1000 });

  const { shopper } = await signIn(phone);
  const district = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكاظمية" },
  });
  const home = (
    await shopper.request("/market/me/addresses", {
      method: "POST",
      body: {
        label: "البيت",
        recipientName: "علي",
        phone,
        altPhone: null,
        governorateKey: "Baghdad",
        districtId: district.id,
        addressLine: "شارع ٢٠",
        latitude: null,
        longitude: null,
      },
    })
  ).payload.address;
  let seq = 0;
  async function buy(items, fulfilment = "delivery") {
    for (const [productId, quantity] of items)
      await shopper.request("/market/cart/items", {
        method: "POST",
        body: { productId, quantity },
      });
    const placed = await shopper.request(`/market/checkout/${A.slug}`, {
      method: "POST",
      body: { addressId: home.id, fulfilment },
      headers: { "idempotency-key": `${testId}-order-${++seq}-idempotency` },
    });
    assert.equal(placed.status, 201, JSON.stringify(placed.payload));
    return placed.payload.order.id;
  }
  const login = await client().request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}@codiq.test`, password },
  });
  const merchant = client(login.payload.accessToken);
  const m = (path) => `/merchant/stores/${A.slug}/orders/${path}`;
  async function moveTo(orderId, ...statuses) {
    for (const toStatus of statuses) {
      const { version } = await prisma.storeOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { version: true },
      });
      const moved = await merchant.request(m(`${orderId}/status`), {
        method: "POST",
        body: { toStatus, expectedVersion: version },
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.payload));
    }
  }
  const view = async (orderId) => (await shopper.request(`/market/orders/${orderId}`)).payload;
  const options = (await client().request("/market/after-sales/options")).payload;
  assert.ok(
    options.cancelReasons.length >= 5 &&
      options.returnReasons.length >= 5 &&
      options.ratingTags.length >= 5
  );

  // ── 1. cancel ────────────────────────────────────────────────────────────
  const toCancel = await buy([[perfume.id, 1]]);
  assert.equal((await view(toCancel)).afterSales.canCancel, true);
  const stranger = await signIn(`+96479${digits}8`.slice(0, 14));
  assert.equal(
    (
      await stranger.shopper.request(`/market/orders/${toCancel}/cancel`, {
        method: "POST",
        body: { reasonCode: "changed_mind" },
      })
    ).status,
    404,
    "not his order"
  );
  assert.equal(
    (
      await shopper.request(`/market/orders/${toCancel}/cancel`, {
        method: "POST",
        body: { reasonCode: "because" },
      })
    ).status,
    422,
    "only listed reasons"
  );
  const cancelled = await shopper.request(`/market/orders/${toCancel}/cancel`, {
    method: "POST",
    body: { reasonCode: "found_better_price", details: "أرخص في مكان آخر" },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.order.status, "cancelled");
  const afterCancel = await view(toCancel);
  assert.deepEqual(
    [
      afterCancel.order.status,
      afterCancel.afterSales.cancelReason,
      afterCancel.afterSales.canCancel,
    ],
    ["cancelled", "وجدت سعراً أفضل", false]
  );
  const event = await prisma.orderStatusEvent.findFirstOrThrow({
    where: { orderId: toCancel, toStatus: "cancelled" },
  });
  assert.match(
    event.note,
    /وجدت سعراً أفضل — أرخص/,
    "the store reads the reason on the order's history"
  );
  assert.equal(
    (await merchant.request(m(`${toCancel}/market`))).payload.cancelReason,
    "وجدت سعراً أفضل"
  );
  const accepted = await buy([[perfume.id, 1]]);
  await moveTo(accepted, "processing");
  assert.equal(
    (
      await shopper.request(`/market/orders/${accepted}/cancel`, {
        method: "POST",
        body: { reasonCode: "changed_mind" },
      })
    ).payload.error.code,
    "ORDER_NOT_CANCELLABLE",
    "the store started: too late"
  );
  summary.cancel = true;

  // ── 2. the receipt code ──────────────────────────────────────────────────
  const delivered = await buy([
    [perfume.id, 2],
    [watch.id, 1],
  ]);
  assert.equal(
    (await view(delivered)).afterSales.handoverCode,
    null,
    "no code before the store accepts"
  );
  await moveTo(delivered, "processing", "preparation");
  const code = (await view(delivered)).afterSales.handoverCode;
  assert.match(code, /^[0-9]{4}$/);
  const merchantOrder = await merchant.request(m(delivered));
  assert.equal(merchantOrder.status, 200);
  const merchantJson = JSON.stringify(merchantOrder.payload);
  assert.ok(!/handover/i.test(merchantJson), "the store's order payload carries no hand-over code");
  const marketView = (await merchant.request(m(`${delivered}/market`))).payload;
  assert.deepEqual(marketView.handover, { used: false, attemptsLeft: 5 });
  assert.ok(!JSON.stringify(marketView).includes(`"${code}"`), "nor does the store's market view");
  summary.code = true;

  // ── 3. delivery stages ───────────────────────────────────────────────────
  assert.equal(
    (
      await merchant.request(m(`${delivered}/delivery-stage`), {
        method: "PUT",
        body: { stage: "at_warehouse" },
      })
    ).status,
    200
  );
  assert.equal((await view(delivered)).afterSales.deliveryStage, null, "shown only once it is out");
  await moveTo(delivered, "out_for_delivery");
  assert.equal(
    (
      await merchant.request(m(`${delivered}/delivery-stage`), {
        method: "PUT",
        body: { stage: "with_courier" },
      })
    ).payload.deliveryStage,
    "with_courier"
  );
  assert.equal((await view(delivered)).afterSales.deliveryStage.label, "مع المندوب");
  assert.equal(
    (
      await merchant.request(m(`${delivered}/delivery-stage`), {
        method: "PUT",
        body: { stage: "teleported" },
      })
    ).status,
    422
  );
  summary.stages = true;

  // ── 4. hand-over ─────────────────────────────────────────────────────────
  const wrong = code === "0000" ? "1111" : "0000";
  const miss = await merchant.request(m(`${delivered}/handover`), {
    method: "POST",
    body: { code: wrong },
  });
  assert.equal(miss.payload.error.code, "HANDOVER_CODE_WRONG");
  assert.match(miss.payload.error.message, /4/);
  const hit = await merchant.request(m(`${delivered}/handover`), {
    method: "POST",
    body: { code },
  });
  assert.equal(hit.status, 200, JSON.stringify(hit.payload));
  assert.equal(hit.payload.order.status, "completed");
  assert.ok(
    await prisma.ledgerEntry.findFirst({
      where: { orderId: delivered, entryType: "order_completed" },
    }),
    "completed through the state machine: the ledger booked it"
  );
  assert.equal(
    (await merchant.request(m(`${delivered}/handover`), { method: "POST", body: { code } })).payload
      .error.code,
    "HANDOVER_ALREADY_USED"
  );
  const afterHandover = await view(delivered);
  assert.deepEqual(
    [
      afterHandover.afterSales.handoverCode,
      afterHandover.afterSales.deliveryStage,
      afterHandover.afterSales.canRate,
      afterHandover.afterSales.canReturn,
    ],
    [null, null, true, true]
  );
  const locked = await buy([[perfume.id, 1]]);
  await moveTo(locked, "processing", "preparation", "out_for_delivery");
  const lockedCode = (await view(locked)).afterSales.handoverCode;
  const bad = lockedCode === "9999" ? "8888" : "9999";
  for (let i = 0; i < 5; i += 1)
    await merchant.request(m(`${locked}/handover`), { method: "POST", body: { code: bad } });
  assert.equal(
    (
      await merchant.request(m(`${locked}/handover`), {
        method: "POST",
        body: { code: lockedCode },
      })
    ).payload.error.code,
    "HANDOVER_LOCKED",
    "five wrong codes lock it"
  );
  assert.equal(
    (await view(locked)).afterSales.handoverCode,
    null,
    "and the shopper no longer shows a dead code"
  );
  // Review batch 6, ت-٣: the lock counted failures AFTER the comparison, so guesses sent in
  // parallel all read «0 failures» and were all compared — 10,000 codes are a short burst away.
  // Now each guess first takes one of the five attempts; the rest are refused unread.
  const burst = await buy([[perfume.id, 1]]);
  await moveTo(burst, "processing", "preparation", "out_for_delivery");
  const burstCode = (await view(burst)).afterSales.handoverCode;
  const guesses = Array.from({ length: 30 }, (_, index) => String(index).padStart(4, "0")).filter(
    (guess) => guess !== burstCode
  );
  const replies = await Promise.all(
    guesses.map((code) =>
      merchant.request(m(`${burst}/handover`), { method: "POST", body: { code } })
    )
  );
  const compared = replies.filter((reply) => reply.payload?.error?.code === "HANDOVER_CODE_WRONG");
  assert.ok(
    compared.length <= 5,
    `at most five guesses are ever compared · ${compared.length} of ${guesses.length}`
  );
  summary.handover = true;

  // ── 5. pick-up ───────────────────────────────────────────────────────────
  const pickup = await buy([[watch.id, 1]], "pickup");
  await moveTo(pickup, "processing", "preparation");
  assert.equal(
    (
      await merchant.request(m(`${pickup}/delivery-stage`), {
        method: "PUT",
        body: { stage: "with_courier" },
      })
    ).payload.error.code,
    "DELIVERY_STAGE_NOT_APPLICABLE"
  );
  const pickupCode = (await view(pickup)).afterSales.handoverCode;
  const handed = await merchant.request(m(`${pickup}/handover`), {
    method: "POST",
    body: { code: pickupCode },
  });
  assert.equal(handed.payload.order.status, "completed", JSON.stringify(handed.payload));
  summary.pickup = true;

  // ── 6. rating ────────────────────────────────────────────────────────────
  const pending = (await shopper.request("/market/ratings/pending")).payload.orders.map(
    (row) => row.id
  );
  assert.deepEqual(
    pending.sort(),
    [delivered, pickup].sort(),
    "both delivered orders wait for stars"
  );
  assert.equal(
    (
      await shopper.request(`/market/orders/${accepted}/rating`, {
        method: "PUT",
        body: { storeStars: 5 },
      })
    ).payload.error.code,
    "ORDER_NOT_RATABLE"
  );
  assert.equal(
    (
      await shopper.request(`/market/orders/${delivered}/rating`, {
        method: "PUT",
        body: { storeStars: 5, products: [{ productId: other.id, stars: 5 }] },
      })
    ).payload.error.code,
    "PRODUCT_NOT_ON_ORDER"
  );
  const rated = await shopper.request(`/market/orders/${delivered}/rating`, {
    method: "PUT",
    body: {
      storeStars: 4,
      deliveryStars: 5,
      tags: ["fast_delivery", "good_packaging", "fast_delivery"],
      note: "ممتاز",
      products: [
        { productId: perfume.id, stars: 5, body: "رائحة جميلة" },
        { productId: watch.id, stars: 3 },
      ],
    },
  });
  assert.equal(rated.status, 200, JSON.stringify(rated.payload));
  assert.deepEqual(rated.payload.rating.tagLabels, ["توصيل سريع", "تغليف ممتاز"]);
  const reviews = await prisma.productReview.findMany({
    where: { storeId: A.id },
    orderBy: { rating: "desc" },
  });
  assert.deepEqual(
    reviews.map((review) => [review.productId, review.rating]),
    [
      [perfume.id, 5],
      [watch.id, 3],
    ],
    "product stars become the products' reviews"
  );
  const pickupRated = await shopper.request(`/market/orders/${pickup}/rating`, {
    method: "PUT",
    body: { storeStars: 5, deliveryStars: 1 },
  });
  assert.equal(pickupRated.payload.rating.deliveryStars, null, "no courier to rate on a pick-up");
  const again = await shopper.request(`/market/orders/${delivered}/rating`, {
    method: "PUT",
    body: { storeStars: 5, deliveryStars: 5, tags: [] },
  });
  assert.equal(again.payload.rating.storeStars, 5, "editable");
  assert.equal(await prisma.orderRating.count({ where: { orderId: delivered } }), 1);
  assert.deepEqual((await shopper.request("/market/ratings/pending")).payload.orders, []);
  const mine = (await shopper.request("/market/ratings?limit=1")).payload;
  assert.equal(mine.ratings.length, 1);
  assert.ok(mine.nextCursor);
  const mine2 = (
    await shopper.request(`/market/ratings?limit=1&cursor=${encodeURIComponent(mine.nextCursor)}`)
  ).payload;
  assert.deepEqual(
    [mine.ratings[0].order.id, mine2.ratings[0].order.id].sort(),
    [delivered, pickup].sort()
  );
  assert.equal(
    (await merchant.request(m(`${delivered}/market`))).payload.rating.storeStars,
    5,
    "the store sees the rating"
  );
  await prisma.storeOrder.update({
    where: { id: pickup },
    data: { statusUpdatedAt: new Date(Date.now() - 31 * 86_400_000) },
  });
  assert.equal(
    (
      await shopper.request(`/market/orders/${pickup}/rating`, {
        method: "PUT",
        body: { storeStars: 2 },
      })
    ).payload.error.code,
    "RATING_WINDOW_CLOSED"
  );
  summary.rating = true;

  // ── 7. return ────────────────────────────────────────────────────────────
  assert.equal(
    (
      await shopper.request(`/market/orders/${delivered}/return`, {
        method: "POST",
        body: { reasonCode: "other" },
      })
    ).status,
    422,
    "«سبب آخر» needs words"
  );
  const asked = await shopper.request(`/market/orders/${delivered}/return`, {
    method: "POST",
    body: { reasonCode: "damaged", details: "الزجاجة مكسورة" },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.payload));
  const state = (await view(delivered)).afterSales;
  assert.deepEqual([state.returnRequest.status, state.canReturn], ["requested", false]);
  assert.equal(
    (await shopper.request(`/market/orders/${delivered}/return`, { method: "DELETE" })).payload
      .returnRequest.status,
    "withdrawn"
  );
  assert.equal((await view(delivered)).afterSales.canReturn, true, "withdrawn: may ask again");
  const second = await shopper.request(`/market/orders/${delivered}/return`, {
    method: "POST",
    body: { reasonCode: "damaged", details: "الزجاجة مكسورة" },
  });
  const decided = await merchant.request(
    `/merchant/stores/${A.slug}/returns/${second.payload.returnRequest.id}/decision`,
    { method: "POST", body: { approve: true, note: "سنستلمه غداً" } }
  );
  assert.equal(decided.status, 200, JSON.stringify(decided.payload));
  const done = await view(delivered);
  assert.deepEqual(
    [
      done.order.status,
      done.afterSales.returnRequest.status,
      done.afterSales.returnRequest.decisionNote,
      done.afterSales.canReturn,
    ],
    ["returned", "approved", "سنستلمه غداً", false]
  );
  summary.returns = true;

  console.log(JSON.stringify({ suite: "market-orders", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.store
    .updateMany({
      where: { id: { in: created.stores } },
      data: { marketStatus: "unlisted", marketStatusAt: new Date() },
    })
    .catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}

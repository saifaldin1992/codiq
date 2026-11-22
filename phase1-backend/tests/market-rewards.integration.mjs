/**
 * Marketplace M8b — the platform's coupons and points, over HTTP, with real
 * orders, real ledger entries and real concurrency.
 *
 *   1. The owner makes coupons (a merchant cannot); free, store-limited, and
 *      bought with points.
 *   2. Claiming: once per shopper; «كوبوناتي».
 *   3. Checkout: the summary offers the held coupons that work here with what
 *      each takes off; the order carries the platform discount OUTSIDE the
 *      store's discount; a store-limited coupon is refused elsewhere; a used
 *      coupon is refused; two checkouts racing one coupon — exactly one wins.
 *   4. Completion: the ledger keeps the full commission base and records the
 *      platform's cost; platform points on what was paid in money.
 *   5. A cancelled order gives the coupon back; a returned one claws the points back.
 *   6. Points: buying a coupon with points; five purchases at the same instant
 *      with points for one — exactly one; a coupon's total limit holds.
 *   7. Tiers: enough points in a year lift the tier and its multiplier.
 *   8. The owner's report: the programme's cost.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");
await prisma.storefrontRateLimit.deleteMany({ where: { scope: { startsWith: "market_otp" } } });

const sent = [];
setOtpProviderForTests({
  name: "capture",
  async send(phone, code) {
    sent.push({ phone, code });
  },
});
const testId = `m8r${Date.now().toString(36)}`;
const tag = testId
  .slice(-6)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "X");
const digits = String(Date.now()).slice(-7);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};
const DAY = 86_400_000;

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

const created = { stores: [], coupons: [] };
try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  assert.ok(
    [200, 201].includes(
      (
        await client().request("/auth/platform/register", {
          method: "POST",
          body: { email: ownerEmail, password: "OwnerPass123!Strong", displayName: "مالك" },
        })
      ).status
    )
  );
  const owner = client(
    (
      await client().request("/auth/platform/login", {
        method: "POST",
        body: { email: ownerEmail, password: "OwnerPass123!Strong" },
      })
    ).payload.accessToken
  );
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  async function merchantWithStore(label, n) {
    const email = `${testId}.${label}@codiq.test`;
    const reg = await registerMerchantDirect({
      ownerName: "تاجر",
      businessName: "متجر",
      phone: `+9647${n}${digits}6`.slice(0, 14),
      email,
      password: "MarketRewards!2026",
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.payload));
    const store = await prisma.store.create({
      data: {
        merchantId: reg.payload.account.id,
        name: `متجر ${testId} ${label}`,
        slug: `${testId}-${label}`,
        defaultSubdomain: `${testId}-${label}`,
        ...listed,
      },
    });
    created.stores.push(store.id);
    await prisma.deliveryRate.create({
      data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        sku: `${testId}-${label}`,
        name: `منتج ${label}`,
        priceIqd: 40000,
        stockQuantity: 100,
      },
    });
    const token = (
      await client().request("/auth/merchant/login", {
        method: "POST",
        body: { identifier: email, password: "MarketRewards!2026" },
      })
    ).payload.accessToken;
    return { store, product, merchantId: reg.payload.account.id, api: client(token) };
  }
  const A = await merchantWithStore("a", 5);
  const B = await merchantWithStore("b", 8);
  const window = {
    startsAt: new Date(Date.now() - DAY).toISOString(),
    endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
  };
  const make = async (body) => {
    const made = await owner.request("/platform/market/coupons", {
      method: "POST",
      body: { ...window, ...body },
    });
    assert.equal(made.status, 201, JSON.stringify(made.payload));
    created.coupons.push(made.payload.coupon.id);
    return made.payload.coupon;
  };

  // ── 1. the owner ─────────────────────────────────────────────────────────
  assert.ok(
    [401, 403].includes(
      (
        await A.api.request("/platform/market/coupons", {
          method: "POST",
          body: { ...window, code: `X${tag}`, title: "x", kind: "fixed", amountOffIqd: 1 },
        })
      ).status
    )
  );
  const free10 = await make({
    code: `F${tag}`,
    title: "خصم ١٠٪ على أوّل طلب",
    kind: "percent",
    percentOff: 10,
    maxDiscountIqd: 5000,
    minSubtotalIqd: 10000,
  });
  const free20 = await make({
    code: `G${tag}`,
    title: "خصم ٢٠٪",
    kind: "percent",
    percentOff: 20,
    maxDiscountIqd: 6000,
  });
  const onlyB = await make({
    code: `B${tag}`,
    title: "٣٠٠٠ دينار في متجر ب",
    kind: "fixed",
    amountOffIqd: 3000,
    allStores: false,
  });
  assert.deepEqual(
    (
      await owner.request(`/platform/market/coupons/${onlyB.id}/stores`, {
        method: "PUT",
        body: { storeSlugs: [B.store.slug] },
      })
    ).payload.storeSlugs,
    [B.store.slug]
  );
  const forPoints = await make({
    code: `P${tag}`,
    title: "٥٠٠٠ دينار بالنقاط",
    kind: "fixed",
    amountOffIqd: 5000,
    pointsCost: 100,
    totalLimit: 3,
  });
  summary.owner = true;

  // ── 2. claiming ──────────────────────────────────────────────────────────
  const { shopper, id: shopperId } = await signIn(`+96477${digits}4`.slice(0, 14));
  const page = (await shopper.request("/market/coupons")).payload;
  assert.ok(page.free.some((row) => row.code === free10.code && !row.claimed));
  assert.ok(page.forPoints.some((row) => row.code === forPoints.code && row.pointsCost === 100));
  const onlyBPage = (await client().request(`/market/coupons/${onlyB.code}`)).payload;
  assert.deepEqual(
    onlyBPage.stores.map((store) => store.slug),
    [B.store.slug],
    "the coupon page lists the stores it works in"
  );
  const claim = async (code) =>
    (await shopper.request(`/market/coupons/${code}/claim`, { method: "POST" })).payload;
  const w10 = (await claim(free10.code)).walletId;
  assert.equal((await claim(free10.code)).error.code, "COUPON_ALREADY_CLAIMED");
  const w20 = (await claim(free20.code)).walletId;
  const wB = (await claim(onlyB.code)).walletId;
  assert.equal((await claim(forPoints.code)).error.code, "COUPON_COSTS_POINTS");
  assert.equal((await shopper.request("/market/me/coupons")).payload.coupons.length, 3);
  summary.claiming = true;

  // ── 3. checkout ──────────────────────────────────────────────────────────
  const district = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكاظمية" },
  });
  const home = (
    await shopper.request("/market/me/addresses", {
      method: "POST",
      body: {
        label: "البيت",
        recipientName: "علي",
        phone: `+96477${digits}4`.slice(0, 14),
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
  const key = () => `${testId}-order-${++seq}-idempotency`;
  const add = (m, quantity = 1) =>
    shopper.request("/market/cart/items", {
      method: "POST",
      body: { productId: m.product.id, quantity },
    });
  const place = (m, walletId) =>
    shopper.request(`/market/checkout/${m.store.slug}`, {
      method: "POST",
      body: { addressId: home.id, ...(walletId ? { platformCouponWalletId: walletId } : {}) },
      headers: { "idempotency-key": key() },
    });
  await add(A);
  const offer = (
    await shopper.request(
      `/market/checkout/${A.store.slug}?addressId=${home.id}&platformCoupon=${w10}`
    )
  ).payload;
  const offered10 = offer.platformCoupons.find((row) => row.walletId === w10);
  const offeredB = offer.platformCoupons.find((row) => row.walletId === wB);
  assert.deepEqual(
    [offered10.usable, offered10.discountIqd, offeredB.usable],
    [true, 4000, false],
    "10% of 40,000; the store-B coupon does not work here"
  );
  assert.match(offeredB.reason, /لا يعمل في هذا المتجر/);
  assert.equal(offer.totalIqd, 40000 - 4000 + 3000);
  assert.equal((await place(A, wB)).payload.error.code, "PLATFORM_COUPON_NOT_APPLICABLE");
  // Review batch 2, م-١٣: once handed out, a coupon's stores may grow, never shrink — the shopper
  // holding it (perhaps for points) would lose what he holds.
  const restore = (storeSlugs) =>
    owner.request(`/platform/market/coupons/${onlyB.id}/stores`, {
      method: "PUT",
      body: { storeSlugs },
    });
  assert.equal(
    (await restore([A.store.slug])).payload.error?.code,
    "COUPON_ALREADY_ISSUED",
    "a store is not taken away from a coupon shoppers hold"
  );
  assert.deepEqual(
    ((await restore([B.store.slug, A.store.slug])).payload.storeSlugs ?? []).sort(),
    [A.store.slug, B.store.slug].sort(),
    "…while one may be added"
  );
  const paid = await place(A, w10);
  assert.equal(paid.status, 201, JSON.stringify(paid.payload));
  const order = await prisma.storeOrder.findUniqueOrThrow({ where: { id: paid.payload.order.id } });
  assert.deepEqual(
    [order.subtotalIqd, order.discountIqd, order.platformDiscountIqd, order.totalIqd],
    [40000, 0, 4000, 39000],
    "the platform discount is not the store's discount"
  );
  // Review batch 2, م-١٢: the shopper's own order page must add up — it showed every term of the
  // total except the platform coupon, so 40,000 + 3,000 «came to» 39,000.
  const mine = (await shopper.request(`/market/orders/${order.id}`)).payload.order;
  assert.equal(mine.platformDiscountIqd, 4000);
  assert.equal(
    mine.subtotalIqd -
      mine.discountIqd -
      mine.loyaltyDiscountIqd -
      mine.platformDiscountIqd +
      mine.deliveryFeeIqd,
    mine.totalIqd,
    "every term of the total is on the shopper's page"
  );
  assert.equal(
    (await prisma.shopperCoupon.findUniqueOrThrow({ where: { id: w10 } })).usedOrderId,
    order.id
  );
  await add(A);
  assert.equal((await place(A, w10)).payload.error.code, "PLATFORM_COUPON_USED");
  // Two checkouts at once with one coupon, in two stores.
  await add(B);
  const raced = await Promise.all([place(A, w20), place(B, w20)]);
  assert.equal(raced.filter((result) => result.status === 201).length, 1, "one coupon, one order");
  assert.ok(raced.some((result) => result.payload?.error?.code === "PLATFORM_COUPON_USED"));
  const racedOrderId = raced.find((result) => result.status === 201).payload.order.id;
  const racedStore = raced[0].status === 201 ? A : B;
  summary.checkout = true;

  // ── 4. completion ────────────────────────────────────────────────────────
  const move = async (m, orderId, ...statuses) => {
    for (const toStatus of statuses) {
      const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
      await transitionOrderStatus(m.store.id, { kind: "merchant", id: m.merchantId }, orderId, {
        toStatus,
        expectedVersion: version,
      });
    }
  };
  await move(A, order.id, "processing", "preparation", "out_for_delivery", "completed");
  const entry = await prisma.ledgerEntry.findFirstOrThrow({
    where: { orderId: order.id, entryType: "order_completed" },
  });
  assert.deepEqual(
    [entry.subtotalIqd, entry.platformDiscountIqd, entry.loyaltyDiscountIqd],
    [40000, 4000, 0],
    "full commission base; the platform's cost recorded, not deducted"
  );
  assert.equal(entry.commissionIqd, Math.round((40000 * entry.commissionBps) / 10000));
  const points = (await shopper.request("/market/me/points")).payload;
  assert.deepEqual(
    [points.balance, points.tier.code],
    [36, "bronze"],
    "one point per 1,000 paid in money for goods (36,000)"
  );
  summary.completion = true;

  // ── 5. cancelled / returned ──────────────────────────────────────────────
  await move(racedStore, racedOrderId, "cancelled");
  assert.equal(
    (await prisma.shopperCoupon.findUniqueOrThrow({ where: { id: w20 } })).usedOrderId,
    null,
    "a cancelled order gives the coupon back"
  );
  const decision = await shopper.request(`/market/orders/${order.id}/return`, {
    method: "POST",
    body: { reasonCode: "damaged" },
  });
  await A.api.request(
    `/merchant/stores/${A.store.slug}/returns/${decision.payload.returnRequest.id}/decision`,
    { method: "POST", body: { approve: true } }
  );
  assert.equal(
    (await shopper.request("/market/me/points")).payload.balance,
    0,
    "a returned order's points come back off"
  );
  const returnEntry = await prisma.ledgerEntry.findFirstOrThrow({
    where: { orderId: order.id, entryType: "order_returned" },
  });
  assert.equal(returnEntry.platformDiscountIqd, 4000, "the reversal mirrors the platform's cost");
  // Owner decision 2026-11-22 (review batch 2, م-٤): refused at the door — returned before it
  // was ever completed — the shopper paid nothing, so the coupon comes back too.
  await add(A);
  const refused = await place(A, w20);
  assert.equal(refused.status, 201, JSON.stringify(refused.payload));
  await move(A, refused.payload.order.id, "processing", "preparation", "out_for_delivery");
  await move(A, refused.payload.order.id, "returned");
  assert.equal(
    (await prisma.shopperCoupon.findUniqueOrThrow({ where: { id: w20 } })).usedOrderId,
    null,
    "refused at the door: the coupon comes back"
  );
  summary.cancelReturn = true;

  // ── 6. points ────────────────────────────────────────────────────────────
  await prisma.shopperPointsEntry.create({ data: { shopperId, delta: 150, reason: "granted" } });
  const races = await Promise.all(
    Array.from({ length: 5 }, () =>
      shopper.request("/market/points/redeem", { method: "POST", body: { couponId: forPoints.id } })
    )
  );
  assert.equal(
    races.filter((result) => result.status === 201).length,
    1,
    "points for one coupon buy exactly one, however many at once"
  );
  assert.ok(
    races.every(
      (result) => result.status === 201 || result.payload.error.code === "POINTS_NOT_ENOUGH"
    )
  );
  assert.equal((await shopper.request("/market/me/points")).payload.balance, 50);
  // Signed in one at a time — each reads the last code sent.
  const others = [];
  for (const n of [1, 2, 3]) others.push(await signIn(`+9647${n}${digits}9`.slice(0, 14)));
  for (const other of others)
    await prisma.shopperPointsEntry.create({
      data: { shopperId: other.id, delta: 100, reason: "granted" },
    });
  const limited = await Promise.all(
    others.map((other) =>
      other.shopper.request("/market/points/redeem", {
        method: "POST",
        body: { couponId: forPoints.id },
      })
    )
  );
  assert.equal(
    limited.filter((result) => result.status === 201).length,
    2,
    "a limit of three, one already gone"
  );
  assert.equal(
    limited.find((result) => result.status !== 201).payload.error.code,
    "COUPON_EXHAUSTED"
  );
  assert.equal(
    (await prisma.platformCoupon.findUniqueOrThrow({ where: { id: forPoints.id } })).issuedCount,
    3
  );
  summary.points = true;

  // ── 7. tiers ─────────────────────────────────────────────────────────────
  await prisma.shopperPointsEntry.create({
    data: { shopperId, delta: 2000, reason: "earned", orderId: null },
  });
  const lifted = (await shopper.request("/market/me/points")).payload;
  assert.deepEqual([lifted.tier.code, lifted.next.code], ["silver", "gold"]);
  await add(A);
  const silverOrder = (await place(A)).payload.order.id;
  await move(A, silverOrder, "processing", "preparation", "out_for_delivery", "completed");
  const silver = await prisma.storeOrder.findUniqueOrThrow({ where: { id: silverOrder } });
  const basePoints = Math.floor(
    (silver.subtotalIqd - silver.discountIqd - silver.platformDiscountIqd) / 1000
  );
  assert.equal(
    (
      await prisma.shopperPointsEntry.findFirstOrThrow({
        where: { orderId: silverOrder, reason: "earned" },
      })
    ).delta,
    Math.floor((basePoints * 125) / 100),
    "the silver tier earns × 1.25"
  );
  summary.tiers = true;

  // ── 8. the owner's report ────────────────────────────────────────────────
  const report = (await owner.request("/platform/market/rewards/report")).payload;
  assert.ok(report.couponsUsed >= 1 && report.couponsIssued >= 6);
  assert.equal(typeof report.platformDiscountIqd, "number");
  const issuedEdit = await owner.request(`/platform/market/coupons/${forPoints.id}`, {
    method: "PUT",
    body: {
      ...window,
      code: forPoints.code,
      title: forPoints.title,
      kind: "fixed",
      amountOffIqd: 9000,
      pointsCost: 100,
      totalLimit: 3,
    },
  });
  assert.equal(
    issuedEdit.payload.error.code,
    "COUPON_ALREADY_ISSUED",
    "a handed-out coupon's worth does not change"
  );
  summary.report = true;

  console.log(JSON.stringify({ suite: "market-rewards", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.platformCoupon
    .updateMany({ where: { id: { in: created.coupons } }, data: { isActive: false } })
    .catch(() => undefined);
  await prisma.store
    .updateMany({
      where: { id: { in: created.stores } },
      data: { marketStatus: "unlisted", marketStatusAt: new Date() },
    })
    .catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}

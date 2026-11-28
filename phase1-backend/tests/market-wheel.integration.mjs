/**
 * Marketplace M9 — the prize wheel, over HTTP, plus a thousand spins at once.
 *
 *   1. The page: labels only — no weight, no stock ever reaches the browser.
 *   2. One free spin a day; then «خلصت لفّاتك» with when the next comes.
 *   3. A delivered order earns extra spins (capped), a return takes them back.
 *   4. Prizes: a physical one needs an address and goes «بالطريق إلك» then
 *      «وصلتك»; a coupon lands in «كوبوناتي» with its code; points add to the
 *      balance. A prize not claimed in time is «خلص وقت استلامها».
 *   5. The most a shopper may win: after it, only «حظّ أوفر».
 *   6. A cancelled prize goes back into stock.
 *   7. THE ACCEPTANCE: 1000 spins at the same time never hand out more of a
 *      prize than its stock, and every unit taken has exactly one win.
 *   8. «ترتيب الفائزين» with «مركزك»; the support log by phone.
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
const { spin: spinDirect } = await import("../src/modules/market-wheel/wheel.service.ts");
await prisma.storefrontRateLimit.deleteMany({
  where: { OR: [{ scope: { startsWith: "market_otp" } }, { scope: "market_wheel_spin" }] },
});
// One open wheel at a time: earlier runs' wheels are closed.
await prisma.marketWheel.updateMany({ data: { isOpen: false } });

const sent = [];
setOtpProviderForTests({
  name: "capture",
  async send(phone, code) {
    sent.push({ phone, code });
  },
});
const testId = `m9${Date.now().toString(36)}`;
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
      const text = await response.text();
      return { status: response.status, text, payload: text ? JSON.parse(text) : null };
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

const created = { stores: [], wheels: [], shoppers: [] };
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
  const reg = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}6`.slice(0, 14),
    email: `${testId}@codiq.test`,
    password: "MarketWheel!2026",
  });
  const store = await prisma.store.create({
    data: {
      merchantId: reg.payload.account.id,
      name: `متجر ${testId}`,
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  created.stores.push(store.id);
  await prisma.deliveryRate.create({
    data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `${testId}-p`,
      name: "منتج",
      priceIqd: 60000,
      stockQuantity: 50,
    },
  });
  const wheelCoupon = await prisma.platformCoupon.create({
    data: {
      code: `WH${tag}`,
      title: "كوبون العجلة",
      kind: "fixed",
      amountOffIqd: 2000,
      startsAt: new Date(Date.now() - DAY),
      endsAt: new Date(Date.now() + 30 * DAY),
    },
  });

  const wheelBody = {
    slug: `${testId}-wheel`,
    title: "عجلة الحظّ",
    howToPlay: "لفّة مجانيّة كلّ يوم.",
    isOpen: true,
    startsAt: new Date(Date.now() - DAY).toISOString(),
    endsAt: new Date(Date.now() + 10 * DAY).toISOString(),
    dailyFreeSpins: 1,
    iqdPerExtraSpin: 25000,
    maxExtraSpinsPerOrder: 3,
    maxWinsPerShopper: 3,
    claimDays: 7,
  };
  assert.ok(
    [401, 403].includes(
      (await client().request("/platform/market/wheels", { method: "POST", body: wheelBody }))
        .status
    )
  );
  const wheel = (
    await owner.request("/platform/market/wheels", { method: "POST", body: wheelBody })
  ).payload.wheel;
  created.wheels.push(wheel.id);
  const prize = async (body) =>
    (await owner.request(`/platform/market/wheels/${wheel.id}/prizes`, { method: "POST", body }))
      .payload.prize;
  const nothing = await prize({ label: "حظّ أوفر", kind: "nothing", weight: 1, position: 0 });
  const pts = await prize({
    label: "١٠٠ نقطة",
    kind: "points",
    points: 100,
    weight: 0,
    stock: 50,
    position: 1,
  });
  const cpn = await prize({
    label: "كوبون ٢٠٠٠",
    kind: "coupon",
    couponId: wheelCoupon.id,
    weight: 0,
    stock: 50,
    position: 2,
  });
  const gift = await prize({ label: "سمّاعة", kind: "physical", weight: 0, stock: 2, position: 3 });
  assert.equal(
    (
      await owner.request(`/platform/market/wheels/${wheel.id}/prizes`, {
        method: "POST",
        body: { label: "x", kind: "physical", weight: 1 },
      })
    ).status,
    422,
    "a physical prize needs a stock"
  );
  const only = async (target) => {
    for (const row of [nothing, pts, cpn, gift])
      await prisma.wheelPrize.update({
        where: { id: row.id },
        data: { weight: row.id === target.id ? 100 : 0 },
      });
  };

  // ── 1. the page ──────────────────────────────────────────────────────────
  const { shopper, id: shopperId } = await signIn(`+96477${digits}4`.slice(0, 14));
  const page = await shopper.request("/market/wheel");
  assert.equal(page.payload.open, true);
  assert.deepEqual(
    page.payload.segments.map((segment) => segment.label),
    ["حظّ أوفر", "١٠٠ نقطة", "كوبون ٢٠٠٠", "سمّاعة"]
  );
  assert.ok(
    !/weight|stock|wonCount|won_count/i.test(page.text),
    "the odds and the stock never reach the browser"
  );
  assert.deepEqual([page.payload.state.freeLeft, page.payload.state.bonusLeft], [1, 0]);
  summary.page = true;

  // ── 2. the daily spin ────────────────────────────────────────────────────
  await only(gift);
  const first = await shopper.request("/market/wheel/spin", { method: "POST" });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(
    [first.payload.prize.label, first.payload.segmentIndex, first.payload.state.spinsLeft],
    ["سمّاعة", 3, 0]
  );
  assert.ok(!/weight|stock/i.test(first.text));
  const none = await shopper.request("/market/wheel/spin", { method: "POST" });
  assert.equal(none.payload.error.code, "NO_SPINS_LEFT");
  assert.ok(
    new Date(none.payload.error.nextFreeAt) > new Date(),
    "with when the next free spin comes"
  );
  summary.daily = true;

  // ── 3. spins earned by an order ──────────────────────────────────────────
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
  async function deliveredOrder(quantity) {
    await shopper.request("/market/cart/items", {
      method: "POST",
      body: { productId: product.id, quantity },
    });
    const placed = await shopper.request(`/market/checkout/${store.slug}`, {
      method: "POST",
      body: { addressId: home.id },
      headers: { "idempotency-key": `${testId}-o-${++seq}-idempotency` },
    });
    assert.equal(placed.status, 201, placed.text);
    for (const toStatus of ["processing", "preparation", "out_for_delivery", "completed"]) {
      const { version } = await prisma.storeOrder.findUniqueOrThrow({
        where: { id: placed.payload.order.id },
      });
      await transitionOrderStatus(
        store.id,
        { kind: "merchant", id: reg.payload.account.id },
        placed.payload.order.id,
        { toStatus, expectedVersion: version }
      );
    }
    return placed.payload.order.id;
  }
  const big = await deliveredOrder(3);
  assert.equal(
    (await shopper.request("/market/wheel")).payload.state.bonusLeft,
    3,
    "180,000 / 25,000 = 7, capped at 3"
  );
  const returned = await shopper.request(`/market/orders/${big}/return`, {
    method: "POST",
    body: { reasonCode: "damaged" },
  });
  const merchantToken = (
    await client().request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}@codiq.test`, password: "MarketWheel!2026" },
    })
  ).payload.accessToken;
  await client(merchantToken).request(
    `/merchant/stores/${store.slug}/returns/${returned.payload.returnRequest.id}/decision`,
    { method: "POST", body: { approve: true } }
  );
  assert.equal(
    (await shopper.request("/market/wheel")).payload.state.bonusLeft,
    0,
    "a return takes the spins back"
  );
  await deliveredOrder(1);
  assert.equal((await shopper.request("/market/wheel")).payload.state.bonusLeft, 2);
  summary.earned = true;

  // ── 4. prizes ────────────────────────────────────────────────────────────
  let wins = (await shopper.request("/market/wheel/wins")).payload.wins;
  const giftWin = wins[0];
  assert.deepEqual([giftWin.prize.label, giftWin.status], ["سمّاعة", "pending"]);
  assert.equal(
    (await shopper.request(`/market/wheel/wins/${giftWin.id}/claim`, { method: "POST", body: {} }))
      .payload.error.code,
    "ADDRESS_REQUIRED"
  );
  assert.equal(
    (
      await shopper.request(`/market/wheel/wins/${giftWin.id}/claim`, {
        method: "POST",
        body: { addressId: home.id },
      })
    ).payload.win.statusLabel,
    "بالطريق إلك"
  );
  assert.equal(
    (
      await shopper.request(`/market/wheel/wins/${giftWin.id}/claim`, {
        method: "POST",
        body: { addressId: home.id },
      })
    ).payload.error.code,
    "WIN_ALREADY_CLAIMED"
  );
  const queue = (await owner.request(`/platform/market/wheels/${wheel.id}/wins?status=shipping`))
    .payload.wins;
  assert.equal(queue[0].address.addressLine, "شارع ٢٠", "the owner knows where to send it");
  assert.equal(
    (
      await owner.request(`/platform/market/wheel-wins/${giftWin.id}/status`, {
        method: "POST",
        body: { status: "delivered" },
      })
    ).payload.win.status,
    "delivered"
  );
  await only(cpn);
  await shopper.request("/market/wheel/spin", { method: "POST" });
  await only(pts);
  await shopper.request("/market/wheel/spin", { method: "POST" });
  wins = (await shopper.request("/market/wheel/wins")).payload.wins;
  const couponWin = wins.find((win) => win.prize.kind === "coupon");
  const pointsWin = wins.find((win) => win.prize.kind === "points");
  assert.equal(couponWin.code, null, "no code before claiming");
  assert.equal(
    (
      await shopper.request(`/market/wheel/wins/${couponWin.id}/claim`, {
        method: "POST",
        body: {},
      })
    ).payload.win.code,
    wheelCoupon.code,
    "«كود جاهز»"
  );
  assert.ok(
    (await shopper.request("/market/me/coupons")).payload.coupons.some(
      (row) => row.coupon.code === wheelCoupon.code
    )
  );
  await prisma.wheelWin.update({
    where: { id: pointsWin.id },
    data: { claimBy: new Date(Date.now() - 60_000) },
  });
  assert.equal(
    (
      await shopper.request(`/market/wheel/wins/${pointsWin.id}/claim`, {
        method: "POST",
        body: {},
      })
    ).payload.error.code,
    "WIN_EXPIRED"
  );
  assert.equal(
    (await shopper.request("/market/wheel/wins")).payload.wins.find(
      (win) => win.id === pointsWin.id
    ).statusLabel,
    "خلص وقت استلامها"
  );
  summary.prizes = true;

  // ── 5. the most a shopper may win ────────────────────────────────────────
  await prisma.wheelSpinGrant.create({ data: { wheelId: wheel.id, shopperId, spins: 2 } });
  const capped = await shopper.request("/market/wheel/spin", { method: "POST" });
  assert.deepEqual(
    [capped.payload.prize.kind, capped.payload.win],
    ["nothing", null],
    "three won: only «حظّ أوفر» now"
  );
  assert.match(capped.payload.message, /أكثر ما تسمح به العجلة/);
  summary.maxWins = true;

  // ── 6. cancelled goes back to stock ──────────────────────────────────────
  const before = (await prisma.wheelPrize.findUniqueOrThrow({ where: { id: pts.id } })).wonCount;
  assert.equal(
    (
      await owner.request(`/platform/market/wheel-wins/${pointsWin.id}/status`, {
        method: "POST",
        body: { status: "cancelled" },
      })
    ).payload.error.code,
    "WIN_CANCEL_NOTE_REQUIRED"
  );
  await owner.request(`/platform/market/wheel-wins/${pointsWin.id}/status`, {
    method: "POST",
    body: { status: "cancelled", note: "انتهت مدّة الاستلام" },
  });
  assert.equal(
    (await prisma.wheelPrize.findUniqueOrThrow({ where: { id: pts.id } })).wonCount,
    before - 1
  );
  summary.cancelled = true;

  // Review batch 6, ت-١: the status was read outside the transaction and written by id alone.
  // Two cancels together both passed and the stock came back twice; a cancel racing the
  // shopper's claim could overwrite «claimed» — he kept the points and the unit was re-sold.
  const pendingWin = async () => {
    const spinRow = await prisma.wheelSpin.create({
      data: {
        wheelId: wheel.id,
        shopperId,
        kind: "bonus",
        day: new Date(),
        prizeId: pts.id,
        prizeLabel: "نقاط",
      },
    });
    await prisma.wheelPrize.update({ where: { id: pts.id }, data: { wonCount: { increment: 1 } } });
    return prisma.wheelWin.create({
      data: {
        wheelId: wheel.id,
        spinId: spinRow.id,
        shopperId,
        prizeId: pts.id,
        claimBy: new Date(Date.now() + 86_400_000),
      },
    });
  };
  const cancel = (id) =>
    owner.request(`/platform/market/wheel-wins/${id}/status`, {
      method: "POST",
      body: { status: "cancelled", note: "إلغاء متزامن" },
    });
  const twice = await pendingWin();
  const stockBefore = (await prisma.wheelPrize.findUniqueOrThrow({ where: { id: pts.id } }))
    .wonCount;
  const cancels = await Promise.all([cancel(twice.id), cancel(twice.id), cancel(twice.id)]);
  assert.equal(
    cancels.filter((reply) => reply.status === 200).length,
    1,
    `one win, one cancellation · ${cancels.map((reply) => reply.status).join(",")}`
  );
  assert.equal(
    (await prisma.wheelPrize.findUniqueOrThrow({ where: { id: pts.id } })).wonCount,
    stockBefore - 1,
    "the unit comes back once"
  );
  const raced = await pendingWin();
  const [claimed, cancelled] = await Promise.all([
    shopper.request(`/market/wheel/wins/${raced.id}/claim`, { method: "POST", body: {} }),
    cancel(raced.id),
  ]);
  const final = await prisma.wheelWin.findUniqueOrThrow({ where: { id: raced.id } });
  assert.ok(
    !(claimed.status === 200 && cancelled.status === 200),
    `a claimed prize is never also cancelled · claim ${claimed.status}, cancel ${cancelled.status}, now ${final.status}`
  );
  assert.equal(final.status, claimed.status === 200 ? "claimed" : "cancelled");
  summary.cancelRaces = "one cancel wins; a claim and a cancel never both stand";

  // ── 7. a thousand spins at once ──────────────────────────────────────────
  await prisma.marketWheel.update({
    where: { id: wheel.id },
    data: { dailyFreeSpins: 0, maxWinsPerShopper: 100 },
  });
  const rare = await prisma.wheelPrize.create({
    data: {
      wheelId: wheel.id,
      label: "نادرة",
      kind: "points",
      points: 5,
      weight: 50,
      stock: 7,
      position: 4,
    },
  });
  const rarer = await prisma.wheelPrize.create({
    data: {
      wheelId: wheel.id,
      label: "أندر",
      kind: "points",
      points: 9,
      weight: 50,
      stock: 3,
      position: 5,
    },
  });
  for (const row of [pts, cpn, gift])
    await prisma.wheelPrize.update({ where: { id: row.id }, data: { weight: 0 } });
  await prisma.wheelPrize.update({ where: { id: nothing.id }, data: { weight: 1 } });
  const crowd = Array.from({ length: 200 }, (_, index) => ({
    phoneNormalized: `+9647${String(index).padStart(3, "0")}${digits}`.slice(0, 14),
    fullName: `متسوّق ${index}`,
  }));
  await prisma.shopper.createMany({ data: crowd, skipDuplicates: true });
  const crowdRows = await prisma.shopper.findMany({
    where: { phoneNormalized: { in: crowd.map((row) => row.phoneNormalized) } },
    select: { id: true },
  });
  assert.equal(crowdRows.length, 200);
  created.shoppers.push(...crowdRows.map((row) => row.id));
  await prisma.wheelSpinGrant.createMany({
    data: crowdRows.map((row) => ({ wheelId: wheel.id, shopperId: row.id, spins: 5 })),
  });
  const started = Date.now();
  const results = await Promise.allSettled(
    crowdRows.flatMap((row) => Array.from({ length: 5 }, () => spinDirect(row.id)))
  );
  const failed = results.filter((result) => result.status === "rejected");
  assert.equal(
    failed.length,
    0,
    `every spin completes: ${failed
      .slice(0, 2)
      .map((result) => String(result.reason))
      .join(" | ")}`
  );
  for (const target of [rare, rarer]) {
    const row = await prisma.wheelPrize.findUniqueOrThrow({ where: { id: target.id } });
    const winRows = await prisma.wheelWin.count({ where: { prizeId: target.id } });
    assert.ok(
      row.wonCount <= target.stock,
      `${target.label}: ${row.wonCount} won of ${target.stock}`
    );
    assert.equal(winRows, row.wonCount, `${target.label}: every unit taken has exactly one win`);
  }
  assert.equal(
    await prisma.wheelSpin.count({ where: { shopperId: { in: crowdRows.map((row) => row.id) } } }),
    1000
  );
  const extra = await Promise.allSettled(crowdRows.slice(0, 5).map((row) => spinDirect(row.id)));
  assert.ok(
    extra.every((result) => result.status === "rejected" && result.reason.code === "NO_SPINS_LEFT"),
    "five spins each, not one more"
  );
  summary.thousandSpins = {
    ms: Date.now() - started,
    rare: (await prisma.wheelPrize.findUniqueOrThrow({ where: { id: rare.id } })).wonCount,
    rarer: (await prisma.wheelPrize.findUniqueOrThrow({ where: { id: rarer.id } })).wonCount,
  };

  // ── 8. the board and support ─────────────────────────────────────────────
  const board = (await shopper.request("/market/wheel/board")).payload;
  assert.ok(board.board.length > 0 && board.board.length <= 20);
  assert.ok(
    board.board.every((row) => /••\d\d$/.test(row.name)),
    "names masked"
  );
  assert.ok(board.me && typeof board.me.wins === "number");
  const log = (await shopper.request("/market/wheel/spins")).payload.spins;
  assert.ok(log.length >= 4);
  const support = (
    await owner.request(`/platform/market/wheel/support?phone=0770${digits.slice(0, 7)}`)
  ).status;
  assert.ok([200, 404].includes(support));
  const supportOk = (
    await owner.request(
      `/platform/market/wheel/support?phone=${encodeURIComponent(`+96477${digits}4`.slice(0, 14))}`
    )
  ).payload;
  assert.equal(supportOk.spins.length, log.length, "support reads the same log");
  summary.board = true;

  console.log(JSON.stringify({ suite: "market-wheel", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.marketWheel
    .updateMany({ where: { id: { in: created.wheels } }, data: { isOpen: false } })
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

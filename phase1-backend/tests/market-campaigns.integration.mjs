/**
 * Marketplace M8a — campaigns and «عرض الساعة», over HTTP with real orders.
 * Time is moved by moving the hour (its rows), not the clock.
 *
 *   1. The owner: a campaign, its days, its hours (inside it, not overlapping).
 *   2. The store puts a product forward: the campaign's minimum percentage,
 *      its own live product only, an hour not started; the owner approves or
 *      rejects with a reason.
 *   3. Before the hour: the list price everywhere.
 *   4. During the hour: the deal price on the market card (with the list price
 *      struck through and the end time), the product page, the store's own
 *      product page; a cart priced before the hour is refused once and the
 *      order is placed AT THE DEAL PRICE.
 *   5. After the hour: a cart priced during it is refused (CART_PRICE_CHANGED)
 *      — the deal price cannot be bought outside its hour — then sells at the
 *      list price.
 *   6. Once the hour starts nothing about it moves: no withdrawing, no
 *      deciding, no deleting it.
 *   7. An unpublished campaign changes no price.
 *   8. The campaign page: days with today, the running hour's products, the
 *      next hours, the stores.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");
await prisma.storefrontRateLimit.deleteMany({ where: { scope: { startsWith: "market_otp" } } });

const sent = [];
setOtpProviderForTests({
  name: "capture",
  async send(phone, code) {
    sent.push({ phone, code });
  },
});
const testId = `m8${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};
const HOUR = 3_600_000;
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

const created = { stores: [], campaigns: [] };
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
      password: "MarketCampaign!2026",
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
    const token = (
      await client().request("/auth/merchant/login", {
        method: "POST",
        body: { identifier: email, password: "MarketCampaign!2026" },
      })
    ).payload.accessToken;
    return { store, api: client(token) };
  }
  const A = await merchantWithStore("a", 5);
  const B = await merchantWithStore("b", 8);
  const perfume = await prisma.product.create({
    data: {
      storeId: A.store.id,
      sku: `${testId}-p`,
      name: `عطر ${testId}`,
      priceIqd: 10000,
      stockQuantity: 50,
    },
  });
  const other = await prisma.product.create({
    data: {
      storeId: B.store.id,
      sku: `${testId}-o`,
      name: `حقيبة ${testId}`,
      priceIqd: 20000,
      stockQuantity: 50,
    },
  });

  // ── 1. the owner ─────────────────────────────────────────────────────────
  const now = Date.now();
  const campaignBody = {
    slug: `${testId}-sale`,
    title: `تخفيضات ${testId}`,
    subtitle: "أسبوع العروض",
    startsAt: new Date(now - DAY).toISOString(),
    endsAt: new Date(now + 6 * DAY).toISOString(),
    minPercent: 10,
    isPublished: true,
  };
  assert.ok(
    [401, 403].includes(
      (await A.api.request("/platform/market/campaigns", { method: "POST", body: campaignBody }))
        .status
    )
  );
  const made = await owner.request("/platform/market/campaigns", {
    method: "POST",
    body: campaignBody,
  });
  assert.equal(made.status, 201, JSON.stringify(made.payload));
  const campaignId = made.payload.campaign.id;
  created.campaigns.push(campaignId);
  const today = new Date(now + 3 * HOUR).toISOString().slice(0, 10);
  const tomorrow = new Date(now + 3 * HOUR + DAY).toISOString().slice(0, 10);
  assert.equal(
    (
      await owner.request(`/platform/market/campaigns/${campaignId}/days`, {
        method: "PUT",
        body: {
          days: [
            { day: today, title: "يوم العطور" },
            { day: tomorrow, title: "يوم الحقائب", note: "خصومات حتى ٥٠٪" },
          ],
        },
      })
    ).payload.days.length,
    2
  );
  const slot1 = {
    title: "ساعة العطور",
    startsAt: new Date(now + 2 * HOUR).toISOString(),
    endsAt: new Date(now + 3 * HOUR).toISOString(),
  };
  let detail = (
    await owner.request(`/platform/market/campaigns/${campaignId}/slots`, {
      method: "POST",
      body: slot1,
    })
  ).payload;
  assert.equal(
    (
      await owner.request(`/platform/market/campaigns/${campaignId}/slots`, {
        method: "POST",
        body: {
          startsAt: new Date(now + 2.5 * HOUR).toISOString(),
          endsAt: new Date(now + 3.5 * HOUR).toISOString(),
        },
      })
    ).payload.error.code,
    "SLOT_OVERLAP"
  );
  assert.equal(
    (
      await owner.request(`/platform/market/campaigns/${campaignId}/slots`, {
        method: "POST",
        body: {
          startsAt: new Date(now + 10 * DAY).toISOString(),
          endsAt: new Date(now + 10 * DAY + HOUR).toISOString(),
        },
      })
    ).payload.error.code,
    "SLOT_OUTSIDE_CAMPAIGN"
  );
  detail = (
    await owner.request(`/platform/market/campaigns/${campaignId}/slots`, {
      method: "POST",
      body: {
        title: "ساعة الحقائب",
        startsAt: new Date(now + 5 * HOUR).toISOString(),
        endsAt: new Date(now + 6 * HOUR).toISOString(),
      },
    })
  ).payload;
  const [slotA, slotB] = detail.slots;
  summary.owner = true;

  // ── 2. the store puts products forward ───────────────────────────────────
  const offered = (await A.api.request(`/merchant/stores/${A.store.slug}/market-campaigns`))
    .payload;
  assert.ok(offered.campaigns.some((row) => row.id === campaignId && row.slots.length === 2));
  assert.equal(
    (
      await A.api.request(`/merchant/stores/${A.store.slug}/market-deals`, {
        method: "POST",
        body: { slotId: slotA.id, productId: perfume.id, percentOff: 5 },
      })
    ).payload.error.code,
    "DEAL_PERCENT_TOO_LOW"
  );
  assert.equal(
    (
      await A.api.request(`/merchant/stores/${A.store.slug}/market-deals`, {
        method: "POST",
        body: { slotId: slotA.id, productId: other.id, percentOff: 20 },
      })
    ).status,
    404,
    "not his product"
  );
  const proposed = await A.api.request(`/merchant/stores/${A.store.slug}/market-deals`, {
    method: "POST",
    body: { slotId: slotA.id, productId: perfume.id, percentOff: 15 },
  });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.payload));
  assert.equal(
    (
      await A.api.request(`/merchant/stores/${A.store.slug}/market-deals`, {
        method: "POST",
        body: { slotId: slotA.id, productId: perfume.id, percentOff: 20 },
      })
    ).payload.error.code,
    "DEAL_EXISTS"
  );
  const otherDeal = (
    await B.api.request(`/merchant/stores/${B.store.slug}/market-deals`, {
      method: "POST",
      body: { slotId: slotB.id, productId: other.id, percentOff: 30 },
    })
  ).payload.deal;
  const pending = (
    await owner.request(`/platform/market/campaigns/${campaignId}/deals?status=pending`)
  ).payload.deals;
  assert.equal(pending.length, 2);
  assert.equal(
    (
      await owner.request(`/platform/market/deals/${otherDeal.id}/decision`, {
        method: "POST",
        body: { approve: false },
      })
    ).payload.error.code,
    "DEAL_REJECTION_NOTE_REQUIRED"
  );
  assert.equal(
    (
      await owner.request(`/platform/market/deals/${proposed.payload.deal.id}/decision`, {
        method: "POST",
        body: { approve: true },
      })
    ).payload.deal.status,
    "approved"
  );
  assert.equal(
    (
      await owner.request(`/platform/market/deals/${otherDeal.id}/decision`, {
        method: "POST",
        body: { approve: true },
      })
    ).payload.deal.status,
    "approved"
  );
  summary.proposals = true;

  // ── 3. before the hour ───────────────────────────────────────────────────
  const card = async () =>
    (await client().request(`/market/products?ids=${perfume.id}`)).payload.products[0];
  let shown = await card();
  assert.deepEqual(
    [shown.priceIqd, shown.deal, shown.compareAtPriceIqd],
    [10000, null, null],
    "before the hour: the list price"
  );
  const phone = `+96477${digits}4`.slice(0, 14);
  const shopper = client();
  const asked = await shopper.request("/market/auth/code", { method: "POST", body: { phone } });
  await shopper.request("/market/auth/verify", {
    method: "POST",
    body: { challengeId: asked.payload.challengeId, code: sent.at(-1).code },
  });
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
  await shopper.request("/market/cart/items", {
    method: "POST",
    body: { productId: perfume.id, quantity: 2 },
  });
  assert.equal(
    (await shopper.request("/market/cart")).payload.stores[0].lines[0].unitPriceIqd,
    10000
  );
  summary.before = true;

  // ── 4. during the hour ───────────────────────────────────────────────────
  const moveSlot = (slot, startsAt, endsAt) =>
    prisma.marketDealSlot.update({
      where: { id: slot.id },
      data: { startsAt: new Date(startsAt), endsAt: new Date(endsAt) },
    });
  await moveSlot(slotA, Date.now() - 10 * 60_000, Date.now() + 50 * 60_000);
  shown = await card();
  assert.deepEqual(
    [shown.priceIqd, shown.compareAtPriceIqd, shown.deal.percentOff, shown.discountPercent],
    [8500, 10000, 15, 15],
    "the deal price, the list price struck through"
  );
  assert.ok(new Date(shown.deal.endsAt) > new Date(), "with its end for the countdown");
  const page = (await client().request(`/market/products/${perfume.id}`)).payload.product;
  assert.deepEqual([page.variants[0].priceIqd, page.variants[0].listPriceIqd], [8500, 10000]);
  const storefront = (await client().request(`/store/${A.store.slug}/products/${perfume.id}`))
    .payload;
  const storefrontVariant = (storefront.product ?? storefront).variants[0];
  assert.deepEqual(
    [storefrontVariant.priceIqd, storefrontVariant.listPriceIqd],
    [8500, 10000],
    "the store's own page agrees"
  );
  const line = (await shopper.request("/market/cart")).payload.stores[0].lines[0];
  assert.deepEqual(
    [line.problem, line.livePriceIqd, line.listPriceIqd],
    ["price_changed", 8500, 10000],
    "the cart shows the price moved"
  );
  const first = await shopper.request(`/market/checkout/${A.store.slug}`, {
    method: "POST",
    body: { addressId: home.id },
    headers: { "idempotency-key": `${testId}-deal-1-idempotency` },
  });
  assert.equal(
    first.payload.error.code,
    "CART_PRICE_CHANGED",
    "a cart priced before the hour is refused once"
  );
  const during = await shopper.request(`/market/checkout/${A.store.slug}`, {
    method: "POST",
    body: { addressId: home.id },
    headers: { "idempotency-key": `${testId}-deal-2-idempotency` },
  });
  assert.equal(during.status, 201, JSON.stringify(during.payload));
  const duringOrder = await prisma.storeOrder.findUniqueOrThrow({
    where: { id: during.payload.order.id },
    include: { items: true },
  });
  assert.deepEqual(
    [duringOrder.items[0].unitPriceIqd, duringOrder.subtotalIqd],
    [8500, 17000],
    "sold at the deal price"
  );
  summary.during = true;

  // ── 5. after the hour ────────────────────────────────────────────────────
  await shopper.request("/market/cart/items", {
    method: "POST",
    body: { productId: perfume.id, quantity: 1 },
  });
  assert.equal(
    (await shopper.request("/market/cart")).payload.stores[0].lines[0].unitPriceIqd,
    8500,
    "priced inside the hour"
  );
  await moveSlot(slotA, Date.now() - 70 * 60_000, Date.now() - 10 * 60_000);
  const late = await shopper.request(`/market/checkout/${A.store.slug}`, {
    method: "POST",
    body: { addressId: home.id },
    headers: { "idempotency-key": `${testId}-late-1-idempotency` },
  });
  assert.equal(
    late.payload.error.code,
    "CART_PRICE_CHANGED",
    "the deal price is not accepted after the hour"
  );
  const after = await shopper.request(`/market/checkout/${A.store.slug}`, {
    method: "POST",
    body: { addressId: home.id },
    headers: { "idempotency-key": `${testId}-late-2-idempotency` },
  });
  assert.equal(after.status, 201, JSON.stringify(after.payload));
  assert.equal(
    (await prisma.orderItem.findFirstOrThrow({ where: { orderId: after.payload.order.id } }))
      .unitPriceIqd,
    10000,
    "back to the list price"
  );
  assert.equal((await card()).deal, null);
  summary.after = true;

  // ── 6. fixed once started ────────────────────────────────────────────────
  await moveSlot(slotA, Date.now() - 10 * 60_000, Date.now() + 50 * 60_000);
  assert.equal(
    (
      await A.api.request(
        `/merchant/stores/${A.store.slug}/market-deals/${proposed.payload.deal.id}`,
        { method: "DELETE" }
      )
    ).payload.error.code,
    "SLOT_STARTED"
  );
  assert.equal(
    (
      await owner.request(`/platform/market/deals/${proposed.payload.deal.id}/decision`, {
        method: "POST",
        body: { approve: false, note: "x" },
      })
    ).payload.error.code,
    "SLOT_STARTED"
  );
  assert.equal(
    (
      await owner.request(`/platform/market/campaigns/${campaignId}/slots/${slotA.id}`, {
        method: "DELETE",
      })
    ).payload.error.code,
    "SLOT_STARTED"
  );
  summary.fixed = true;

  // ── 8. the campaign page ─────────────────────────────────────────────────
  const campaignPage = (await client().request(`/market/campaigns/${testId}-sale`)).payload;
  assert.equal(campaignPage.campaign.status, "live");
  assert.deepEqual(
    campaignPage.days.map((day) => [day.title, day.isToday]),
    [
      ["يوم العطور", true],
      ["يوم الحقائب", false],
    ]
  );
  assert.deepEqual(
    campaignPage.current.products.map((product) => [product.id, product.priceIqd]),
    [[perfume.id, 8500]]
  );
  assert.equal(campaignPage.upcoming[0].id, slotB.id);
  assert.deepEqual(
    campaignPage.upcoming[0].products.map((product) => [product.id, product.priceIqd]),
    [[other.id, 20000]],
    "the next hour at today's price"
  );
  assert.deepEqual(
    campaignPage.stores.map((store) => store.slug).sort(),
    [A.store.slug, B.store.slug].sort()
  );
  assert.ok(
    (await client().request("/market/campaigns/live")).payload.campaigns.some(
      (row) => row.slug === `${testId}-sale` && row.nextHour.running
    )
  );
  summary.page = true;

  // ── 7. unpublished ───────────────────────────────────────────────────────
  await owner.request(`/platform/market/campaigns/${campaignId}`, {
    method: "PUT",
    body: { ...campaignBody, isPublished: false },
  });
  assert.equal((await card()).priceIqd, 10000, "an unpublished campaign changes no price");
  assert.equal((await client().request(`/market/campaigns/${testId}-sale`)).status, 404);
  assert.equal(
    (await prisma.$queryRaw`SELECT codiq_live_price(${perfume.id}::uuid, 10000, now()) AS p`)[0].p,
    10000
  );
  summary.unpublished = true;

  console.log(JSON.stringify({ suite: "market-campaigns", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.marketCampaign
    .deleteMany({ where: { id: { in: created.campaigns } } })
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

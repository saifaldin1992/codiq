/**
 * ق-202 — the visit beacon and the merchant's home aggregate.
 *
 * A browser that reloads is one visitor and many visits; a second browser is
 * a second visitor; a product page counts a view; a foreign product counts
 * nothing. Then the home aggregate: today's sales exclude the cancelled order
 * and the counter sale, yesterday is yesterday, conversion is orders over
 * unique visitors, the hourly chart is in Baghdad time, best sellers and most
 * viewed come from the range, low stock is an exact count, the wallet is
 * there, and the latest orders exclude the till.
 *
 * Run: pnpm merchant:home
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `home-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

// The visit counter batches in memory; this suite asserts on rows right after the beacon.
process.env.CODIQ_VISIT_FLUSH_MS = "0";
const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const { baghdadDay, baghdadDayBounds, daysBefore } = await import(
  "../src/services/store-traffic.service.ts"
);
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function browser() {
  const jar = new Map();
  return {
    has: (name) => jar.has(name),
    async post(path, body) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base,
          ...(jar.size
            ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
        },
        body: JSON.stringify(body ?? {}),
      });
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
      return response.status;
    },
  };
}

async function get(path, token) {
  const response = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
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
    businessName: "متجر الرئيسية",
    phone: `+96473${suffix}`,
    email: `${testId}.merchant@codiq.test`,
    password: "HomeMerchant!2026",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر الرئيسية",
      slug: `${testId}-s`,
      defaultSubdomain: `${testId}-s`,
    },
  });
  const token = await createTypedSession("merchant", merchant.payload.account.id, store.id);
  const other = await registerMerchantDirect({
    ownerName: "تاجر آخر",
    businessName: "متجر الجار",
    phone: `+96474${suffix}`,
    email: `${testId}.b@codiq.test`,
    password: "HomeNeighbour!2026",
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: other.payload.account.id,
      name: "متجر الجار",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const slug = store.slug;

  const product = async (sku, name, stockQuantity, lowStockThreshold, priceIqd) => {
    const row = await prisma.product.create({
      data: { storeId: store.id, sku, name, priceIqd, stockQuantity, lowStockThreshold },
    });
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { productId: row.id, isDefault: true },
    });
    return { ...row, variantId: variant.id };
  };
  const hero = await product("H-1", "المنتج البطل", 50, 0, 15000);
  const scarce = await product("H-2", "منتج شارف على النفاد", 2, 5, 9000);
  const foreign = await prisma.product.create({
    data: {
      storeId: storeB.id,
      sku: "H-B",
      name: "منتج الجار",
      priceIqd: 5000,
      stockQuantity: 5,
      lowStockThreshold: 0,
    },
  });

  // ── 1. the beacon: visits, visitors, views ────────────────────────────────
  const first = browser();
  assert.equal(await first.post(`/store/${slug}/visit`), 204);
  assert.ok(first.has(`codiq_visit_${slug}`), "the first visit of the day sets the day cookie");
  assert.equal(await first.post(`/store/${slug}/visit`, { productId: hero.id }), 204);
  assert.equal(await first.post(`/store/${slug}/visit`, { productId: hero.id }), 204);
  assert.equal(
    await first.post(`/store/${slug}/visit`, { productId: foreign.id }),
    204,
    "a foreign product id is accepted and counts nothing"
  );
  const second = browser();
  assert.equal(await second.post(`/store/${slug}/visit`, { productId: scarce.id }), 204);
  const noOrigin = await fetch(`${base}/store/${slug}/visit`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
    body: "{}",
  });
  assert.equal(
    noOrigin.status,
    403,
    "a beacon from another origin is refused like every storefront write"
  );
  const today = baghdadDay();
  const [visitRow] = await prisma.$queryRawUnsafe(
    `SELECT visits, visitors FROM store_visits_daily WHERE store_id = '${store.id}' AND day = '${today}'::date`
  );
  assert.deepEqual(
    { visits: Number(visitRow.visits), visitors: Number(visitRow.visitors) },
    { visits: 5, visitors: 2 },
    "ق-202: five page views from two browsers — one reloading is one visitor"
  );
  const views = await prisma.$queryRawUnsafe(
    `SELECT product_id, views FROM product_views_daily WHERE store_id = '${store.id}' AND day = '${today}'::date ORDER BY views DESC`
  );
  assert.deepEqual(
    views.map((row) => [row.product_id, Number(row.views)]),
    [
      [hero.id, 2],
      [scarce.id, 1],
    ],
    "…and the product views are per product; the neighbour's product never appears"
  );
  summary.beacon = { visits: 5, visitors: 2, foreignIgnored: true, originChecked: 403 };

  // ── 2. orders: today (one real, one cancelled, one counter sale), yesterday ─
  const yesterday = daysBefore(today, 1);
  const yesterdayAt10 = new Date(baghdadDayBounds(yesterday).from.valueOf() + 10 * 60 * 60 * 1000);
  let seq = 0;
  const order = async (status, source, totalIqd, createdAt, code = "cod") => {
    seq += 1;
    return prisma.storeOrder.create({
      data: {
        storeId: store.id,
        orderNumber: `${testId}-${seq}`,
        status,
        source,
        customerName: "زبون",
        paymentMethodCode: code,
        subtotalIqd: totalIqd,
        deliveryFeeIqd: 0,
        totalIqd,
        ...(createdAt ? { createdAt } : {}),
        items: {
          create: [
            {
              productId: hero.id,
              variantId: hero.variantId,
              productName: hero.name,
              quantity: 1,
              unitPriceIqd: totalIqd,
              lineTotalIqd: totalIqd,
            },
          ],
        },
      },
      select: { id: true },
    });
  };
  await order("new", "storefront", 15000, null);
  await order("cancelled", "storefront", 99000, null);
  await order("completed", "pos", 77000, null, "cash");
  await order("completed", "storefront", 20000, yesterdayAt10, "zaincash");

  // ── 3. the aggregate ─────────────────────────────────────────────────────
  const home = await get(`/merchant/stores/${slug}/dashboard/home`, token);
  assert.equal(home.status, 200, JSON.stringify(home.payload));
  const h = home.payload.home;
  assert.equal(h.today.day, today);
  assert.equal(
    h.today.salesIqd,
    15000,
    "ق-202: today's sales — the cancelled order and the counter sale are not sales"
  );
  assert.equal(h.today.ordersCount, 1);
  assert.deepEqual(
    { visits: h.today.visits, visitors: h.today.visitors },
    { visits: 5, visitors: 2 }
  );
  assert.equal(h.today.conversionPct, 50, "one order over two unique visitors");
  assert.equal(h.yesterday.day, yesterday);
  assert.deepEqual(
    {
      sales: h.yesterday.salesIqd,
      orders: h.yesterday.ordersCount,
      conversion: h.yesterday.conversionPct,
    },
    { sales: 20000, orders: 1, conversion: null },
    "yesterday had no visitors, so its conversion is null — not a number invented from a division by zero"
  );
  const statusCounts = Object.fromEntries(h.byStatus.map((row) => [row.status, row.count]));
  assert.equal(
    statusCounts.cancelled,
    1,
    "the status chart shows the cancelled order — that is what it is for"
  );
  assert.equal(statusCounts.new, 1);
  assert.equal(statusCounts.completed, 1, "…and the counter sale is not in it");
  const byCode = Object.fromEntries(h.byPaymentMethod.map((row) => [row.code, row.count]));
  assert.deepEqual(byCode, { cod: 1, zaincash: 1 }, "payment methods over real orders only");
  assert.equal(h.byHour.length, 24);
  assert.equal(
    h.byHour.reduce((sum, row) => sum + row.count, 0),
    2
  );
  assert.ok(
    h.byHour[10].count >= 1,
    "D-104: yesterday's 10:00 order sits in the 10:00 bar in Baghdad time, not 07:00"
  );
  assert.equal(h.topProducts[0]?.productId, hero.id);
  assert.deepEqual(
    h.mostViewed.map((row) => [row.productId, row.views]),
    [
      [hero.id, 2],
      [scarce.id, 1],
    ]
  );
  assert.equal(h.lowStock.count, 1, "an exact count from the generated column, not a page");
  assert.equal(h.lowStock.products[0].id, scarce.id);
  assert.equal(typeof h.wallet.pendingNetIqd, "number");
  assert.equal(h.recentOrders.length, 3, "the latest orders exclude the till");
  assert.ok(h.recentOrders.every((row) => row.paymentMethodCode !== "cash"));
  summary.home = {
    todaySales: 15000,
    conversion: 50,
    yesterdayConversion: null,
    byHourTotal: 2,
    lowStock: 1,
    recent: 3,
  };

  // ── 4. a bad range is named; the neighbour cannot read it ────────────────
  assert.equal(
    (await get(`/merchant/stores/${slug}/dashboard/home?from=yesterday`, token)).status,
    400
  );
  const otherToken = await createTypedSession("merchant", other.payload.account.id, storeB.id);
  assert.ok(
    [403, 404].includes((await get(`/merchant/stores/${slug}/dashboard/home`, otherToken)).status)
  );
  summary.walls = { badRange: 400, neighbour: "refused" };

  console.log(JSON.stringify({ suite: "merchant-home", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}

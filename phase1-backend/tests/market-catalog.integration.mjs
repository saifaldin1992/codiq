/**
 * Marketplace M2 — the market catalog end to end, over HTTP.
 *
 *   1. Categories: the seeded tree; a category page names its children and the
 *      stores selling in it; a merchant maps his category onto the market's.
 *   2. The merchant's market details: price-before-discount must exceed the
 *      price; specs, tags, condition, pre-order and per-order cap saved; add-ons
 *      replaced; another store's product is a 404.
 *   3. The product list: only listed stores; Arabic search tolerant of spelling
 *      (ايفون / آيفون / أيفون) with a match percentage; every filter (category
 *      with descendants, price range, discount, condition, tag, pre-order,
 *      delivers-to, store, rating) and every sort; keyset paging; a cursor from
 *      another sort refused; a query that normalizes to nothing finds nothing.
 *   4. Best-selling and rating come from the hourly stats job.
 *   5. The product page: images, variants, add-ons, specs, pre-order, category,
 *      and the view counted; a product of an unlisted store is a 404.
 *   6. Search: suggestions (products, stores, categories) and popular terms
 *      only after enough searches.
 *   7. The per-order cap: refused when adding to the cart, and refused at
 *      checkout when the cap was set after the shopper filled his cart.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
process.env.CODIQ_VISIT_FLUSH_MS = "0";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { recomputeProductStats } = await import("../src/modules/market-catalog/stats.service.ts");
const { POPULAR_MIN_SEARCHES } = await import("../src/modules/market-catalog/search.service.ts");

const testId = `m2${Date.now().toString(36)}`;
const suffix = String(Date.now()).slice(-6);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

function browser() {
  const jar = new Map();
  return {
    async request(path, { method = "GET", body, token, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          origin: base,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(jar.size
            ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
      return {
        status: response.status,
        headers: response.headers,
        payload: await response.json().catch(() => null),
      };
    },
  };
}
const api = browser();
const ids = (payload) => payload.products.map((product) => product.id);

const created = [];
try {
  // ── fixtures: three stores, two listed ───────────────────────────────────
  const password = "MarketCatalog!2026Strong";
  const stores = {};
  for (const [key, digit, listed, governorate] of [
    ["a", "4", true, "Baghdad"],
    ["b", "5", true, "Basra"],
    ["c", "6", false, "Baghdad"],
  ]) {
    const email = `${testId}.${key}@codiq.test`;
    const registered = await registerMerchantDirect({
      ownerName: `تاجر ${key}`,
      businessName: `متجر ${key}`,
      phone: `+964771${digit}${suffix}`,
      email,
      password,
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.payload));
    const store = await prisma.store.create({
      data: {
        merchantId: registered.payload.account.id,
        name: `كتالوج ${testId} ${key}`,
        slug: `${testId}-${key}`,
        defaultSubdomain: `${testId}-${key}`,
        ...(listed
          ? { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() }
          : {}),
      },
      select: { id: true, slug: true },
    });
    created.push(store.id);
    await prisma.deliveryRate.create({
      data: { storeId: store.id, governorate, amountIqd: 3000, isEnabled: true },
    });
    const token = (
      await api.request("/auth/merchant/login", {
        method: "POST",
        body: { identifier: email, password },
      })
    ).payload.accessToken;
    stores[key] = { ...store, token };
  }
  const { a, b, c } = stores;
  const phones = await prisma.marketCategory.findUniqueOrThrow({ where: { slug: "phones" } });
  const audio = await prisma.marketCategory.findUniqueOrThrow({ where: { slug: "audio" } });
  const electronics = await prisma.marketCategory.findUniqueOrThrow({
    where: { slug: "electronics" },
  });

  const storeCategory = await prisma.productCategory.create({
    data: { storeId: a.id, name: "موبايلات", normalizedName: `موبايلات-${testId}` },
  });
  const product = (store, data) =>
    prisma.product.create({
      data: {
        storeId: store.id,
        sku: `${testId}-${Math.random().toString(36).slice(2, 8)}`,
        ...data,
      },
    });
  const iphone = await product(a, {
    name: `ايفون 15 برو ${testId}`,
    priceIqd: 1_500_000,
    stockQuantity: 3,
    categoryId: storeCategory.id,
    description: "هاتف ذكي بشاشة 6.1 انش",
  });
  const airpods = await product(a, {
    name: `سماعة ايربودز ${testId}`,
    priceIqd: 250_000,
    stockQuantity: 20,
    compareAtPriceIqd: 500_000,
  });
  const watch = await product(a, {
    name: `ساعة ذكية ${testId}`,
    priceIqd: 400_000,
    stockQuantity: 0,
  });
  const sony = await product(b, {
    name: `سماعة سوني ${testId}`,
    priceIqd: 300_000,
    stockQuantity: 5,
    marketCategoryId: audio.id,
    condition: "used",
  });
  const hidden = await product(c, {
    name: `ايفون مخفي ${testId}`,
    priceIqd: 900_000,
    stockQuantity: 5,
  });
  await prisma.productImage
    .create({
      data: {
        storeId: a.id,
        productId: iphone.id,
        objectKey: `products/${iphone.id}/x.webp`,
        contentType: "image/webp",
        byteSize: 10,
      },
    })
    .catch(() => undefined);

  // ── 1. categories ────────────────────────────────────────────────────────
  const tree = await api.request("/market/categories");
  assert.equal(tree.status, 200);
  const electronicsNode = tree.payload.categories.find((node) => node.slug === "electronics");
  assert.ok(
    electronicsNode.children.some((child) => child.slug === "phones"),
    "a two-level tree"
  );

  const mapped = await api.request(
    `/merchant/stores/${a.slug}/market-catalog/categories/${storeCategory.id}`,
    { method: "PUT", token: a.token, body: { marketCategoryId: phones.id } }
  );
  assert.equal(mapped.status, 200, JSON.stringify(mapped.payload));
  assert.equal(
    (
      await api.request(
        `/merchant/stores/${a.slug}/market-catalog/categories/${storeCategory.id}`,
        { method: "PUT", token: b.token, body: { marketCategoryId: phones.id } }
      )
    ).status === 200,
    false,
    "another merchant cannot map this store's category"
  );
  assert.equal(
    (
      await api.request(
        `/merchant/stores/${a.slug}/market-catalog/categories/${storeCategory.id}`,
        { method: "PUT", token: a.token, body: { marketCategoryId: 999999 } }
      )
    ).status,
    422
  );
  const mappings = await api.request(`/merchant/stores/${a.slug}/market-catalog/categories`, {
    token: a.token,
  });
  assert.equal(
    mappings.payload.categories.find((row) => row.id === storeCategory.id).marketCategoryId,
    phones.id
  );

  const categoryPage = await api.request("/market/categories/electronics");
  assert.equal(categoryPage.status, 200);
  assert.ok(categoryPage.payload.children.some((child) => child.slug === "audio"));
  assert.ok(
    categoryPage.payload.stores.some((store) => store.slug === a.slug) &&
      categoryPage.payload.stores.some((store) => store.slug === b.slug),
    "both selling stores appear"
  );
  assert.ok(
    !categoryPage.payload.stores.some((store) => store.slug === c.slug),
    "an unlisted store never appears"
  );
  assert.equal((await api.request("/market/categories/no-such-category")).status, 404);
  summary.categories = true;

  // ── 2. the merchant's market details ────────────────────────────────────
  const fieldsPath = (store, productId) =>
    `/merchant/stores/${store.slug}/market-catalog/products/${productId}`;
  const fields = {
    marketCategoryId: null,
    compareAtPriceIqd: 1_400_000,
    condition: "new",
    tags: ["warranty", "original", "warranty"],
    specs: [{ name: "الذاكرة", value: "256GB" }],
    isPreorder: false,
    preorderReleaseOn: null,
    preorderShipsBy: null,
    maxPerOrder: 2,
  };
  const belowPrice = await api.request(fieldsPath(a, iphone.id), {
    method: "PUT",
    token: a.token,
    body: fields,
  });
  assert.equal(belowPrice.status, 422);
  assert.equal(belowPrice.payload.error.code, "COMPARE_AT_NOT_ABOVE_PRICE");
  const saved = await api.request(fieldsPath(a, iphone.id), {
    method: "PUT",
    token: a.token,
    body: { ...fields, compareAtPriceIqd: 1_800_000 },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.deepEqual(saved.payload.product.tags, ["warranty", "original"], "duplicate tags collapse");
  assert.equal(
    saved.payload.product.effectiveMarketCategoryId,
    phones.id,
    "filed under its store category's mapping"
  );
  assert.equal(
    (await api.request(fieldsPath(a, sony.id), { method: "PUT", token: a.token, body: fields }))
      .status,
    404,
    "another store's product is a 404"
  );
  const datesWithoutPreorder = await api.request(fieldsPath(a, watch.id), {
    method: "PUT",
    token: a.token,
    body: { ...fields, compareAtPriceIqd: null, maxPerOrder: null, preorderShipsBy: "2030-01-01" },
  });
  assert.equal(datesWithoutPreorder.status, 422, "pre-order dates need a pre-order");
  const preorder = await api.request(fieldsPath(a, watch.id), {
    method: "PUT",
    token: a.token,
    body: {
      ...fields,
      compareAtPriceIqd: null,
      maxPerOrder: null,
      tags: [],
      isPreorder: true,
      preorderReleaseOn: "2030-01-01",
      preorderShipsBy: "2030-01-15",
      marketCategoryId: electronics.id,
    },
  });
  assert.equal(preorder.status, 200, JSON.stringify(preorder.payload));
  const addons = await api.request(`${fieldsPath(a, iphone.id)}/addons`, {
    method: "PUT",
    token: a.token,
    body: {
      addons: [
        { name: "تغليف هدية", priceIqd: 5000 },
        { name: "حافظة", priceIqd: 15000, isActive: false },
      ],
    },
  });
  assert.equal(addons.status, 200, JSON.stringify(addons.payload));
  assert.equal(addons.payload.product.addons.length, 2);
  const merchantList = await api.request(
    `/merchant/stores/${a.slug}/market-catalog/products?limit=2`,
    { token: a.token }
  );
  assert.equal(merchantList.payload.products.length, 2);
  assert.ok(merchantList.payload.nextCursor, "the merchant's list pages");
  summary.merchantFields = true;

  // ── 3. the product list ─────────────────────────────────────────────────
  const list = async (query) => {
    const result = await api.request(`/market/products?${query}`);
    assert.equal(result.status, 200, `${query}: ${JSON.stringify(result.payload)}`);
    return result.payload;
  };
  const mine = (payload) =>
    ids(payload).filter((id) => [iphone.id, airpods.id, watch.id, sony.id, hidden.id].includes(id));

  for (const spelling of ["ايفون", "آيفون", "أيفون"]) {
    const found = await list(`q=${encodeURIComponent(`${spelling} ${testId}`)}`);
    assert.ok(ids(found).includes(iphone.id), `«${spelling}» finds the iPhone`);
    assert.ok(!ids(found).includes(hidden.id), "an unlisted store's product is never found");
  }
  const typo = await list(`q=${encodeURIComponent("ايفوون")}&store=${a.slug}`);
  assert.ok(ids(typo).includes(iphone.id), "a one-letter typo still finds it");
  assert.ok(typo.products[0].matchPercent > 0 && typo.products[0].matchPercent <= 100);
  const byDescription = await list(`q=${encodeURIComponent("بشاشة")}&store=${a.slug}`);
  assert.deepEqual(mine(byDescription), [iphone.id], "the description is searched too");
  assert.deepEqual(
    (await list(`q=${encodeURIComponent("ًٌٍ")}`)).products,
    [],
    "a query of harakat only finds nothing"
  );

  assert.deepEqual(
    mine(await list(`category=phones&store=${a.slug}`)),
    [iphone.id],
    "category via the store mapping"
  );
  assert.deepEqual(
    mine(await list(`category=electronics&q=${testId}`)).sort(),
    [iphone.id, watch.id, sony.id].sort(),
    "a parent category includes its children"
  );
  assert.deepEqual(
    mine(await list(`minPrice=260000&maxPrice=450000&q=${testId}`)).sort(),
    [watch.id, sony.id].sort(),
    "price range"
  );
  assert.equal(
    (await api.request("/market/products?minPrice=5&maxPrice=1")).status,
    422,
    "min above max is refused"
  );
  assert.deepEqual(mine(await list(`discount=50&q=${testId}`)), [airpods.id], "+50%");
  assert.deepEqual(
    mine(await list(`discount=any&q=${testId}`)).sort(),
    [iphone.id, airpods.id].sort(),
    "any discount"
  );
  assert.deepEqual(mine(await list(`condition=used&q=${testId}`)), [sony.id]);
  assert.deepEqual(mine(await list(`tag=warranty&q=${testId}`)), [iphone.id]);
  assert.deepEqual(mine(await list(`preorder=1&q=${testId}`)), [watch.id]);
  assert.deepEqual(
    mine(await list(`deliverTo=Basra&q=${testId}`)),
    [sony.id],
    "only stores that deliver to Basra"
  );
  assert.deepEqual(
    mine(await list(`deliverTo=${encodeURIComponent("البصرة")}&q=${testId}`)),
    [sony.id],
    "the Arabic name works too"
  );

  const cheapest = mine(await list(`sort=price_asc&q=${testId}`));
  assert.deepEqual(cheapest, [airpods.id, sony.id, watch.id, iphone.id], "cheapest first");
  assert.deepEqual(mine(await list(`sort=price_desc&q=${testId}`)), [...cheapest].reverse());
  assert.equal(
    mine(await list(`sort=discount&q=${testId}`))[0],
    airpods.id,
    "deepest discount first"
  );
  assert.equal(mine(await list(`sort=newest&q=${testId}`))[0], sony.id, "newest first");

  const card = (await list(`q=${encodeURIComponent(`ايفون ${testId}`)}`)).products.find(
    (row) => row.id === iphone.id
  );
  assert.equal(card.compareAtPriceIqd, 1_800_000);
  assert.equal(card.discountPercent, 17);
  assert.equal(card.sellsFast, true, "three left: «ينفد قريباً»");
  assert.equal(card.store.slug, a.slug);
  const watchCard = (await list(`preorder=1&q=${testId}`)).products[0];
  assert.equal(watchCard.isAvailable, true, "a pre-order is orderable with no stock");

  // Keyset paging across four products, one per page, then the end.
  const seen = [];
  let cursor = null;
  for (let pageNo = 0; pageNo < 10; pageNo += 1) {
    const page = await list(
      `sort=price_asc&limit=1&q=${testId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    seen.push(...ids(page));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, cheapest, "paging walks the same order without repeats");
  const first = await list(`sort=price_asc&limit=1&q=${testId}`);
  assert.equal(
    (
      await api.request(
        `/market/products?sort=newest&cursor=${encodeURIComponent(first.nextCursor)}`
      )
    ).status,
    400,
    "a «price» cursor is refused by «newest»"
  );
  summary.productList = true;

  // ── 4. stats: best-selling and rating ───────────────────────────────────
  const order = await prisma.storeOrder.create({
    data: {
      storeId: b.id,
      orderNumber: `${testId}-o1`,
      status: "completed",
      source: "storefront",
      customerName: "زبون",
      paymentMethodCode: "cod",
      subtotalIqd: 900000,
      deliveryFeeIqd: 0,
      totalIqd: 900000,
    },
  });
  await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId: sony.id,
      productName: "سماعة سوني",
      quantity: 3,
      unitPriceIqd: 300000,
      lineTotalIqd: 900000,
    },
  });
  const cancelled = await prisma.storeOrder.create({
    data: {
      storeId: a.id,
      orderNumber: `${testId}-o2`,
      status: "cancelled",
      source: "storefront",
      customerName: "زبون",
      paymentMethodCode: "cod",
      subtotalIqd: 1,
      deliveryFeeIqd: 0,
      totalIqd: 1,
    },
  });
  await prisma.orderItem.create({
    data: {
      orderId: cancelled.id,
      productId: airpods.id,
      productName: "سماعة",
      quantity: 50,
      unitPriceIqd: 1,
      lineTotalIqd: 50,
    },
  });
  await recomputeProductStats([a.id, b.id]);
  assert.equal(
    mine(await list(`sort=best_selling&period=day&q=${testId}`))[0],
    sony.id,
    "units sold, cancelled orders not counted"
  );
  const sonyStats = await prisma.productMarketStats.findUniqueOrThrow({
    where: { productId: sony.id },
  });
  assert.equal(sonyStats.sold1d, 3);
  assert.equal(
    (await prisma.productMarketStats.findUniqueOrThrow({ where: { productId: airpods.id } }))
      .sold30d,
    0
  );
  summary.stats = true;

  // ── 5. the product page ─────────────────────────────────────────────────
  const page = await api.request(`/market/products/${iphone.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.payload));
  const shown = page.payload.product;
  assert.deepEqual(shown.specs, [{ name: "الذاكرة", value: "256GB" }]);
  assert.deepEqual(
    shown.addons.map((addon) => addon.name),
    ["تغليف هدية"],
    "inactive add-ons are not offered"
  );
  assert.equal(shown.category.slug, "phones");
  assert.equal(shown.maxPerOrder, 2);
  assert.equal(shown.variants.length, 1);
  assert.equal(shown.storefrontPath, `/store/${a.slug}/products/${iphone.id}`);
  const watchPage = await api.request(`/market/products/${watch.id}`);
  assert.deepEqual(watchPage.payload.product.preorder, {
    releaseOn: "2030-01-01",
    shipsBy: "2030-01-15",
  });
  assert.equal(
    (await api.request(`/market/products/${hidden.id}`)).status,
    404,
    "an unlisted store's product page is a 404"
  );
  assert.equal((await api.request("/market/products/not-a-uuid")).status, 404);
  const views = await prisma.productViewDaily.findMany({ where: { productId: iphone.id } });
  assert.ok(
    views.reduce((sum, row) => sum + row.views, 0) >= 1,
    "the view is counted for the merchant"
  );
  summary.productPage = true;

  // ── 6. search helpers ───────────────────────────────────────────────────
  const suggest = await api.request(`/market/search/suggest?q=${encodeURIComponent("سماعة")}`);
  assert.equal(suggest.status, 200);
  assert.ok(suggest.payload.products.length >= 1);
  assert.ok(
    suggest.payload.categories.some((category) => category.slug === "audio"),
    "«سماعة» suggests «سمّاعات وصوتيّات»"
  );
  const term = `نادر${testId}`;
  // Earlier runs of this suite leave terms carrying their own run id ("m2…"), which
  // would crowd the top ten; only those are removed.
  await prisma.$executeRaw`DELETE FROM market_search_terms WHERE term ~ 'm2[0-9a-z]{6,}' AND term NOT LIKE ${`%${testId}%`}`;
  for (let n = 1; n <= POPULAR_MIN_SEARCHES; n += 1) {
    await list(`q=${encodeURIComponent(term)}`);
    const popular = (await api.request("/market/search/popular")).payload.terms;
    assert.equal(
      popular.includes(term),
      n >= POPULAR_MIN_SEARCHES,
      `after ${n} search(es) the term is ${n >= POPULAR_MIN_SEARCHES ? "" : "not "}popular`
    );
  }
  summary.search = true;

  // ── 7. the per-order cap ────────────────────────────────────────────────
  const shopper = browser();
  const tooMany = await shopper.request(`/store/${a.slug}/cart/items`, {
    method: "POST",
    body: { productId: iphone.id, quantity: 3 },
  });
  assert.equal(tooMany.status, 422);
  assert.equal(tooMany.payload.error.code, "ORDER_LIMIT_EXCEEDED");
  const two = await shopper.request(`/store/${a.slug}/cart/items`, {
    method: "POST",
    body: { productId: iphone.id, quantity: 2 },
  });
  assert.equal(two.status, 200, JSON.stringify(two.payload));
  assert.equal(
    (
      await shopper.request(`/store/${a.slug}/cart/items`, {
        method: "POST",
        body: { productId: iphone.id, quantity: 1 },
      })
    ).payload.error.code,
    "ORDER_LIMIT_EXCEEDED",
    "the cap counts what is already in the cart"
  );
  // The merchant lowers the cap after the cart was filled: checkout refuses and names the line.
  await prisma.product.update({ where: { id: iphone.id }, data: { maxPerOrder: 1 } });
  const checkout = await shopper.request(`/store/${a.slug}/checkout/guest`, {
    method: "POST",
    headers: { "idempotency-key": `${testId}-order-limit-key` },
    body: {
      cartVersion: two.payload.cart.version,
      fullName: "متسوّق",
      phone: "07712345670",
      address: {
        recipientName: "متسوّق",
        fullAddress: "الكاظمية، شارع ١",
        city: "بغداد",
        governorate: "Baghdad",
        phoneContact: "07712345670",
      },
      paymentMethodCode: "cod",
    },
  });
  assert.equal(checkout.status, 422, JSON.stringify(checkout.payload));
  assert.equal(checkout.payload.error.code, "ORDER_LIMIT_EXCEEDED");
  assert.equal(checkout.payload.error.lines[0].reason, "order_limit");
  assert.equal(checkout.payload.error.lines[0].available, 1);
  summary.orderLimit = true;

  console.log(JSON.stringify({ suite: "market-catalog", ok: true, summary }, null, 2));
} finally {
  if (created.length)
    await prisma.store
      .updateMany({
        where: { id: { in: created } },
        data: { marketStatus: "unlisted", marketStatusAt: new Date() },
      })
      .catch(() => undefined);
  server.close();
  await prisma.$disconnect();
}

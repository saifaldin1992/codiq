/**
 * Marketplace M3 — the owner's market content, end to end over HTTP.
 *
 *   1. Banners: validated (a link names its target, a known section, a sane
 *      window), live by the clock (a future one is not shown), counted (views
 *      and taps, origin-checked), and the owner's alone.
 *   2. Collections: a unique slug, products set in order (unknown ones refused
 *      by id), only live collections public, and their products only from
 *      stores in the market.
 *   3. Malls: stores set by slug, only listed stores shown, and the mall as a
 *      product filter.
 *   4. The front page: the seeded layout, a strict per-kind config, the order
 *      the owner saves is the order shoppers get, banners and collections
 *      resolved in one answer.
 *   5. The category tree: two levels enforced in words, a new category, a
 *      hidden one leaves the public tree.
 *   6. New product filters: explicit ids, «related to», «sells fast».
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { forgetMarketCategories } = await import(
  "../src/modules/market-catalog/categories.service.ts"
);

const testId = `m3${Date.now().toString(36)}`;
const suffix = String(Date.now()).slice(-6);
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

async function request(path, { method = "GET", body, token, origin = base } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

const created = { stores: [], banners: [], collections: [], malls: [], categories: [] };
let originalSections = null;
try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  const ownerEmail = `${testId}.owner@codiq.test`;
  assert.ok(
    [200, 201].includes(
      (
        await request("/auth/platform/register", {
          method: "POST",
          body: { email: ownerEmail, password: "OwnerPass123!Strong", displayName: "مالك" },
        })
      ).status
    )
  );
  const ownerToken = (
    await request("/auth/platform/login", {
      method: "POST",
      body: { email: ownerEmail, password: "OwnerPass123!Strong" },
    })
  ).payload.accessToken;
  const merchantEmail = `${testId}.m@codiq.test`;
  const registered = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+964772${suffix}1`.slice(0, 14),
    email: merchantEmail,
    password: "MarketHome!2026Strong",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const merchantToken = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: merchantEmail, password: "MarketHome!2026Strong" },
    })
  ).payload.accessToken;
  const merchantId = registered.payload.account.id;
  const listed = await prisma.store.create({
    data: {
      merchantId,
      name: `رئيسية ${testId} أ`,
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  const unlisted = await prisma.store.create({
    data: {
      merchantId,
      name: `رئيسية ${testId} ب`,
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  created.stores.push(listed.id, unlisted.id);
  const phones = await prisma.marketCategory.findUniqueOrThrow({ where: { slug: "phones" } });
  const p1 = await prisma.product.create({
    data: {
      storeId: listed.id,
      sku: `${testId}-1`,
      name: `هاتف ${testId}`,
      priceIqd: 100000,
      stockQuantity: 2,
      marketCategoryId: phones.id,
    },
  });
  const p2 = await prisma.product.create({
    data: {
      storeId: listed.id,
      sku: `${testId}-2`,
      name: `هاتف آخر ${testId}`,
      priceIqd: 200000,
      stockQuantity: 50,
      marketCategoryId: phones.id,
    },
  });
  const p3 = await prisma.product.create({
    data: {
      storeId: unlisted.id,
      sku: `${testId}-3`,
      name: `مخفي ${testId}`,
      priceIqd: 300000,
      stockQuantity: 5,
    },
  });

  // ── 1. banners ───────────────────────────────────────────────────────────
  const banner = (extra) => ({
    placement: "home_hero",
    title: `بنر ${testId}`,
    subtitle: null,
    linkKind: "store",
    linkTarget: listed.slug,
    startsAt: null,
    endsAt: null,
    sortOrder: 0,
    isActive: true,
    isAd: false,
    ...extra,
  });
  assert.ok(
    [401, 403].includes(
      (
        await request("/platform/market/banners", {
          method: "POST",
          token: merchantToken,
          body: banner({}),
        })
      ).status
    ),
    "a merchant cannot edit the market's banners"
  );
  assert.equal(
    (
      await request("/platform/market/banners", {
        method: "POST",
        token: ownerToken,
        body: banner({ linkKind: "none" }),
      })
    ).status,
    422,
    "«no link» with a target"
  );
  assert.equal(
    (
      await request("/platform/market/banners", {
        method: "POST",
        token: ownerToken,
        body: banner({ linkKind: "section", linkTarget: "nonsense" }),
      })
    ).status,
    422,
    "an unknown section"
  );
  assert.equal(
    (
      await request("/platform/market/banners", {
        method: "POST",
        token: ownerToken,
        body: banner({ startsAt: "2030-02-01T00:00:00Z", endsAt: "2030-01-01T00:00:00Z" }),
      })
    ).status,
    422,
    "an inverted window"
  );
  const now = await request("/platform/market/banners", {
    method: "POST",
    token: ownerToken,
    body: banner({}),
  });
  assert.equal(now.status, 201, JSON.stringify(now.payload));
  const later = await request("/platform/market/banners", {
    method: "POST",
    token: ownerToken,
    body: banner({
      title: `لاحق ${testId}`,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  });
  created.banners.push(now.payload.banner.id, later.payload.banner.id);

  const home = await request("/market/home");
  assert.equal(home.status, 200);
  const hero = home.payload.sections.find(
    (section) => section.kind === "banners" && section.config.placement === "home_hero"
  );
  assert.ok(
    hero.banners.some((row) => row.id === now.payload.banner.id),
    "a live banner is on the front page"
  );
  assert.ok(
    !hero.banners.some((row) => row.id === later.payload.banner.id),
    "a banner scheduled for tomorrow is not"
  );
  assert.deepEqual(hero.banners.find((row) => row.id === now.payload.banner.id).link, {
    kind: "store",
    target: listed.slug,
  });

  assert.equal(
    (
      await request(`/market/banners/${now.payload.banner.id}/events`, {
        method: "POST",
        body: { kind: "view" },
      })
    ).status,
    200
  );
  assert.equal(
    (
      await request(`/market/banners/${now.payload.banner.id}/events`, {
        method: "POST",
        body: { kind: "click" },
      })
    ).status,
    200
  );
  assert.equal(
    (
      await request(`/market/banners/${now.payload.banner.id}/events`, {
        method: "POST",
        body: { kind: "view" },
        origin: "https://evil.example",
      })
    ).status,
    403,
    "a foreign page cannot inflate the numbers"
  );
  assert.equal(
    (
      await request(`/market/banners/${now.payload.banner.id}/events`, {
        method: "POST",
        body: { kind: "like" },
      })
    ).status,
    422
  );
  const counted = await prisma.marketBanner.findUniqueOrThrow({
    where: { id: now.payload.banner.id },
  });
  assert.deepEqual([counted.views, counted.clicks], [1, 1]);
  summary.banners = true;

  // ── 2. collections ──────────────────────────────────────────────────────
  const collection = (extra) => ({
    slug: `${testId}-picks`,
    kind: "discount",
    title: "خصومات الهواتف",
    subtitle: null,
    headlineDiscountPercent: 40,
    startsAt: null,
    endsAt: null,
    sortOrder: 0,
    isActive: true,
    ...extra,
  });
  const made = await request("/platform/market/collections", {
    method: "POST",
    token: ownerToken,
    body: collection({}),
  });
  assert.equal(made.status, 201, JSON.stringify(made.payload));
  created.collections.push(made.payload.collection.id);
  assert.equal(
    (
      await request("/platform/market/collections", {
        method: "POST",
        token: ownerToken,
        body: collection({}),
      })
    ).status,
    409,
    "a slug is unique"
  );
  const unknown = await request(
    `/platform/market/collections/${made.payload.collection.id}/items`,
    {
      method: "PUT",
      token: ownerToken,
      body: { productIds: [p1.id, "00000000-0000-4000-8000-000000000000"] },
    }
  );
  assert.equal(unknown.status, 422);
  assert.deepEqual(
    unknown.payload.error.productIds,
    ["00000000-0000-4000-8000-000000000000"],
    "the refusal names the unknown product"
  );
  const items = await request(`/platform/market/collections/${made.payload.collection.id}/items`, {
    method: "PUT",
    token: ownerToken,
    body: { productIds: [p2.id, p1.id, p3.id] },
  });
  assert.equal(items.status, 200, JSON.stringify(items.payload));
  assert.deepEqual(
    items.payload.collection.items.map((item) => item.productId),
    [p2.id, p1.id, p3.id],
    "kept in the owner's order"
  );
  const publicCollection = await request(`/market/collections/${testId}-picks`);
  assert.equal(publicCollection.status, 200);
  assert.equal(publicCollection.payload.collection.headlineDiscountPercent, 40);
  const inCollection = await request(`/market/products?collection=${testId}-picks`);
  assert.deepEqual(
    inCollection.payload.products.map((row) => row.id).sort(),
    [p1.id, p2.id].sort(),
    "a product of a store outside the market is never shown"
  );
  await request(`/platform/market/collections/${made.payload.collection.id}`, {
    method: "PUT",
    token: ownerToken,
    body: collection({
      endsAt: new Date(Date.now() - 60_000).toISOString(),
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
    }),
  });
  assert.equal(
    (await request(`/market/collections/${testId}-picks`)).status,
    404,
    "an ended collection is gone"
  );
  assert.deepEqual(
    (await request(`/market/products?collection=${testId}-picks`)).payload.products,
    [],
    "and so are its products"
  );
  await request(`/platform/market/collections/${made.payload.collection.id}`, {
    method: "PUT",
    token: ownerToken,
    body: collection({}),
  });
  summary.collections = true;

  // ── 3. malls ────────────────────────────────────────────────────────────
  const mall = await request("/platform/market/malls", {
    method: "POST",
    token: ownerToken,
    body: {
      slug: `${testId}-mall`,
      name: "مول الإلكترونيات",
      description: null,
      sortOrder: 0,
      isActive: true,
    },
  });
  assert.equal(mall.status, 201, JSON.stringify(mall.payload));
  created.malls.push(mall.payload.mall.id);
  assert.equal(
    (
      await request(`/platform/market/malls/${mall.payload.mall.id}/stores`, {
        method: "PUT",
        token: ownerToken,
        body: { storeSlugs: ["no-such-store-anywhere"] },
      })
    ).status,
    422
  );
  const members = await request(`/platform/market/malls/${mall.payload.mall.id}/stores`, {
    method: "PUT",
    token: ownerToken,
    body: { storeSlugs: [listed.slug, unlisted.slug] },
  });
  assert.equal(members.status, 200);
  assert.deepEqual(
    members.payload.mall.stores.map((store) => store.listed),
    [true, false],
    "the owner sees which members are not in the market"
  );
  const mallPage = await request(`/market/malls/${testId}-mall`);
  assert.equal(mallPage.status, 200);
  assert.deepEqual(
    mallPage.payload.stores.map((store) => store.slug),
    [listed.slug],
    "only listed stores are shown"
  );
  assert.deepEqual(
    (await request(`/market/products?mall=${testId}-mall`)).payload.products
      .map((row) => row.id)
      .sort(),
    [p1.id, p2.id].sort()
  );
  summary.malls = true;

  // ── 4. the front page ───────────────────────────────────────────────────
  originalSections = (await request("/platform/market/home-sections", { token: ownerToken }))
    .payload.sections;
  assert.ok(originalSections.length >= 10, "the seeded layout");
  assert.equal(
    (
      await request("/platform/market/home-sections", {
        method: "PUT",
        token: ownerToken,
        body: {
          sections: [
            { kind: "products", title: "x", isActive: true, config: { sort: "newest", sneaky: 1 } },
          ],
        },
      })
    ).status,
    422,
    "a config carries only its kind's keys"
  );
  const layout = [
    { kind: "collections", title: "مجموعات", isActive: true, config: {} },
    { kind: "banners", title: null, isActive: true, config: { placement: "home_hero" } },
    {
      kind: "products",
      title: "تخفيضات",
      isActive: true,
      config: { sort: "discount", discount: "any", section: "discounts" },
    },
    { kind: "malls", title: "المولات", isActive: true, config: {} },
    { kind: "for_you", title: "مقترح لك", isActive: false, config: {} },
  ];
  assert.equal(
    (
      await request("/platform/market/home-sections", {
        method: "PUT",
        token: ownerToken,
        body: { sections: layout },
      })
    ).status,
    200
  );
  const page = (await request("/market/home")).payload.sections;
  assert.deepEqual(
    page.map((section) => section.kind),
    ["collections", "banners", "products", "malls"],
    "the owner's order; an inactive block is not served"
  );
  assert.ok(
    page[0].collections.some((row) => row.slug === `${testId}-picks`),
    "collections resolved in the same answer"
  );
  const shownMall = page[3].malls.find((row) => row.slug === `${testId}-mall`);
  assert.equal(shownMall.stores, 1, "a mall counts only its listed stores");
  assert.deepEqual(
    shownMall.logos.map((logo) => logo.slug),
    [listed.slug]
  );
  summary.home = true;

  // ── 5. the category tree ────────────────────────────────────────────────
  assert.equal(
    (
      await request("/platform/market/categories", {
        method: "POST",
        token: ownerToken,
        body: { slug: `${testId}-x`, name: "تحت فرعيّة", parentId: phones.id, sortOrder: 0 },
      })
    ).status,
    422,
    "no third level"
  );
  const root = await request("/platform/market/categories", {
    method: "POST",
    token: ownerToken,
    body: { slug: `${testId}-pets`, name: "الحيوانات الأليفة", parentId: null, sortOrder: 99 },
  });
  assert.equal(root.status, 201, JSON.stringify(root.payload));
  created.categories.push(root.payload.categoryId);
  assert.ok(
    (await request("/market/categories")).payload.categories.some(
      (node) => node.slug === `${testId}-pets`
    )
  );
  assert.equal(
    (
      await request(`/platform/market/categories/${root.payload.categoryId}`, {
        method: "PUT",
        token: ownerToken,
        body: { name: "الحيوانات الأليفة", parentId: null, sortOrder: 99, isActive: false },
      })
    ).status,
    200
  );
  forgetMarketCategories();
  assert.ok(
    !(await request("/market/categories")).payload.categories.some(
      (node) => node.slug === `${testId}-pets`
    ),
    "a hidden category leaves the public tree"
  );
  summary.categories = true;

  // ── 6. new product filters ──────────────────────────────────────────────
  assert.deepEqual(
    (await request(`/market/products?ids=${p1.id},${p3.id}`)).payload.products.map((row) => row.id),
    [p1.id],
    "explicit ids, market-visible only"
  );
  assert.equal((await request(`/market/products?ids=${p1.id},nope`)).status, 422);
  const related = (
    await request(`/market/products?relatedTo=${p1.id}&store=${listed.slug}`)
  ).payload.products.map((row) => row.id);
  assert.deepEqual(related, [p2.id], "same category, not itself");
  assert.deepEqual(
    (await request(`/market/products?sellsFast=1&store=${listed.slug}`)).payload.products.map(
      (row) => row.id
    ),
    [p1.id],
    "two left: running out"
  );
  summary.filters = true;

  console.log(JSON.stringify({ suite: "market-home", ok: true, summary }, null, 2));
} finally {
  if (originalSections) {
    await prisma.marketHomeSection.deleteMany({});
    await prisma.marketHomeSection.createMany({
      data: originalSections.map((section) => ({
        kind: section.kind,
        title: section.title,
        config: section.config,
        isActive: section.isActive,
        position: section.position,
      })),
    });
  }
  await prisma.marketBanner.deleteMany({ where: { id: { in: created.banners } } });
  await prisma.marketCollection.deleteMany({ where: { id: { in: created.collections } } });
  await prisma.marketMall.deleteMany({ where: { id: { in: created.malls } } });
  await prisma.marketCategory.deleteMany({ where: { id: { in: created.categories } } });
  await prisma.store.updateMany({
    where: { id: { in: created.stores } },
    data: { marketStatus: "unlisted", marketStatusAt: new Date() },
  });
  server.close();
  await prisma.$disconnect();
}

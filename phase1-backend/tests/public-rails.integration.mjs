/**
 * ق-200 — the storefront's front-page rails are orderings of ONE list.
 *
 * «الأكثر مبيعاً» ranks by units in real, platform-carried orders — a
 * cancelled order is not a sale and a counter sale never had a storefront;
 * «الأعلى تقييماً» ranks by average rating with withdrawn reviews gone and
 * hidden ones still counting; both re-read their ids through the same card
 * projection as the catalog, and each has a cursor kind of its own. Beside
 * them: the store-wide public review feed that shows only what a shopper may
 * see, same-category «عناصر قد تعجبك», and the three small facts the cards and
 * the product page gained (createdAt, the parent category, the star summary).
 *
 * Run: pnpm public:rails
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `rails-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function get(path) {
  const response = await fetch(`${base}${path}`);
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
    businessName: "متجر السكك",
    phone: `+96470${suffix}`,
    email: `${testId}.merchant@codiq.test`,
    password: "RailsMerchant!2026",
  });
  assert.equal(merchant.status, 201, JSON.stringify(merchant.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر السكك",
      slug: `${testId}-s`,
      defaultSubdomain: `${testId}-s`,
    },
  });
  const slug = store.slug;

  // ── a two-level tree, five products, two shoppers ─────────────────────────
  const root = await prisma.productCategory.create({
    data: { storeId: store.id, name: "عطور", normalizedName: "عطور" },
  });
  const child = await prisma.productCategory.create({
    data: { storeId: store.id, name: "رجالي", normalizedName: "رجالي", parentCategoryId: root.id },
  });
  const product = async (sku, name, categoryId, stockQuantity, priceIqd) => {
    const row = await prisma.product.create({
      data: {
        storeId: store.id,
        sku,
        name,
        priceIqd,
        stockQuantity,
        lowStockThreshold: 0,
        categoryId,
      },
    });
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { productId: row.id, isDefault: true },
    });
    return { ...row, variantId: variant.id };
  };
  const A = await product("R-A", "ألف — عود ملكي", child.id, 20, 40000);
  const B = await product("R-B", "باء — مسك أبيض", child.id, 20, 30000);
  const C = await product("R-C", "جيم — عنبر", root.id, 20, 20000);
  const D = await product("R-D", "دال — بلا تصنيف", null, 20, 10000);
  const E = await product("R-E", "هاء — نفد", child.id, 0, 15000);
  const shopper = await prisma.customer.create({
    data: {
      storeId: store.id,
      fullName: "زبونة الأولى",
      passwordHash: "not-a-real-hash",
      phoneNormalized: `+96477${suffix}`,
      isGuest: false,
    },
  });
  const other = await prisma.customer.create({
    data: {
      storeId: store.id,
      fullName: "سامر الثاني",
      passwordHash: "not-a-real-hash",
      phoneNormalized: `+96478${suffix}`,
      isGuest: false,
    },
  });

  let seq = 0;
  const order = async (customerId, status, source, lines) => {
    seq += 1;
    const subtotal = lines.reduce((sum, [p, qty]) => sum + p.priceIqd * qty, 0);
    return prisma.storeOrder.create({
      data: {
        storeId: store.id,
        customerId,
        orderNumber: `${testId}-${seq}`,
        status,
        source,
        customerName: "زبون",
        paymentMethodCode: "cod",
        subtotalIqd: subtotal,
        deliveryFeeIqd: 0,
        totalIqd: subtotal,
        items: {
          create: lines.map(([p, quantity]) => ({
            productId: p.id,
            variantId: p.variantId,
            productName: p.name,
            quantity,
            unitPriceIqd: p.priceIqd,
            lineTotalIqd: p.priceIqd * quantity,
          })),
        },
      },
      select: { id: true },
    });
  };
  const o1 = await order(shopper.id, "new", "storefront", [
    [A, 5],
    [B, 1],
  ]);
  const o2 = await order(other.id, "completed", "storefront", [
    [B, 2],
    [C, 1],
  ]);
  await order(shopper.id, "cancelled", "storefront", [[C, 50]]); // not a sale
  await order(other.id, "completed", "pos", [[D, 99]]); // a counter sale never had a storefront

  const review = (productId, customerId, orderId, rating, body, extra = {}) =>
    prisma.productReview.create({
      data: { storeId: store.id, productId, customerId, orderId, rating, body, ...extra },
    });
  await review(A.id, shopper.id, o1.id, 5, "رائحة تدوم يوماً كاملاً");
  await review(A.id, other.id, o2.id, 4, "جميل لكن العلبة وصلت مخدوشة");
  await review(B.id, other.id, o2.id, 5, "أفضل مسك جرّبته");
  await review(C.id, other.id, o2.id, 3, "عادي");
  await review(D.id, shopper.id, o1.id, 5, "سُحب", { withdrawnAt: new Date() }); // gone entirely
  await review(E.id, shopper.id, o1.id, 4, "نص مخفي", {
    hiddenAt: new Date(),
    hiddenReason: "لغة غير لائقة",
  }); // text hidden, rating counts

  // ── 1. best-selling: units in real, platform-carried orders ──────────────
  const best = await get(`/store/${slug}/products?sort=best_selling`);
  assert.equal(best.status, 200, JSON.stringify(best.payload));
  assert.deepEqual(
    best.payload.products.map((p) => p.sku),
    ["R-A", "R-B", "R-C"],
    "ق-200: A sold 5, B sold 3, C sold 1 — the cancelled 50 and the counter's 99 are not sales"
  );
  assert.ok(
    best.payload.products.every((p) => typeof p.createdAt === "string"),
    "every card carries createdAt for the «جديد» badge"
  );
  assert.equal(
    best.payload.products[0].category.parentCategoryId,
    root.id,
    "…and its category carries the parent, for a breadcrumb"
  );
  assert.deepEqual(
    (
      await get(`/store/${slug}/products?sort=best_selling&categoryId=${root.id}`)
    ).payload.products.map((p) => p.sku),
    ["R-A", "R-B", "R-C"],
    "a parent category rolls its children up"
  );
  assert.deepEqual(
    (
      await get(`/store/${slug}/products?sort=best_selling&categoryId=${child.id}`)
    ).payload.products.map((p) => p.sku),
    ["R-A", "R-B"]
  );
  summary.bestSelling = ["R-A", "R-B", "R-C"];

  // ── 2. top-rated: average, withdrawn gone, hidden still counted ──────────
  const rated = await get(`/store/${slug}/products?sort=top_rated`);
  assert.equal(rated.status, 200, JSON.stringify(rated.payload));
  assert.deepEqual(
    rated.payload.products.map((p) => p.sku),
    ["R-B", "R-A", "R-E", "R-C"],
    "ق-200 (D-98): B 5.0, A 4.5, E 4.0 (hidden text, rating counts), C 3.0 — D's withdrawn review never existed"
  );
  summary.topRated = ["R-B", "R-A", "R-E", "R-C"];

  // ── 3. a wrong sort is named; a cursor cannot cross rails ────────────────
  const bogus = await get(`/store/${slug}/products?sort=cheapest`);
  assert.equal(bogus.status, 422);
  assert.equal(bogus.payload.error.code, "INVALID_PRODUCT_SORT");
  const page1 = await get(`/store/${slug}/products?sort=best_selling&limit=1`);
  assert.equal(page1.payload.products[0].sku, "R-A");
  assert.ok(page1.payload.nextCursor, "there is a second page");
  const crossed = await get(
    `/store/${slug}/products?cursor=${encodeURIComponent(page1.payload.nextCursor)}`
  );
  assert.ok(
    [400, 422].includes(crossed.status),
    `ق-200: a best-selling cursor does not page the newest list — it would silently return the wrong page (got ${crossed.status})`
  );
  assert.equal(crossed.payload.error.code, "INVALID_CURSOR");
  const page2 = await get(
    `/store/${slug}/products?sort=best_selling&limit=1&cursor=${encodeURIComponent(page1.payload.nextCursor)}`
  );
  assert.equal(page2.payload.products[0].sku, "R-B", "…and pages its own rail");
  summary.cursors = { bogusSort: 422, crossed: 422, ownRail: "R-B" };

  // ── 4. the store-wide review feed shows only what a shopper may see ──────
  const feed = await get(`/store/${slug}/reviews`);
  assert.equal(feed.status, 200, JSON.stringify(feed.payload));
  assert.deepEqual(
    feed.payload.reviews.map((r) => [r.product.id, r.rating]).sort(),
    [
      [A.id, 4],
      [A.id, 5],
      [B.id, 5],
    ].sort(),
    "ق-200: 4★+ with text; the 3★, the withdrawn and the hidden are not testimonials"
  );
  assert.ok(
    feed.payload.reviews.every((r) => r.author === "زبونة" || r.author === "سامر"),
    "first names only"
  );
  assert.ok(feed.payload.reviews.every((r) => typeof r.body === "string" && r.body.length > 0));
  summary.reviewFeed = feed.payload.reviews.length;

  // ── 5. «عناصر قد تعجبك» — same category, buyable, never itself ────────────
  const relatedA = await get(`/store/${slug}/products/${A.id}/related`);
  assert.equal(relatedA.status, 200, JSON.stringify(relatedA.payload));
  assert.deepEqual(
    relatedA.payload.related.map((r) => r.productId),
    [B.id],
    "A's category is «رجالي»: B is there, E is out of stock, A is itself"
  );
  const relatedC = await get(`/store/${slug}/products/${C.id}/related`);
  assert.deepEqual(
    relatedC.payload.related.map((r) => r.productId).sort(),
    [A.id, B.id].sort(),
    "C sits in the parent: the children roll up"
  );
  assert.deepEqual(
    (await get(`/store/${slug}/products/${D.id}/related`)).payload.related,
    [],
    "no category, no siblings — an empty list, not an error"
  );
  summary.related = { A: 1, C: 2, D: 0 };

  // ── 6. the product page gets its star row on the same fetch ─────────────
  const detail = await get(`/store/${slug}/products/${A.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.deepEqual(
    detail.payload.product.rating,
    { average: 4.5, count: 2 },
    "ق-200: the summary rides the product fetch — no second round trip above the fold"
  );
  assert.equal(typeof detail.payload.product.createdAt, "string");
  assert.deepEqual(
    detail.payload.product.attributes,
    [],
    "ق-199: typed attributes reach the shopper (empty until the merchant writes them)"
  );

  // ── 7. a cart line carries its product's cover image key ─────────────────
  const added = await fetch(`${base}/store/${slug}/cart/items`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ productId: A.id, quantity: 1 }),
  });
  assert.equal(added.status, 200);
  const cart = (await added.json()).cart;
  assert.ok(
    "image" in cart.items[0].product,
    "ق-200: the cart line can show a thumbnail — the key is there even when no image is"
  );
  summary.cartImageKey = true;

  console.log(JSON.stringify({ suite: "public-rails", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}

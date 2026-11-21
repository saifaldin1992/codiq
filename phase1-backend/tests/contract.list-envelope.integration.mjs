/**
 * المرحلة 20-2 «العقد الموحّد» — the list contract, proven over the real app.
 *
 * `list:unit` proves the cursor codec in isolation. This proves the things only
 * a real request can:
 *
 *  1. PAGE 2 EXISTS AND IS RIGHT. Walking a list two rows at a time yields
 *     EXACTLY the rows of one big page, in the same order, with nothing
 *     repeated and nothing dropped — on the merchant surface, the platform
 *     surface and the storefront.
 *  2. D-18's TWO LITERALS ARE CLOSED. `/merchant/stores/:slug/products` and
 *     `/platform/stores/:slug/orders` used to return every row the store had.
 *  3. A FOREIGN CURSOR IS REFUSED CLEANLY. A cursor minted by another list is a
 *     400 with a stable code — never an empty page, never a wrong page, and
 *     never a 500. The red team found `?cursor=abc` producing a bare
 *     INTERNAL_ERROR through an unmapped Prisma P2023; that must not return.
 *  4. LINKS IN FLIGHT STILL OPEN. A bare row uuid (what ten lists minted before
 *     this branch) and the old encoded `{id,createdAt}` order cursor both still
 *     open the page they pointed at.
 *  5. `limit` BEHAVES IDENTICALLY EVERYWHERE. Out of the window is 400
 *     INVALID_LIMIT on every list, not a silent clamp on nine and a refusal on
 *     one.
 *  6. THE ENVELOPE IS ONE SHAPE. Every store-scoped list answers
 *     `{ <resource>: [...], nextCursor, storeSlug }`.
 *  7. A CURSOR CANNOT CROSS A TENANT. Store A's cursor used against store B's
 *     list returns store B's rows or nothing — never store A's.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `contract-${Date.now()}`;
process.env.SESSION_JWT_SECRET =
  process.env.SESSION_JWT_SECRET ?? "contract-test-secret-only-not-for-production";
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

/** A cursor forged for a DIFFERENT list, in the platform's own dialect. */
function cursorOfKind(kind, id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301") {
  return Buffer.from(
    JSON.stringify({ v: 1, k: kind, c: new Date().toISOString(), i: id }),
    "utf8"
  ).toString("base64url");
}
/** The pre-20-2 order cursor, byte for byte as `order-lifecycle` used to mint it. */
function legacyOrderCursor(id, createdAt) {
  return Buffer.from(
    JSON.stringify({ id, createdAt: new Date(createdAt).toISOString() }),
    "utf8"
  ).toString("base64url");
}
const q = (value) => encodeURIComponent(value);

/**
 * The heart of the suite: walk a list `step` rows at a time and prove the walk
 * reproduces one big page exactly. A cursor that repeats a row, drops one, or
 * fails to terminate fails here rather than in a merchant's face.
 */
async function walk(path, key, { token, step = 2, big = 100, max = 40 } = {}) {
  const joiner = path.includes("?") ? "&" : "?";
  const whole = await request(`${path}${joiner}limit=${big}`, { token });
  assert.equal(whole.status, 200, `${path} whole page: ${JSON.stringify(whole.payload)}`);
  assert.equal(whole.payload.nextCursor, null, `${path}: a page that fits carries no cursor`);
  const walked = [];
  let cursor = null;
  for (let page = 0; page < max; page += 1) {
    const query = `${joiner}limit=${step}${cursor ? `&cursor=${q(cursor)}` : ""}`;
    const answer = await request(`${path}${query}`, { token });
    assert.equal(answer.status, 200, `${path} page ${page}: ${JSON.stringify(answer.payload)}`);
    assert.ok(
      Array.isArray(answer.payload[key]),
      `${path}: the collection key «${key}» is an array`
    );
    assert.ok(answer.payload[key].length <= step, `${path}: the limit is honoured`);
    assert.ok(
      Object.hasOwn(answer.payload, "nextCursor"),
      `${path}: every list carries nextCursor`
    );
    walked.push(...answer.payload[key].map((row) => row.id));
    cursor = answer.payload.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null, `${path}: the walk terminates`);
  assert.equal(new Set(walked).size, walked.length, `${path}: no row is served twice across pages`);
  assert.deepEqual(
    walked,
    whole.payload[key].map((row) => row.id),
    `${path}: paging by ${step} yields EXACTLY one big page, in the same order`
  );
  return { walked, whole: whole.payload };
}

/** Every refusal a client can provoke with a query parameter is a 4xx with a code. */
async function refusals(path, { token, kind, expectCursorCode = "INVALID_CURSOR" } = {}) {
  const joiner = path.includes("?") ? "&" : "?";
  for (const [limit, why] of [
    ["0", "below the window"],
    ["101", "above the window"],
    ["2.5", "not an integer"],
    ["abc", "not a number"],
  ]) {
    const answer = await request(`${path}${joiner}limit=${limit}`, { token });
    assert.equal(
      answer.status,
      400,
      `${path}?limit=${limit} (${why}) must be refused, not clamped: ${JSON.stringify(answer.payload)}`
    );
    assert.equal(answer.payload.error.code, "INVALID_LIMIT", `${path}: one limit code everywhere`);
  }
  const garbage = await request(`${path}${joiner}cursor=abc`, { token });
  assert.equal(
    garbage.status,
    400,
    `${path}?cursor=abc must be a 400, never the unmapped P2023 500: ${JSON.stringify(garbage.payload)}`
  );
  assert.equal(garbage.payload.error.code, expectCursorCode);
  const foreign = await request(`${path}${joiner}cursor=${q(cursorOfKind("some.other.list"))}`, {
    token,
  });
  assert.equal(
    foreign.status,
    400,
    `${path}: a cursor from another list is refused, not silently used: ${JSON.stringify(foreign.payload)}`
  );
  assert.equal(foreign.payload.error.code, expectCursorCode);
  if (kind) {
    // Right dialect, right kind, a row id that is not this store's — the page is
    // empty or short, but nothing foreign is ever returned.
    const stranger = await request(`${path}${joiner}cursor=${q(cursorOfKind(kind))}`, { token });
    assert.equal(
      stranger.status,
      200,
      `${path}: a well-formed cursor for a vanished row is a page, not an error`
    );
  }
}

const summary = {};

try {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE order_whatsapp_sends, order_notes, order_tags, storefront_rate_limits, store_marketing_settings, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners, plan_upgrade_requests, platform_audit_events, store_audit_events CASCADE"
  );

  // ---------------------------------------------------------------- fixtures
  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100519401",
    email: `${testId}.a@codiq.test`,
    password: "ContractMerchant!2026",
    businessName: "متجر العقد ألف",
  });
  const merchantB = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100519402",
    email: `${testId}.b@codiq.test`,
    password: "ContractMerchant!2026",
    businessName: "متجر العقد باء",
  });
  assert.equal(merchantA.status, 201, JSON.stringify(merchantA.payload));
  assert.equal(merchantB.status, 201, JSON.stringify(merchantB.payload));
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.payload.account.id,
      name: "متجر ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.payload.account.id,
      name: "متجر باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  await prisma.deliveryRate.create({
    data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true },
  });
  const tokenA = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.a@codiq.test`, password: "ContractMerchant!2026" },
    })
  ).payload.accessToken;
  const tokenB = (
    await request("/auth/merchant/login", {
      method: "POST",
      body: { identifier: `${testId}.b@codiq.test`, password: "ContractMerchant!2026" },
    })
  ).payload.accessToken;

  const ownerEmail = `${testId}.owner@codiq.test`;
  assert.equal(
    (
      await request("/auth/platform/register", {
        method: "POST",
        body: { email: ownerEmail, password: "ContractOwner!2026", displayName: "مالك المنصة" },
      })
    ).status,
    201
  );
  const tokenOwner = (
    await request("/auth/platform/login", {
      method: "POST",
      body: { email: ownerEmail, password: "ContractOwner!2026" },
    })
  ).payload.accessToken;

  const catalogA = `/merchant/stores/${storeA.slug}/catalog`;
  const productIds = [];
  for (let index = 0; index < 5; index += 1) {
    const created = await request(`${catalogA}/products`, {
      method: "POST",
      token: tokenA,
      body: {
        sku: `CT-${String(index).padStart(3, "0")}`,
        name: `منتج العقد ${index}`,
        priceIqd: 5000 + index,
        stockQuantity: 10,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    productIds.push(created.payload.product.id);
  }
  // Store B holds one product, so a cross-tenant cursor has something to fail against.
  const productB = await request(`/merchant/stores/${storeB.slug}/catalog/products`, {
    method: "POST",
    token: tokenB,
    body: { sku: "CT-B-000", name: "منتج باء", priceIqd: 7000, stockQuantity: 3 },
  });
  assert.equal(productB.status, 201, JSON.stringify(productB.payload));

  // Five coupons — the D-18 list that grew with every campaign.
  for (let index = 0; index < 5; index += 1) {
    const created = await request(`/merchant/stores/${storeA.slug}/marketing/coupons`, {
      method: "POST",
      token: tokenA,
      body: { code: `CTCOUP${index}`, kind: "percent", percentOff: 10 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
  }

  // Five orders, written directly so the suite does not depend on the checkout.
  const orderIds = [];
  for (let index = 0; index < 5; index += 1) {
    const order = await prisma.storeOrder.create({
      data: {
        storeId: storeA.id,
        orderNumber: `CT-${String(1000 + index)}`,
        status: "new",
        customerName: `زبون ${index}`,
        recipientPhone: `+96477055000${index}`,
        shippingGovernorate: "Baghdad",
        shippingAddressLine1: "شارع الاختبار",
        subtotalIqd: 5000,
        deliveryFeeIqd: 2500,
        totalIqd: 7500,
        paymentStatus: "pending",
        source: "storefront",
        createdAt: new Date(Date.now() - (5 - index) * 60_000),
      },
    });
    orderIds.push(order.id);
  }

  // ------------------------------------------------------- 1. the merchant surface
  {
    const catalog = await walk(`${catalogA}/products`, "products", { token: tokenA });
    assert.equal(catalog.walked.length, 5);
    assert.equal(
      catalog.whole.storeSlug,
      storeA.slug,
      "the envelope says which store it is a list of"
    );
    await refusals(`${catalogA}/products`, { token: tokenA, kind: "merchant.catalog.products" });

    const orders = await walk(`/merchant/stores/${storeA.slug}/orders`, "orders", {
      token: tokenA,
    });
    assert.equal(orders.walked.length, 5);
    await refusals(`/merchant/stores/${storeA.slug}/orders`, {
      token: tokenA,
      kind: "merchant.orders",
    });

    const coupons = await walk(`/merchant/stores/${storeA.slug}/marketing/coupons`, "coupons", {
      token: tokenA,
    });
    assert.equal(
      coupons.walked.length,
      5,
      "D-18: the coupon list is a page now, not every coupon in the store"
    );
    await refusals(`/merchant/stores/${storeA.slug}/marketing/coupons`, { token: tokenA });
    summary.merchantSurface =
      "catalog, orders and coupons walk two at a time and reproduce one big page exactly";
  }

  // -------------------------------------- 2. D-18's two literals, closed at last
  {
    const legacyProducts = await walk(`/merchant/stores/${storeA.slug}/products`, "products", {
      token: tokenA,
    });
    assert.equal(legacyProducts.walked.length, 5);
    assert.equal(legacyProducts.whole.storeSlug, storeA.slug);
    const platformProducts = await walk(`/platform/stores/${storeA.slug}/products`, "products", {
      token: tokenOwner,
    });
    assert.deepEqual(
      platformProducts.walked,
      legacyProducts.walked,
      "the two routes share one helper and must agree"
    );
    const platformOrders = await walk(`/platform/stores/${storeA.slug}/orders`, "orders", {
      token: tokenOwner,
    });
    assert.equal(
      platformOrders.walked.length,
      5,
      "D-18: every order the store ever took, in one query, is closed"
    );
    await refusals(`/platform/stores/${storeA.slug}/orders`, {
      token: tokenOwner,
      kind: "store.orders",
    });
    summary.d18Literals =
      "sendProductsForStore and sendOrdersForStore are keyset pages on (sku,id) and (orderNumber,id)";
  }

  // ------------------------------------------------------------ 3. the platform surface
  {
    const merchants = await walk("/platform/merchants", "merchants", { token: tokenOwner });
    assert.ok(
      merchants.walked.length >= 2,
      "D-74: listMerchantsWithPlans() took no arguments and returned every merchant"
    );
    await refusals("/platform/merchants", { token: tokenOwner, kind: "platform.merchants" });
    const stores = await walk("/platform/stores", "stores", { token: tokenOwner });
    assert.ok(stores.walked.length >= 2);
    const platformOrders = await walk("/platform/orders", "orders", { token: tokenOwner });
    assert.equal(platformOrders.walked.length, 5);
    summary.platformSurface =
      "merchants (D-74), the store directory and the platform order list all page";
  }

  // ---------------------------------------------------------- 4. the storefront
  {
    const storefrontProducts = await walk(`/store/${storeA.slug}/products`, "products", {});
    assert.equal(storefrontProducts.walked.length, 5);
    assert.equal(storefrontProducts.whole.storeSlug, storeA.slug);
    await refusals(`/store/${storeA.slug}/products`, { kind: "storefront.products" });

    // The ranked search used to answer with ONE page and `nextCursor: null`.
    const searchPath = `/store/${storeA.slug}/products?q=${q("منتج العقد")}`;
    const first = await request(`${searchPath}&limit=2`);
    assert.equal(first.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.products.length, 2);
    assert.ok(
      first.payload.nextCursor,
      "a search with more matches than the page must offer page 2"
    );
    const second = await request(`${searchPath}&limit=2&cursor=${q(first.payload.nextCursor)}`);
    assert.equal(second.status, 200, JSON.stringify(second.payload));
    const firstIds = first.payload.products.map((row) => row.id);
    const secondIds = second.payload.products.map((row) => row.id);
    assert.equal(
      secondIds.some((id) => firstIds.includes(id)),
      false,
      "page 2 of a search repeats nothing from page 1"
    );

    // The unfiltered catalog and the ranked search are two lists sharing one
    // route. Carrying a cursor from one into the other would silently return
    // the wrong page, so each has its own kind and refuses the other's.
    const crossed = await request(
      `${searchPath}&limit=2&cursor=${q(cursorOfKind("storefront.products"))}`
    );
    assert.equal(
      crossed.status,
      400,
      `a catalog cursor on the search path is refused: ${JSON.stringify(crossed.payload)}`
    );
    assert.equal(crossed.payload.error.code, "INVALID_CURSOR");
    summary.storefront =
      "the catalog pages, the ranked search pages in relevance order, and neither accepts the other's cursor";
  }

  // -------------------------------------------- 5. links already in flight
  {
    // The bare row uuid ten lists minted before 20-2.
    const page1 = await request(`${catalogA}/products?limit=2`, { token: tokenA });
    const anchor = page1.payload.products[1].id;
    const viaLegacy = await request(`${catalogA}/products?limit=2&cursor=${q(anchor)}`, {
      token: tokenA,
    });
    assert.equal(
      viaLegacy.status,
      200,
      `a pre-20-2 bare uuid must still open its page: ${JSON.stringify(viaLegacy.payload)}`
    );
    const viaFresh = await request(
      `${catalogA}/products?limit=2&cursor=${q(page1.payload.nextCursor)}`,
      { token: tokenA }
    );
    assert.deepEqual(
      viaLegacy.payload.products.map((row) => row.id),
      viaFresh.payload.products.map((row) => row.id),
      "the legacy uuid and the new cursor open the SAME page"
    );

    // A legacy uuid the caller cannot see is a 404, not an oracle.
    const foreignRow = await request(
      `${catalogA}/products?cursor=${q(productB.payload.product.id)}`,
      { token: tokenA }
    );
    assert.equal(
      foreignRow.status,
      404,
      `a legacy cursor for another store's row is a 404: ${JSON.stringify(foreignRow.payload)}`
    );

    // The pre-20-2 ENCODED order cursor, byte for byte.
    const orderRow = await prisma.storeOrder.findUnique({
      where: { id: orderIds[3] },
      select: { id: true, createdAt: true },
    });
    const legacyEncoded = legacyOrderCursor(orderRow.id, orderRow.createdAt);
    const viaLegacyOrders = await request(
      `/merchant/stores/${storeA.slug}/orders?limit=2&cursor=${q(legacyEncoded)}`,
      { token: tokenA }
    );
    assert.equal(
      viaLegacyOrders.status,
      200,
      `the old {id,createdAt} order cursor must still open its page: ${JSON.stringify(viaLegacyOrders.payload)}`
    );
    assert.ok(
      viaLegacyOrders.payload.orders.every((row) => row.id !== orderRow.id),
      "and it starts AFTER the row it points at"
    );
    summary.linksInFlight =
      "a bare uuid and the old encoded order cursor both still open the page they pointed at";
  }

  // ----------------------------------------------- 6. a cursor cannot cross a tenant
  {
    const pageA = await request(`${catalogA}/products?limit=2`, { token: tokenA });
    const crossTenant = await request(
      `/merchant/stores/${storeB.slug}/catalog/products?limit=10&cursor=${q(pageA.payload.nextCursor)}`,
      { token: tokenB }
    );
    assert.equal(crossTenant.status, 200, JSON.stringify(crossTenant.payload));
    const leaked = crossTenant.payload.products.filter((row) => productIds.includes(row.id));
    assert.equal(
      leaked.length,
      0,
      "store A's cursor must never surface store A's rows on store B's list"
    );
    summary.tenancy =
      "a cursor carries ordering values, never authority — the tenant predicate is still the wall";
  }

  // -------------------------------------------------- 7. one envelope, everywhere
  {
    const shapes = [
      [`/merchant/stores/${storeA.slug}/catalog/products`, "products", tokenA],
      [`/merchant/stores/${storeA.slug}/orders`, "orders", tokenA],
      [`/merchant/stores/${storeA.slug}/customers`, "customers", tokenA],
      [`/merchant/stores/${storeA.slug}/marketing/coupons`, "coupons", tokenA],
      [`/merchant/stores/${storeA.slug}/audit-events`, "events", tokenA],
      [`/merchant/stores/${storeA.slug}/trash`, "items", tokenA],
      [`/merchant/stores/${storeA.slug}/notifications/log`, "notifications", tokenA],
      [`/merchant/stores/${storeA.slug}/returns`, "requests", tokenA],
      [`/merchant/stores/${storeA.slug}/reviews`, "reviews", tokenA],
      [`/merchant/stores/${storeA.slug}/inventory/returns`, "returns", tokenA],
      [`/merchant/stores/${storeA.slug}/pos/shortfalls`, "shortfalls", tokenA],
      [`/merchant/stores/${storeA.slug}/marketing/abandoned-carts`, "carts", tokenA],
    ];
    for (const [path, key, token] of shapes) {
      const answer = await request(path, { token });
      assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.payload)}`);
      assert.ok(Array.isArray(answer.payload[key]), `${path}: «${key}» is the collection`);
      assert.ok(Object.hasOwn(answer.payload, "nextCursor"), `${path}: carries nextCursor`);
      assert.equal(answer.payload.storeSlug, storeA.slug, `${path}: carries storeSlug`);
    }
    summary.envelope = `${shapes.length} store-scoped lists all answer { <resource>, nextCursor, storeSlug }`;
  }

  // ------------- 8. ق-242 — a timestamp the cursor cannot carry
  //
  // EVERY OTHER FIXTURE IN THIS FILE SPACES ITS ROWS OUT: the five orders above
  // are minted 60 seconds apart, at millisecond precision, by hand. That is why
  // this suite stayed green while the two sides of the cursor disagreed — the
  // collision it exists to rule out could not occur in its own data.
  //
  // WHAT THE DISAGREEMENT IS. `encodeListCursor` serialises with
  // `Date.toISOString()` — milliseconds, because that is all a JS Date holds.
  // The columns were `timestamptz(6)` — microseconds. A stored `…494832` mints
  // a cursor `…494`, and then: a DESCENDING page asks `created_at <= …494`,
  // which is FALSE for the row it just served and for every sibling sharing that
  // millisecond, so they are never served again — a short answer with no error
  // in it. An ASCENDING page asks `>= …494`, which is TRUE for the boundary row
  // again, so `limit=1` never advances at all.
  //
  // WHO WRITES SUCH A VALUE — measured, not assumed. Prisma supplies
  // `@default(now())` ITSELF, at millisecond precision: `prisma.create` and
  // `prisma.createMany` both store `…719000`, so through Prisma the ties are
  // whole milliseconds and the `id` tiebreaker already handles them. It is a
  // write that lets the COLUMN DEFAULT fire — raw SQL, a trigger, a backfill
  // migration — that lands `…723787`. Every one of these 23 columns carries
  // `DEFAULT now()`, so the door is open; today's writers all happen to go
  // through Prisma. That is why the fixture below writes the way the defect
  // requires rather than the way the app currently happens to.
  //
  // The six values all round to the SAME millisecond, which is the hard case:
  // after the migration they are six exact ties and the `id` tiebreaker is the
  // whole of the ordering; before it they are six distinct microsecond values no
  // cursor can name.
  {
    const tieBase = "2026-03-01 09:15:22.494";
    const microseconds = ["600", "700", "800", "850", "900", "950"];
    for (const [index, micro] of microseconds.entries()) {
      await sql.query(
        `INSERT INTO store_orders (id, store_id, order_number, status, customer_name, recipient_phone,
           shipping_governorate, shipping_address_line1, subtotal_iqd, delivery_fee_iqd, total_iqd,
           payment_status, source, created_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, 'new', $3, $4, 'Baghdad', 'شارع التزامن',
           5000, 2500, 7500, 'pending', 'storefront', $5::timestamptz)`,
        [
          storeB.id,
          `CT-TIE-${index}`,
          `زبون متزامن ${index}`,
          `+96477055100${index}`,
          `${tieBase}${micro}+00`,
        ]
      );
    }
    const written = await prisma.storeOrder.findMany({
      where: { storeId: storeB.id, orderNumber: { startsWith: "CT-TIE-" } },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    assert.equal(written.length, 6, "the six colliding orders were written");

    // The rounding is the fix, and it is asserted on the STORED text rather than
    // through a JS Date — a Date would truncate the evidence away.
    const stored = await sql.query(
      "SELECT created_at::text AS at FROM store_orders WHERE store_id = $1::uuid AND order_number LIKE 'CT-TIE-%'",
      [storeB.id]
    );
    const distinct = new Set(stored.rows.map((row) => row.at));
    assert.equal(
      distinct.size,
      1,
      `ق-242: six sub-millisecond values must round to ONE stored instant — got ${[...distinct].join(", ")}`
    );
    assert.match([...distinct][0], /\.495\b/, "…the millisecond they all round to");
    assert.equal(
      new Set(written.map((row) => row.createdAt.toISOString())).size,
      1,
      "…so the cursor's own serialisation loses nothing"
    );

    // `step: 1` is the other half: the smallest page makes EVERY row a boundary
    // row, so `walk()`'s two standing assertions — no row twice, and paging
    // equals one big page exactly — become the whole test.
    const descending = await walk(`/merchant/stores/${storeB.slug}/orders`, "orders", {
      token: tokenB,
      step: 1,
    });
    assert.equal(
      descending.walked.length,
      6,
      "ق-242: a DESCENDING keyset over six rows sharing one instant serves all six, one at a time"
    );

    const notesOrderId = written[0].id;
    for (const [index, micro] of microseconds.entries()) {
      await sql.query(
        `INSERT INTO order_notes (id, store_id, order_id, author_kind, author_id, body, created_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'merchant', $3::uuid, $4, $5::timestamptz)`,
        [
          storeB.id,
          notesOrderId,
          merchantB.payload.account.id,
          `ملاحظة متزامنة ${index}`,
          `${tieBase}${micro}+00`,
        ]
      );
    }
    const ascending = await walk(
      `/merchant/stores/${storeB.slug}/orders/${notesOrderId}/notes`,
      "notes",
      { token: tokenB, step: 1 }
    );
    assert.equal(
      ascending.walked.length,
      6,
      "ق-242: an ASCENDING keyset with limit=1 advances instead of serving the boundary row forever"
    );

    summary.cursorPrecision =
      "six sub-millisecond timestamps round to one stored instant; both directions walk all six, one at a time, exactly once each";
  }

  console.log(JSON.stringify({ suite: "contract.list-envelope", summary }, null, 2));
} finally {
  await sql.end();
  server.close();
  await prisma.$disconnect();
}

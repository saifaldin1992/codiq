import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { createApp } from "../src/http/app.js";
import { prisma } from "../src/db/prisma.js";
import { createStoreFoundation } from "../src/services/store-bootstrap.service.js";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";

const port = 3105;
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "content-type": "application/json", ...(options.headers ?? {}) }, ...options });
  return { response, body: await response.json() as any };
}

async function run() {
  const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
  if (process.env.DATABASE_URL !== testDatabaseUrl || process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl) throw new Error("Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL.");
  // ONE TRUNCATE, not a hand-ordered chain of deleteMany.
  //
  // THIS SUITE ONLY PASSED BECAUSE OF THE ORDER CI HAPPENS TO RUN IT IN. The old
  // cleanup deleted `customer` with no prior delete of `customer_addresses`,
  // `shopping_carts`, `cart_items`, `wishlist_items`, `checkout_requests`,
  // `product_reviews`, `loyalty_entries` or `return_requests` — every one of
  // which has a foreign key to it. It worked because phase 5 runs early, while
  // those tables are still empty. Proved on 2026-09-05 by running `phase9a:test`
  // first, which leaves addresses and carts behind:
  //
  //     Foreign key constraint violated on `customer_addresses_customer_store_fk`
  //
  // The damage is not the failure, it is what the failure LOOKS like: an FK error
  // in a TENANCY suite reads as a tenancy defect, and whoever hits it goes
  // looking in the wrong file. The same trap sits under `product` (variants,
  // images, movements, reservations all reference it).
  //
  // `TRUNCATE … CASCADE` is order-independent by construction, so this cannot
  // regress the day someone reorders `ci.yml` or adds a suite above this one. It
  // is what `phase9a` and `pg3` already do. `plans` is deliberately NOT listed:
  // the default plan is seeded once and every merchant subscribes to it, and
  // nothing referenced here cascades INTO it.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    storefront_rate_limits, settlements, ledger_entries,
    order_status_events, order_items, order_notes, order_tags, order_prescriptions, order_whatsapp_sends,
    store_orders, checkout_requests, inventory_reservations, inventory_movements,
    cart_items, shopping_carts, wishlist_items, product_reviews, loyalty_entries, return_requests,
    customer_addresses, customer_sessions, customers,
    product_images, product_variants, products, product_categories,
    delivery_rates, notification_settings, payment_methods, notification_outbox,
    staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff,
    merchant_subscriptions, merchant_sessions, stores, merchants,
    platform_owner_sessions, platform_owners
    CASCADE`);

  const server = createApp().listen(port);
  try {
    const owner = await request("/auth/platform/register", { method: "POST", body: JSON.stringify({ email: "owner.phase5@codiq.test", password: "owner-phase5-password", displayName: "Phase Five Owner" }) });
    const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100507101", email: "merchant.a.phase5@codiq.test", password: "merchant-a-phase5-password", businessName: "Phase Five Merchant A" });
    const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100507102", email: "merchant.b.phase5@codiq.test", password: "merchant-b-phase5-password", businessName: "Phase Five Merchant B" });
    assert.equal(owner.response.status, 201);
    assert.equal(merchantA.response.status, 201);
    assert.equal(merchantB.response.status, 201);

    const storeA = await createStoreFoundation({ merchantId: merchantA.body.account.id, name: "متجر النخلة", slug: "phase5-tenant-a", defaultSubdomain: "phase5-tenant-a" });
    const storeB = await createStoreFoundation({ merchantId: merchantB.body.account.id, name: "متجر الرافدين", slug: "phase5-tenant-b", defaultSubdomain: "phase5-tenant-b" });

    const productsA = await Promise.all([
      prisma.product.create({ data: { storeId: storeA.id, sku: "A-COFFEE", name: "قهوة عربية محمصة", description: "بن عربي محمص طازج", priceIqd: 12000 } }),
      prisma.product.create({ data: { storeId: storeA.id, sku: "A-DATES", name: "تمر زاهدي فاخر", description: "تمور عراقية منتقاة", priceIqd: 8000 } }),
      prisma.product.create({ data: { storeId: storeA.id, sku: "A-CARDAMOM", name: "هيل أخضر", description: "هيل كامل للحلويات والقهوة", priceIqd: 6500 } }),
    ]);
    const productsB = await Promise.all([
      prisma.product.create({ data: { storeId: storeB.id, sku: "B-LAMP", name: "مصباح مكتبي LED", description: "مصباح عملي قابل للتعديل", priceIqd: 24500 } }),
      prisma.product.create({ data: { storeId: storeB.id, sku: "B-NOTEBOOK", name: "دفتر ملاحظات جلدي", description: "دفتر A5 بغلاف جلدي", priceIqd: 9500 } }),
      prisma.product.create({ data: { storeId: storeB.id, sku: "B-PEN", name: "قلم حبر معدني", description: "قلم يومي بلمسة معدنية", priceIqd: 5500 } }),
    ]);
    const orderA = await prisma.storeOrder.create({ data: { storeId: storeA.id, orderNumber: "A-1001", status: "new", customerName: "زبون متجر النخلة", totalIqd: 20000, items: { create: [{ productId: productsA[0].id, productName: productsA[0].name, quantity: 1, unitPriceIqd: 12000, lineTotalIqd: 12000 }, { productId: productsA[1].id, productName: productsA[1].name, quantity: 1, unitPriceIqd: 8000, lineTotalIqd: 8000 }] } } });
    const orderB = await prisma.storeOrder.create({ data: { storeId: storeB.id, orderNumber: "B-1001", status: "new", customerName: "زبون متجر الرافدين", totalIqd: 34000, items: { create: [{ productId: productsB[0].id, productName: productsB[0].name, quantity: 1, unitPriceIqd: 24500, lineTotalIqd: 24500 }, { productId: productsB[1].id, productName: productsB[1].name, quantity: 1, unitPriceIqd: 9500, lineTotalIqd: 9500 }] } } });

    const ownerLogin = await request("/auth/platform/login", { method: "POST", body: JSON.stringify({ email: "owner.phase5@codiq.test", password: "owner-phase5-password" }) });
    const loginA = await request("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: "merchant.a.phase5@codiq.test", password: "merchant-a-phase5-password" }) });
    const loginB = await request("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: "merchant.b.phase5@codiq.test", password: "merchant-b-phase5-password" }) });
    assert.equal(ownerLogin.response.status, 200);
    assert.equal(loginA.response.status, 200);
    assert.equal(loginB.response.status, 200);
    const ownerAuth = { authorization: `Bearer ${ownerLogin.body.accessToken}` };
    const authA = { authorization: `Bearer ${loginA.body.accessToken}` };
    const authB = { authorization: `Bearer ${loginB.body.accessToken}` };

    const aOwnProducts = await request(`/merchant/stores/${storeA.slug}/products`, { headers: authA });
    const aOwnOrders = await request(`/merchant/stores/${storeA.slug}/orders`, { headers: authA });
    const bOwnProducts = await request(`/merchant/stores/${storeB.slug}/products`, { headers: authB });
    const bOwnOrders = await request(`/merchant/stores/${storeB.slug}/orders`, { headers: authB });
    assert.equal(aOwnProducts.response.status, 200);
    assert.equal(aOwnProducts.body.products.length, 3);
    assert.equal(aOwnOrders.response.status, 200);
    assert.equal(aOwnOrders.body.orders.length, 1);
    assert.equal(bOwnProducts.response.status, 200);
    assert.equal(bOwnProducts.body.products.length, 3);
    assert.equal(bOwnOrders.response.status, 200);
    assert.equal(bOwnOrders.body.orders.length, 1);

    const aSlugTamper = await request(`/merchant/stores/${storeB.slug}/products`, { headers: authA });
    const aOrderSlugTamper = await request(`/merchant/stores/${storeB.slug}/orders`, { headers: authA });
    const aProductIdor = await request(`/merchant/stores/${storeA.slug}/products/${productsB[0].id}`, { headers: authA });
    const aOrderIdor = await request(`/merchant/stores/${storeA.slug}/orders/${orderB.id}`, { headers: authA });
    assert.equal(aSlugTamper.response.status, 403);
    assert.equal(aSlugTamper.body.error.code, "STORE_BOUNDARY_DENIED");
    assert.equal(aOrderSlugTamper.response.status, 403);
    assert.equal(aProductIdor.response.status, 404);
    assert.equal(aProductIdor.body.error.code, "RESOURCE_NOT_FOUND");
    assert.equal(aOrderIdor.response.status, 404);
    assert.equal(aOrderIdor.body.error.code, "RESOURCE_NOT_FOUND");

    const bSlugTamper = await request(`/merchant/stores/${storeA.slug}/products`, { headers: authB });
    const bOrderSlugTamper = await request(`/merchant/stores/${storeA.slug}/orders`, { headers: authB });
    const bProductIdor = await request(`/merchant/stores/${storeB.slug}/products/${productsA[0].id}`, { headers: authB });
    const bOrderIdor = await request(`/merchant/stores/${storeB.slug}/orders/${orderA.id}`, { headers: authB });
    assert.equal(bSlugTamper.response.status, 403);
    assert.equal(bSlugTamper.body.error.code, "STORE_BOUNDARY_DENIED");
    assert.equal(bOrderSlugTamper.response.status, 403);
    assert.equal(bProductIdor.response.status, 404);
    assert.equal(bProductIdor.body.error.code, "RESOURCE_NOT_FOUND");
    assert.equal(bOrderIdor.response.status, 404);
    assert.equal(bOrderIdor.body.error.code, "RESOURCE_NOT_FOUND");

    const ownerProductsA = await request(`/platform/stores/${storeA.slug}/products`, { headers: ownerAuth });
    const ownerProductsB = await request(`/platform/stores/${storeB.slug}/products/${productsB[0].id}`, { headers: ownerAuth });
    const ownerOrdersA = await request(`/platform/stores/${storeA.slug}/orders/${orderA.id}`, { headers: ownerAuth });
    const ownerOrdersB = await request(`/platform/stores/${storeB.slug}/orders`, { headers: ownerAuth });
    assert.equal(ownerProductsA.response.status, 200);
    assert.equal(ownerProductsA.body.products.length, 3);
    assert.equal(ownerProductsB.response.status, 200);
    assert.equal(ownerOrdersA.response.status, 200);
    assert.equal(ownerOrdersB.response.status, 200);
    assert.equal(ownerOrdersB.body.orders.length, 1);

    console.log(JSON.stringify({
      stores: { a: { slug: storeA.slug, productCount: productsA.length, orderId: orderA.id }, b: { slug: storeB.slug, productCount: productsB.length, orderId: orderB.id } },
      merchantA: { ownProducts: aOwnProducts.response.status, ownOrders: aOwnOrders.response.status, slugTamper: { status: aSlugTamper.response.status, code: aSlugTamper.body.error.code }, productIdor: { status: aProductIdor.response.status, code: aProductIdor.body.error.code }, orderIdor: { status: aOrderIdor.response.status, code: aOrderIdor.body.error.code } },
      merchantB: { ownProducts: bOwnProducts.response.status, ownOrders: bOwnOrders.response.status, slugTamper: { status: bSlugTamper.response.status, code: bSlugTamper.body.error.code }, productIdor: { status: bProductIdor.response.status, code: bProductIdor.body.error.code }, orderIdor: { status: bOrderIdor.response.status, code: bOrderIdor.body.error.code } },
      platformOwner: { tenantAProducts: ownerProductsA.response.status, tenantBProduct: ownerProductsB.response.status, tenantAOrder: ownerOrdersA.response.status, tenantBOrders: ownerOrdersB.response.status },
    }, null, 2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

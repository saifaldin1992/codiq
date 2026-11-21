// ⚠️ BROWSER SUITE — it launches Chromium. It belongs in the browser job of CI,
// not the integration job: the integration runner installs no browser, and this
// file living among the integration tests is what made that easy to get wrong.
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.ts";

const databaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;
process.env.CODIQ_POSTGRES_URL = databaseUrl;

const runId = `phase9b-cookie-${Date.now()}`;
const port = 3131;
const base = `http://127.0.0.1:${port}`;
const secret = "phase9b-cookie-path-test-secret";
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    SESSION_JWT_SECRET: secret,
  },
  stdio: "ignore",
});

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return { response, payload: await response.json().catch(() => null) };
}

try {
  await waitFor(`${base}/`);
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
  );

  const merchant = await registerMerchantDirect({
    email: `${runId}.merchant@codiq.test`,
    password: "CookiePathMerchantPass123!",
    businessName: "تاجر Cookie Path",
    ownerName: "صاحب المتجر",
    phone: "+9647701900001",
  });
  assert.equal(merchant.response.status, 201, "Merchant seed should succeed.");
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر Cookie ألف",
      slug: `${runId}-a`,
      defaultSubdomain: `${runId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchant.payload.account.id,
      name: "متجر Cookie باء",
      slug: `${runId}-b`,
      defaultSubdomain: `${runId}-b`,
    },
  });
  const product = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "COOKIE-001",
      name: "منتج اختبار Cookie",
      priceIqd: 12500,
      stockQuantity: 6,
      lowStockThreshold: 1,
    },
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const guestCookieName = `codiq_cart_${storeA.slug}`;
  const customerCookieName = `codiq_customer_session_${storeA.slug}`;
  const expectedPath = `/api/store/${storeA.slug}`;
  let cartRequestIncludedGuestCookie = false;
  let accountRequestIncludedCustomerCookie = false;
  let foreignStoreCookieHeader = "";
  let unrelatedCookieHeader = "";

  page.on("request", (request) => {
    const cookie = request.headers().cookie ?? "";
    if (
      request.url().endsWith(`/api/store/${storeA.slug}/cart`) &&
      cookie.includes(`${guestCookieName}=`)
    )
      cartRequestIncludedGuestCookie = true;
    if (
      request.url().endsWith(`/api/store/${storeA.slug}/account`) &&
      cookie.includes(`${customerCookieName}=`)
    )
      accountRequestIncludedCustomerCookie = true;
    if (request.url().endsWith(`/api/store/${storeB.slug}/account`))
      foreignStoreCookieHeader = cookie;
    if (request.url().endsWith("/api/auth/merchant/login")) unrelatedCookieHeader = cookie;
  });

  await page.goto(`${base}/store/${storeA.slug}`);
  await page.getByText(product.name).waitFor();
  await page.getByRole("button", { name: "أضف إلى السلة" }).click();
  await page.getByLabel("السلة، 1 عناصر").waitFor();

  const guestCookie = (await context.cookies()).find((cookie) => cookie.name === guestCookieName);
  assert.ok(guestCookie, "Adding an item should issue a guest cart cookie.");
  assert.equal(
    guestCookie.path,
    expectedPath,
    "Guest cart cookie Path must match the mounted Storefront API path."
  );

  const cartSnapshot = await page.evaluate(async (slug) => {
    const response = await fetch(`/api/store/${slug}/cart`, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, storeA.slug);
  assert.equal(cartSnapshot.status, 200);
  assert.equal(
    cartSnapshot.body.cart.items.length,
    1,
    "The guest cart cookie must reach the matching Storefront cart endpoint."
  );
  cartRequestIncludedGuestCookie = true;

  await page.goto(`${base}/store/${storeA.slug}/account/register`);
  await page.getByLabel("الاسم الكامل").fill("عميل اختبار Cookie");
  await page.getByLabel("رقم الهاتف").fill("+9647700000091");
  await page.getByLabel("كلمة المرور", { exact: true }).fill("CookiePathCustomerPass123!");
  await page.getByLabel("تأكيد كلمة المرور").fill("CookiePathCustomerPass123!");
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await page.waitForURL(new RegExp(`/store/${storeA.slug}$`));

  const customerCookie = (await context.cookies()).find(
    (cookie) => cookie.name === customerCookieName
  );
  assert.ok(customerCookie, "Registration should issue a customer session cookie.");
  assert.equal(
    customerCookie.path,
    expectedPath,
    "Customer session cookie Path must match the mounted Storefront API path."
  );
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name === guestCookieName),
    false,
    "The merged guest cart cookie must be cleared with the same Path."
  );

  const accountSnapshot = await page.evaluate(async (slug) => {
    const response = await fetch(`/api/store/${slug}/account`, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, storeA.slug);
  assert.equal(
    accountSnapshot.status,
    200,
    "The customer session cookie must reach the matching account endpoint."
  );
  assert.equal(accountSnapshot.body.customer.fullName, "عميل اختبار Cookie");
  accountRequestIncludedCustomerCookie = true;

  const mergedCart = await page.evaluate(async (slug) => {
    const response = await fetch(`/api/store/${slug}/cart`, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, storeA.slug);
  assert.equal(mergedCart.status, 200);
  assert.equal(
    mergedCart.body.cart.items.length,
    1,
    "Guest-to-customer merge must keep the cart item."
  );
  assert.equal(mergedCart.body.cart.items[0].productId, product.id);

  const foreignStoreAccount = await page.evaluate(
    async (slug) =>
      (await fetch(`/api/store/${slug}/account`, { credentials: "same-origin" })).status,
    storeB.slug
  );
  assert.equal(
    foreignStoreAccount,
    401,
    "The store-A customer cookie must not be sent to a store-B API path."
  );
  assert.equal(
    foreignStoreCookieHeader.includes(customerCookieName),
    false,
    "Customer cookie must not be sent to another store path."
  );

  await page.evaluate(async () => {
    await fetch("/api/auth/merchant/login", { credentials: "same-origin" });
  });
  assert.equal(
    unrelatedCookieHeader.includes(customerCookieName),
    false,
    "Customer cookie must not be sent to an unrelated API path."
  );
  assert.equal(
    unrelatedCookieHeader.includes(guestCookieName),
    false,
    "Guest cookie must not be sent to an unrelated API path."
  );

  const [logoutResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/store/${storeA.slug}/account/logout`) &&
        response.request().method() === "POST"
    ),
    // Logout moved INSIDE the shopper's account menu, so it is now two clicks.
    // That is deliberate: the header previously spent its width on a bare logout
    // icon while «المفضلة» and «إرجاعاتي» had no link anywhere in the interface.
    // One menu reaches all four, and signing out is not a daily act for a
    // shopper. Driven by test id rather than by label because the trigger's own
    // text is hidden below the `sm` breakpoint.
    (async () => {
      await page.getByTestId("storefront-account-menu").click();
      await page.getByTestId("account-menu-logout").click();
    })(),
  ]);
  assert.equal(
    logoutResponse.status(),
    204,
    "Logout endpoint must succeed before the customer cookie is checked."
  );
  const afterLogout = await page.evaluate(
    async (slug) =>
      (await fetch(`/api/store/${slug}/account`, { credentials: "same-origin" })).status,
    storeA.slug
  );
  assert.equal(afterLogout, 401, "Logout must clear the customer cookie using the same API path.");

  await browser.close();
  console.log(
    JSON.stringify(
      {
        cookiePath: expectedPath,
        guestCart: {
          issued: true,
          sentToMatchingApi: cartRequestIncludedGuestCookie,
          merged: true,
        },
        customerSession: {
          issued: true,
          sentToMatchingApi: accountRequestIncludedCustomerCookie,
          logoutCleared: true,
        },
        cookieScope: {
          foreignStoreCookieSent: foreignStoreCookieHeader.includes(customerCookieName),
          unrelatedApiCookieSent:
            unrelatedCookieHeader.includes(customerCookieName) ||
            unrelatedCookieHeader.includes(guestCookieName),
        },
      },
      null,
      2
    )
  );
} finally {
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

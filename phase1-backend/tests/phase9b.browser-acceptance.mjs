import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const databaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;
process.env.CODIQ_POSTGRES_URL = databaseUrl;
process.env.SESSION_JWT_SECRET = "phase9b-browser-acceptance-secret";

const { prisma } = await import("../src/db/prisma.ts");
const runId = `phase9b-ui-${Date.now()}`;
const port = 3138;
const base = `http://127.0.0.1:${port}`;
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    CODIQ_POSTGRES_URL: databaseUrl,
    SESSION_JWT_SECRET: process.env.SESSION_JWT_SECRET,
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
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null),
    response,
  };
}

async function registerCustomer(storeSlug, { phone, fullName, password }) {
  const result = await api(`/api/store/${storeSlug}/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, fullName, password }),
  });
  assert.equal(result.status, 201);
  return result.body;
}

async function addAddress(storeSlug, token, governorate = "Baghdad") {
  const result = await api(`/api/store/${storeSlug}/account/addresses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      recipientName: "عنوان الاختبار",
      fullAddress: "شارع الاختبار",
      city: governorate,
      governorate,
      phoneContact: "+9647700000101",
      isDefault: true,
    }),
  });
  assert.equal(result.status, 201);
  return result.body.address;
}

try {
  await waitFor(`${base}/health`);
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
  );

  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100215601",
    email: `${runId}.merchant-a@codiq.test`,
    password: "Phase9BMerchantPass123!",
    businessName: "تاجر واجهة ألف",
  });
  const merchantB = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100215602",
    email: `${runId}.merchant-b@codiq.test`,
    password: "Phase9BMerchantPass123!",
    businessName: "تاجر واجهة باء",
  });
  assert.equal(merchantA.status, 201);
  assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.body.account.id,
      name: "متجر واجهة ألف",
      slug: `${runId}-a`,
      defaultSubdomain: `${runId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.body.account.id,
      name: "متجر واجهة باء",
      slug: `${runId}-b`,
      defaultSubdomain: `${runId}-b`,
    },
  });
  await prisma.deliveryRate.create({
    data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
  });
  await prisma.deliveryRate.create({
    data: { storeId: storeB.id, governorate: "Baghdad", amountIqd: 1000, isEnabled: true },
  });
  const categoryA = await prisma.productCategory.create({
    data: { storeId: storeA.id, name: "تصنيف واجهة ألف", normalizedName: "تصنيف واجهة ألف" },
  });
  const categoryB = await prisma.productCategory.create({
    data: { storeId: storeB.id, name: "تصنيف واجهة باء", normalizedName: "تصنيف واجهة باء" },
  });
  const productA = await prisma.product.create({
    data: {
      storeId: storeA.id,
      categoryId: categoryA.id,
      sku: "UI-A-1",
      name: "منتج واجهة ألف",
      description: "وصف واجهة قابل للبحث",
      priceIqd: 12000,
      stockQuantity: 2,
      lowStockThreshold: 1,
    },
  });
  const productB = await prisma.product.create({
    data: {
      storeId: storeB.id,
      categoryId: categoryB.id,
      sku: "UI-B-1",
      name: "منتج واجهة باء",
      priceIqd: 9000,
      stockQuantity: 2,
      lowStockThreshold: 1,
    },
  });
  const unavailableProductUi = await prisma.product.create({
    data: {
      storeId: storeA.id,
      categoryId: categoryA.id,
      sku: "UI-A-OOS",
      name: "منتج واجهة نافد",
      description: "وصف المنتج النافد",
      priceIqd: 3000,
      stockQuantity: 0,
      lowStockThreshold: 1,
    },
  });

  const browser = await chromium.launch({ headless: true });
  const contextA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageA = await contextA.newPage();

  // UI-01: catalog → guest cart → register merge → checkout → order detail.
  await pageA.goto(`${base}/store/${storeA.slug}`);
  await pageA.getByText(productA.name).waitFor();
  // UI-12: storefront search, category filter, public stock state and CSS variable injection.
  // ق-203: the search lives in the header now. On a phone it opens behind the
  // «بحث» button, and a query lands on the catalog page (/products?q=…).
  await pageA.getByRole("button", { name: "بحث" }).click();
  await pageA.getByLabel("بحث المنتجات").fill("وصف واجهة قابل للبحث");
  await pageA.getByLabel("بحث المنتجات").press("Enter");
  await pageA.waitForURL(new RegExp(`/store/${storeA.slug}/products\\?q=`));
  await pageA.getByText(productA.name).waitFor();
  // A category is a page of its own, with the children rolled up server-side.
  await pageA.goto(`${base}/store/${storeA.slug}/categories/${categoryA.id}`);
  await pageA.getByText(productA.name).waitFor();
  await pageA.getByRole("button", { name: "مسح عوامل التصفية" }).click();
  await pageA.waitForURL(new RegExp(`/store/${storeA.slug}/products$`));
  const outOfStockCard = pageA.locator("article", { hasText: unavailableProductUi.name });
  await outOfStockCard.getByRole("button", { name: "نفد المخزون" }).waitFor();
  assert.equal(
    await outOfStockCard.getByRole("button", { name: "نفد المخزون" }).isDisabled(),
    true
  );
  const storefrontVariables = await pageA
    .locator("div[dir=rtl]")
    .evaluate((element) => ({
      accent: getComputedStyle(element).getPropertyValue("--storefront-accent").trim(),
      surface: getComputedStyle(element).getPropertyValue("--storefront-surface").trim(),
    }));
  // ق-203: the storefront speaks the platform tokens now — Codiq blue, not its own.
  // A hex colour has three spellings a browser may hand back (#fff, #FFFFFF,
  // rgb(...)); the aliases are asserted for their VALUE, so normalise before
  // comparing rather than pinning the spelling the stylesheet happens to use.
  const hex = (value) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3");
  assert.equal(hex(storefrontVariables.accent), "#1e6fdb");
  assert.equal(hex(storefrontVariables.surface), "#ffffff");
  await pageA.getByRole("button", { name: "أضف إلى السلة" }).click();
  await pageA.getByLabel("السلة، 1 عناصر").waitFor();
  await pageA.goto(`${base}/store/${storeA.slug}/cart`);
  await pageA.getByText(productA.name).waitFor();
  // ق-201: buying needs no account by default, so the cart goes straight to
  // checkout; a shopper who wants an account takes the sign-in link from there.
  await pageA.getByRole("button", { name: "إتمام الطلب" }).click();
  await pageA.getByTestId("guest-login-link").click();
  await pageA.getByRole("link", { name: "أنشئ حسابًا" }).click();
  await pageA.waitForURL(new RegExp(`/store/${storeA.slug}/account/register`));
  await pageA.getByLabel("الاسم الكامل").fill("عميل واجهة ألف");
  await pageA.getByLabel("رقم الهاتف").fill("+9647700000101");
  await pageA.getByLabel("كلمة المرور", { exact: true }).fill("Phase9BCustomerPass123!");
  await pageA.getByLabel("تأكيد كلمة المرور").fill("Phase9BCustomerPass123!");
  await pageA.getByRole("button", { name: "إنشاء الحساب" }).click();
  await pageA.waitForURL(new RegExp(`/store/${storeA.slug}/checkout$`));
  await pageA.getByRole("button", { name: "عنوان جديد" }).click();
  await pageA.getByLabel("اسم المستلم").fill("عميل واجهة ألف");
  await pageA.getByLabel("هاتف المستلم").fill("+9647700000101");
  await pageA.getByLabel("العنوان التفصيلي").fill("شارع واجهة ألف");
  await pageA.getByLabel("المدينة").fill("Baghdad");
  // ق-162: المحافظة صارت قائمة اختيار — الزبون يرى «بغداد» ويُخزَّن `Baghdad`.
  await pageA.getByLabel("المحافظة").selectOption("Baghdad");
  await pageA.getByRole("button", { name: "حفظ العنوان وحساب التوصيل" }).click();
  await pageA.getByText("التوصيل — Baghdad").waitFor();
  await pageA.getByText("٣٬٠٠٠ د.ع").waitFor();
  await pageA.getByRole("button", { name: "تأكيد الطلب — الدفع عند الاستلام" }).click();
  await pageA.waitForURL(new RegExp(`/store/${storeA.slug}/account/orders/`));
  // 20-2: this used to wait for «تفاصيل الطلب», which appears ONLY in this
  // page's loading placeholder («جارٍ تحميل تفاصيل الطلب…»). It asserted that a
  // spinner had been seen, not that the order rendered — so it raced the fetch
  // and passed or failed on how fast the server answered. The reorder button
  // exists only once `order` is loaded, so waiting for it asserts the thing the
  // step is actually about.
  await pageA.getByTestId("reorder-button").waitFor();
  await pageA.getByText("مسار الطلب").waitFor();
  const orderId = new URL(pageA.url()).pathname.split("/").at(-1);
  assert.ok(orderId);

  // ق-173: the address he saved at checkout can now be corrected — and a second
  // one, which no order references, can be removed. PATCH and DELETE on the
  // address had shipped with a validation schema and no caller.
  await pageA.goto(`${base}/store/${storeA.slug}/account/addresses`);
  await pageA.getByTestId("address-card").first().waitFor();
  await pageA.getByTestId("address-edit").first().click();
  await pageA.getByLabel("اسم المستلم").fill("عميل واجهة ألف — بعد التعديل");
  await pageA.getByTestId("address-save").click();
  await pageA.getByText("عميل واجهة ألف — بعد التعديل").waitFor();
  await pageA.getByTestId("address-add").click();
  await pageA.getByLabel("اسم المستلم").fill("عنوان مؤقت");
  await pageA.getByLabel("هاتف المستلم").fill("+9647700000101");
  await pageA.getByLabel("العنوان التفصيلي").fill("شارع سيُحذف");
  await pageA.getByLabel("المدينة").fill("Baghdad");
  await pageA.getByLabel("المحافظة").selectOption("Baghdad");
  await pageA.getByTestId("address-save").click();
  await pageA.getByText("عنوان مؤقت").waitFor();
  assert.equal(
    await pageA.getByTestId("address-card").count(),
    2,
    "two saved addresses before the delete"
  );
  await pageA.getByTestId("address-delete").nth(1).click();
  await pageA.getByTestId("address-delete-confirm").click();
  await pageA.getByText("عنوان مؤقت").waitFor({ state: "detached" });
  assert.equal(
    await pageA.getByTestId("address-card").count(),
    1,
    "the temporary address is gone and the ordered one stays"
  );

  // UI-02: mobile RTL, keyboard focus, labels and an Arabic visible heading.
  assert.ok((await pageA.locator('[dir="rtl"]').count()) >= 1);
  await pageA.goto(`${base}/store/${storeA.slug}/cart`);
  await pageA.getByRole("link", { name: /السلة/ }).focus();
  assert.equal(
    await pageA
      .getByRole("link", { name: /السلة/ })
      .evaluate((element) => document.activeElement === element),
    true
  );
  await pageA.getByText("سلتك").waitFor();
  const mobileLayout = await pageA.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert.ok(
    mobileLayout.documentWidth <= mobileLayout.viewportWidth,
    `Mobile horizontal overflow: ${JSON.stringify(mobileLayout)}`
  );

  // Register customer B and use its browser session for UI-04/UI-05 isolation checks.
  const customerB = await registerCustomer(storeA.slug, {
    phone: "+9647700000102",
    fullName: "عميل واجهة باء",
    password: "Phase9BCustomerBPass123!",
  });
  const addressB = await addAddress(storeA.slug, customerB.accessToken, "Baghdad");
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await contextB.newPage();
  await pageB.goto(`${base}/store/${storeA.slug}/account/login`);
  await pageB.getByLabel("رقم الهاتف").fill("+9647700000102");
  // The customer sign-in field carries the reveal toggle too, and the toggle is
  // correctly named «إظهار كلمة المرور» — which CONTAINS the field label. The
  // input's own name is exactly «كلمة المرور», so the exact match is the precise
  // query; the loose one was always ambiguous, it just had nothing to collide with.
  await pageB.getByLabel("كلمة المرور", { exact: true }).fill("Phase9BCustomerBPass123!");
  await pageB.getByRole("button", { name: "تسجيل الدخول" }).click();
  await pageB.waitForURL(new RegExp(`/store/${storeA.slug}$`));
  const addressA = await pageA.evaluate(
    async (slug) =>
      (await fetch(`/api/store/${slug}/account/addresses`, { credentials: "same-origin" })).json(),
    storeA.slug
  );
  await pageB.evaluate(
    async ({ slug, productId }) => {
      await fetch(`/api/store/${slug}/cart/items`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId, quantity: 1 }),
      });
    },
    { slug: storeA.slug, productId: productA.id }
  );
  const customerBCart = await pageB.evaluate(
    async (slug) => (await fetch(`/api/store/${slug}/cart`, { credentials: "same-origin" })).json(),
    storeA.slug
  );

  // UI-04/UI-05: no cross-order, cross-address, cross-store, or merchant access.
  const idor = await pageB.evaluate(
    async ({ aSlug, bSlug, foreignOrderId, foreignAddressId, cartVersion }) => {
      const fetchStatus = async (path, init) =>
        (await fetch(path, { credentials: "same-origin", ...init })).status;
      return {
        order: await fetchStatus(`/api/store/${aSlug}/account/orders/${foreignOrderId}`),
        storeCookieScope: await fetchStatus(`/api/store/${bSlug}/account/orders`),
        addressCheckout: await fetchStatus(`/api/store/${aSlug}/checkout`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "phase9b-foreign-address-key-00001",
          },
          body: JSON.stringify({
            cartVersion,
            addressId: foreignAddressId,
            paymentMethodCode: "cod",
          }),
        }),
      };
    },
    {
      aSlug: storeA.slug,
      bSlug: storeB.slug,
      foreignOrderId: orderId,
      foreignAddressId: addressA.addresses[0].id,
      cartVersion: customerBCart.cart.version,
    }
  );
  const tokenIsolation = await Promise.all([
    api(`/api/store/${storeB.slug}/account/orders`, {
      headers: { authorization: `Bearer ${customerB.accessToken}` },
    }),
    api(`/api/merchant/stores/${storeA.slug}/orders`, {
      headers: { authorization: `Bearer ${customerB.accessToken}` },
    }),
  ]);
  assert.equal(idor.order, 404);
  assert.equal(idor.storeCookieScope, 401);
  assert.equal(idor.addressCheckout, 404);
  assert.equal(tokenIsolation[0].status, 403);
  assert.equal(tokenIsolation[1].status, 403);

  // UI-03: two identical browser submissions return one idempotent order.
  const duplicateCheckout = await pageB.evaluate(
    async ({ slug, addressId, cartVersion }) => {
      const init = {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "phase9b-double-submit-key-00001",
        },
        body: JSON.stringify({ cartVersion, addressId, paymentMethodCode: "cod" }),
      };
      const responses = await Promise.all([
        fetch(`/api/store/${slug}/checkout`, init),
        fetch(`/api/store/${slug}/checkout`, init),
      ]);
      return Promise.all(
        responses.map(async (response) => ({
          status: response.status,
          body: await response.json(),
        }))
      );
    },
    { slug: storeA.slug, addressId: addressB.id, cartVersion: customerBCart.cart.version }
  );
  assert.deepEqual(duplicateCheckout.map((result) => result.status).sort(), [200, 201]);
  assert.equal(duplicateCheckout[0].body.order.id, duplicateCheckout[1].body.order.id);

  // UI-06: price snapshot, product availability and scarce-stock behavior.
  const unavailableProduct = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "UI-A-UNAVAILABLE",
      name: "منتج لقطة السعر",
      priceIqd: 4000,
      stockQuantity: 1,
      lowStockThreshold: 1,
    },
  });
  const stockProduct = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "UI-A-STOCK",
      name: "منتج مخزون محدود",
      priceIqd: 5000,
      stockQuantity: 1,
      lowStockThreshold: 1,
    },
  });
  const customerC = await registerCustomer(storeA.slug, {
    phone: "+9647700000103",
    fullName: "عميل لقطة السعر",
    password: "Phase9BCustomerCPass123!",
  });
  const customerD = await registerCustomer(storeA.slug, {
    phone: "+9647700000104",
    fullName: "عميل مخزون أول",
    password: "Phase9BCustomerDPass123!",
  });
  const customerE = await registerCustomer(storeA.slug, {
    phone: "+9647700000105",
    fullName: "عميل مخزون ثان",
    password: "Phase9BCustomerEPass123!",
  });
  const [addressC, addressD, addressE] = await Promise.all([
    addAddress(storeA.slug, customerC.accessToken),
    addAddress(storeA.slug, customerD.accessToken),
    addAddress(storeA.slug, customerE.accessToken),
  ]);
  const snapshotCart = await api(`/api/store/${storeA.slug}/cart/items`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${customerC.accessToken}`,
    },
    body: JSON.stringify({ productId: unavailableProduct.id, quantity: 1 }),
  });
  assert.equal(snapshotCart.status, 200);
  assert.equal(snapshotCart.body.cart.items[0].priceSnapshotIqd, 4000);
  await prisma.product.update({
    where: { id: unavailableProduct.id },
    data: { priceIqd: 7000, isActive: false },
  });
  const snapshotRead = await api(`/api/store/${storeA.slug}/cart`, {
    headers: { authorization: `Bearer ${customerC.accessToken}` },
  });
  assert.equal(snapshotRead.body.cart.items[0].priceSnapshotIqd, 4000);
  const unavailableCheckout = await api(`/api/store/${storeA.slug}/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${customerC.accessToken}`,
      "idempotency-key": "phase9b-product-unavailable-key",
    },
    body: JSON.stringify({
      cartVersion: snapshotRead.body.cart.version,
      addressId: addressC.id,
      paymentMethodCode: "cod",
    }),
  });
  assert.equal(unavailableCheckout.status, 422);
  assert.equal(unavailableCheckout.body.error.code, "PRODUCT_UNAVAILABLE");
  const [stockCartD, stockCartE] = await Promise.all(
    [customerD, customerE].map((customer) =>
      api(`/api/store/${storeA.slug}/cart/items`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${customer.accessToken}`,
        },
        body: JSON.stringify({ productId: stockProduct.id, quantity: 1 }),
      })
    )
  );
  const stockCheckoutD = await api(`/api/store/${storeA.slug}/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${customerD.accessToken}`,
      "idempotency-key": "phase9b-stock-customer-d-key",
    },
    body: JSON.stringify({
      cartVersion: stockCartD.body.cart.version,
      addressId: addressD.id,
      paymentMethodCode: "cod",
    }),
  });
  const stockCheckoutE = await api(`/api/store/${storeA.slug}/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${customerE.accessToken}`,
      "idempotency-key": "phase9b-stock-customer-e-key",
    },
    body: JSON.stringify({
      cartVersion: stockCartE.body.cart.version,
      addressId: addressE.id,
      paymentMethodCode: "cod",
    }),
  });
  assert.equal(stockCheckoutD.status, 201);
  assert.equal(stockCheckoutE.status, 422);
  assert.equal(stockCheckoutE.body.error.code, "INSUFFICIENT_AVAILABLE_STOCK");

  // UI-07: customer timeline excludes internal actor/note fields.
  const timeline = await pageA.evaluate(
    async ({ slug, order }) => {
      const response = await fetch(`/api/store/${slug}/account/orders/${order}/history`, {
        credentials: "same-origin",
      });
      return { status: response.status, body: await response.json() };
    },
    { slug: storeA.slug, order: orderId }
  );
  assert.equal(timeline.status, 200);
  assert.ok(timeline.body.events.length >= 1);
  assert.equal(
    timeline.body.events.every(
      (event) =>
        !Object.hasOwn(event, "actorKind") &&
        !Object.hasOwn(event, "actorId") &&
        !Object.hasOwn(event, "note")
    ),
    true
  );

  await browser.close();
  console.log(
    JSON.stringify(
      {
        scenarios: {
          "UI-01": "passed",
          "UI-02": "passed",
          "UI-03": "passed",
          "UI-04": "passed",
          "UI-05": "passed",
          "UI-06": "passed",
          "UI-07": "passed",
          "UI-12": "passed",
        },
        orderId,
        isolation: {
          ...idor,
          tokenCrossStore: tokenIsolation[0].status,
          tokenMerchant: tokenIsolation[1].status,
        },
        idempotency: duplicateCheckout.map((result) => result.status),
        pricingAndInventory: {
          snapshotIqd: snapshotRead.body.cart.items[0].priceSnapshotIqd,
          unavailable: unavailableCheckout.status,
          stock: [stockCheckoutD.status, stockCheckoutE.status],
        },
        timelineProjection: "no_internal_actor_or_note",
      },
      null,
      2
    )
  );
} finally {
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

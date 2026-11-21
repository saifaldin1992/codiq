import assert from "node:assert/strict";
import { ownProvisionedPassword } from "./helpers/own-provisioned-password.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `phase8b-ui-${Date.now()}`;
const port = 3122;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "phase8b-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    SESSION_JWT_SECRET: "phase8b-browser-seed-secret-not-for-production",
  },
  stdio: "ignore",
});

async function waitFor(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return { response, body: await response.json().catch(() => null) };
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Expected authenticated response to set a session cookie.");
  return setCookie.split(";", 1)[0];
}

async function browserLogin(page, kind, { email, password, storeSlug }) {
  await page.goto(`${base}/${kind === "merchant" ? "merchant" : "platform"}/login`);
  // P27-21: the merchant door no longer asks for a store, and its identity field
  // accepts a phone too — so the two kinds no longer share a label. (The owner's
  // ORDER FILTER further down still says «معرّف المتجر» and is a different
  // control entirely; it is deliberately untouched.)
  await page
    .getByLabel(kind === "merchant" ? "البريد الإلكتروني أو رقم الهاتف" : "البريد الإلكتروني")
    .fill(email);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(password);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL(
    kind === "merchant"
      ? new RegExp(`/merchant/stores/${storeSlug}/dashboard`)
      : /\/platform\/dashboard/
  );
}

try {
  await waitFor(`${base}/health`);
  // `storefront_rate_limits` belongs on this list and was the one table missing
  // from it. The limiter is keyed on `platform:<ip>` — 30 dashboard logins per
  // ten minutes — and every suite on this runner is the same 127.0.0.1 writing
  // into the same shared database, so the counter is a number this suite
  // INHERITS rather than one it sets. Ten consecutive runs walked it past the
  // ceiling and the owner login answered 429 instead of 200: four passes, six
  // failures. Nothing about phase 8B was wrong — it was reading another suite's
  // meter. Every other truncating suite already clears it.
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
  );

  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantAEmail = `${runId}.merchant-a@codiq.test`;
  const merchantBEmail = `${runId}.merchant-b@codiq.test`;
  const ownerPassword = "Phase8BOwnerPass123!";
  let merchantPassword = "Phase8BMerchantPass123!";

  const ownerRegister = await json("/api/auth/platform/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: ownerEmail,
      password: ownerPassword,
      displayName: "مالك قبول 8B",
    }),
  });
  assert.equal(ownerRegister.response.status, 201);
  const ownerLogin = await json("/api/auth/platform/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  assert.equal(ownerLogin.response.status, 200);
  const ownerCookie = sessionCookie(ownerLogin.response);

  // P27-12: the merchant phone is unique across the PLATFORM, so a helper called
  // more than once needs a number per call — a shared literal answers 409 and
  // reads like a logic bug rather than the fixture mistake it is.
  let provisionedMerchants = 0;
  async function provisionMerchant(email, businessName, storeName) {
    provisionedMerchants += 1;
    const phone = `+964710066350${provisionedMerchants}`;
    const created = await json("/api/platform/merchants/manual", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        ownerName: "صاحب المتجر",
        phone,
        email,
        temporaryPassword: merchantPassword,
        businessName,
        firstStoreName: storeName,
      }),
    });
    assert.equal(created.response.status, 201);
    return created.body;
  }
  const merchantA = await provisionMerchant(merchantAEmail, "تاجر قبول A", "متجر قبول A");
  const merchantB = await provisionMerchant(merchantBEmail, "تاجر قبول B", "متجر قبول B");
  // ق-218/ق-226: a hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens — otherwise the login below lands on
  // «الأمان» and this suite waits for a dashboard that will never come. Only
  // merchant A ever signs in; B exists to be a foreign store, and a row that is
  // never logged into needs no password of its own.
  merchantPassword = await ownProvisionedPassword(base, merchantAEmail, merchantPassword);
  const storeA = merchantA.store;
  const storeB = merchantB.store;
  const customerA = await prisma.customer.create({
    data: {
      storeId: storeA.id,
      email: `${runId}.customer-a@codiq.test`,
      passwordHash: "not-used",
      fullName: "عميل متجر A",
    },
  });
  const productA = await prisma.product.create({
    data: {
      storeId: storeA.id,
      sku: "SNAPSHOT-001",
      name: "منتج لقطة الطلب",
      priceIqd: 1000,
      stockQuantity: 8,
      lowStockThreshold: 2,
    },
  });

  const seeded = {};
  async function createA(suffix, status, withItem = false) {
    const order = await prisma.storeOrder.create({
      data: {
        storeId: storeA.id,
        customerId: customerA.id,
        orderNumber: `UI-A-${suffix}`,
        status,
        customerName: customerA.fullName,
        customerEmail: customerA.email,
        recipientPhone: "07700000001",
        shippingGovernorate: "بغداد",
        shippingAddressLine1: "حي الاختبار",
        subtotalIqd: withItem ? 1000 : 500,
        totalIqd: withItem ? 1000 : 500,
        items: withItem
          ? {
              create: {
                productId: productA.id,
                sku: productA.sku,
                productName: productA.name,
                quantity: 1,
                unitPriceIqd: 1000,
                lineTotalIqd: 1000,
              },
            }
          : undefined,
      },
    });
    seeded[suffix] = order;
    return order;
  }
  const newOrder = await createA("NEW", "new", true);
  const processingOrder = await createA("PROCESSING", "processing");
  const preparationOrder = await createA("PREPARATION", "preparation");
  const deliveryOrder = await createA("DELIVERY", "out_for_delivery");
  const completedOrder = await createA("COMPLETED", "completed");
  const cancelledOrder = await createA("CANCELLED", "cancelled");
  const rejectedOrder = await createA("REJECTED", "rejected");
  const returnedOrder = await createA("RETURNED", "returned");
  const concurrentOrder = await createA("CONCURRENT", "new");
  for (let index = 0; index < 27; index += 1)
    await createA(`PAGE-${String(index).padStart(2, "0")}`, "new");
  const orderB = await prisma.storeOrder.create({
    data: {
      storeId: storeB.id,
      orderNumber: "UI-B-FOREIGN",
      status: "new",
      customerName: "عميل متجر B",
      subtotalIqd: 700,
      totalIqd: 700,
    },
  });
  await prisma.product.update({
    where: { id: productA.id },
    data: { name: "اسم المنتج بعد التعديل", priceIqd: 9999 },
  });
  const stockBefore = await prisma.product.findUniqueOrThrow({
    where: { id: productA.id },
    select: { stockQuantity: true },
  });
  const movementsBefore = await prisma.inventoryMovement.count({
    where: { productId: productA.id },
  });

  const browser = await chromium.launch({ headless: true });
  const merchantContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const merchantPage = await merchantContext.newPage();
  await browserLogin(merchantPage, "merchant", {
    email: merchantAEmail,
    password: merchantPassword,
    storeSlug: storeA.slug,
  });

  // M-01, M-03, M-05: store-scoped list, searching, and cursor pagination.
  await merchantPage.goto(`${base}/merchant/stores/${storeA.slug}/dashboard/orders`);
  await merchantPage.getByText("UI-A-PAGE-26").waitFor();
  assert.equal(await merchantPage.getByText("UI-B-FOREIGN").count(), 0);
  await merchantPage.getByLabel("البحث برقم الطلب").fill("UI-A-NEW");
  await merchantPage.getByRole("button", { name: "تطبيق" }).click();
  await merchantPage.getByText("UI-A-NEW").waitFor();
  await merchantPage.getByRole("button", { name: "مسح" }).click();
  await merchantPage.getByRole("button", { name: "تحميل المزيد" }).click();
  await merchantPage.getByText("UI-A-NEW").waitFor();

  // M-02 and M-04: each status view and date-filter empty state.
  const merchantStatusPaths = [
    ["action-needed", "UI-A-PAGE-26"],
    ["new", "UI-A-PAGE-26"],
    ["processing", "UI-A-PROCESSING"],
    ["preparation", "UI-A-PREPARATION"],
    ["out-for-delivery", "UI-A-DELIVERY"],
    ["completed", "UI-A-COMPLETED"],
    ["cancelled", "UI-A-CANCELLED"],
    ["rejected", "UI-A-REJECTED"],
    ["returned", "UI-A-RETURNED"],
  ];
  for (const [path, expectedOrder] of merchantStatusPaths) {
    await merchantPage.goto(`${base}/merchant/stores/${storeA.slug}/dashboard/orders/${path}`);
    await merchantPage.getByText(expectedOrder).waitFor();
  }
  await merchantPage.goto(`${base}/merchant/stores/${storeA.slug}/dashboard/orders`);
  await merchantPage.getByLabel("من تاريخ").fill("2100-01-01");
  await merchantPage.getByRole("button", { name: "تطبيق" }).click();
  await merchantPage.getByText("لا توجد طلبات تطابق المرشحات الحالية.").waitFor();
  await merchantPage.getByRole("button", { name: "مسح" }).click();

  // M-06, M-19, M-20, M-21: missing store context and cross-boundary UI states.
  await merchantPage.goto(`${base}/merchant/dashboard/orders`);
  await merchantPage.getByText("اختر متجراً عبر مسار لوحة التاجر").waitFor();
  await merchantPage.goto(`${base}/merchant/stores/${storeB.slug}/dashboard/orders`);
  await merchantPage.getByText("ليست لديك صلاحية الوصول إلى هذه الطلبات.").waitFor();
  await merchantPage.goto(`${base}/merchant/stores/${storeA.slug}/dashboard/orders/${orderB.id}`);
  await merchantPage.getByText("الطلب المطلوب غير موجود ضمن نطاق المتجر الحالي.").waitFor();
  // ق-171: the owner shell no longer draws for another identity. A merchant
  // who types its URL is sent to the owner login BEFORE any screen mounts —
  // the in-page refusal this used to wait for can no longer be reached.
  await merchantPage.goto(`${base}/platform/dashboard/orders`);
  await merchantPage.waitForURL(/\/platform\/login$/);

  // M-07 to M-18: detail, allowed actions, disallowed actions, final state, concurrency, and inventory stability.
  await merchantPage.goto(`${base}/merchant/stores/${storeA.slug}/dashboard/orders/${newOrder.id}`);
  await merchantPage.getByText("بنود الطلب").waitFor();
  await merchantPage.getByText("منتج لقطة الطلب").waitFor();
  assert.equal(await merchantPage.getByRole("button", { name: "نقل إلى «جديدة»" }).count(), 0);
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التجهيز»" }).waitFor();
  const invalidNew = await merchantPage.evaluate(
    async ({ slug, orderId }) => {
      const response = await fetch(`/api/merchant/stores/${slug}/orders/${orderId}/status`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toStatus: "new", expectedVersion: 2 }),
      });
      return response.status;
    },
    { slug: storeA.slug, orderId: newOrder.id }
  );
  assert.equal(invalidNew, 422);
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التجهيز»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التوصيل»" }).waitFor();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التوصيل»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «مكتملة»" }).waitFor();
  await merchantPage.getByRole("button", { name: "نقل إلى «مكتملة»" }).click();
  // See phase20a: «مرتجعة» is already offered at out_for_delivery, so it is a
  // false signal. Completion is what removes the «مكتملة» button.
  await merchantPage
    .getByRole("button", { name: "نقل إلى «مكتملة»" })
    .waitFor({ state: "detached" });
  await merchantPage.getByRole("button", { name: "نقل إلى «مرتجعة»" }).click();
  await merchantPage.getByText("هذه حالة نهائية؛ لا توجد انتقالات إضافية.").waitFor();
  await merchantPage.goto(
    `${base}/merchant/stores/${storeA.slug}/dashboard/orders/${deliveryOrder.id}`
  );
  assert.equal(await merchantPage.getByRole("button", { name: "نقل إلى «ملغاة»" }).count(), 0);
  const forbiddenDeliveryCancel = await merchantPage.evaluate(
    async ({ slug, orderId }) => {
      const response = await fetch(`/api/merchant/stores/${slug}/orders/${orderId}/status`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toStatus: "cancelled", expectedVersion: 1 }),
      });
      return response.status;
    },
    { slug: storeA.slug, orderId: deliveryOrder.id }
  );
  assert.equal(forbiddenDeliveryCancel, 422);
  await merchantPage.goto(
    `${base}/merchant/stores/${storeA.slug}/dashboard/orders/${cancelledOrder.id}`
  );
  await merchantPage.getByText("هذه حالة نهائية؛ لا توجد انتقالات إضافية.").waitFor();

  const stalePage = await merchantPage.context().newPage();
  await stalePage.setViewportSize({ width: 1280, height: 800 });
  await stalePage.goto(
    `${base}/merchant/stores/${storeA.slug}/dashboard/orders/${concurrentOrder.id}`
  );
  await stalePage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).waitFor();
  await merchantPage.goto(
    `${base}/merchant/stores/${storeA.slug}/dashboard/orders/${concurrentOrder.id}`
  );
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التجهيز»" }).waitFor();
  await stalePage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).click();
  await stalePage.getByText("تم تحديث الطلب في جلسة أو نافذة أخرى.").waitFor();
  await stalePage.close();
  const stockAfter = await prisma.product.findUniqueOrThrow({
    where: { id: productA.id },
    select: { stockQuantity: true },
  });
  const movementsAfter = await prisma.inventoryMovement.count({
    where: { productId: productA.id },
  });
  assert.equal(stockAfter.stockQuantity, stockBefore.stockQuantity);
  assert.equal(movementsAfter, movementsBefore);

  // M-22: Customer identity remains outside all operational order views.
  const customerToken = await createTypedSession("customer", customerA.id);
  const customerOrders = await fetch(`${base}/api/merchant/stores/${storeA.slug}/orders`, {
    headers: { authorization: `Bearer ${customerToken}` },
  });
  assert.equal(customerOrders.status, 403);

  // O-01 to O-07: global read-only owner view, filters, detail/history, and unknown order state.
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const ownerPage = await ownerContext.newPage();
  await browserLogin(ownerPage, "platform", { email: ownerEmail, password: ownerPassword });
  await ownerPage.goto(`${base}/platform/dashboard/orders`);
  await ownerPage.getByText("UI-A-PAGE-26").waitFor();
  await ownerPage.getByText("UI-B-FOREIGN").waitFor();
  const ownerStatusPaths = [
    ["processing", "UI-A-PROCESSING"],
    ["fulfillment", "UI-A-PREPARATION"],
    ["out-for-delivery", "UI-A-DELIVERY"],
    ["completed", "UI-A-COMPLETED"],
    ["cancelled", "UI-A-CANCELLED"],
    ["returned", "UI-A-RETURNED"],
  ];
  for (const [path, expectedOrder] of ownerStatusPaths) {
    await ownerPage.goto(`${base}/platform/dashboard/orders/${path}`);
    await ownerPage.getByText(expectedOrder).waitFor();
  }
  await ownerPage.goto(`${base}/platform/dashboard/orders`);
  await ownerPage.getByLabel("معرّف المتجر").fill(storeB.slug);
  await ownerPage.getByRole("button", { name: "تطبيق" }).click();
  await ownerPage.getByText("UI-B-FOREIGN").waitFor();
  assert.equal(await ownerPage.getByText("UI-A-NEW").count(), 0);
  await ownerPage.getByRole("button", { name: "مسح" }).click();
  await ownerPage.getByText("UI-A-PAGE-26").waitFor();
  await ownerPage.getByLabel("معرّف التاجر").fill(merchantA.merchant.id);
  const merchantFilterResponse = ownerPage.waitForResponse(
    (response) =>
      response.url().includes("/api/platform/orders?") &&
      new URL(response.url()).searchParams.get("merchantId") === merchantA.merchant.id &&
      response.request().method() === "GET"
  );
  await ownerPage.getByRole("button", { name: "تطبيق" }).click();
  assert.equal((await merchantFilterResponse).status(), 200);
  await ownerPage.getByText("UI-A-PAGE-26").waitFor();
  await ownerPage.getByText("UI-B-FOREIGN").waitFor({ state: "hidden" });
  await ownerPage.getByRole("button", { name: "مسح" }).click();
  await ownerPage.getByText("UI-A-PAGE-26").waitFor();
  await ownerPage.getByLabel("البحث برقم الطلب").fill("UI-A-NEW");
  // Wait for the FILTER RESPONSE before clicking, exactly as the merchantId
  // filter above already does. Waiting only for the text lets the click race the
  // re-render that the same filter triggers, and the row detaches mid-click.
  const orderNumberFilterResponse = ownerPage.waitForResponse(
    (response) =>
      response.url().includes("/api/platform/orders?") && response.request().method() === "GET"
  );
  await ownerPage.getByRole("button", { name: "تطبيق" }).click();
  assert.equal((await orderNumberFilterResponse).status(), 200);
  await ownerPage.getByText("UI-A-NEW").waitFor();
  await ownerPage.getByText("UI-A-NEW").first().click();
  await ownerPage.getByText("إشراف للقراءة فقط").waitFor();
  assert.equal(await ownerPage.getByText("تحديث حالة الطلب").count(), 0);
  await ownerPage.goto(`${base}/platform/dashboard/orders/${newOrder.id}/history`);
  await ownerPage.getByText("سجل الحالة").waitFor();
  await ownerPage.goto(`${base}/platform/dashboard/orders/00000000-0000-0000-0000-000000000000`);
  await ownerPage.getByText("الطلب المطلوب غير موجود").waitFor();

  // U-01 to U-04: mobile navigation, keyboard focus, empty/error presentation, and active order navigation.
  await merchantPage.setViewportSize({ width: 390, height: 844 });
  await merchantPage.goto(`${base}/merchant/stores/${storeA.slug}/dashboard/orders/processing`);
  await merchantPage.getByLabel("فتح القائمة").click();
  await merchantPage.getByLabel("تنقل لوحة التاجر").last().waitFor();
  const activeProcessingNav = merchantPage.locator('button[aria-current="page"]', {
    hasText: "قيد المعالجة",
  });
  assert.ok((await activeProcessingNav.count()) >= 1);
  await merchantPage.getByRole("button", { name: "تطبيق" }).focus();
  assert.equal(
    await merchantPage
      .getByRole("button", { name: "تطبيق" })
      .evaluate((element) => document.activeElement === element),
    true
  );
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.goto(`${base}/platform/dashboard/orders`);
  await ownerPage.getByLabel("فتح القائمة").click();
  await ownerPage.getByLabel("التنقل الرئيسي").last().waitFor();
  const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu";
  fs.mkdirSync(artifactsDir, { recursive: true });
  await merchantPage.screenshot({
    path: `${artifactsDir}/phase8b-merchant-orders.png`,
    fullPage: true,
  });
  await ownerPage.screenshot({ path: `${artifactsDir}/phase8b-owner-orders.png`, fullPage: true });
  await browser.close();

  console.log(
    JSON.stringify(
      {
        scenarios: { merchant: "M-01–M-22", owner: "O-01–O-07", usability: "U-01–U-04" },
        orders: {
          storeA: storeA.slug,
          storeB: storeB.slug,
          completedToReturned: newOrder.id,
          concurrency: concurrentOrder.id,
        },
        browserScreenshots: [
          `${artifactsDir}/phase8b-merchant-orders.png`,
          `${artifactsDir}/phase8b-owner-orders.png`,
        ],
        stockInvariant: {
          before: stockBefore.stockQuantity,
          after: stockAfter.stockQuantity,
          movementsBefore,
          movementsAfter,
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

/**
 * codiq phase 20A-2 browser acceptance — product variants UI.
 * The merchant creates a product from the dashboard, adds two variants with
 * different prices/stock from the new variant editor, and adjusts variant
 * inventory through the variant inventory route. The storefront shows the
 * variant picker, switching variants changes the displayed price, add-to-cart
 * carries the chosen variantId, the cart line shows the variant name, checkout
 * completes, and completing the order from the merchant orders UI decrements
 * the chosen VARIANT's stock only. A default-only product renders with no
 * picker and still purchases exactly like before 20A.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `phase20a-ui-${Date.now().toString(36)}`;
const port = 3201;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "phase20a-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "phase20a-browser-seed-secret-not-for-production", CODIQ_NOTIFICATIONS_WORKER: "off" },
  stdio: "ignore",
});

const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(artifactsDir, { recursive: true });
const executablePath = process.env.CODIQ_CHROMIUM_PATH ?? (process.platform === "linux" ? "/usr/bin/chromium" : undefined);
const fmt = new Intl.NumberFormat("ar-IQ");

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe("TRUNCATE TABLE settlements, ledger_entries, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE");

  // ---------- seed: owner provisions the merchant + store; delivery rate ----------
  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  // `let` because ق-218 makes the merchant replace the provisioner's password
  // before anything else, and every later sign-in uses the one he chose.
  let merchantPassword = "Phase20AMerchantPass123!";
  const ownerRegister = await json("/api/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: "Phase20AOwnerPass123!", displayName: "مالك قبول 20A" }) });
  assert.equal(ownerRegister.response.status, 201);
  const ownerLogin = await json("/api/auth/platform/login", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: "Phase20AOwnerPass123!" }) });
  const ownerCookie = ownerLogin.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(ownerCookie);
  const merchantCreated = await json("/api/platform/merchants/manual", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100648401", email: merchantEmail, temporaryPassword: merchantPassword, businessName: "تاجر متغيرات 20A", firstStoreName: "متجر المتغيرات" }) });
  assert.equal(merchantCreated.response.status, 201, JSON.stringify(merchantCreated.body));
  const storeSlug = merchantCreated.body.store.slug;
  // ق-218: a hand-provisioned merchant must replace the password the provisioner
  // typed before any merchant surface opens — `phase6:test` proves that gate end
  // to end. This suite is about VARIANTS, so it does here what the merchant does
  // on his first login, in one call, and gets on with its subject.
  const merchantSession = await json("/api/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: merchantEmail, password: merchantPassword }) });
  assert.equal(merchantSession.response.status, 200, JSON.stringify(merchantSession.body));
  const ownedPassword = await json("/api/auth/password", { method: "POST", headers: { authorization: `Bearer ${merchantSession.body.accessToken}` }, body: JSON.stringify({ currentPassword: merchantPassword, newPassword: merchantPassword + "-Owned1" }) });
  assert.equal(ownedPassword.response.status, 200, JSON.stringify(ownedPassword.body));
  merchantPassword = `${merchantPassword}-Owned1`;
  const store = await prisma.store.findUnique({ where: { slug: storeSlug }, select: { id: true } });
  // createStoreFoundation seeds all 18 governorate rates (disabled, 0 IQD) at
  // store creation, so the Baghdad row must be enabled, not created.
  await prisma.deliveryRate.update({ where: { storeId_governorate: { storeId: store.id, governorate: "Baghdad" } }, data: { amountIqd: 3000, isEnabled: true } });

  const baseSku = "P20A-BASE";
  const redSku = "P20A-RED-L";
  const blueSku = "P20A-BLUE-M";

  // ---------- merchant: product from the add form, variants from the editor ----------
  const merchantContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const merchantPage = await merchantContext.newPage();
  await merchantPage.goto(`${base}/merchant/login`);
  await merchantPage.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchantPage.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchantPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchantPage.waitForURL(new RegExp(`/merchant/stores/${storeSlug}/dashboard`));

  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/products/add`);
  await merchantPage.getByLabel("اسم المنتج").fill("قميص المتغيرات");
  await merchantPage.getByLabel("SKU").fill(baseSku);
  await merchantPage.getByLabel("السعر بالدينار العراقي").fill("10000");
  await merchantPage.getByLabel("كمية المخزون").fill("5");
  await merchantPage.getByLabel("حد تنبيه المخزون").fill("1");
  await merchantPage.getByRole("button", { name: "إنشاء المنتج" }).click();
  await merchantPage.getByText("تم إنشاء المنتج وصوره داخل المتجر الحالي.").waitFor();
  const product = await prisma.product.findFirst({ where: { storeId: store.id, sku: baseSku } });
  assert.ok(product, "product must exist after the add form");

  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/products`);
  await merchantPage.getByText("قميص المتغيرات").waitFor();
  await merchantPage.getByTestId(`product-variants-toggle-${baseSku}`).click();
  // The implicit default variant is listed with its protection badge and a disabled delete.
  await merchantPage.getByTestId(`variant-row-${baseSku}`).waitFor();
  await merchantPage.getByTestId(`variant-row-${baseSku}`).getByText("افتراضي").waitFor();
  assert.equal(await merchantPage.getByTestId(`variant-row-${baseSku}`).getByRole("button", { name: "إزالة" }).isDisabled(), true, "default variant delete must be disabled");

  async function addVariant({ name, sku, price, stock, optionKey, optionValue, expectedCount }) {
    await merchantPage.getByRole("button", { name: "إضافة متغير" }).click();
    await merchantPage.getByLabel("اسم المتغير").fill(name);
    await merchantPage.getByLabel("SKU المتغير").fill(sku);
    await merchantPage.getByLabel("سعر المتغير").fill(price);
    await merchantPage.getByLabel("مخزون المتغير").fill(stock);
    await merchantPage.getByLabel("حد تنبيه المتغير").fill("1");
    await merchantPage.getByRole("button", { name: "إضافة خيار" }).click();
    await merchantPage.getByLabel("مفتاح الخيار 1").fill(optionKey);
    await merchantPage.getByLabel("قيمة الخيار 1").fill(optionValue);
    await merchantPage.getByRole("button", { name: "حفظ المتغير" }).click();
    await merchantPage.getByTestId(`variant-row-${sku}`).waitFor();
    // The variants counter on the card updates only after the quiet parent
    // refresh lands — waiting on it makes the next interaction race-free.
    await merchantPage.getByRole("button", { name: `المتغيرات (${expectedCount})` }).waitFor();
  }
  await addVariant({ name: "أحمر / L", sku: redSku, price: "15000", stock: "4", optionKey: "اللون", optionValue: "أحمر", expectedCount: 2 });
  await addVariant({ name: "أزرق / M", sku: blueSku, price: "12000", stock: "3", optionKey: "اللون", optionValue: "أزرق", expectedCount: 3 });

  // Duplicate variant SKU is refused by the server (409) and surfaced in Arabic.
  await merchantPage.getByRole("button", { name: "إضافة متغير" }).click();
  await merchantPage.getByLabel("اسم المتغير").fill("متغير مكرر");
  await merchantPage.getByLabel("SKU المتغير").fill(redSku);
  await merchantPage.getByLabel("سعر المتغير").fill("1000");
  await merchantPage.getByRole("button", { name: "حفظ المتغير" }).click();
  await merchantPage.getByText("يوجد متغير آخر بنفس SKU داخل هذا المتجر.").waitFor();
  await merchantPage.getByRole("button", { name: "إلغاء" }).click();

  // Variant inventory adjustment goes through the variant inventory route.
  await merchantPage.getByTestId(`variant-row-${redSku}`).getByRole("button", { name: "ضبط المخزون" }).click();
  await merchantPage.getByLabel("الكمية الجديدة للمتغير").fill("6");
  await merchantPage.getByRole("button", { name: "حفظ مخزون المتغير" }).click();
  await merchantPage.getByTestId(`variant-row-${redSku}`).getByText("المخزون: 6").waitFor();
  const redAfterAdjust = await prisma.productVariant.findFirst({ where: { productId: product.id, sku: redSku } });
  assert.equal(redAfterAdjust.stockQuantity, 6, "variant inventory route must persist the new quantity");
  await merchantPage.screenshot({ path: `${artifactsDir}/phase20a-merchant-variants.png`, fullPage: true });

  // ---------- storefront: picker drives price, availability and the cart line ----------
  const shopperContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const shopperPage = await shopperContext.newPage();
  await shopperPage.goto(`${base}/store/${storeSlug}/products/${product.id}`);
  await shopperPage.getByTestId("variant-picker").waitFor();
  assert.equal(await shopperPage.getByTestId("variant-picker").getByRole("button").count(), 3, "picker must list the default variant and both added variants");
  await shopperPage.getByTestId("product-price").filter({ hasText: fmt.format(10000) }).waitFor();
  await shopperPage.getByTestId(`variant-option-${redSku}`).click();
  await shopperPage.getByTestId("product-price").filter({ hasText: fmt.format(15000) }).waitFor();
  await shopperPage.screenshot({ path: `${artifactsDir}/phase20a-storefront-picker.png`, fullPage: true });
  await shopperPage.getByRole("button", { name: "أضف إلى السلة" }).click();
  await shopperPage.getByLabel("السلة، 1 عناصر").waitFor();

  await shopperPage.goto(`${base}/store/${storeSlug}/cart`);
  await shopperPage.getByText("قميص المتغيرات").waitFor();
  await shopperPage.getByTestId("cart-line-variant").waitFor();
  assert.equal(await shopperPage.getByTestId("cart-line-variant").innerText(), "أحمر / L", "cart line must show the chosen variant name");
  await shopperPage.screenshot({ path: `${artifactsDir}/phase20a-cart-variant-line.png`, fullPage: true });

  // ق-201: the cart goes straight to checkout; the account door is on that page.
  await shopperPage.getByRole("button", { name: "إتمام الطلب" }).click();
  await shopperPage.getByTestId("guest-login-link").click();
  await shopperPage.getByRole("link", { name: "أنشئ حسابًا" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/account/register`));
  await shopperPage.getByLabel("الاسم الكامل").fill("عميل المتغيرات");
  await shopperPage.getByLabel("رقم الهاتف").fill("+9647711112222");
  await shopperPage.getByLabel("كلمة المرور", { exact: true }).fill("Phase20ACustomerPass123!");
  await shopperPage.getByLabel("تأكيد كلمة المرور").fill("Phase20ACustomerPass123!");
  await shopperPage.getByRole("button", { name: "إنشاء الحساب" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/checkout$`));
  await shopperPage.getByRole("button", { name: "عنوان جديد" }).click();
  await shopperPage.getByLabel("اسم المستلم").fill("عميل المتغيرات");
  await shopperPage.getByLabel("هاتف المستلم").fill("+9647711112222");
  await shopperPage.getByLabel("العنوان التفصيلي").fill("شارع المتغيرات 20A");
  await shopperPage.getByLabel("المدينة").fill("Baghdad");
  // ق-162: المحافظة صارت قائمة اختيار — الزبون يرى «بغداد» ويُخزَّن `Baghdad`.
  await shopperPage.getByLabel("المحافظة").selectOption("Baghdad");
  await shopperPage.getByRole("button", { name: "حفظ العنوان وحساب التوصيل" }).click();
  await shopperPage.getByText("التوصيل — Baghdad").waitFor();
  await shopperPage.getByRole("button", { name: "تأكيد الطلب — الدفع عند الاستلام" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/account/orders/`));
  const orderId = new URL(shopperPage.url()).pathname.split("/").at(-1);
  assert.ok(orderId);
  const orderItems = await prisma.orderItem.findMany({ where: { orderId } });
  assert.equal(orderItems.length, 1);
  assert.equal(orderItems[0].variantId, redAfterAdjust.id, "order line must reference the chosen variant");
  assert.equal(orderItems[0].variantName, "أحمر / L");

  // ---------- merchant completes the order from the orders UI; variant stock settles ----------
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/orders/${orderId}`);
  await merchantPage.getByText("بنود الطلب").waitFor();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التجهيز»" }).waitFor();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التجهيز»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التوصيل»" }).waitFor();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التوصيل»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «مكتملة»" }).waitFor();
  await merchantPage.getByRole("button", { name: "نقل إلى «مكتملة»" }).click();
  // NOT the «مرتجعة» button: out_for_delivery already offers both completed and
  // returned, so that button is on screen BEFORE the click and waiting for it
  // proves nothing — the assertions below then race the settlement. Completion
  // is the only edge that REMOVES the «مكتملة» button, so its disappearance is
  // the signal that the write actually landed.
  await merchantPage.getByRole("button", { name: "نقل إلى «مكتملة»" }).waitFor({ state: "detached" });
  await merchantPage.screenshot({ path: `${artifactsDir}/phase20a-order-completed.png`, fullPage: true });

  const [redSettled, blueSettled, defaultSettled] = await Promise.all([
    prisma.productVariant.findFirst({ where: { productId: product.id, sku: redSku } }),
    prisma.productVariant.findFirst({ where: { productId: product.id, sku: blueSku } }),
    prisma.productVariant.findFirst({ where: { productId: product.id, sku: baseSku } }),
  ]);
  assert.equal(redSettled.stockQuantity, 5, "completed order must decrement the purchased variant (6 -> 5)");
  assert.equal(blueSettled.stockQuantity, 3, "sibling variant stock must be untouched");
  assert.equal(defaultSettled.stockQuantity, 5, "default variant stock must be untouched");
  const reservations = await prisma.inventoryReservation.findMany({ where: { orderId } });
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, "consumed");
  assert.equal(reservations[0].variantId, redSettled.id);

  // ---------- a default-only product renders with no picker and still purchases ----------
  const soloProduct = await prisma.product.create({ data: { storeId: store.id, sku: "P20A-SOLO", name: "منتج افتراضي فقط", priceIqd: 7000, stockQuantity: 2, lowStockThreshold: 0 } });
  await shopperPage.goto(`${base}/store/${storeSlug}/products/${soloProduct.id}`);
  await shopperPage.getByTestId("product-price").filter({ hasText: fmt.format(7000) }).waitFor();
  assert.equal(await shopperPage.getByTestId("variant-picker").count(), 0, "default-only product must render without a picker");
  await shopperPage.getByRole("button", { name: "أضف إلى السلة" }).click();
  await shopperPage.getByLabel("السلة، 1 عناصر").waitFor();
  await shopperPage.goto(`${base}/store/${storeSlug}/cart`);
  await shopperPage.getByText("منتج افتراضي فقط").waitFor();
  assert.equal(await shopperPage.getByTestId("cart-line-variant").count(), 0, "default-only cart line must carry no variant chip");
  await shopperPage.getByRole("button", { name: "إتمام الطلب" }).click();
  await shopperPage.getByText("التوصيل — Baghdad").waitFor();
  await shopperPage.getByRole("button", { name: "تأكيد الطلب — الدفع عند الاستلام" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/account/orders/`));
  const soloOrderId = new URL(shopperPage.url()).pathname.split("/").at(-1);
  const soloDefaultVariant = await prisma.productVariant.findFirst({ where: { productId: soloProduct.id, isDefault: true } });
  const soloItems = await prisma.orderItem.findMany({ where: { orderId: soloOrderId } });
  assert.equal(soloItems.length, 1);
  assert.equal(soloItems[0].variantId, soloDefaultVariant.id, "legacy add-to-cart must resolve the implicit default variant");
  const soloReservations = await prisma.inventoryReservation.findMany({ where: { orderId: soloOrderId } });
  assert.equal(soloReservations.length, 1);
  assert.equal(soloReservations[0].status, "active");
  assert.equal(soloReservations[0].variantId, soloDefaultVariant.id);

  await merchantContext.close();
  await shopperContext.close();
  console.log(JSON.stringify({
    phase: "20A-2",
    flow: {
      merchantVariantEditor: { defaultProtected: true, variantsCreated: [redSku, blueSku], duplicateSku409Surfaced: true, inventoryRouteAdjust: "4 -> 6" },
      storefront: { pickerOptions: 3, priceSwitched: "10000 -> 15000", cartVariantLine: "أحمر / L" },
      completion: { via: "merchant orders UI", variantDecrement: "6 -> 5", siblingUntouched: 3, reservation: "consumed" },
      defaultOnly: { picker: "absent", cartVariantLine: "absent", reservation: "active", orderVariant: "implicit default" },
    },
    orders: { variantOrderId: orderId, defaultOnlyOrderId: soloOrderId },
    screenshots: ["phase20a-merchant-variants.png", "phase20a-storefront-picker.png", "phase20a-cart-variant-line.png", "phase20a-order-completed.png"].map((name) => `${artifactsDir}/${name}`),
  }, null, 2));
} finally {
  await browser.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

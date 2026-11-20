/**
 * codiq phase 20B — unified browser acceptance for the whole growth batch
 * (20B-1 coupons + prescriptions, 20B-2 analytics + abandoned carts,
 * 20B-3 CSV + ad pixels). Real chromium against the production build:
 *
 *  1. merchant creates a coupon from CouponsManager;
 *  2. merchant configures + enables the ad pixels from the integrations page;
 *  3. merchant runs the CSV flow: dry-run preview, then commit, and the
 *     imported product appears in the products list;
 *  4. merchant toggles the abandoned-carts recovery panel;
 *  5. shopper storefront carries the injected pixels (fbq/ttq/dataLayer),
 *     applies the coupon at checkout (discount row renders), completes the
 *     order, and the GA4 dataLayer records add_to_cart + a purchase with the
 *     exact order total (fired once — !replayed);
 *  6. prescription journey: buy a flagged product, upload the prescription,
 *     merchant sees the blocked «قيد المعالجة», approves, transition unblocks;
 *  7. merchant completes the coupon order and the analytics page renders the
 *     exact realized-revenue numbers;
 *  8. dashboards carry NO pixel objects and NO third-party script tags —
 *     the StorefrontProvider-only injection holds in a real browser.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { killTree } from "./helpers/child-process.mjs";

const runId = `phase20b-ui-${Date.now().toString(36)}`;
const port = 3202;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "phase20b-browser-seed-secret-not-for-production";

// The prescription journey uploads through the S3-compatible pipeline, so this
// suite needs the moto emulator exactly like phase7 — without it the upload
// fails server-side and the order stays at pending_upload.
const s3Port = 5202;
const bucket = "codiq-phase20b-test";
process.env.PRODUCT_S3_ENDPOINT = `http://127.0.0.1:${s3Port}`;
process.env.PRODUCT_S3_BUCKET = bucket;
process.env.PRODUCT_S3_ACCESS_KEY_ID = "S3RVER";
process.env.PRODUCT_S3_SECRET_ACCESS_KEY = "S3RVER";
process.env.PRODUCT_S3_REGION = "us-east-1";
process.env.PRODUCT_S3_FORCE_PATH_STYLE = "true";

const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore", shell: process.platform === "win32" });
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  if (attempt === 59) throw new Error("Moto S3-compatible test server did not start.");
}
const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
const s3 = new S3Client({ endpoint: process.env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const { prisma } = await import("../src/db/prisma.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "phase20b-browser-seed-secret-not-for-production", CODIQ_ALLOW_OWNER_REGISTRATION: "true", CODIQ_NOTIFICATIONS_WORKER: "off" },
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

async function json(pathName, init = {}) {
  const response = await fetch(`${base}${pathName}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, store_marketing_settings, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

  // ---------- seed: owner provisions the merchant + store; products; delivery ----------
  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  // `let` because ق-218 makes the merchant replace the provisioner's password first.
  let merchantPassword = "Phase20BMerchantPass123!";
  assert.equal((await json("/api/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: "Phase20BOwnerPass123!", displayName: "مالك قبول 20B" }) })).response.status, 201);
  const ownerLogin = await json("/api/auth/platform/login", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: "Phase20BOwnerPass123!" }) });
  const ownerCookie = ownerLogin.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(ownerCookie, `owner login returned ${ownerLogin.response.status}: ${JSON.stringify(ownerLogin.body)}`);
  const merchantCreated = await json("/api/platform/merchants/manual", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100562101", email: merchantEmail, temporaryPassword: merchantPassword, businessName: "تاجر نمو 20B", firstStoreName: "متجر النمو" }) });
  assert.equal(merchantCreated.response.status, 201, JSON.stringify(merchantCreated.body));
  const storeSlug = merchantCreated.body.store.slug;
  // ق-218: the hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens (proven end to end in `phase6:test` and
  // through the UI in `phase6:browser`). This suite is about coupons and
  // prescriptions, so it does in one call what he does on his first login.
  const merchantSession = await json("/api/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: merchantEmail, password: merchantPassword }) });
  assert.equal(merchantSession.response.status, 200, JSON.stringify(merchantSession.body));
  const ownedPassword = await json("/api/auth/password", { method: "POST", headers: { authorization: `Bearer ${merchantSession.body.accessToken}` }, body: JSON.stringify({ currentPassword: merchantPassword, newPassword: `${merchantPassword}-Owned1` }) });
  assert.equal(ownedPassword.response.status, 200, JSON.stringify(ownedPassword.body));
  merchantPassword = `${merchantPassword}-Owned1`;
  const store = await prisma.store.findUnique({ where: { slug: storeSlug }, select: { id: true } });
  await prisma.deliveryRate.update({ where: { storeId_governorate: { storeId: store.id, governorate: "Baghdad" } }, data: { amountIqd: 2500, isEnabled: true } });
  const normalProduct = await prisma.product.create({ data: { storeId: store.id, sku: "P20B-NORM", name: "منتج النمو", priceIqd: 10000, stockQuantity: 20, lowStockThreshold: 1 } });
  const rxProduct = await prisma.product.create({ data: { storeId: store.id, sku: "P20B-RX", name: "دواء بوصفة", priceIqd: 8000, stockQuantity: 5, lowStockThreshold: 1, requiresPrescription: true } });

  // ---------- merchant dashboard flows ----------
  const merchantContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const merchantPage = await merchantContext.newPage();
  await merchantPage.goto(`${base}/merchant/login`);
  await merchantPage.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchantPage.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchantPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchantPage.waitForURL(new RegExp(`/merchant/stores/${storeSlug}/dashboard`));

  // 1. CouponsManager: create SAVE10 (10%).
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/marketing/coupons`);
  await merchantPage.getByTestId("coupon-code-input").fill("SAVE10");
  await merchantPage.getByTestId("coupon-submit").click();
  await merchantPage.getByTestId("coupon-row-SAVE10").waitFor();
  await merchantPage.screenshot({ path: `${artifactsDir}/phase20b-coupons.png`, fullPage: true });

  // 2. Ad pixels: configure + enable from the integrations settings page.
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/settings/integrations`);
  await merchantPage.getByTestId("pixel-meta-input").fill("1234567890123");
  await merchantPage.getByTestId("pixel-tiktok-input").fill("ABC123DEF456G");
  await merchantPage.getByTestId("pixel-ga4-input").fill("G-ABC123XYZ");
  await merchantPage.getByTestId("pixels-enabled-toggle").check();
  await merchantPage.getByTestId("pixels-save").click();
  await merchantPage.getByTestId("integrations-notice").waitFor();
  const pixelRow = await prisma.storeMarketingSettings.findUnique({ where: { storeId: store.id } });
  assert.equal(pixelRow.isEnabled, true);
  assert.equal(pixelRow.metaPixelId, "1234567890123");
  await merchantPage.screenshot({ path: `${artifactsDir}/phase20b-integrations.png`, fullPage: true });

  // 3. CSV: dry-run preview then commit; the product shows up in the list.
  const csvPath = path.join(artifactsDir, `${runId}-products.csv`);
  fs.writeFileSync(csvPath, [
    "product_sku,product_name,description,category_path,requires_prescription,variant_sku,variant_name,price_iqd,stock_quantity,low_stock_threshold,is_active,options_json",
    "CSV-UI,منتج CSV,وصف مستورد,مستوردات > صيفي,false,CSV-UI-A,خيار أ,6000,4,1,true,",
    "CSV-UI,,,,,CSV-UI-B,خيار ب,6500,2,1,true,",
  ].join("\r\n"), "utf8");
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/products/import-export`);
  await merchantPage.getByTestId("csv-file-input").setInputFiles(csvPath);
  await merchantPage.getByTestId("csv-dryrun").click();
  await merchantPage.getByTestId("csv-dryrun-summary").waitFor();
  const previewText = await merchantPage.getByTestId("csv-dryrun-summary").innerText();
  assert.ok(previewText.includes("لا أخطاء"), `dry-run preview must be clean: ${previewText}`);
  assert.equal(await prisma.product.count({ where: { storeId: store.id, sku: "CSV-UI" } }), 0, "the dry-run wrote nothing");
  await merchantPage.getByTestId("csv-commit").click();
  await merchantPage.getByTestId("csv-import-success").waitFor();
  await merchantPage.screenshot({ path: `${artifactsDir}/phase20b-csv-import.png`, fullPage: true });
  const importedProduct = await prisma.product.findFirst({ where: { storeId: store.id, sku: "CSV-UI" }, include: { variants: true } });
  assert.equal(importedProduct.variants.length, 2);
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/products`);
  await merchantPage.getByText("منتج CSV").waitFor();

  // 4. Abandoned-carts panel: opt-in toggle persists through the API.
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/customers/abandoned-carts`);
  // The checkbox is fully server-controlled (checked={settings.enabled}), so it
  // only flips once the PUT resolves — click and await the confirmation rather
  // than .check(), whose immediate post-click assertion races the request.
  await merchantPage.getByTestId("abandoned-enable").click();
  await merchantPage.getByTestId("abandoned-notice").waitFor();
  await merchantPage.waitForFunction(() => document.querySelector('[data-testid="abandoned-enable"]')?.checked === true);
  await merchantPage.reload();
  await merchantPage.getByTestId("abandoned-enable").waitFor();
  assert.equal(await merchantPage.getByTestId("abandoned-enable").isChecked(), true, "the opt-in survives a reload");

  // ---------- shopper: pixels + coupon checkout + purchase event ----------
  const shopperContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const shopperPage = await shopperContext.newPage();
  await shopperPage.goto(`${base}/store/${storeSlug}`);
  // 5a. the pixel bootstrap objects exist and the script tags are injected.
  await shopperPage.waitForFunction(() => typeof window.fbq === "function" && window.TiktokAnalyticsObject === "ttq" && Array.isArray(window.dataLayer));
  assert.ok(await shopperPage.evaluate(() => Boolean(document.querySelector('script[src*="connect.facebook.net"]'))), "Meta script tag injected in the storefront");
  assert.ok(await shopperPage.evaluate(() => Boolean(document.querySelector('script[src*="analytics.tiktok.com"]'))), "TikTok script tag injected in the storefront");
  assert.ok(await shopperPage.evaluate(() => Boolean(document.querySelector('script[src*="googletagmanager.com"]'))), "GA4 script tag injected in the storefront");

  // 5b. coupon checkout journey.
  await shopperPage.goto(`${base}/store/${storeSlug}/products/${normalProduct.id}`);
  await shopperPage.getByRole("button", { name: "أضف إلى السلة" }).click();
  await shopperPage.getByLabel("السلة، 1 عناصر").waitFor();
  await shopperPage.waitForFunction(() => Array.prototype.some.call(window.dataLayer ?? [], (entry) => entry && entry[0] === "event" && entry[1] === "add_to_cart"));
  await shopperPage.goto(`${base}/store/${storeSlug}/cart`);
  // ق-201: the cart goes straight to checkout; the account door is on that page.
  await shopperPage.getByRole("button", { name: "إتمام الطلب" }).click();
  await shopperPage.getByTestId("guest-login-link").click();
  await shopperPage.getByRole("link", { name: "أنشئ حسابًا" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/account/register`));
  await shopperPage.getByLabel("الاسم الكامل").fill("عميلة النمو");
  await shopperPage.getByLabel("رقم الهاتف").fill("+9647722223333");
  await shopperPage.getByLabel("كلمة المرور", { exact: true }).fill("Phase20BCustomerPass123!");
  await shopperPage.getByLabel("تأكيد كلمة المرور").fill("Phase20BCustomerPass123!");
  await shopperPage.getByRole("button", { name: "إنشاء الحساب" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/checkout$`));
  await shopperPage.getByRole("button", { name: "عنوان جديد" }).click();
  await shopperPage.getByLabel("اسم المستلم").fill("عميلة النمو");
  await shopperPage.getByLabel("هاتف المستلم").fill("+9647722223333");
  await shopperPage.getByLabel("العنوان التفصيلي").fill("شارع النمو 20B");
  await shopperPage.getByLabel("المدينة").fill("Baghdad");
  // ق-162: المحافظة صارت قائمة اختيار — الزبون يرى «بغداد» ويُخزَّن `Baghdad`.
  await shopperPage.getByLabel("المحافظة").selectOption("Baghdad");
  await shopperPage.getByRole("button", { name: "حفظ العنوان وحساب التوصيل" }).click();
  await shopperPage.getByText("التوصيل — Baghdad").waitFor();
  await shopperPage.locator("#checkout-coupon").fill("SAVE10");
  await shopperPage.getByRole("button", { name: "تطبيق" }).click();
  await shopperPage.getByText("الخصم (SAVE10)").waitFor();
  await shopperPage.screenshot({ path: `${artifactsDir}/phase20b-coupon-checkout.png`, fullPage: true });
  await shopperPage.getByRole("button", { name: "تأكيد الطلب — الدفع عند الاستلام" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/account/orders/`));
  const couponOrderId = new URL(shopperPage.url()).pathname.split("/").at(-1);
  const couponOrder = await prisma.storeOrder.findUniqueOrThrow({ where: { id: couponOrderId } });
  assert.equal(couponOrder.discountIqd, 1000, "10% of 10000");
  assert.equal(couponOrder.totalIqd, 11500, "9000 + 2500 delivery");
  assert.equal(couponOrder.couponCode, "SAVE10");
  // 5c. exactly ONE purchase event with the exact order total (!replayed guard).
  await shopperPage.waitForFunction((expected) => {
    const events = Array.prototype.filter.call(window.dataLayer ?? [], (entry) => entry && entry[0] === "event" && entry[1] === "purchase");
    return events.length === 1 && events[0][2] && events[0][2].value === expected;
  }, couponOrder.totalIqd);

  // ---------- 6. prescription journey ----------
  await shopperPage.goto(`${base}/store/${storeSlug}/products/${rxProduct.id}`);
  await shopperPage.getByTestId("prescription-badge").waitFor();
  await shopperPage.getByRole("button", { name: "أضف إلى السلة" }).click();
  await shopperPage.getByLabel("السلة، 1 عناصر").waitFor();
  await shopperPage.goto(`${base}/store/${storeSlug}/cart`);
  await shopperPage.getByRole("button", { name: "إتمام الطلب" }).click();
  await shopperPage.getByText("التوصيل — Baghdad").waitFor();
  await shopperPage.getByRole("button", { name: "تأكيد الطلب — الدفع عند الاستلام" }).click();
  await shopperPage.waitForURL(new RegExp(`/store/${storeSlug}/account/orders/`));
  const rxOrderId = new URL(shopperPage.url()).pathname.split("/").at(-1);
  await shopperPage.getByTestId("prescription-section").waitFor();
  await shopperPage.getByText("بانتظار رفع الوصفة").waitFor();
  const rxImagePath = path.join(artifactsDir, `${runId}-prescription.png`);
  fs.writeFileSync(rxImagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await shopperPage.getByTestId("prescription-file-input").setInputFiles(rxImagePath);
  await shopperPage.getByTestId("prescription-upload-button").click();
  await shopperPage.getByText("الوصفة قيد المراجعة").waitFor();
  await shopperPage.screenshot({ path: `${artifactsDir}/phase20b-prescription-uploaded.png`, fullPage: true });

  // Merchant: processing is BLOCKED until the approval, then unblocks.
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/orders/${rxOrderId}`);
  await merchantPage.getByTestId("prescription-gate-reason").waitFor();
  assert.equal(await merchantPage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).isDisabled(), true, "processing must be disabled before the approval");
  await merchantPage.getByTestId("prescription-approve").click();
  await merchantPage.getByText("وصفة معتمدة").first().waitFor();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).click();
  await merchantPage.getByRole("button", { name: "نقل إلى «قيد التجهيز»" }).waitFor();
  await merchantPage.screenshot({ path: `${artifactsDir}/phase20b-prescription-approved.png`, fullPage: true });

  // ---------- 7. analytics renders real numbers after a completion ----------
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/orders/${couponOrderId}`);
  await merchantPage.getByText("بنود الطلب").waitFor();
  for (const label of ["نقل إلى «قيد المعالجة»", "نقل إلى «قيد التجهيز»", "نقل إلى «قيد التوصيل»", "نقل إلى «مكتملة»"]) {
    await merchantPage.getByRole("button", { name: label }).click();
  }
  // See phase20a: «مرتجعة» is already offered at out_for_delivery, so waiting
  // for it does not prove the completion landed — and the completion is what
  // writes the ledger entry the revenue card below is read from.
  await merchantPage.getByRole("button", { name: "نقل إلى «مكتملة»" }).waitFor({ state: "detached" });
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/orders/reports`);
  // Scoped to the card: "الإيراد المحقق" also appears in the page intro and in
  // another card's hint, and the figure alone matches the AOV card too.
  const revenueCard = merchantPage.getByTestId("analytics-stat-revenue");
  await revenueCard.waitFor();
  const revenueCardText = (await revenueCard.innerText()).replace(/\s+/g, " ");
  assert.ok(revenueCardText.includes(`${fmt.format(11500)} د.ع`), `realized revenue card should show 9000 + 2500 delivery; it showed: ${revenueCardText}`);
  await merchantPage.getByText("قمع حالات الطلبات (ضمن المدة)").waitFor();
  await merchantPage.screenshot({ path: `${artifactsDir}/phase20b-analytics.png`, fullPage: true });

  // ---------- 8. dashboards carry NO pixels (structural guarantee, verified) ----------
  const dashboardPixelState = await merchantPage.evaluate(() => ({
    fbq: typeof window.fbq,
    ttq: typeof window.ttq,
    metaScript: Boolean(document.querySelector('script[src*="connect.facebook.net"]')),
    tiktokScript: Boolean(document.querySelector('script[src*="analytics.tiktok.com"]')),
    gtagScript: Boolean(document.querySelector('script[src*="googletagmanager.com"]')),
  }));
  assert.deepEqual(dashboardPixelState, { fbq: "undefined", ttq: "undefined", metaScript: false, tiktokScript: false, gtagScript: false }, "no pixel object or script may exist in any dashboard page");

  await merchantContext.close();
  await shopperContext.close();
  console.log(JSON.stringify({
    phase: "20B unified",
    flow: {
      coupons: { created: "SAVE10", checkoutDiscount: 1000, orderTotal: 11500 },
      pixels: { storefrontInjected: true, purchaseEventValue: 11500, dashboardClean: true },
      csv: { dryRunClean: true, committed: { products: 1, variants: 2 }, visibleInList: true },
      abandonedCarts: { optInPersisted: true },
      prescriptions: { uploaded: true, gateBlockedThenApproved: true, processingUnblocked: true },
      analytics: { realizedRevenueShown: 11500 },
    },
    orders: { couponOrderId, rxOrderId },
    screenshots: ["phase20b-coupons.png", "phase20b-integrations.png", "phase20b-csv-import.png", "phase20b-coupon-checkout.png", "phase20b-prescription-uploaded.png", "phase20b-prescription-approved.png", "phase20b-analytics.png"].map((name) => `${artifactsDir}/${name}`),
  }, null, 2));
} catch (error) {
  // A browser suite that fails without evidence costs an hour of guessing. Dump
  // where every open page actually was, and what it was showing, before we tear
  // the browser down.
  console.error("--- phase20b failure context ---");
  for (const [contextIndex, context] of browser.contexts().entries()) {
    for (const [pageIndex, page] of context.pages().entries()) {
      const tag = `ctx${contextIndex}-page${pageIndex}`;
      try {
        console.error(`${tag} url: ${page.url()}`);
        const alerts = await page.getByRole("alert").allInnerTexts();
        if (alerts.length) console.error(`${tag} alerts: ${JSON.stringify(alerts)}`);
        await page.screenshot({ path: `${artifactsDir}/phase20b-FAILURE-${tag}.png`, fullPage: true });
      } catch (dumpError) {
        console.error(`${tag} could not be captured: ${dumpError.message}`);
      }
    }
  }
  console.error(`--- screenshots in ${artifactsDir} ---`);
  throw error;
} finally {
  await browser.close();
  web.kill("SIGTERM");
  killTree(moto);
  await prisma.$disconnect();
}

/**
 * Marketplace M6 in a real browser: after the order, on a phone and on the
 * store's dashboard.
 *
 *   the shopper cancels one order with a reason and sees it recorded; on a
 *   second order the store sets the delivery stage, the shopper sees it and his
 *   receipt code; the store types the code and the order completes; the
 *   shopper rates the store, a tag and the product, then asks for a return;
 *   «تقييماتي» lists the rating. The store's dashboard shows the rating.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3282;
const base = `http://127.0.0.1:${port}`;
const runId = `m6ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}5`.slice(0, 11);
const merchantEmail = `${runId}@codiq.test`;
const merchantPassword = "MarketOrdersUi!2026";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");

const codes = [];
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log" },
  stdio: ["ignore", "pipe", "inherit"],
});
web.stdout.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (!line.includes("otp.code_logged_not_sent")) continue;
    try { codes.push(JSON.parse(line).ctx.code); } catch { /* not JSON */ }
  }
});
async function nextCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) { if (codes.length) return codes.pop(); await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("no code logged");
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let browser;
const storeIds = [];
const summary = {};
const summaryMark = (name) => { summary[name] = true; };
try {
  await waitFor(`${base}/api/health`);
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}9`.slice(0, 14), email: merchantEmail, password: merchantPassword });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const merchantId = registered.payload.account.id;
  const store = await prisma.store.create({ data: { merchantId, name: `عطور ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  const perfume = await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-1`, name: `عطر ${runId}`, priceIqd: 25000, stockQuantity: 10 } });

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({ where: { phoneNormalized: `+964${phone.slice(1)}` } });
  const karrada = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكرادة" } });
  const address = await prisma.shopperAddress.create({ data: { shopperId: shopper.id, label: "البيت", recipientName: "سارة", phoneNormalized: shopper.phoneNormalized, phoneVerifiedAt: new Date(), governorateKey: "Baghdad", districtId: karrada.id, addressLine: "شارع ٦٢", isDefault: true } });
  // The cart and checkout screens are M5's test; here the order is placed through the same API from the page.
  let seq = 0;
  const buy = () => page.evaluate(async ({ productId, slug, addressId, key }) => {
    await fetch("/api/market/cart/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId, quantity: 1 }) });
    const response = await fetch(`/api/market/checkout/${slug}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ addressId }) });
    return (await response.json()).order.id;
  }, { productId: perfume.id, slug: store.slug, addressId: address.id, key: `${runId}-order-${++seq}-idempotency` });
  const actor = { kind: "merchant", id: merchantId };
  async function moveTo(orderId, ...statuses) {
    for (const toStatus of statuses) {
      const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
      await transitionOrderStatus(store.id, actor, orderId, { toStatus, expectedVersion: version });
    }
  }

  // ── cancel with a reason ────────────────────────────────────────────────────
  const first = await buy();
  await page.goto(`${base}/market/orders/${first}`);
  await page.getByTestId("market-order-cancel").click();
  await page.getByTestId("cancel-reason-ordered_by_mistake").check();
  await page.getByTestId("market-cancel-submit").click();
  await page.getByTestId("market-order-cancel-reason").waitFor();
  assert.match(await page.getByTestId("market-order-status").innerText(), /ملغي/);
  assert.match(await page.getByTestId("market-order-cancel-reason").innerText(), /طلبته بالخطأ/);
  summaryMark("cancel");

  // ── stage, code, hand-over ──────────────────────────────────────────────────
  const second = await buy();
  await moveTo(second, "processing", "preparation", "out_for_delivery");
  const merchant = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  merchant.on("pageerror", (error) => errors.push(`merchant: ${error}`));
  await merchant.goto(`${base}/merchant/login`);
  await merchant.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchant.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchant.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchant.waitForURL((url) => url.pathname.startsWith(`/merchant/stores/${store.slug}/dashboard`));
  await merchant.goto(`${base}/merchant/stores/${store.slug}/dashboard/orders/${second}`);
  await merchant.getByTestId("order-market-stage").selectOption("with_courier");
  await merchant.waitForFunction(() => document.querySelector('[data-testid="order-market-stage"]')?.value === "with_courier");
  await page.goto(`${base}/market/orders/${second}`);
  await page.getByTestId("market-order-stage").waitFor();
  assert.match(await page.getByTestId("market-order-stage").innerText(), /مع المندوب/);
  const code = (await page.getByTestId("market-handover-code").innerText()).trim();
  assert.match(code, /^[0-9]{4}$/);
  assert.ok(!(await merchant.content()).includes(`>${code}<`), "the store's screen never shows the code");
  await merchant.getByTestId("order-market-code").fill(code);
  await merchant.getByTestId("order-market-handover").click();
  await merchant.waitForFunction(() => document.querySelector('[data-testid="order-market-stage"]')?.value === "with_courier");
  summaryMark("handover");

  // ── rate, then ask to return ────────────────────────────────────────────────
  await page.reload();
  await page.getByTestId("market-order-rate").click();
  await page.getByTestId("market-rate-store-4").click();
  await page.getByTestId("market-rate-delivery-5").click();
  await page.getByTestId("market-rate-tag-fast_delivery").click();
  await page.getByTestId(`market-rate-product-${perfume.id}-5`).click();
  await page.getByTestId("market-rate-note").fill("وصل بسرعة");
  await page.getByTestId("market-rate-submit").click();
  await page.waitForFunction(() => /تقييمك/.test(document.querySelector('[data-testid="market-rating-summary"]')?.textContent ?? ""));
  assert.match(await page.getByTestId("market-rating-summary").innerText(), /توصيل سريع/);
  const review = await prisma.productReview.findFirstOrThrow({ where: { productId: perfume.id } });
  assert.equal(review.rating, 5, "the product star became a product review");
  await page.getByTestId("market-order-return").click();
  await page.getByTestId("return-reason-damaged").check();
  await page.getByTestId("market-return-details").fill("الغطاء مكسور");
  await page.getByTestId("market-return-submit").click();
  await page.getByTestId("market-return-status-label").waitFor();
  assert.match(await page.getByTestId("market-return-status-label").innerText(), /قيد مراجعة المتجر/);
  summaryMark("rateAndReturn");

  await page.goto(`${base}/market/ratings`);
  await page.getByTestId("market-ratings-tab-mine").click();
  await page.getByTestId(`market-rated-${second}`).waitFor();
  await merchant.reload();
  await merchant.getByTestId("order-market-rating").waitFor();
  assert.match(await merchant.getByTestId("order-market-rating").innerText(), /المتجر 4\/5/);
  summaryMark("ratings");

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-orders-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

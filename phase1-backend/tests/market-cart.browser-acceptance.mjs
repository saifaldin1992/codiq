/**
 * Marketplace M5 in a real browser, on a phone: one basket, two stores, two
 * orders.
 *
 *   the shopper signs in (code read from the server log), adds a product from
 *   store A with a paid add-on and a product from store B; the tab badge
 *   counts them; the cart shows two stores; store A is paid with a coupon that
 *   fails and then delivery — the order page confirms it and shows the add-on;
 *   only store B is left in the cart; store B is paid with pick-up; «طلباتي»
 *   lists both. The orders are real store orders, each with its own customer row.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3281;
const base = `http://127.0.0.1:${port}`;
const runId = `m5ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}3`.slice(0, 11);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

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
try {
  await waitFor(`${base}/api/health`);
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}8`.slice(0, 14), email: `${runId}@codiq.test`, password: "MarketCartUi!2026" });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  const A = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `عطور ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, ...listed } });
  const B = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `هواتف ${runId}`, slug: `${runId}-b`, defaultSubdomain: `${runId}-b`, latitude: 33.31, longitude: 44.42, pickupEnabled: true, ...listed } });
  storeIds.push(A.id, B.id);
  for (const store of [A, B]) await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  const perfume = await prisma.product.create({ data: { storeId: A.id, sku: `${runId}-1`, name: `عطر ${runId}`, priceIqd: 25000, stockQuantity: 10 } });
  const gift = await prisma.productAddon.create({ data: { storeId: A.id, productId: perfume.id, name: "تغليف هدية", priceIqd: 5000 } });
  const charger = await prisma.product.create({ data: { storeId: B.id, sku: `${runId}-2`, name: `شاحن ${runId}`, priceIqd: 15000, stockQuantity: 10 } });

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // Sign in, and give the shopper a Baghdad address (the address screens are M4's test).
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({ where: { phoneNormalized: `+964${phone.slice(1)}` } });
  const karrada = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكرادة" } });
  await prisma.shopperAddress.create({ data: { shopperId: shopper.id, label: "البيت", recipientName: "سارة", phoneNormalized: shopper.phoneNormalized, phoneVerifiedAt: new Date(), governorateKey: "Baghdad", districtId: karrada.id, addressLine: "شارع ٦٢، بناية ١٤", isDefault: true } });

  // ── two stores in one basket ────────────────────────────────────────────────
  await page.goto(`${base}/market/p/${perfume.id}`);
  await page.getByTestId(`market-product-addon-${gift.id}`).check();
  await page.getByTestId("market-product-plus").click();
  assert.match(await page.getByTestId("market-product-add").innerText(), /٦٠٬٠٠٠|60,000/, "two × (25,000 + 5,000) on the button");
  await page.getByTestId("market-product-add").click();
  await page.getByTestId("market-product-added").waitFor();
  await page.goto(`${base}/market/p/${charger.id}`);
  await page.getByTestId("market-product-add").click();
  await page.getByTestId("market-product-added").waitFor();
  assert.match(await page.getByTestId("market-cart-badge").innerText(), /٣|3/, "the tab counts three pieces");

  await page.getByTestId("market-tab-cart").click();
  await page.getByTestId(`market-cart-store-${A.slug}`).waitFor();
  await page.getByTestId(`market-cart-store-${B.slug}`).waitFor();
  assert.match(await page.getByTestId(`market-cart-store-${A.slug}`).innerText(), /تغليف هدية/);

  // ── pay store A: a coupon that fails, then delivery ─────────────────────────
  await page.getByTestId(`market-cart-checkout-${A.slug}`).click();
  await page.getByTestId("market-checkout-totals").waitFor();
  assert.equal(await page.getByTestId("market-checkout-fulfilment").count(), 0, "store A offers no pick-up, so there is no choice");
  await page.getByTestId("market-checkout-coupon").fill("NOPE");
  await page.getByTestId("market-checkout-coupon-apply").click();
  await page.getByTestId("market-checkout-coupon-error").waitFor();
  assert.match(await page.getByTestId("market-checkout-total").innerText(), /٦٣٬٠٠٠|63,000/, "60,000 + 3,000 delivery");
  await page.getByTestId("market-checkout-place").click();
  await page.getByTestId("market-order-placed").waitFor();
  assert.match(await page.getByTestId("market-order-page").innerText(), /تغليف هدية/);
  assert.match(await page.getByTestId("market-order-status").innerText(), /قيد المراجعة/);
  assert.match(await page.getByTestId("market-cart-badge").innerText(), /١|1/, "only store B's piece is left");

  // ── pay store B with pick-up ────────────────────────────────────────────────
  await page.getByTestId("market-tab-cart").click();
  await page.getByTestId(`market-cart-checkout-${B.slug}`).click();
  await page.getByTestId("market-checkout-totals").waitFor();
  // Summaries do not come back in order. Hold every DELIVERY summary back from
  // here on, then go pick-up → delivery → pick-up: the slow delivery answer
  // lands last and must not paint its 18,000 (15,000 + 3,000) under pick-up.
  const deliverySummaryOfB = (url) => url.pathname === `/api/market/checkout/${B.slug}` && url.searchParams.get("fulfilment") === "delivery";
  await page.route(deliverySummaryOfB, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.getByTestId("market-checkout-pickup").click();
  await page.waitForTimeout(300);
  await page.getByTestId("market-checkout-delivery").click();
  await page.waitForTimeout(200);
  await page.getByTestId("market-checkout-pickup").click();
  await page.waitForTimeout(3200); // past the held-back delivery summary
  await page.waitForFunction(() => /الاستلام من المتجر/.test(document.querySelector('[data-testid="market-checkout-totals"]')?.textContent ?? ""));
  assert.match(await page.getByTestId("market-checkout-total").innerText(), /١٥٬٠٠٠|15,000/, "no delivery fee for a pick-up");
  await page.unroute(deliverySummaryOfB);
  await page.getByTestId("market-checkout-place").click();
  await page.getByTestId("market-order-placed").waitFor();
  assert.equal(await page.getByTestId("market-cart-badge").count(), 0, "the basket is empty");

  // ── «طلباتي» ────────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/orders`);
  await page.locator('[data-testid^="market-order-"]').nth(1).waitFor();
  const orders = await prisma.storeOrder.findMany({ where: { customer: { shopperId: shopper.id } }, include: { items: true }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(orders.map((order) => [order.storeId, order.fulfilment, order.totalIqd]), [[A.id, "delivery", 63000], [B.id, "pickup", 15000]], "two real store orders");
  assert.equal(orders[0].items[0].unitPriceIqd, 30000, "the add-on is inside the line price");

  // ── M6 «إلغاء الطلب»: the pick-up order, with a reason ──────────────────────
  await page.goto(`${base}/market/orders/${orders[1].id}`);
  await page.getByTestId("market-order-cancel").click();
  assert.equal(await page.getByTestId("market-cancel-confirm").isDisabled(), true, "no reason, no cancellation");
  await page.getByTestId("market-cancel-reason-other").click();
  assert.equal(await page.getByTestId("market-cancel-confirm").isDisabled(), true, "«سبب آخر» waits for words");
  await page.getByTestId("market-cancel-note").fill("سأشتريه من الفرع مباشرة");
  await page.getByTestId("market-cancel-confirm").click();
  await page.waitForFunction(() => /ملغي/.test(document.querySelector('[data-testid="market-order-status"]')?.textContent ?? ""));
  assert.equal(await page.getByTestId("market-order-cancel").count(), 0, "a cancelled order offers no second cancel");
  const cancelEvent = await prisma.orderStatusEvent.findFirst({ where: { orderId: orders[1].id, toStatus: "cancelled" } });
  assert.equal(cancelEvent?.note, "سبب الإلغاء: سبب آخر — سأشتريه من الفرع مباشرة");
  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-cart-browser", status: "passed", summary: { basketAcrossStores: true, couponRefused: true, deliveryOrder: true, pickupOrder: true, myOrders: true, cancelWithReason: true } }, null, 2));
} finally {
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

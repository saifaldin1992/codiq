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

  // ── M6 «قيّم طلبك»: store A's order, once delivered ─────────────────────────
  await prisma.storeOrder.update({ where: { id: orders[0].id }, data: { status: "completed", statusUpdatedAt: new Date() } });
  await page.goto(`${base}/market/orders`);
  await page.getByTestId(`market-pending-rating-${orders[0].id}`).click();
  await page.getByTestId("market-order-rating").waitFor();
  await page.getByTestId(`market-rate-product-${perfume.id}-4`).click();
  await page.getByTestId("market-rate-delivery-5").click();
  await page.getByTestId("market-rate-tag-fast_delivery").click();
  await page.getByTestId("market-rate-note").fill("وصل مغلّفاً بعناية");
  await page.getByTestId("market-rate-save").click();
  await page.getByTestId("market-rate-saved").waitFor();
  const review = await prisma.productReview.findFirst({ where: { productId: perfume.id, withdrawnAt: null } });
  assert.equal(review?.rating, 4, "the product's stars became the store's verified-buyer review");
  const orderRating = await prisma.orderRating.findUnique({ where: { orderId: orders[0].id } });
  assert.deepEqual([orderRating?.deliveryRating, orderRating?.tags, orderRating?.note], [5, ["fast_delivery"], "وصل مغلّفاً بعناية"]);
  await page.goto(`${base}/market/ratings`);
  await page.getByTestId(`market-rating-${orders[0].id}`).waitFor();
  assert.equal(await page.getByTestId("market-pending-ratings").count(), 0, "nothing waits for a rating any more");

  // ── M6 «رمز الاستلام»: a pick-up at store B, confirmed by the merchant ──────
  // From inside the page: the shopper's cookie is Secure, which the browser honours on 127.0.0.1 and a bare request client does not.
  const inPage = (path, init) => page.evaluate(async ([url, options]) => (await fetch(url, { credentials: "same-origin", ...options })).json(), [path, init]);
  const { addresses: [address] } = await inPage("/api/market/me/addresses", {});
  await inPage("/api/market/cart/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: charger.id, quantity: 1 }) });
  const collect = await inPage(`/api/market/checkout/${B.slug}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `${runId}-collect` }, body: JSON.stringify({ addressId: address.id, fulfilment: "pickup" }) });
  assert.ok(collect.order?.id, JSON.stringify(collect));
  await prisma.merchant.update({ where: { id: registered.payload.account.id }, data: { approvalStatus: "approved" } });
  const merchantLogin = await (await fetch(`${base}/api/auth/merchant/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ identifier: `${runId}@codiq.test`, password: "MarketCartUi!2026" }) })).json();
  // A merchant session is bound to one store: switch it to B, the pick-up store.
  const atB = await (await fetch(`${base}/api/merchant/stores/switch`, { method: "POST", headers: { authorization: `Bearer ${merchantLogin.accessToken}`, "content-type": "application/json", origin: base }, body: JSON.stringify({ storeSlug: B.slug }) })).json();
  for (const toStatus of ["processing", "preparation", "out_for_delivery"]) {
    const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: collect.order.id }, select: { version: true } });
    const moved = await fetch(`${base}/api/merchant/stores/${B.slug}/orders/${collect.order.id}/status`, { method: "POST", headers: { authorization: `Bearer ${atB.accessToken}`, "content-type": "application/json", origin: base }, body: JSON.stringify({ toStatus, expectedVersion: version }) });
    assert.equal(moved.status, 200, `${toStatus}: ${await moved.text()}`);
  }
  await page.goto(`${base}/market/orders/${collect.order.id}`);
  await page.getByTestId("market-order-pickup-qr").waitFor();
  const shownCode = (await page.getByTestId("market-order-pickup-code").innerText()).trim();
  assert.match(shownCode, /^\d{6}$/, "six digits to read out at the counter");
  assert.match(await page.getByTestId("market-order-status").innerText(), /جاهز للاستلام/);
  // The merchant's phone opens the QR's link: his order page with the code filled in.
  const merchantPage = await (await browser.newContext()).newPage();
  await merchantPage.goto(`${base}/merchant/login`);
  await merchantPage.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(`${runId}@codiq.test`);
  await merchantPage.getByLabel("كلمة المرور", { exact: true }).fill("MarketCartUi!2026");
  await merchantPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchantPage.waitForURL((url) => url.pathname.includes("/dashboard"));
  // His session opened on store A; the pick-up is at B (the store switcher's own call).
  const switchedInBrowser = await merchantPage.evaluate(async (slug) => (await fetch("/api/merchant/stores/switch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ storeSlug: slug }) })).status, B.slug);
  assert.equal(switchedInBrowser, 200);
  await merchantPage.goto(`${base}/merchant/stores/${B.slug}/dashboard/orders/${collect.order.id}?pickupCode=${shownCode}`);
  await merchantPage.getByTestId("pickup-confirm").waitFor();
  assert.equal(await merchantPage.getByTestId("pickup-code-input").inputValue(), shownCode, "the scanned link fills the code in");
  await merchantPage.getByTestId("pickup-confirm-button").click();
  await merchantPage.getByTestId("pickup-confirm").waitFor({ state: "detached" });
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: collect.order.id } })).status, "completed", "the pick-up is complete");
  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-cart-browser", status: "passed", summary: { basketAcrossStores: true, couponRefused: true, deliveryOrder: true, pickupOrder: true, myOrders: true, cancelWithReason: true, rating: true, pickupCode: true } }, null, 2));
} finally {
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

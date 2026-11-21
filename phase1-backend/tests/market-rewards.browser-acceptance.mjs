/**
 * Marketplace M8b in a real browser.
 *
 *   desktop (owner): creates a market coupon.
 *   phone: claims it from «الكوبونات», picks it at checkout — the total drops
 *   by the platform's discount — and places the order.
 *   desktop (store): the order shows the market coupon line «تتحمّله المنصّة».
 *   phone: «نقاطي» buys a coupon with points; it lands in «كوبوناتي».
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3286;
const base = `http://127.0.0.1:${port}`;
const runId = `m8rui${Date.now().toString(36)}`;
const tag = runId.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}8`.slice(0, 11);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");
await prisma.storefrontRateLimit.deleteMany({ where: { scope: { startsWith: "market_otp" } } });

const codes = [];
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log", CODIQ_ALLOW_OWNER_REGISTRATION: "true" },
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
const couponCodes = [];
const summary = {};
try {
  await waitFor(`${base}/api/health`);
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  assert.ok([200, 201].includes((await fetch(`${base}/api/auth/platform/register`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }) })).status));
  const merchantEmail = `${runId}@codiq.test`;
  const merchantPassword = "MarketRewardsUi!2026";
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}5`.slice(0, 14), email: merchantEmail, password: merchantPassword });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `عطور ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  const perfume = await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-1`, name: `عطر ${runId}`, priceIqd: 50000, stockQuantity: 10 } });
  const pointsCoupon = await prisma.platformCoupon.create({ data: { code: `P${tag}`, title: `٢٠٠٠ دينار بالنقاط ${tag}`, kind: "fixed", amountOffIqd: 2000, pointsCost: 50, startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 30 * 86_400_000) } });
  couponCodes.push(pointsCoupon.code);

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const errors = [];
  const desktop = async () => { const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); p.on("pageerror", (error) => errors.push(String(error))); return p; };

  // ── the owner makes a coupon ────────────────────────────────────────────────
  const owner = await desktop();
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-coupons`);
  const code = `W${tag}`;
  couponCodes.push(code);
  await owner.getByTestId("coupon-new-code").fill(code);
  await owner.getByTestId("coupon-new-title").fill(`أهلاً ${tag}`);
  await owner.getByTestId("coupon-new-value").fill("10");
  await owner.getByTestId("coupon-new-create").click();
  await owner.getByTestId(`coupon-admin-${code}`).waitFor();
  summary.ownerCoupon = true;

  // ── the shopper claims it and uses it ───────────────────────────────────────
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({ where: { phoneNormalized: `+964${phone.slice(1)}` } });
  const karrada = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكرادة" } });
  await prisma.shopperAddress.create({ data: { shopperId: shopper.id, label: "البيت", recipientName: "سارة", phoneNormalized: shopper.phoneNormalized, phoneVerifiedAt: new Date(), governorateKey: "Baghdad", districtId: karrada.id, addressLine: "شارع ٦٢", isDefault: true } });
  await page.goto(`${base}/market/coupons`);
  await page.getByTestId(`market-coupon-claim-${code}`).click();
  await page.getByTestId(`market-coupon-${code}`).getByText("في كوبوناتك").waitFor();
  await page.goto(`${base}/market/p/${perfume.id}`);
  await page.getByTestId("market-product-add").click();
  await page.getByTestId("market-product-added").waitFor();
  await page.goto(`${base}/market/checkout/${store.slug}`);
  await page.getByTestId("market-checkout-platform-coupons").waitFor();
  assert.match(await page.getByTestId("market-checkout-total").innerText(), /٥٣٬٠٠٠|53,000/);
  await page.getByTestId(`market-checkout-platform-${code}`).check();
  await page.waitForFunction(() => /٤٨٬٠٠٠|48,000/.test(document.querySelector('[data-testid="market-checkout-total"]')?.textContent ?? ""));
  await page.getByTestId("market-checkout-place").click();
  await page.getByTestId("market-order-placed").waitFor();
  const order = await prisma.storeOrder.findFirstOrThrow({ where: { storeId: store.id }, orderBy: { createdAt: "desc" } });
  assert.deepEqual([order.platformDiscountIqd, order.discountIqd, order.totalIqd], [5000, 0, 48000]);
  summary.shopperUsed = true;

  // ── the store sees who pays it ──────────────────────────────────────────────
  const merchant = await desktop();
  await merchant.goto(`${base}/merchant/login`);
  await merchant.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchant.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchant.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchant.waitForURL((url) => url.pathname.startsWith(`/merchant/stores/${store.slug}/dashboard`));
  await merchant.goto(`${base}/merchant/stores/${store.slug}/dashboard/orders/${order.id}`);
  await merchant.getByTestId("order-platform-discount").waitFor();
  assert.match(await merchant.getByTestId("order-platform-discount").innerText(), /تتحمّله المنصّة/);
  summary.storeSees = true;

  // ── points buy a coupon ─────────────────────────────────────────────────────
  await prisma.shopperPointsEntry.create({ data: { shopperId: shopper.id, delta: 60, reason: "granted" } });
  await page.goto(`${base}/market/points`);
  assert.match(await page.getByTestId("market-points-balance").innerText(), /٦٠|60/);
  await page.getByTestId(`market-points-redeem-${pointsCoupon.code}`).click();
  await page.getByTestId("market-points-notice").waitFor();
  await page.waitForFunction(() => /^\s*(١٠|10)\s/.test(document.querySelector('[data-testid="market-points-balance"]')?.textContent ?? ""));
  await page.goto(`${base}/market/coupons?tab=active`);
  await page.getByTestId(`market-coupon-${pointsCoupon.code}`).waitFor();
  summary.points = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-rewards-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.platformCoupon.updateMany({ where: { code: { in: couponCodes } }, data: { isActive: false } }).catch(() => undefined);
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

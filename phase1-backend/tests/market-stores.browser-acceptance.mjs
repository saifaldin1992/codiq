/**
 * Marketplace M1 in a real browser — the three people the directory involves:
 *
 *   merchant  fills «السوق» (type, governorate → district, hours), sees the
 *             readiness list turn green, and asks to join;
 *   owner     finds the request in «السوق ← بانتظار القرار», lists the store,
 *             then boosts it;
 *   shopper   (phone) sees it lead «متاجر مقترحة», opens its page — name,
 *             «متجر جديد», hours, the badge sheet — and loses it when the
 *             header's location moves to another governorate.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3273;
const base = `http://127.0.0.1:${port}`;
const runId = `m1ui${Date.now().toString(36)}`;
const suffix = String(Date.now()).slice(-6);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off" },
  stdio: ["ignore", "inherit", "inherit"],
});

async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
async function json(path, body) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

let browser;
const storeIds = [];
try {
  await waitFor(`${base}/api/health`);

  // ── seed: an owner, a merchant whose store has a logo and a product ─────────
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "MarketOwnerPass123!";
  assert.ok([200, 201].includes((await json("/api/auth/platform/register", { email: ownerEmail, password: ownerPassword, displayName: "مالك السوق" })).status));
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const merchantPassword = "MarketMerchantPass123!";
  const registered = await registerMerchantDirect({ ownerName: "تاجر السوق", businessName: "متجر السوق", phone: `+96478${suffix}11`.slice(0, 14), email: merchantEmail, password: merchantPassword });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const storeName = `متجر ${runId}`;
  const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: storeName, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, logoObjectKey: `logos/${runId}/l.png`, logoContentType: "image/png", logoByteSize: 10 }, select: { id: true, slug: true } });
  storeIds.push(store.id);
  await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-1`, name: "سمّاعة لاسلكيّة", priceIqd: 25000, stockQuantity: 4 } });

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});

  // ── merchant ────────────────────────────────────────────────────────────────
  const merchant = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await merchant.goto(`${base}/merchant/login`);
  await merchant.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchant.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchant.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchant.waitForURL((url) => url.pathname.startsWith(`/merchant/stores/${store.slug}/dashboard`));
  await merchant.goto(`${base}/merchant/stores/${store.slug}/dashboard/settings/market`);
  await merchant.getByTestId("market-profile-panel").waitFor();
  assert.match(await merchant.getByTestId("market-listing-status").innerText(), /غير معروض/);
  assert.equal(await merchant.getByTestId("market-request-listing").isDisabled(), true, "cannot ask before the profile is complete");

  await merchant.getByTestId("market-business-type").fill("إلكترونيات");
  await merchant.getByTestId("market-governorate").selectOption("Baghdad");
  await merchant.getByTestId("market-district").selectOption({ label: "الكرادة" });
  await merchant.getByTestId("market-latitude").fill("33.3");
  await merchant.getByTestId("market-longitude").fill("44.42");
  await merchant.getByTestId("market-pickup").check();
  for (const weekday of [0, 1, 2, 3, 4, 6]) await merchant.getByTestId(`market-hours-open-${weekday}`).check();
  await merchant.getByTestId("market-profile-save").click();
  await merchant.getByTestId("market-profile-notice").waitFor();
  assert.equal(await merchant.getByTestId("market-request-listing").isDisabled(), false, "complete profile: the request opens");
  await merchant.getByTestId("market-request-listing").click();
  await merchant.waitForFunction(() => document.querySelector('[data-testid="market-listing-status"]')?.textContent?.includes("قيد المراجعة"));

  // ── owner ───────────────────────────────────────────────────────────────────
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market`);
  await owner.getByTestId(`platform-market-row-${store.slug}`).waitFor();
  await owner.getByTestId(`platform-market-list-${store.slug}`).click();
  await owner.getByTestId("platform-market-notice").waitFor();
  await owner.getByTestId("platform-market-tab-listed").click();
  await owner.getByTestId(`platform-market-boost-${store.slug}`).click();
  await owner.waitForFunction((slug) => document.querySelector(`[data-testid="platform-market-boost-${slug}"]`)?.getAttribute("aria-pressed") === "true", store.slug);

  // ── shopper on a phone ──────────────────────────────────────────────────────
  const shopperContext = await browser.newContext({ ...devices["iPhone 13"] });
  const shopper = await shopperContext.newPage();
  const consoleErrors = [];
  shopper.on("pageerror", (error) => consoleErrors.push(String(error)));
  shopper.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) consoleErrors.push(message.text()); });

  await shopper.goto(`${base}/market/stores`);
  const shelf = shopper.getByTestId("market-shelf-recommended");
  await shelf.getByTestId(`market-store-card-${store.slug}`).waitFor();
  const firstCard = await shelf.locator('[data-testid^="market-store-card-"]').first().getAttribute("data-testid");
  assert.equal(firstCard, `market-store-card-${store.slug}`, "the boosted store leads «متاجر مقترحة»");

  await shopper.getByTestId("market-stores-search").fill(runId);
  await shopper.getByTestId(`market-store-row-${store.slug}`).waitFor();
  assert.equal(await shopper.locator('[data-testid^="market-store-row-"]').count(), 1, "the search narrows the list");
  await shopper.getByTestId(`market-store-row-${store.slug}`).click();

  await shopper.getByTestId("market-store-page").waitFor();
  assert.equal(new URL(shopper.url()).pathname, `/market/s/${store.slug}`);
  assert.ok((await shopper.getByTestId("market-store-name").innerText()).includes(runId));
  assert.match(await shopper.getByTestId("market-store-details").innerText(), /الكرادة/);
  assert.match(await shopper.getByTestId("market-store-details").innerText(), /استلام طلبك من المتجر/);
  assert.match(await shopper.getByTestId("market-store-hours").innerText(), /الجمعة\s*مغلق/);
  await shopper.getByTestId("market-store-open-now").waitFor();
  await shopper.getByTestId("market-store-newest").getByTestId("market-product-card-" + (await prisma.product.findFirstOrThrow({ where: { storeId: store.id } })).id).waitFor();
  await shopper.getByTestId("market-store-badges-open").click();
  await shopper.getByTestId("market-badge-sheet").waitFor();
  assert.match(await shopper.getByTestId("market-badge-new_store").innerText(), /محقّقة/);
  assert.match(await shopper.getByTestId("market-badge-boosted").innerText(), /محقّقة/);
  assert.match(await shopper.getByTestId("market-badge-fast_response").innerText(), /غير محقّقة بعد/);
  await shopper.getByRole("button", { name: "إغلاق" }).click();

  // The header's location filters the directory: Basra hides a Baghdad store.
  await shopper.goto(`${base}/market/stores`);
  await shopper.getByTestId("market-location-button").click();
  await shopper.getByTestId("market-governorate-Basra").click();
  await shopper.getByRole("button", { name: "كل مناطق البصرة" }).click();
  await shopper.getByTestId("market-stores-search").fill(runId);
  await shopper.getByTestId("market-stores-empty").waitFor();

  const overflow = await shopper.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll at phone width (overflow ${overflow}px)`);
  assert.deepEqual(consoleErrors, [], "no script errors");

  console.log(JSON.stringify({ suite: "market-stores-browser", status: "passed", summary: { merchantRequested: true, ownerListedAndBoosted: true, shopperSawStore: true, locationFilter: true } }, null, 2));
} finally {
  if (storeIds.length) await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date(), boostedUntil: null } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

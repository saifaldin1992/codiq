/**
 * Marketplace M8a in a real browser.
 *
 *   desktop (owner): creates a campaign, adds an hour, publishes it.
 *   desktop (store): puts a product forward for that hour at 20% off.
 *   desktop (owner): approves it.
 *   — the hour is moved to now —
 *   phone: the front page's campaign card counts down; the campaign page
 *   shows the product in «عرض الساعة» at the deal price; the product page
 *   strikes the list price through; the cart charges the deal price.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3285;
const base = `http://127.0.0.1:${port}`;
const runId = `m8ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log", CODIQ_ALLOW_OWNER_REGISTRATION: "true", TZ: "UTC" },
  stdio: ["ignore", "ignore", "inherit"],
});
async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
/** A datetime-local value in the browser's zone (the contexts below are pinned to UTC). */
const local = (ms) => new Date(ms).toISOString().slice(0, 16);

let browser;
const storeIds = [];
const campaignSlugs = [];
const summary = {};
try {
  await waitFor(`${base}/api/health`);
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  assert.ok([200, 201].includes((await fetch(`${base}/api/auth/platform/register`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }) })).status));
  const merchantEmail = `${runId}@codiq.test`;
  const merchantPassword = "MarketCampaignUi!2026";
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}4`.slice(0, 14), email: merchantEmail, password: merchantPassword });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `عطور ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  const perfume = await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-1`, name: `عطر ${runId}`, priceIqd: 50000, stockQuantity: 10 } });

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const errors = [];
  const desktop = async () => { const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC" })).newPage(); p.on("pageerror", (error) => errors.push(String(error))); return p; };

  // ── the owner sets it up ────────────────────────────────────────────────────
  const owner = await desktop();
  owner.on("dialog", (dialog) => void dialog.accept());
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-campaigns`);
  const now = Date.now();
  const slug = `${runId}-sale`;
  campaignSlugs.push(slug);
  await owner.getByTestId("campaign-new-title").fill(`تخفيضات ${runId}`);
  await owner.getByTestId("campaign-new-slug").fill(slug);
  await owner.getByTestId("campaign-new-starts").fill(local(now - 3_600_000));
  await owner.getByTestId("campaign-new-ends").fill(local(now + 3 * 86_400_000));
  await owner.getByTestId("campaign-new-create").click();
  await owner.getByTestId("campaign-editor").waitFor();
  await owner.getByTestId("slot-starts").fill(local(now + 2 * 3_600_000));
  await owner.getByTestId("slot-ends").fill(local(now + 3 * 3_600_000));
  await owner.getByTestId("slot-add").click();
  await owner.waitForFunction(() => /بانتظار/.test(document.querySelector('[data-testid="campaign-slots"]')?.textContent ?? ""));
  await owner.getByTestId("campaign-publish").click();
  await owner.waitForFunction(() => /إيقاف النشر/.test(document.querySelector('[data-testid="campaign-publish"]')?.textContent ?? ""));
  summary.ownerSetup = true;

  // ── the store puts its product forward ──────────────────────────────────────
  const merchant = await desktop();
  await merchant.goto(`${base}/merchant/login`);
  await merchant.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchant.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchant.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchant.waitForURL((url) => url.pathname.startsWith(`/merchant/stores/${store.slug}/dashboard`));
  await merchant.goto(`${base}/merchant/stores/${store.slug}/dashboard/products/market-deals`);
  const slot = await prisma.marketDealSlot.findFirstOrThrow({ where: { campaign: { slug } } });
  await merchant.getByTestId(`market-deal-product-${slot.id}`).selectOption(perfume.id);
  await merchant.getByTestId(`market-deal-percent-${slot.id}`).fill("20");
  await merchant.getByTestId(`market-deal-propose-${slot.id}`).click();
  await merchant.getByTestId("market-deals-notice").waitFor();
  await merchant.getByTestId("market-deals-panel").getByText("بانتظار موافقة السوق").waitFor();
  const deal = await prisma.marketDeal.findFirstOrThrow({ where: { slotId: slot.id } });
  summary.storeProposed = true;

  // ── the owner approves ──────────────────────────────────────────────────────
  await owner.reload();
  await owner.getByTestId(`campaign-row-${slug}`).click();
  await owner.getByTestId(`deal-approve-${deal.id}`).click();
  await owner.getByTestId("market-campaigns-notice").waitFor();
  assert.equal((await prisma.marketDeal.findUniqueOrThrow({ where: { id: deal.id } })).status, "approved");
  summary.ownerApproved = true;

  // ── the hour starts ─────────────────────────────────────────────────────────
  await prisma.marketDealSlot.update({ where: { id: slot.id }, data: { startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 59 * 60_000) } });
  const page = await (await browser.newContext({ ...devices["iPhone 13"], timezoneId: "Asia/Baghdad" })).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/market`);
  await page.getByTestId(`market-home-campaign-${slug}`).waitFor();
  assert.match(await page.getByTestId(`market-home-campaign-${slug}`).innerText(), /عرض الساعة ينتهي خلال/);
  await page.getByTestId(`market-home-campaign-${slug}`).click();
  await page.getByTestId("market-campaign-countdown").waitFor();
  await page.getByTestId(`market-product-deal-${perfume.id}`).waitFor();
  assert.match(await page.getByTestId(`market-product-card-${perfume.id}`).innerText(), /٤٠٬٠٠٠|40,000/, "the deal price on the card");
  await page.getByTestId(`market-product-card-${perfume.id}`).click();
  await page.getByTestId("market-product-deal").waitFor();
  const price = await page.getByTestId("market-product-price").innerText();
  assert.match(price, /٤٠٬٠٠٠|40,000/);
  assert.match(price, /٥٠٬٠٠٠|50,000/, "the list price struck through");
  summary.shopperSees = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-campaigns-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.marketCampaign.deleteMany({ where: { slug: { in: campaignSlugs } } }).catch(() => undefined);
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

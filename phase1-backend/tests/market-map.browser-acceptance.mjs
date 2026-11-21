/**
 * Marketplace M11 in a real browser (a phone that allows its position).
 *
 *   /market/map: the stores in view appear as pins; a pin opens the store's
 *   card and the card the store; «موقعي» puts the shopper on the map; the list
 *   view names the same stores. The front page shows «قريبة منك» without
 *   asking (the browser already allows it). /market/route: «موقعي» as the
 *   start, a tap on the map, then a saved address as the end; the stores near
 *   the line come back in order, a wider corridor takes in the one further off.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3293;
const base = `http://127.0.0.1:${port}`;
const runId = `m11ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}5`.slice(0, 11);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const codes = [];
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, CODIQ_MAP_TILE_URL: "", NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log", CODIQ_ALLOW_OWNER_REGISTRATION: "true" },
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
try {
  await waitFor(`${base}/api/health`);
  await prisma.storefrontRateLimit.deleteMany({ where: { scope: { startsWith: "market_otp" } } });
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}4`.slice(0, 14), email: `${runId}@codiq.test`, password: "MarketMapUi!2026" });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  const make = async (label, name, latitude, longitude) => {
    const row = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name, slug: `${runId}-${label}`, defaultSubdomain: `${runId}-${label}`, latitude, longitude, businessType: "مخبز", ...listed } });
    storeIds.push(row.id);
    return row;
  };
  // The shopper stands at 33.3000,44.3600; the errand runs east to «العمل» at 33.3000,44.4600.
  const bakery = await make("bakery", `مخبز ${runId}`, 33.3020, 44.4000);   // ≈ 0.2 km off the line
  const florist = await make("florist", `زهور ${runId}`, 33.3250, 44.4100);  // ≈ 2.8 km off

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const context = await browser.newContext({ ...devices["iPhone 13"], geolocation: { latitude: 33.3, longitude: 44.36 }, permissions: ["geolocation"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // ── the map ─────────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/map`);
  await page.getByTestId("market-map").waitFor();
  const pin = page.locator(`[data-testid="market-map-pin"][data-slug="${bakery.slug}"]`);
  await pin.waitFor();
  await page.locator(`[data-testid="market-map-pin"][data-slug="${florist.slug}"]`).waitFor();
  await page.getByText("خلفيّة الخريطة غير مفعّلة").waitFor();
  await pin.click();
  assert.equal(await page.getByTestId("market-map-card-name").innerText(), bakery.name);
  summary.pins = true;
  await page.getByTestId("market-map-view").click();
  await page.getByTestId("market-map-list").getByText(florist.name).waitFor();
  await page.getByTestId("market-map-view").click();
  await pin.click();
  await page.getByTestId("market-map-card-open").click();
  await page.waitForURL((url) => url.pathname === `/market/s/${bakery.slug}`);
  summary.toStore = true;
  await page.goto(`${base}/market/map`);
  await page.getByTestId("market-map-locate").click();
  await page.locator("path.codiq-map-me").waitFor();
  summary.locate = true;

  // ── «قريبة منك» on the front page, no prompt ────────────────────────────────
  await page.goto(`${base}/market`);
  await page.getByTestId("market-home-nearest").getByText(bakery.name).waitFor();
  summary.nearby = true;

  // ── «على طريقك» ─────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({ where: { phoneNormalized: `+964${phone.slice(1)}` } });
  const karrada = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكرادة" } });
  await prisma.shopperAddress.create({ data: { shopperId: shopper.id, label: "العمل", recipientName: "سارة", phoneNormalized: shopper.phoneNormalized, phoneVerifiedAt: new Date(), governorateKey: "Baghdad", districtId: karrada.id, addressLine: "شارع ٥٢", latitude: 33.3, longitude: 44.46, isDefault: true } });

  await page.goto(`${base}/market/route`);
  await page.getByTestId("market-route-page").waitFor();
  await page.getByTestId("market-route-from-me").click();
  await page.getByTestId("market-route-from-set").waitFor();
  await page.getByTestId("market-route-hint").filter({ hasText: "الوجهة" }).waitFor();
  const box = await page.getByTestId("market-map").boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.3);
  await page.getByTestId("market-route-to-set").waitFor();
  await page.locator('[data-testid="market-route-to-pin"]').waitFor();
  summary.tapped = true;
  await page.getByTestId("market-route-to-address").filter({ hasText: "العمل" }).click();
  await page.getByTestId("market-route-corridor-1").click();
  await page.getByTestId("market-route-results").getByText(bakery.name).waitFor();
  assert.match(await page.getByTestId("market-route-summary").innerText(), /المشوار ٩٫٣ كم/);
  const names = await page.getByTestId("market-route-store").allInnerTexts();
  assert.ok(names.some((text) => text.includes(bakery.name)), "the bakery is on the way");
  assert.ok(!names.some((text) => text.includes(florist.name)), "the florist is too far off at 1 km");
  const bakeryRow = names.find((text) => text.includes(bakery.name));
  assert.match(bakeryRow, /بعد ٣٫٧ كم من البداية/);
  await page.locator(`[data-testid="market-map-pin"][data-slug="${bakery.slug}"]`).waitFor();
  summary.route = true;
  await page.getByTestId("market-route-corridor-5").click();
  await page.getByTestId("market-route-results").getByText(florist.name).waitFor();
  const ordered = (await page.getByTestId("market-route-store").allInnerTexts()).filter((text) => text.includes(runId));
  assert.deepEqual(ordered.map((text) => (text.includes(bakery.name) ? "bakery" : "florist")), ["bakery", "florist"], "in the order passed");
  summary.widen = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-map-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

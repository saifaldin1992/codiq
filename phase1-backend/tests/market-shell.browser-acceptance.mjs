/**
 * Marketplace M0 — the shopper app's frame, in a real browser at phone size.
 *
 *   · /market opens on the home tab; every bottom tab opens its page and is
 *     marked current; an unknown path inside the market is the market's 404,
 *     not the platform's.
 *   · «التوصيل إلى»: governorate → searchable district; the choice shows in the
 *     header and survives a reload (browser storage), and «كل المحافظات» clears it.
 *   · search submits to /market/search?q=…
 *   · nothing the page does logs a console error.
 *
 * Needs `pnpm build` first (the script does it) and a migrated test database.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";

const port = 3271;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

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

let browser;
try {
  await waitFor(`${base}/api/health`);
  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(`${base}/market`);
  await page.getByTestId("market-home").waitFor();
  assert.equal(await page.getByTestId("market-tab-home").getAttribute("aria-current"), "page");
  assert.match(await page.title(), /ماركت/);

  for (const tab of ["stores", "categories", "cart", "account"]) {
    await page.getByTestId(`market-tab-${tab}`).click();
    await page.getByTestId(`market-${tab}`).waitFor();
    assert.equal(new URL(page.url()).pathname, `/market/${tab}`);
    assert.equal(await page.getByTestId(`market-tab-${tab}`).getAttribute("aria-current"), "page", `${tab} tab is current`);
    assert.equal(await page.getByTestId("market-tab-home").getAttribute("aria-current"), null);
  }
  await page.getByTestId("market-brand").click();
  await page.getByTestId("market-home").waitFor();

  await page.goto(`${base}/market/no-such-page`);
  await page.getByTestId("market-not-found").waitFor();
  await page.getByTestId("market-shell").waitFor();

  // «التوصيل إلى»
  await page.goto(`${base}/market`);
  assert.match(await page.getByTestId("market-location-button").innerText(), /اختر محافظتك/);
  await page.getByTestId("market-location-button").click();
  await page.getByTestId("market-governorate-Basra").waitFor();
  assert.equal(await page.locator('[data-testid^="market-governorate-"]').count(), 18, "all eighteen governorates are offered");
  await page.getByTestId("market-location-search").fill("بغد");
  assert.equal(await page.locator('[data-testid^="market-governorate-"]').count(), 1, "search narrows the governorates");
  await page.getByTestId("market-governorate-Baghdad").click();
  await page.getByTestId("market-location-search").fill("كاظم");
  const district = page.locator('[data-testid^="market-district-"]');
  assert.equal(await district.count(), 1);
  await district.click();
  await page.getByTestId("market-location-picker").waitFor({ state: "detached" });
  assert.match(await page.getByTestId("market-location-button").innerText(), /بغداد · الكاظمية/);
  await page.reload();
  assert.match(await page.getByTestId("market-location-button").innerText(), /بغداد · الكاظمية/, "the choice survives a reload");
  await page.getByTestId("market-location-button").click();
  await page.getByRole("button", { name: "كل المحافظات" }).click();
  assert.match(await page.getByTestId("market-location-button").innerText(), /اختر محافظتك/, "«كل المحافظات» clears it");

  // search
  await page.getByTestId("market-search-input").fill("ايفون");
  await page.getByTestId("market-search-input").press("Enter");
  await page.getByTestId("market-search").waitFor();
  const url = new URL(page.url());
  assert.equal(url.pathname, "/market/search");
  assert.equal(url.searchParams.get("q"), "ايفون");

  // phone width: nothing scrolls sideways
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll at phone width (overflow ${overflow}px)`);

  assert.deepEqual(consoleErrors, [], "no console errors");
  console.log(JSON.stringify({ suite: "market-shell-browser", status: "passed", summary: { tabs: 5, locationPersisted: true, search: true } }, null, 2));
} finally {
  await browser?.close();
  await killTree(web);
}

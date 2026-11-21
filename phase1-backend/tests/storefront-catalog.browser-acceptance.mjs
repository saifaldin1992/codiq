/**
 * The storefront catalog follows its own address bar — and only its latest one.
 *
 * Two defects, one page:
 *
 *  1. SEARCH AND SORT DID NOTHING ON THE PAGE ITSELF. The filters were read
 *     from `window.location.search` in a memo keyed on wouter's `location`,
 *     which is the PATH only. Searching from `/products` to `/products?q=…`
 *     changed the address bar and left the path — and so the products — exactly
 *     as they were. Only a fresh page load applied a filter.
 *
 *  2. A SLOW ANSWER COULD OVERWRITE A NEWER ONE. Each filter change fires its
 *     own request, and they do not return in order: search «alpha», then
 *     «beta», let «alpha» be the slow one, and its rows painted last — alpha's
 *     products under beta's search box.
 *
 * Both are driven here through the real search box, with the first request held
 * back on purpose so the order of the answers is not left to chance.
 *
 * Run: pnpm catalog:browser
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const databaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;
process.env.CODIQ_POSTGRES_URL = databaseUrl;

const { prisma } = await import("../src/db/prisma.ts");
const { createStoreFoundation } = await import("../src/services/store-bootstrap.service.ts");

const runId = `catalog-${Date.now().toString(36)}`;
const port = 3241;
const base = `http://127.0.0.1:${port}`;
const executablePath = process.env.CODIQ_CHROMIUM_PATH || undefined;
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: databaseUrl, CODIQ_POSTGRES_URL: databaseUrl, CODIQ_NOTIFICATIONS_WORKER: "off" },
  stdio: "ignore",
});

async function waitFor(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const summary = {};
let browser;
try {
  const merchant = await prisma.merchant.create({ data: { email: `${runId}@codiq.test`, passwordHash: "unused", businessName: "متجر الكتالوج", approvalStatus: "approved" } });
  const store = await createStoreFoundation({ merchantId: merchant.id, name: "متجر الكتالوج", slug: runId, defaultSubdomain: runId });
  for (const [index, name] of ["Alpha Lamp", "Alpha Chair", "Beta Table", "Beta Shelf"].entries()) {
    await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-${index}`, name, priceIqd: 1000, stockQuantity: 5, isActive: true } });
  }
  await waitFor(`${base}/api/health`);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  const cardNames = async () => (await page.getByTestId("product-card").allInnerTexts()).map((text) => (/(Alpha|Beta) \w+/.exec(text) ?? [""])[0]).sort();
  const settle = (expected) => page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="product-card"]').length === count,
    expected,
    { timeout: 15000 },
  );

  await page.goto(`${base}/store/${store.slug}/products`);
  await settle(4);

  // 1. A search typed on the page filters the page.
  await page.fill("#catalog-search", "beta");
  await page.press("#catalog-search", "Enter");
  await page.waitForURL(/\?q=beta/);
  await settle(2);
  assert.deepEqual(await cardNames(), ["Beta Shelf", "Beta Table"], "a search typed on the catalog page filters it — not only after a reload");

  // 2. The older, slower answer does not win.
  await page.route(/\/api\/store\/[^/]+\/products\?.*q=alpha/i, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.fill("#catalog-search", "alpha");
  await page.press("#catalog-search", "Enter");
  await page.waitForTimeout(200);
  await page.fill("#catalog-search", "beta");
  await page.press("#catalog-search", "Enter");
  await page.waitForTimeout(3500); // past the held-back «alpha» answer
  assert.match(page.url(), /\?q=beta/);
  assert.deepEqual(await cardNames(), ["Beta Shelf", "Beta Table"], "the slow «alpha» answer must not paint over the newer «beta» search");
  summary.catalog = { searchFilters: true, staleAnswerDropped: true };

  console.log(JSON.stringify({ suite: "storefront-catalog", status: "passed", summary }, null, 2));
} finally {
  await browser?.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

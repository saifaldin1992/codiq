/**
 * Marketplace M3 in a real browser.
 *
 *   owner    «محتوى السوق»: adds a banner leading to a store, builds a discount
 *            event from a product found by search, and moves the collections
 *            block to the top of the front page;
 *   shopper  (phone) sees that order, taps the banner (counted) into the
 *            store, opens the discount event (headline, countdown, product),
 *            views a product and finds it under «شاهدته مؤخراً» back home, and
 *            opens a section page from «عرض الكل».
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3277;
const base = `http://127.0.0.1:${port}`;
const runId = `m3ui${Date.now().toString(36)}`;
const suffix = String(Date.now()).slice(-6);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    CODIQ_POSTGRES_URL: dbUrl,
    CODIQ_PUBLIC_BASE_URL: base,
    CODIQ_NOTIFICATIONS_WORKER: "off",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let browser;
let originalSections = null;
const storeIds = [];
try {
  await waitFor(`${base}/api/health`);
  originalSections = await prisma.marketHomeSection.findMany({ orderBy: { position: "asc" } });
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "MarketHomeOwner123!";
  const registerOwner = await fetch(`${base}/api/auth/platform/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }),
  });
  assert.ok([200, 201].includes(registerOwner.status));
  const registered = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96478${suffix}34`.slice(0, 14),
    email: `${runId}.m@codiq.test`,
    password: "MarketHomeUi!2026",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: registered.payload.account.id,
      name: `متجر ${runId}`,
      slug: `${runId}-a`,
      defaultSubdomain: `${runId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  storeIds.push(store.id);
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `${runId}-1`,
      name: `مكنسة ${runId}`,
      priceIqd: 90000,
      compareAtPriceIqd: 150000,
      stockQuantity: 20,
    },
  });

  browser = await chromium.launch(
    process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {}
  );

  // ── owner ───────────────────────────────────────────────────────────────────
  const owner = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  owner.on("dialog", (dialog) => void dialog.accept());
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-content`);

  await owner.getByTestId("market-content-tab-banners").click();
  await owner.getByTestId("banner-title").fill(`عروض ${runId}`);
  await owner.getByTestId("banner-link-kind").selectOption("store");
  await owner.getByTestId("banner-link-target").fill(store.slug);
  await owner.getByTestId("banner-save").click();
  await owner.getByTestId("market-content-notice").waitFor();
  const banner = await prisma.marketBanner.findFirstOrThrow({ where: { title: `عروض ${runId}` } });

  await owner.getByTestId("market-content-tab-collections").click();
  await owner.getByTestId("collection-title").fill("أسبوع الأجهزة المنزليّة");
  await owner.getByTestId("collection-slug").fill(`${runId}-week`);
  await owner.locator("select").filter({ hasText: "مجموعة مختارة" }).selectOption("discount");
  await owner.getByPlaceholder("«خصومات لحدّ» ٪ (اختياريّ)").fill("40");
  await owner.getByPlaceholder("«خصومات لحدّ» ٪ (اختياريّ)").press("Tab");
  const endsAt = new Date(Date.now() + 3 * 86_400_000);
  const local = new Date(endsAt.getTime() - endsAt.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  await owner.locator('input[type="datetime-local"]').nth(1).fill(local);
  await owner.getByTestId("collection-product-search").fill(`مكنسة ${runId}`);
  await owner.getByTestId("collection-product-search").press("Enter");
  await owner.getByTestId(`collection-pick-${product.id}`).click();
  await owner.getByTestId("collection-save").click();
  await owner.getByTestId("market-content-notice").waitFor();

  await owner.getByTestId("market-content-tab-home").click();
  const blocks = owner.locator('[data-testid^="market-home-block-"]');
  await blocks.first().waitFor();
  const count = await blocks.count();
  let collectionsAt = -1;
  for (let at = 0; at < count; at += 1)
    if ((await blocks.nth(at).innerText()).includes("المجموعات")) collectionsAt = at;
  assert.ok(collectionsAt > 0, "the seeded page has a collections block below the top");
  for (let at = collectionsAt; at > 0; at -= 1)
    await blocks.nth(at).getByRole("button", { name: "أعلى" }).click();
  await owner.getByTestId("market-home-save").click();
  await owner.getByTestId("market-content-notice").waitFor();

  // ── shopper ─────────────────────────────────────────────────────────────────
  const shopper = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  const errors = [];
  shopper.on("pageerror", (error) => errors.push(String(error)));
  await shopper.goto(`${base}/market`);
  await shopper.getByTestId("market-home-collections").waitFor();
  const firstBlock = await shopper
    .getByTestId("market-home")
    .locator(":scope > *")
    .first()
    .getAttribute("data-testid");
  assert.equal(firstBlock, "market-home-collections", "the owner's order is the shopper's order");

  await shopper.getByTestId(`market-banner-${banner.id}`).scrollIntoViewIfNeeded();
  await shopper.getByTestId(`market-banner-${banner.id}`).click();
  await shopper.getByTestId("market-store-page").waitFor();
  assert.equal(
    new URL(shopper.url()).pathname,
    `/market/s/${store.slug}`,
    "the banner leads to its store"
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await prisma.marketBanner.findUniqueOrThrow({ where: { id: banner.id } });
    if (row.views >= 1 && row.clicks >= 1) break;
    if (attempt === 19)
      assert.fail(`banner counts not recorded: views ${row.views}, clicks ${row.clicks}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  await shopper.goto(`${base}/market`);
  await shopper.getByTestId(`market-home-collection-${runId}-week`).click();
  await shopper.getByTestId("market-collection-page").waitFor();
  assert.match(
    await shopper.getByTestId("market-collection-page").innerText(),
    /خصومات لحدّ ٤٠٪|خصومات لحدّ ٤٠%/
  );
  await shopper.getByTestId("market-collection-countdown").waitFor();
  await shopper.getByTestId(`market-product-card-${product.id}`).click();
  await shopper.getByTestId("market-product-page").waitFor();

  await shopper.goto(`${base}/market`);
  await shopper
    .getByTestId("market-home-recent")
    .getByTestId(`market-product-card-${product.id}`)
    .waitFor();

  await shopper.goto(`${base}/market/section/discounts`);
  await shopper.getByTestId("market-section-page").waitFor();
  await shopper.getByTestId(`market-product-card-${product.id}`).first().waitFor();

  const overflow = await shopper.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  assert.ok(overflow <= 0, `no horizontal scroll at phone width (overflow ${overflow}px)`);
  assert.deepEqual(errors, [], "no script errors");
  console.log(
    JSON.stringify(
      {
        suite: "market-home-browser",
        status: "passed",
        summary: {
          ownerBuiltContent: true,
          homeOrder: true,
          bannerCounted: true,
          collectionPage: true,
          recentlyViewed: true,
          sectionPage: true,
        },
      },
      null,
      2
    )
  );
} finally {
  if (originalSections) {
    await prisma.marketHomeSection.deleteMany({});
    await prisma.marketHomeSection.createMany({
      data: originalSections.map(({ kind, title, config, isActive, position }) => ({
        kind,
        title,
        config,
        isActive,
        position,
      })),
    });
  }
  await prisma.marketBanner
    .deleteMany({ where: { title: { contains: runId } } })
    .catch(() => undefined);
  await prisma.marketCollection
    .deleteMany({ where: { slug: { startsWith: runId } } })
    .catch(() => undefined);
  if (storeIds.length)
    await prisma.store
      .updateMany({
        where: { id: { in: storeIds } },
        data: { marketStatus: "unlisted", marketStatusAt: new Date() },
      })
      .catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

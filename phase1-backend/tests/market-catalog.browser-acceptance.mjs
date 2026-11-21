/**
 * Marketplace M2 in a real browser.
 *
 *   merchant  «بيانات السوق»: files a product under «هواتف ذكيّة», gives it a
 *             price before discount, a warranty tag, a spec, an add-on and a
 *             per-order cap;
 *   shopper   (phone) finds it from «الفئات» and from the header search typed
 *             with a different hamza, narrows with the filter sheet (a discount
 *             floor keeps it, a price ceiling below it empties the grid with a
 *             way back), and opens its page: price and the price before, the
 *             discount, the tag, the spec, the add-on, the cap, and a buy button
 *             into the store's own checkout.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3275;
const base = `http://127.0.0.1:${port}`;
const runId = `m2ui${Date.now().toString(36)}`;
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
const storeIds = [];
try {
  await waitFor(`${base}/api/health`);
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const merchantPassword = "MarketCatalogUi123!";
  const registered = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96479${suffix}12`.slice(0, 14),
    email: merchantEmail,
    password: merchantPassword,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: registered.payload.account.id,
      name: `هواتف ${runId}`,
      slug: `${runId}-a`,
      defaultSubdomain: `${runId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
    select: { id: true, slug: true },
  });
  storeIds.push(store.id);
  const productName = `ايفون 15 ${runId}`;
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `${runId}-1`,
      name: productName,
      priceIqd: 1_500_000,
      stockQuantity: 9,
      description: "هاتف ذكي",
    },
  });

  browser = await chromium.launch(
    process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {}
  );

  // ── merchant ────────────────────────────────────────────────────────────────
  const merchant = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await merchant.goto(`${base}/merchant/login`);
  await merchant.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchant.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchant.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchant.waitForURL((url) =>
    url.pathname.startsWith(`/merchant/stores/${store.slug}/dashboard`)
  );
  await merchant.goto(`${base}/merchant/stores/${store.slug}/dashboard/products/market`);
  await merchant.getByTestId(`market-catalog-edit-${product.id}`).click();
  const phones = await prisma.marketCategory.findUniqueOrThrow({ where: { slug: "phones" } });
  await merchant.getByTestId("market-editor-category").selectOption(String(phones.id));
  await merchant.getByTestId("market-editor-compare").fill("1000");
  await merchant.getByTestId("market-editor-save").click();
  await merchant.getByTestId("market-catalog-error").waitFor();
  assert.match(
    await merchant.getByTestId("market-catalog-error").innerText(),
    /أعلى من سعر المنتج/,
    "a «before» price below the price is refused, in words"
  );
  await merchant.getByTestId("market-editor-compare").fill("1800000");
  await merchant.getByTestId("market-editor-max").fill("2");
  await merchant.getByTestId("market-editor-tag-warranty").check();
  await merchant.getByTestId("market-editor-add-spec").click();
  await merchant.getByPlaceholder("مثال: الذاكرة").fill("الذاكرة");
  await merchant.getByPlaceholder("256GB").fill("256GB");
  await merchant.getByTestId("market-editor-add-addon").click();
  await merchant.getByPlaceholder("مثال: تغليف هدية").fill("تغليف هدية");
  await merchant.getByPlaceholder("السعر").fill("5000");
  await merchant.getByTestId("market-editor-save").click();
  await merchant.getByTestId("market-catalog-notice").waitFor();
  const saved = await prisma.product.findUniqueOrThrow({
    where: { id: product.id },
    include: { addons: true },
  });
  assert.equal(saved.compareAtPriceIqd, 1_800_000);
  assert.equal(saved.maxPerOrder, 2);
  assert.deepEqual(saved.tags, ["warranty"]);
  assert.equal(saved.addons.length, 1);

  // ── shopper on a phone ──────────────────────────────────────────────────────
  const shopper = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  const errors = [];
  shopper.on("pageerror", (error) => errors.push(String(error)));

  await shopper.goto(`${base}/market/categories`);
  await shopper.getByTestId("market-category-phones").click();
  await shopper.getByTestId("market-category-title").waitFor();
  assert.match(await shopper.getByTestId("market-category-title").innerText(), /هواتف/);
  await shopper.getByTestId("market-filters-open").waitFor();

  // Header search, typed with a hamza the product name does not have.
  await shopper.getByTestId("market-search-input").fill(`أيفون ${runId}`);
  await shopper.getByTestId("market-search-input").press("Enter");
  const card = shopper.getByTestId(`market-product-card-${product.id}`);
  await card.waitFor();
  assert.match(await card.innerText(), /خصم ١٧٪|خصم ١٧%/, "the discount badge");
  assert.match(await card.innerText(), /مطابقة/, "the match percentage on a search result");

  await shopper.getByTestId("market-filters-open").click();
  await shopper
    .getByTestId("market-filter-discount")
    .getByRole("button", { name: "خصم +30%" })
    .click();
  await shopper.getByTestId("market-filter-apply").click();
  await shopper.getByTestId("market-search-results-empty").waitFor();
  await shopper.getByRole("button", { name: "مسح الفلاتر" }).click();
  await card.waitFor();
  await shopper.getByTestId("market-filters-open").click();
  await shopper.getByTestId("market-filter-max-price").fill("1000000");
  await shopper.getByTestId("market-filter-apply").click();
  await shopper.getByTestId("market-search-results-empty").waitFor();
  await shopper.getByRole("button", { name: "مسح الفلاتر" }).click();

  await card.click();
  await shopper.getByTestId("market-product-page").waitFor();
  assert.equal(new URL(shopper.url()).pathname, `/market/p/${product.id}`);
  const price = await shopper.getByTestId("market-product-price").innerText();
  assert.match(price, /١٬٥٠٠٬٠٠٠|1,500,000/);
  assert.match(price, /١٬٨٠٠٬٠٠٠|1,800,000/);
  assert.match(await shopper.getByTestId("market-product-page").innerText(), /مضمون/);
  assert.match(await shopper.getByTestId("market-product-specs").innerText(), /256GB/);
  assert.match(await shopper.getByTestId("market-product-addons").innerText(), /تغليف هدية/);
  assert.match(await shopper.getByTestId("market-product-limit").innerText(), /٢|2/);
  assert.equal(
    await shopper.getByTestId("market-product-buy").getAttribute("href"),
    `/store/${store.slug}/products/${product.id}`
  );

  // The store page lists it, and «عرض الكل» opens the store's catalogue.
  await shopper.getByTestId("market-product-store").click();
  await shopper
    .getByTestId("market-store-newest")
    .getByTestId(`market-product-card-${product.id}`)
    .waitFor();
  await shopper.getByTestId("market-store-all-products").click();
  await shopper
    .getByTestId("market-store-products-list")
    .getByTestId(`market-product-card-${product.id}`)
    .waitFor();

  const overflow = await shopper.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  assert.ok(overflow <= 0, `no horizontal scroll at phone width (overflow ${overflow}px)`);
  assert.deepEqual(errors, [], "no script errors");
  console.log(
    JSON.stringify(
      {
        suite: "market-catalog-browser",
        status: "passed",
        summary: {
          merchantEdited: true,
          categoryBrowse: true,
          searchAndFilters: true,
          productPage: true,
          storeCatalogue: true,
        },
      },
      null,
      2
    )
  );
} finally {
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

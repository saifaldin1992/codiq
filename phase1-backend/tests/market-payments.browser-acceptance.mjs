/**
 * Marketplace M13a in a real browser (phone), with the TEST providers.
 *
 *   The product page says «أو من X د.ع شهرياً». Card: checkout → the test
 *   gateway's page → a refused card, then a paid one → the order page says
 *   «مدفوع إلكترونيّاً». Instalments: a lender, a term, the code the lender
 *   «sent» (read from the server's log, as the market's sign-in code is) →
 *   the order page shows the plan and that delivery is paid in cash. The
 *   owner's «المدفوعات الإلكترونيّة» lists both and says test mode is on.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3295;
const base = `http://127.0.0.1:${port}`;
const runId = `m13ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}5`.slice(0, 11);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const codes = [];
const lenderCodes = [];
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
    CODIQ_OTP_PROVIDER: "insecure-log",
    CODIQ_ALLOW_OWNER_REGISTRATION: "true",
    CODIQ_PAYMENTS_PROVIDER: "fake",
    CODIQ_PAYMENTS_WEBHOOK_SECRET: "browser-test-webhook-secret-of-32-chars-or-more",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
web.stdout.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    try {
      if (line.includes("otp.code_logged_not_sent")) codes.push(JSON.parse(line).ctx.code);
      if (line.includes("payments.fake_code_logged")) lenderCodes.push(JSON.parse(line).ctx.code);
    } catch {
      /* not JSON */
    }
  }
});
async function waitForCode(list) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (list.length) return list.pop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("no code logged");
}
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
const summary = {};
try {
  await waitFor(`${base}/api/health`);
  await prisma.storefrontRateLimit.deleteMany({
    where: {
      OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_instalment" } }],
    },
  });
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  assert.ok(
    [200, 201].includes(
      (
        await fetch(`${base}/api/auth/platform/register`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }),
        })
      ).status
    )
  );
  const registered = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}2`.slice(0, 14),
    email: `${runId}@codiq.test`,
    password: "MarketPayUi!2026",
  });
  const store = await prisma.store.create({
    data: {
      merchantId: registered.payload.account.id,
      name: `إلكترونيّات ${runId}`,
      slug: `${runId}-a`,
      defaultSubdomain: `${runId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({
    data: { storeId: store.id, governorate: "Baghdad", amountIqd: 5000, isEnabled: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `${runId}-1`,
      name: `هاتف ${runId}`,
      priceIqd: 600_000,
      stockQuantity: 10,
    },
  });

  browser = await chromium.launch(
    process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {}
  );
  const errors = [];
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await waitForCode(codes));
  await page.getByTestId("market-account-name").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({
    where: { phoneNormalized: `+964${phone.slice(1)}` },
  });
  const karrada = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكرادة" },
  });
  await prisma.shopperAddress.create({
    data: {
      shopperId: shopper.id,
      label: "البيت",
      recipientName: "سارة",
      phoneNormalized: shopper.phoneNormalized,
      phoneVerifiedAt: new Date(),
      governorateKey: "Baghdad",
      districtId: karrada.id,
      addressLine: "شارع ٦٢",
      isDefault: true,
    },
  });

  // ── E6 and the card ─────────────────────────────────────────────────────────
  await page.goto(`${base}/market/p/${product.id}`);
  assert.match(
    await page.getByTestId("market-product-instalments").innerText(),
    /أو من .* شهرياً · أقساط حتى ٢٤ شهراً/
  );
  summary.teaser = true;
  await page.getByTestId("market-product-add").click();
  await page.waitForFunction(() => /السلة|تمت الإضافة/.test(document.body.innerText));
  await page.goto(`${base}/market/checkout/${store.slug}`);
  await page.getByTestId("market-checkout-pay-card").check();
  await page.getByTestId("market-checkout-place").click();
  await page.getByTestId("market-pay-test-gateway").waitFor();
  assert.match(page.url(), /\/market\/pay\//);
  assert.match(await page.getByTestId("market-pay-amount").innerText(), /٦٠٥/);
  await page.getByTestId("market-pay-decline").click();
  await page.getByTestId("market-pay-status").filter({ hasText: "فشل الدفع" }).waitFor();
  await page.getByTestId("market-pay-approve").click();
  await page.getByTestId("market-pay-status").filter({ hasText: "مدفوع" }).waitFor();
  await page.getByTestId("market-pay-order").click();
  await page
    .getByTestId("market-order-online-status")
    .filter({ hasText: "مدفوع إلكترونيّاً" })
    .waitFor();
  summary.card = true;

  // ── instalments ─────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/p/${product.id}`);
  await page.getByTestId("market-product-add").click();
  await page.waitForFunction(() => /السلة|تمت الإضافة/.test(document.body.innerText));
  await page.goto(`${base}/market/checkout/${store.slug}`);
  await page.getByTestId("market-checkout-pay-instalments").check();
  await page.getByTestId("market-instalments").waitFor();
  assert.equal(
    await page.getByTestId("market-checkout-place").isDisabled(),
    true,
    "no order before the plan is confirmed"
  );
  await page.getByTestId("market-instalments-term-6").click();
  await page.getByTestId("market-instalments-send").click();
  await page.getByTestId("market-instalments-plan").waitFor();
  await page.getByTestId("market-instalments-code").fill(await waitForCode(lenderCodes));
  await page.getByTestId("market-checkout-place").click();
  await page.waitForURL((url) => url.pathname.startsWith("/market/orders/"));
  await page
    .getByTestId("market-order-online-status")
    .filter({ hasText: "خطّة التقسيط معتمدة" })
    .waitFor();
  assert.match(
    await page.getByTestId("market-order-online-payment").innerText(),
    /٦ أشهر × .* ورسوم التوصيل .* نقداً/
  );
  summary.instalments = true;

  // ── the owner ───────────────────────────────────────────────────────────────
  const owner = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  owner.on("pageerror", (error) => errors.push(`owner: ${error}`));
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-payments`);
  await owner.getByTestId("payments-test-mode").waitFor();
  const rows = await owner
    .getByTestId("payments-row")
    .filter({ hasText: store.name })
    .allInnerTexts();
  assert.ok(
    rows.some((text) => text.includes("بطاقة")) && rows.some((text) => text.includes("أقساط")),
    JSON.stringify(rows)
  );
  summary.owner = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(
    JSON.stringify({ suite: "market-payments-browser", status: "passed", summary }, null, 2)
  );
} finally {
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

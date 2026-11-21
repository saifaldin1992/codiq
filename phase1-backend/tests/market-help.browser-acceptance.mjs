/**
 * Marketplace M7a in a real browser.
 *
 *   phone: the shopper hearts a product and follows a store, finds both in
 *   «المفضّلة» and the store on the home page; the store moves his order and
 *   the bell counts the notices; opening one goes to the order; «تحديد الكلّ
 *   كمقروء» clears the bell; help search opens an answer; «تواصل معنا» sends;
 *   «قيّم التطبيق» sends.
 *   desktop: the owner adds an answer shoppers then find, sets the support
 *   hours, and marks the message handled.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3283;
const base = `http://127.0.0.1:${port}`;
const runId = `m7ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}6`.slice(0, 11);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");

const codes = [];
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
  },
  stdio: ["ignore", "pipe", "inherit"],
});
web.stdout.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (!line.includes("otp.code_logged_not_sent")) continue;
    try {
      codes.push(JSON.parse(line).ctx.code);
    } catch {
      /* not JSON */
    }
  }
});
async function nextCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (codes.length) return codes.pop();
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
  await prisma.storefrontRateLimit.deleteMany({ where: { scope: "market_contact_ip" } });
  await prisma.marketAppFeedback.deleteMany({});
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  const registerOwner = await fetch(`${base}/api/auth/platform/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }),
  });
  assert.ok(
    [200, 201].includes(registerOwner.status),
    `owner registration ${registerOwner.status}`
  );
  const registered = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}2`.slice(0, 14),
    email: `${runId}@codiq.test`,
    password: "MarketHelpUi!2026",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const merchantId = registered.payload.account.id;
  const store = await prisma.store.create({
    data: {
      merchantId,
      name: `عطور ${runId}`,
      slug: `${runId}-a`,
      defaultSubdomain: `${runId}-a`,
      marketStatus: "listed",
      marketStatusAt: new Date(),
      marketListedAt: new Date(),
    },
  });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({
    data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
  });
  const perfume = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `${runId}-1`,
      name: `عطر ${runId}`,
      priceIqd: 25000,
      stockQuantity: 10,
    },
  });

  browser = await chromium.launch(
    process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {}
  );
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // ── owner: an answer, the hours ─────────────────────────────────────────────
  const owner = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  owner.on("pageerror", (error) => errors.push(`owner: ${error}`));
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-support`);
  await owner.getByTestId("market-support-tab-help").click();
  await owner.getByTestId("market-support-add-orders").click();
  await owner.getByTestId("market-support-question").fill(`متى يصل طلب ${runId}؟`);
  await owner.getByTestId("market-support-answer").fill("خلال يومين في بغداد.");
  await owner.getByTestId("market-support-article-save").click();
  await owner.getByTestId("market-support-notice").waitFor();
  await owner.getByTestId("market-support-hours").fill("يوميّاً من ٩ إلى ٩");
  await owner.getByTestId("market-support-contacts-save").click();
  await owner.waitForFunction(() =>
    /بيانات التواصل/.test(
      document.querySelector('[data-testid="market-support-notice"]')?.textContent ?? ""
    )
  );
  summary.ownerHelp = true;

  // ── shopper: sign in ────────────────────────────────────────────────────────
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({
    where: { phoneNormalized: `+964${phone.slice(1)}` },
  });
  const karrada = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكرادة" },
  });
  const address = await prisma.shopperAddress.create({
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

  // ── favourites ──────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/p/${perfume.id}`);
  await page.getByTestId(`market-favourite-${perfume.id}`).click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="market-favourite-${id}"]`)
        ?.getAttribute("aria-pressed") === "true",
    perfume.id
  );
  await page.goto(`${base}/market/s/${store.slug}`);
  await page.getByTestId("market-store-follow").click();
  await page.waitForFunction(() =>
    /تتابعه/.test(document.querySelector('[data-testid="market-store-follow"]')?.textContent ?? "")
  );
  await page.goto(`${base}/market/favourites`);
  await page.getByTestId(`market-product-card-${perfume.id}`).waitFor();
  assert.equal(
    await page.getByTestId(`market-favourite-${perfume.id}`).getAttribute("aria-pressed"),
    "true",
    "the heart is filled in the list too"
  );
  await page.getByTestId("market-favourites-tab-stores").click();
  await page.getByText(store.name).first().waitFor();
  await page.goto(`${base}/market`);
  await page.getByTestId("market-home-followed").waitFor();
  summary.favourites = true;

  // ── the bell ────────────────────────────────────────────────────────────────
  const orderId = await page.evaluate(
    async ({ productId, slug, addressId, key }) => {
      await fetch("/api/market/cart/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      const response = await fetch(`/api/market/checkout/${slug}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ addressId }),
      });
      return (await response.json()).order.id;
    },
    {
      productId: perfume.id,
      slug: store.slug,
      addressId: address.id,
      key: `${runId}-order-1-idempotency`,
    }
  );
  for (const toStatus of ["processing", "preparation"]) {
    const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
    await transitionOrderStatus(store.id, { kind: "merchant", id: merchantId }, orderId, {
      toStatus,
      expectedVersion: version,
    });
  }
  await page.goto(`${base}/market`);
  await page.getByTestId("market-bell-badge").waitFor();
  assert.match(await page.getByTestId("market-bell-badge").innerText(), /٢|2/);
  await page.getByTestId("market-bell").click();
  await page.getByTestId("market-notifications").waitFor();
  await page.locator('[data-testid^="market-notification-"][data-read="0"]').nth(1).waitFor();
  await page.locator('[data-testid^="market-notification-"]').first().click();
  await page.waitForURL((url) => url.pathname === `/market/orders/${orderId}`);
  await page.getByTestId("market-bell-badge").waitFor();
  assert.match(
    await page.getByTestId("market-bell-badge").innerText(),
    /١|1/,
    "opening one reads it"
  );
  await page.goto(`${base}/market/notifications`);
  await page.getByTestId("market-notifications-read-all").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="market-bell-badge"]'));
  summary.inbox = true;

  // ── help, contact, feedback ─────────────────────────────────────────────────
  await page.goto(`${base}/market/help`);
  await page.getByTestId("market-help-quick").waitFor();
  assert.match(
    await page.getByTestId("market-help-contact").innerText(),
    /يوميّاً من ٩ إلى ٩/,
    "the hours the owner set"
  );
  await page.getByTestId("market-help-search").fill(`طلب ${runId}`);
  await page.getByTestId("market-help-search").press("Enter");
  await page.getByTestId("market-help-results").getByText(`متى يصل طلب ${runId}؟`).click();
  await page.getByText("خلال يومين في بغداد.").waitFor();
  await page.goto(`${base}/market/help/contact`);
  await page.getByTestId("market-contact-kind-suggestion").click();
  assert.equal(
    await page.getByTestId("market-contact-phone").inputValue(),
    `${phone.slice(0, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`,
    "his number filled in"
  );
  await page.getByTestId("market-contact-name").fill("سارة");
  await page.getByTestId("market-contact-body").fill(`اقتراح ${runId}: أضيفوا فلتر اللون.`);
  await page.getByTestId("market-contact-submit").click();
  await page.getByTestId("market-contact-sent").waitFor();
  await page.goto(`${base}/market/feedback`);
  await page.getByTestId("market-feedback-stars-5").click();
  await page.getByTestId("market-feedback-like-variety").click();
  await page.getByTestId("market-feedback-submit").click();
  await page.getByTestId("market-feedback-done").waitFor();
  summary.helpContactFeedback = true;

  // ── owner: the message, the rating ──────────────────────────────────────────
  await owner.getByTestId("market-support-tab-messages").click();
  const message = await prisma.marketContactMessage.findFirstOrThrow({
    where: { body: { contains: runId } },
  });
  await owner.getByTestId(`market-support-handle-${message.id}`).click();
  await owner.waitForFunction(
    (id) => !document.querySelector(`[data-testid="market-support-message-${id}"]`),
    message.id
  );
  assert.equal(
    (await prisma.marketContactMessage.findUniqueOrThrow({ where: { id: message.id } })).status,
    "handled"
  );
  await owner.getByTestId("market-support-tab-feedback").click();
  await owner.getByTestId("market-support-feedback").getByText("تنوّع المتاجر والمنتجات").waitFor();
  summary.ownerQueue = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-help-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.store
    .updateMany({
      where: { id: { in: storeIds } },
      data: { marketStatus: "unlisted", marketStatusAt: new Date() },
    })
    .catch(() => undefined);
  await prisma.storefrontRateLimit
    .deleteMany({ where: { scope: "market_contact_ip" } })
    .catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

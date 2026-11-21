/**
 * Marketplace M13b in a real browser (phone). The test plays the partner app.
 *
 *   The partner opens /market/partner?token=… (signed) → the shopper is in,
 *   linked, and lands where the partner sent him; the token is gone from the
 *   address bar. The account page says «مربوط بـ… · آخر مزامنة». At checkout he
 *   picks «عبر …», gets a payment link (the deep link that opens the partner),
 *   the partner reports it paid (signed), and the page moves to the order.
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3296;
const base = `http://127.0.0.1:${port}`;
const runId = `m13pui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const SECRET = "browser-test-partner-secret-of-at-least-32-chars";
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
    CODIQ_OTP_PROVIDER: "insecure-log",
    CODIQ_PARTNER_APP_SECRET: SECRET,
    CODIQ_PARTNER_APP_NAME: "المحفظة الشريكة",
  },
  stdio: ["ignore", "ignore", "inherit"],
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
const handoff = (fields) => {
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      iat: Math.floor(Date.now() / 1000),
      nonce: randomBytes(16).toString("hex"),
      ...fields,
    })
  ).toString("base64url");
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("hex")}`;
};

let browser;
const storeIds = [];
const summary = {};
try {
  await waitFor(`${base}/api/health`);
  await prisma.storefrontRateLimit.deleteMany({
    where: { scope: { startsWith: "market_partner" } },
  });
  const registered = await registerMerchantDirect({
    ownerName: "تاجر",
    businessName: "متجر",
    phone: `+96475${digits}4`.slice(0, 14),
    email: `${runId}@codiq.test`,
    password: "MarketPartnerUi!2026",
  });
  const store = await prisma.store.create({
    data: {
      merchantId: registered.payload.account.id,
      name: `بقالة ${runId}`,
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
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `${runId}-1`,
      name: `رز ${runId}`,
      priceIqd: 12_000,
      stockQuantity: 10,
    },
  });
  const phone = `+96477${digits}6`.slice(0, 14);
  const account = `acct-${runId}`;

  browser = await chromium.launch(
    process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {}
  );
  const errors = [];
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));

  // ── A2: in from the partner ─────────────────────────────────────────────────
  await page.goto(
    `${base}/market/partner?token=${encodeURIComponent(handoff({ partnerAccountId: account, phone, name: "زينب" }))}&next=/account`
  );
  await page.waitForURL((url) => url.pathname === "/market/account");
  assert.equal(
    new URL(page.url()).searchParams.get("token"),
    null,
    "the token left the address bar"
  );
  await page.getByTestId("market-account-name").filter({ hasText: "زينب" }).waitFor();
  await page.getByTestId("market-partner-card").getByText("مربوط بـالمحفظة الشريكة").waitFor();
  await page.getByTestId("market-partner-synced").waitFor();
  summary.signIn = true;
  await page.goto(`${base}/market/partner?token=not.a-real-token-from-the-partner&next=/account`);
  await page.getByTestId("market-partner-enter-error").waitFor();
  summary.refused = true;

  // ── F10: pay through the partner ────────────────────────────────────────────
  const shopper = await prisma.shopper.findUniqueOrThrow({ where: { phoneNormalized: phone } });
  const karrada = await prisma.district.findFirstOrThrow({
    where: { governorateKey: "Baghdad", nameAr: "الكرادة" },
  });
  await prisma.shopperAddress.create({
    data: {
      shopperId: shopper.id,
      label: "البيت",
      recipientName: "زينب",
      phoneNormalized: phone,
      phoneVerifiedAt: new Date(),
      governorateKey: "Baghdad",
      districtId: karrada.id,
      addressLine: "شارع ٥٢",
      isDefault: true,
    },
  });
  await page.evaluate(async (productId) => {
    await fetch("/api/market/cart/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId, quantity: 2 }),
    });
  }, product.id);
  await page.goto(`${base}/market/checkout/${store.slug}`);
  await page.getByTestId("market-checkout-pay-partner").check();
  assert.equal(
    await page.getByTestId("market-checkout-place").isDisabled(),
    true,
    "the partner pays the link, not this button"
  );
  await page.getByTestId("market-partner-pay-create").click();
  const href = await page.getByTestId("market-partner-pay-open").getAttribute("href");
  assert.match(href, /^codiq-partner:\/\/pay\?token=.+&amount=27000$/);
  await page.getByTestId("market-partner-pay-waiting").waitFor();
  const token = new URL(
    href.replace("codiq-partner://", "https://partner.example/")
  ).searchParams.get("token");
  const raw = JSON.stringify({
    token,
    partnerAccountId: account,
    amountIqd: 27_000,
    paymentRef: `${runId}-pay`,
  });
  const paid = await fetch(`${base}/api/partner/payment-links/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codiq-signature": createHmac("sha256", SECRET).update(raw).digest("hex"),
    },
    body: raw,
  }).then((response) => response.json());
  assert.equal(paid.ok, true, JSON.stringify(paid));
  await page.waitForURL((url) => url.pathname === `/market/orders/${paid.orderId}`, {
    timeout: 15000,
  });
  await page
    .getByTestId("market-order-online-payment")
    .getByText("الدفع عبر التطبيق الشريك")
    .waitFor();
  await page
    .getByTestId("market-order-online-status")
    .filter({ hasText: "مدفوع إلكترونيّاً" })
    .waitFor();
  summary.paid = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(
    JSON.stringify({ suite: "market-partner-browser", status: "passed", summary }, null, 2)
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

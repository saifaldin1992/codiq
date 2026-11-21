/**
 * Marketplace M4 in a real browser, on a phone.
 *
 * The server runs with CODIQ_OTP_PROVIDER=insecure-log, so the one-time code
 * reaches the server log instead of an SMS — this test reads it from there,
 * exactly as a developer would.
 *
 *   sign in   phone → code → signed in; still signed in after a reload;
 *   profile   name and an interest saved;
 *   address   the shopper's own phone needs no code; another phone gets a code
 *             of its own; the default address drives «التوصيل إلى» and the
 *             product page's delivery price;
 *   sign out  back to the sign-in form.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3279;
const base = `http://127.0.0.1:${port}`;
const runId = `m4ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const ownPhone = `077${digits}1`.slice(0, 11);
const otherPhone = `078${digits}2`.slice(0, 11);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const codes = [];
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log" },
  stdio: ["ignore", "pipe", "inherit"],
});
web.stdout.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (!line.includes("otp.code_logged_not_sent")) continue;
    try { const entry = JSON.parse(line); codes.push({ tail: entry.ctx.phoneTail, code: entry.ctx.code }); } catch { /* not JSON */ }
  }
});
async function codeFor(phone) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = [...codes].reverse().find((row) => phone.endsWith(row.tail));
    if (found) { codes.splice(codes.indexOf(found), 1); return found.code; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no code logged for ${phone}`);
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
try {
  await waitFor(`${base}/api/health`);
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}5`.slice(0, 14), email: `${runId}@codiq.test`, password: "MarketAccountUi!2026" });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `متجر ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 4000, isEnabled: true } });
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-1`, name: `منتج ${runId}`, priceIqd: 10000, stockQuantity: 5 } });

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // ── sign in ─────────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(ownPhone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").waitFor();
  await page.getByTestId("market-sign-in-code").fill(await codeFor(ownPhone));
  await page.getByTestId("market-account-name").waitFor();
  await page.reload();
  await page.getByTestId("market-account-name").waitFor();

  // ── profile ─────────────────────────────────────────────────────────────────
  await page.getByTestId("market-account-info-link").click();
  await page.getByTestId("market-info-name").fill("زينب علي");
  await page.getByTestId("market-info-interests").getByRole("button", { name: "الإلكترونيات والموبايل" }).click();
  await page.getByTestId("market-info-save").click();
  await page.getByTestId("market-info-saved").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({ where: { phoneNormalized: `+964${ownPhone.slice(1)}` } });
  assert.equal(shopper.fullName, "زينب علي");
  assert.equal(shopper.interests.length, 1);

  // ── addresses ───────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/account/addresses`);
  await page.getByTestId("market-address-add").click();
  assert.equal(await page.getByTestId("market-address-recipient").inputValue(), "زينب علي", "the name is suggested");
  assert.equal(await page.getByTestId("market-address-phone").inputValue(), ownPhone, "the shopper's own phone is suggested");
  assert.equal(await page.getByTestId("market-address-phone-verify").count(), 0, "her own phone needs no code");
  await page.getByTestId("market-address-governorate").selectOption("Baghdad");
  await page.getByTestId("market-address-district").selectOption({ label: "الكرادة" });
  await page.getByTestId("market-address-line").fill("شارع ٦٢، بناية ١٤، الطابق ٣");
  await page.getByTestId("market-address-save").click();
  const rows = page.getByTestId("market-addresses").locator("li");
  await rows.filter({ hasText: "البيت" }).waitFor();
  assert.match(await rows.filter({ hasText: "البيت" }).innerText(), /الافتراضي/, "the first address is the default");
  assert.match(await page.getByTestId("market-location-button").innerText(), /بغداد · الكرادة/, "the default address drives «التوصيل إلى»");

  await page.getByTestId("market-address-add").click();
  await page.getByRole("button", { name: "العمل" }).click();
  await page.getByTestId("market-address-phone").fill(otherPhone);
  await page.getByTestId("market-address-phone-verify").waitFor();
  await page.getByTestId("market-address-governorate").selectOption("Baghdad");
  await page.getByTestId("market-address-district").selectOption({ label: "المنصور" });
  await page.getByTestId("market-address-line").fill("مجمع تجاري، مكتب ٢٠٧");
  assert.equal(await page.getByTestId("market-address-save").isDisabled(), true, "cannot save an unproven phone");
  await page.getByTestId("market-address-send-code").click();
  await page.getByTestId("market-address-code").fill(await codeFor(otherPhone));
  await page.getByTestId("market-address-save").click();
  await rows.filter({ hasText: "العمل" }).waitFor();
  assert.equal(await rows.count(), 2);

  // ── delivery price on a product ─────────────────────────────────────────────
  await page.goto(`${base}/market/p/${product.id}`);
  await page.getByTestId("market-delivery-to-me").waitFor();
  assert.match(await page.getByTestId("market-delivery-to-me").innerText(), /البيت.*٤٬٠٠٠|البيت.*4,000/);

  // ── sign out ────────────────────────────────────────────────────────────────
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-out").click();
  await page.getByTestId("market-sign-in").waitFor();
  await page.reload();
  await page.getByTestId("market-sign-in").waitFor();

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-account-browser", status: "passed", summary: { signIn: true, persisted: true, profile: true, addresses: true, deliveryQuote: true, signOut: true } }, null, 2));
} finally {
  await prisma.shopper.deleteMany({ where: { phoneNormalized: { in: [`+964${ownPhone.slice(1)}`] } } }).catch(() => undefined);
  if (storeIds.length) await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

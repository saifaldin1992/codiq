/**
 * codiq phase 15 browser acceptance — the merchant enables notifications from
 * the settings page, a real storefront checkout generates an event, and the
 * delivery log shows it with its state. Empty state is asserted before any
 * event exists. The worker child is disabled for a deterministic pending state.
 */
import assert from "node:assert/strict";
import { ownProvisionedPassword } from "./helpers/own-provisioned-password.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `phase15-ui-${Date.now().toString(36)}`;
const port = 3152;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "phase15-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "phase15-browser-seed-secret-not-for-production", CODIQ_NOTIFICATIONS_WORKER: "off" },
  stdio: "ignore",
});

const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(artifactsDir, { recursive: true });
const executablePath = process.env.CODIQ_CHROMIUM_PATH ?? (process.platform === "linux" ? "/usr/bin/chromium" : undefined);

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Expected authenticated response to set a session cookie.");
  return setCookie.split(";", 1)[0];
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe("TRUNCATE TABLE notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE");

  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const ownerPassword = "Phase15OwnerPass123!";
  let merchantPassword = "Phase15MerchantPass123!";

  const ownerRegister = await json("/api/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك قبول 15" }) });
  assert.equal(ownerRegister.response.status, 201);
  const ownerLogin = await json("/api/auth/platform/login", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword }) });
  const ownerCookie = sessionCookie(ownerLogin.response);
  const provisioned = await json("/api/platform/merchants/manual", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100482301", email: merchantEmail, temporaryPassword: merchantPassword, businessName: "تاجر قبول 15", firstStoreName: "متجر قبول 15" }) });
  assert.equal(provisioned.response.status, 201);
  const storeSlug = provisioned.body.store.slug;
  const storeId = provisioned.body.store.id;
  // ق-218/ق-226: a hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens (the gate itself is proven in `phase6:test`
  // and through the UI in `phase6:browser`).
  merchantPassword = await ownProvisionedPassword(base, merchantEmail, merchantPassword);
  await prisma.deliveryRate.update({ where: { storeId_governorate: { storeId, governorate: "Baghdad" } }, data: { amountIqd: 3000, isEnabled: true } });
  const product = await prisma.product.create({ data: { storeId, sku: "P15-UI", name: "منتج قبول 15", priceIqd: 6000, stockQuantity: 8, lowStockThreshold: 2 } });

  // ---------- merchant enables notifications from the settings page ----------
  const merchantContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await merchantContext.newPage();
  await page.goto(`${base}/merchant/login`);
  await page.locator('input[name="identifier"]').fill(merchantEmail);
  await page.locator('input[name="password"]').fill(merchantPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL(`**/merchant/stores/${storeSlug}/dashboard`);

  await page.goto(`${base}/merchant/stores/${storeSlug}/dashboard/settings/notifications`);
  try {
    await page.getByTestId("notif-empty").waitFor({ timeout: 15000 });
  } catch (cause) {
    await page.screenshot({ path: `${artifactsDir}/phase15-DEBUG.png`, fullPage: true });
    const bodyText = await page.locator("body").innerText().catch(() => "<unreadable>");
    throw new Error(`notif-empty never appeared. Page text: ${bodyText.slice(0, 800)}`);
  }
  const enableResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/merchant/stores/${storeSlug}/notifications/settings`) && response.request().method() === "PUT");
  // The checkbox is React-controlled: its checked state flips only after the PUT
  // resolves, so click() (not check()) is the correct driver here.
  await page.getByTestId("notif-enable").click();
  const enableResponse = await enableResponsePromise;
  assert.equal(enableResponse.status(), 200, "enabling notifications must persist");
  await page.getByTestId("notif-notice").waitFor();
  await page.screenshot({ path: `${artifactsDir}/phase15-notifications-settings.png`, fullPage: true });

  // ---------- a real storefront checkout generates the event ----------
  const register = await json(`/api/store/${storeSlug}/account/register`, { method: "POST", body: JSON.stringify({ phone: "+9647701500901", password: "Phase15CustomerPass!", fullName: "زبون قبول 15", email: `${runId}.customer@codiq.test` }) });
  assert.equal(register.response.status, 201);
  const customerToken = register.body.accessToken;
  const addItem = await json(`/api/store/${storeSlug}/cart/items`, { method: "POST", headers: { authorization: `Bearer ${customerToken}` }, body: JSON.stringify({ productId: product.id, quantity: 1 }) });
  assert.equal(addItem.response.status, 200);
  const address = await json(`/api/store/${storeSlug}/account/addresses`, { method: "POST", headers: { authorization: `Bearer ${customerToken}` }, body: JSON.stringify({ recipientName: "زبون قبول 15", fullAddress: "شارع القبول 15", city: "Baghdad", governorate: "Baghdad", phoneContact: "+9647701500901", isDefault: true }) });
  assert.equal(address.response.status, 201);
  const checkout = await json(`/api/store/${storeSlug}/checkout`, { method: "POST", headers: { authorization: `Bearer ${customerToken}`, "idempotency-key": `${runId}-checkout` }, body: JSON.stringify({ cartVersion: addItem.body.cart.version, addressId: address.body.address.id, paymentMethodCode: "cod" }) });
  assert.equal(checkout.response.status, 201, JSON.stringify(checkout.body));
  const orderNumber = checkout.body.order.orderNumber;

  // ---------- the delivery log shows the event with its state ----------
  const refreshResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/merchant/stores/${storeSlug}/notifications/log`) && response.status() === 200);
  await page.getByTestId("notif-refresh").click();
  await refreshResponsePromise;
  await page.getByText(orderNumber).first().waitFor();
  const statusChip = await page.getByTestId("notif-status").first().textContent();
  assert.ok(statusChip && statusChip.length > 0, "the log row must show a delivery state");
  await page.screenshot({ path: `${artifactsDir}/phase15-notifications-log.png`, fullPage: true });

  console.log(JSON.stringify({
    phase: 15,
    flow: {
      emptyStateShown: true,
      enablePersisted: enableResponse.status(),
      checkout: checkout.response.status,
      orderNumber,
      logRowVisible: true,
      statusChip,
    },
    screenshots: [`${artifactsDir}/phase15-notifications-settings.png`, `${artifactsDir}/phase15-notifications-log.png`],
  }, null, 2));
  await merchantContext.close();
} finally {
  await browser.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

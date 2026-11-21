/**
 * codiq phase 17 browser acceptance — the public landing signs a merchant up for
 * real, the owner drives approval policy and settlements from the dashboard, the
 * merchant sees their dues, and a store host lands in its storefront.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `phase17-ui-${Date.now().toString(36)}`;
const port = 3172;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "phase17-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    SESSION_JWT_SECRET: "phase17-browser-seed-secret-not-for-production",
    CODIQ_NOTIFICATIONS_WORKER: "off",
  },
  stdio: "ignore",
});

const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(artifactsDir, { recursive: true });
const executablePath =
  process.env.CODIQ_CHROMIUM_PATH ??
  (process.platform === "linux" ? "/usr/bin/chromium" : undefined);

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: await response.json().catch(() => null) };
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE settlements, ledger_entries, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE"
  );
  await prisma.platformSetting.upsert({
    where: { key: "merchant_self_registration_mode" },
    create: { key: "merchant_self_registration_mode", value: "auto" },
    update: { value: "auto" },
  });

  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "Phase17OwnerPass123!";
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const merchantPassword = "Phase17MerchantPass123!";
  const storeSlug = `p17-${runId.slice(-8)}`;

  const ownerRegister = await json("/api/auth/platform/register", {
    method: "POST",
    body: JSON.stringify({
      email: ownerEmail,
      password: ownerPassword,
      displayName: "مالك قبول 17",
    }),
  });
  assert.equal(ownerRegister.response.status, 201);

  // ---------- the public landing signs a merchant up for real ----------
  const landing = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const landingPage = await landing.newPage();
  await landingPage.goto(`${base}/`);
  await landingPage.getByTestId("landing-plan-free").waitFor();
  await landingPage.getByTestId("landing-plan-growth").waitFor();
  await landingPage.getByTestId("landing-plan-pro").waitFor();

  // PC-1: the footer's contact details are the OWNER'S settings, not compiled-in
  // strings. Asserted in a real browser because the promise is a rendering one:
  // the page paints the compiled-in fallback with no request in its path (ق-137)
  // and then reconciles, so what has to be true is that a visitor ends up looking
  // at the PUBLISHED values — and that the wa.me link is built from the number,
  // not from a second copy of it.
  const { body: publishedContact } = await json("/api/public/contact");
  assert.deepEqual(
    Object.keys(publishedContact.contact).sort(),
    ["email", "phone", "whatsapp"],
    "PC-1: the public contact read publishes three fields and nothing else"
  );
  await landingPage.getByTestId("footer-contact-email").waitFor();
  assert.equal(
    await landingPage.getByTestId("footer-contact-email").getAttribute("href"),
    `mailto:${publishedContact.contact.email}`,
    "PC-1: the footer's email link is the published setting"
  );
  assert.equal(
    await landingPage.getByTestId("footer-contact-phone").getAttribute("href"),
    `tel:${publishedContact.contact.phone}`,
    "PC-1: …and the phone link dials the published number, whatever the visitor is shown"
  );
  assert.equal(
    await landingPage.getByTestId("footer-contact-whatsapp").getAttribute("href"),
    `https://wa.me/${publishedContact.contact.whatsapp.replace(/\D/g, "")}`,
    "PC-1: …and WhatsApp is built from that number rather than kept as a second copy"
  );

  await landingPage.getByTestId("signup-business").fill("تاجر قبول 17");
  await landingPage.getByTestId("signup-store-name").fill("متجر قبول 17");
  await landingPage.getByTestId("signup-store-slug").fill(storeSlug);
  await landingPage.getByTestId("signup-owner-name").fill("صاحب متجر القبول");
  await landingPage.getByTestId("signup-phone").fill("07709000017");
  await landingPage.getByTestId("signup-email").fill(merchantEmail);
  await landingPage.getByTestId("signup-password").fill(merchantPassword);
  const signupResponsePromise = landingPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/public/merchants/register") &&
      response.request().method() === "POST"
  );
  await landingPage.getByTestId("signup-submit").click();
  assert.equal(
    (await signupResponsePromise).status(),
    201,
    "landing signup must create the merchant"
  );
  await landingPage.getByTestId("signup-success").waitFor();
  await landingPage.screenshot({
    path: `${artifactsDir}/phase17-landing-signup.png`,
    fullPage: true,
  });
  await landing.close();

  // ---------- owner: approval policy + a pending request lifecycle ----------
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`${base}/platform/login`);
  await ownerPage.locator('input[name="email"]').fill(ownerEmail);
  await ownerPage.locator('input[name="password"]').fill(ownerPassword);
  await ownerPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await ownerPage.waitForURL("**/platform/dashboard");
  await ownerPage.goto(`${base}/platform/dashboard/merchants/registration-requests`);
  const manualModePromise = ownerPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/platform/settings/registration") &&
      response.request().method() === "PUT"
  );
  await ownerPage.getByTestId("registration-mode-manual").click();
  assert.equal((await manualModePromise).status(), 200);
  await ownerPage.getByTestId("registration-notice").waitFor();

  const pendingEmail = `${runId}.pending@codiq.test`;
  const pendingRegister = await json("/api/public/merchants/register", {
    method: "POST",
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100309701",
      businessName: "تاجر معلق 17",
      storeName: "متجر معلق",
      storeSlug: `p17p-${runId.slice(-8)}`,
      email: pendingEmail,
      password: "Pending17Password!",
    }),
  });
  assert.equal(pendingRegister.response.status, 201);
  assert.equal(pendingRegister.body.approvalStatus, "pending");
  await ownerPage.getByRole("button", { name: "تحديث" }).click();
  await ownerPage.getByTestId(`registration-request-${pendingEmail}`).waitFor();
  const approvePromise = ownerPage.waitForResponse(
    (response) => response.url().includes("/approval") && response.request().method() === "POST"
  );
  await ownerPage.getByTestId("registration-approve").click();
  assert.equal((await approvePromise).status(), 200, "approval must succeed from the UI");
  await ownerPage.screenshot({
    path: `${artifactsDir}/phase17-owner-registrations.png`,
    fullPage: true,
  });
  // Restore auto mode for suite isolation.
  await ownerPage.getByTestId("registration-mode-auto").click();
  await ownerPage.getByTestId("registration-notice").waitFor();

  // ---------- finance: a completed order books commission; the owner settles ----------
  const store = await prisma.store.findUnique({
    where: { slug: storeSlug },
    select: { id: true, merchantId: true },
  });
  const tokenMerchant = await createTypedSession("merchant", store.merchantId, store.id);
  const order = await prisma.storeOrder.create({
    data: {
      storeId: store.id,
      orderNumber: "P17-UI-0001",
      status: "new",
      customerName: "زبون قبول 17",
      subtotalIqd: 20000,
      deliveryFeeIqd: 4000,
      totalIqd: 24000,
    },
  });
  for (const [toStatus, expectedVersion] of [
    ["processing", 1],
    ["preparation", 2],
    ["out_for_delivery", 3],
    ["completed", 4],
  ]) {
    const transition = await json(`/api/merchant/stores/${storeSlug}/orders/${order.id}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenMerchant}` },
      body: JSON.stringify({ toStatus, expectedVersion }),
    });
    assert.equal(transition.response.status, 200, `${toStatus} must succeed`);
  }

  await ownerPage.goto(`${base}/platform/dashboard/commissions`);
  await ownerPage.getByTestId(`finance-merchant-${merchantEmail}`).waitFor();
  await ownerPage.getByTestId(`finance-settle-${merchantEmail}`).click();
  const settlePromise = ownerPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/platform/finance/settlements") &&
      response.request().method() === "POST"
  );
  await ownerPage.getByTestId("finance-settle-confirm").click();
  assert.equal((await settlePromise).status(), 201, "settlement must be recorded from the UI");
  await ownerPage.getByTestId("finance-notice").waitFor();
  await ownerPage.screenshot({ path: `${artifactsDir}/phase17-owner-finance.png`, fullPage: true });
  await ownerContext.close();

  // ---------- merchant sees dues and the recorded settlement ----------
  const merchantContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const merchantPage = await merchantContext.newPage();
  await merchantPage.goto(`${base}/merchant/login`);
  await merchantPage.locator('input[name="identifier"]').fill(merchantEmail);
  await merchantPage.locator('input[name="password"]').fill(merchantPassword);
  await merchantPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchantPage.waitForURL(`**/merchant/stores/${storeSlug}/dashboard`);
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/orders/settlements`);
  await merchantPage.getByTestId("merchant-finance-entry").first().waitFor();
  await merchantPage.getByText("P17-UI-0001").first().waitFor();
  await merchantPage.screenshot({
    path: `${artifactsDir}/phase17-merchant-finance.png`,
    fullPage: true,
  });

  // ---------- a store host lands in its storefront ----------
  const subdomain = (
    await prisma.store.findUnique({ where: { id: store.id }, select: { defaultSubdomain: true } })
  ).defaultSubdomain;
  await merchantPage.goto(`${base}/?codiq_host=${subdomain}.codiq.iq`);
  await merchantPage.waitForURL(`**/store/${storeSlug}`);
  await merchantPage.screenshot({
    path: `${artifactsDir}/phase17-host-storefront.png`,
    fullPage: true,
  });
  await merchantContext.close();

  console.log(
    JSON.stringify(
      {
        phase: 17,
        flow: {
          landingPlansVisible: 3,
          landingContactLinksMatchPublishedSettings: true,
          landingSignup: 201,
          manualModePersisted: 200,
          pendingApprovedFromUI: 200,
          settlementFromUI: 201,
          merchantSeesLedgerEntry: true,
          hostRedirectedToStorefront: `/store/${storeSlug}`,
        },
        screenshots: [
          "phase17-landing-signup.png",
          "phase17-owner-registrations.png",
          "phase17-owner-finance.png",
          "phase17-merchant-finance.png",
          "phase17-host-storefront.png",
        ].map((name) => `${artifactsDir}/${name}`),
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

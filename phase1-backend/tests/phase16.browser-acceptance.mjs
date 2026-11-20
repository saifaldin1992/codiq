/**
 * codiq phase 16 browser acceptance — the owner manages plans and assignments
 * from the platform dashboard, and the merchant sees their plan with live
 * usage bars in the subscription panel.
 */
import assert from "node:assert/strict";
import { ownProvisionedPassword } from "./helpers/own-provisioned-password.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `phase16-ui-${Date.now().toString(36)}`;
const port = 3162;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "phase16-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "phase16-browser-seed-secret-not-for-production", CODIQ_NOTIFICATIONS_WORKER: "off" },
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
  const ownerPassword = "Phase16OwnerPass123!";
  let merchantPassword = "Phase16MerchantPass123!";

  const ownerRegister = await json("/api/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك قبول 16" }) });
  assert.equal(ownerRegister.response.status, 201);
  const ownerLogin = await json("/api/auth/platform/login", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword }) });
  const ownerCookie = sessionCookie(ownerLogin.response);
  const provisioned = await json("/api/platform/merchants/manual", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100396001", email: merchantEmail, temporaryPassword: merchantPassword, businessName: "تاجر قبول 16", firstStoreName: "متجر قبول 16" }) });
  assert.equal(provisioned.response.status, 201);
  const storeSlug = provisioned.body.store.slug;
  // ق-218/ق-226: a hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens (the gate itself is proven in `phase6:test`
  // and through the UI in `phase6:browser`).
  merchantPassword = await ownProvisionedPassword(base, merchantEmail, merchantPassword);
  // ق-128 grants every new merchant a free MONTH on «growth», and this suite
  // asserts the subscription screen reads «خطة «المجانية»». It is about the
  // entitlements SCREEN, not about the trial, so the plan is pinned rather
  // than the expectation re-baselined — otherwise the assertion would move
  // again the next time the trial plan changes.
  const freePlanForScreen = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  await prisma.merchantSubscription.updateMany({
    where: { merchantId: provisioned.body.merchant.id, status: "active" },
    data: { planId: freePlanForScreen.id, endsAt: null },
  });

  // ---------- owner: plans page shows the three cards and price edits persist ----------
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`${base}/platform/login`);
  await ownerPage.locator('input[name="email"]').fill(ownerEmail);
  await ownerPage.locator('input[name="password"]').fill(ownerPassword);
  await ownerPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await ownerPage.waitForURL("**/platform/dashboard");

  await ownerPage.goto(`${base}/platform/dashboard/plans`);
  await ownerPage.getByTestId("plan-card-free").waitFor();
  await ownerPage.getByTestId("plan-card-growth").waitFor();
  await ownerPage.getByTestId("plan-card-pro").waitFor();
  await ownerPage.getByTestId("plan-price-growth").fill("27500");
  const saveResponsePromise = ownerPage.waitForResponse((response) => response.url().includes("/api/platform/plans/") && response.request().method() === "PATCH");
  await ownerPage.getByTestId("plan-save-growth").click();
  assert.equal((await saveResponsePromise).status(), 200, "plan save must persist");
  await ownerPage.getByTestId("plan-saved-growth").waitFor();
  await ownerPage.screenshot({ path: `${artifactsDir}/phase16-owner-plans.png`, fullPage: true });

  // ---------- owner: subscriptions page lists the merchant with its plan ----------
  await ownerPage.goto(`${base}/platform/dashboard/subscriptions`);
  await ownerPage.getByTestId(`subscription-row-${merchantEmail}`).waitFor();
  await ownerPage.screenshot({ path: `${artifactsDir}/phase16-owner-subscriptions.png`, fullPage: true });

  // ---------- merchant: subscription panel shows the plan and usage bars ----------
  const merchantContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const merchantPage = await merchantContext.newPage();
  await merchantPage.goto(`${base}/merchant/login`);
  await merchantPage.locator('input[name="identifier"]').fill(merchantEmail);
  await merchantPage.locator('input[name="password"]').fill(merchantPassword);
  await merchantPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchantPage.waitForURL(`**/merchant/stores/${storeSlug}/dashboard`);
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/settings/subscription`);
  await merchantPage.getByTestId("subscription-plan").waitFor();
  await merchantPage.getByText("خطة «المجانية»").waitFor();
  await merchantPage.getByTestId("entitlement-max_stores").waitFor();
  await merchantPage.getByTestId("entitlement-max_monthly_orders").waitFor();
  await merchantPage.screenshot({ path: `${artifactsDir}/phase16-merchant-subscription.png`, fullPage: true });

  console.log(JSON.stringify({
    phase: 16,
    flow: {
      ownerPlansVisible: ["free", "growth", "pro"],
      priceEditPersisted: 200,
      merchantRowVisible: true,
      merchantPlanVisible: "المجانية",
      usageBarsVisible: true,
    },
    screenshots: [`${artifactsDir}/phase16-owner-plans.png`, `${artifactsDir}/phase16-owner-subscriptions.png`, `${artifactsDir}/phase16-merchant-subscription.png`],
  }, null, 2));
  await merchantContext.close();
  await ownerContext.close();
} finally {
  await browser.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

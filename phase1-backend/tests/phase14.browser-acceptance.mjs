/**
 * codiq phase 14 browser acceptance — the live flow the owner gate requires:
 * merchant creates a staff member through the Team UI, the staff member signs in,
 * sees only permitted navigation, succeeds at an authorized action, fails at an
 * unauthorized one, and loses the session the moment the membership is disabled.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `phase14-ui-${Date.now().toString(36)}`;
const port = 3142;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "phase14-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    SESSION_JWT_SECRET: "phase14-browser-seed-secret-not-for-production",
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

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Expected authenticated response to set a session cookie.");
  return setCookie.split(";", 1)[0];
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  // `storefront_rate_limits` leads the list for the same reason it leads phase
  // 8B's (#140): the dashboard limiter is keyed `platform:<ip>` at 30 logins per
  // ten minutes, and every suite on this runner is the same 127.0.0.1 writing
  // into one shared database — so the counter is a number this suite INHERITS,
  // not one it sets. This suite signs in seven times. It was the last truncating
  // browser suite still missing the table; every other one already clears it.
  //
  // The three that DON'T clear it — phase 6, 7 and 13 — are deliberately left
  // alone: they import no Prisma client at all, so giving them a database
  // cleanup would be a change of what those suites ARE, not a correction. Their
  // exposure is latent (a handful of logins against a ceiling of 30) and the
  // right answer for them, if it ever goes live, is not a truncate bolted on
  // here.
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
  );

  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const staffEmail = `${runId}.staff@codiq.test`;
  const ownerPassword = "Phase14OwnerPass123!";
  // `let` because ق-218 makes the merchant replace the provisioner's password first.
  let merchantPassword = "Phase14MerchantPass123!";
  const staffPassword = "Phase14StaffPass123!";

  // Seed through the real APIs: owner -> merchant + first store.
  const ownerRegister = await json("/api/auth/platform/register", {
    method: "POST",
    body: JSON.stringify({
      email: ownerEmail,
      password: ownerPassword,
      displayName: "مالك قبول 14",
    }),
  });
  assert.equal(ownerRegister.response.status, 201);
  const ownerLogin = await json("/api/auth/platform/login", {
    method: "POST",
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  const ownerCookie = sessionCookie(ownerLogin.response);
  const provisioned = await json("/api/platform/merchants/manual", {
    method: "POST",
    headers: { cookie: ownerCookie },
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: "+9647100568601",
      email: merchantEmail,
      temporaryPassword: merchantPassword,
      businessName: "تاجر قبول 14",
      firstStoreName: "متجر قبول 14",
    }),
  });
  assert.equal(provisioned.response.status, 201);
  const storeSlug = provisioned.body.store.slug;
  const storeId = provisioned.body.store.id;
  // ق-218: a hand-provisioned merchant is refused every merchant surface until he
  // replaces the password the provisioner typed, and ق-226 sends him to «الأمان»
  // instead of the dashboard. Both are proven end to end in `phase6:test` and
  // through the UI in `phase6:browser`; this suite is about STAFF PERMISSIONS, so
  // it does in one call what he does on his first login.
  const merchantFirstSession = await json("/api/auth/merchant/login", {
    method: "POST",
    body: JSON.stringify({ identifier: merchantEmail, password: merchantPassword }),
  });
  assert.equal(
    merchantFirstSession.response.status,
    200,
    JSON.stringify(merchantFirstSession.body)
  );
  const merchantOwned = await json("/api/auth/password", {
    method: "POST",
    headers: { authorization: `Bearer ${merchantFirstSession.body.accessToken}` },
    body: JSON.stringify({
      currentPassword: merchantPassword,
      newPassword: `${merchantPassword}-Owned1`,
    }),
  });
  assert.equal(merchantOwned.response.status, 200, JSON.stringify(merchantOwned.body));
  merchantPassword = `${merchantPassword}-Owned1`;
  const order = await prisma.storeOrder.create({
    data: {
      storeId,
      orderNumber: "P14-UI-0001",
      status: "new",
      customerName: "زبون قبول 14",
      totalIqd: 4500,
    },
  });

  // ---------- merchant creates the staff member through the Team UI ----------
  const merchantContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const merchantPage = await merchantContext.newPage();
  await merchantPage.goto(`${base}/merchant/login`);
  await merchantPage.locator('input[name="identifier"]').fill(merchantEmail);
  await merchantPage.locator('input[name="password"]').fill(merchantPassword);
  await merchantPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchantPage.waitForURL(`**/merchant/stores/${storeSlug}/dashboard`);

  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/stores/team`);
  await merchantPage.getByTestId("team-create-email").fill(staffEmail);
  await merchantPage.getByTestId("team-create-name").fill("موظفة القبول");
  await merchantPage.getByTestId("team-create-password").fill(staffPassword);
  await merchantPage.getByTestId("team-create-role").selectOption("store_staff");
  const createResponsePromise = merchantPage.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/merchant/stores/${storeSlug}/team`) &&
      response.request().method() === "POST"
  );
  await merchantPage.getByTestId("team-create-submit").click();
  const createResponse = await createResponsePromise;
  assert.equal(createResponse.status(), 201, "Team UI staff creation must return 201.");
  await merchantPage.getByTestId(`team-row-${staffEmail}`).waitFor();
  await merchantPage.screenshot({
    path: `${artifactsDir}/phase14-merchant-team.png`,
    fullPage: true,
  });

  // ---------- staff signs in through the dedicated staff login ----------
  const staffContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const staffPage = await staffContext.newPage();
  await staffPage.goto(`${base}/staff/login`);
  await staffPage.locator('input[name="storeSlug"]').fill(storeSlug);
  await staffPage.locator('input[name="email"]').fill(staffEmail);
  await staffPage.locator('input[name="password"]').fill(staffPassword);
  await staffPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  // Audit 14-ب: the merchant typed this password, so the first stop is «الأمان».
  await staffPage.waitForURL(`**/staff/stores/${storeSlug}/dashboard/security`);
  await staffPage.getByTestId("staff-must-change-password").waitFor();
  const gatedCall = await staffPage.evaluate(
    async (slug) =>
      (await fetch(`/api/merchant/stores/${slug}/orders`, { credentials: "same-origin" })).status,
    storeSlug
  );
  assert.equal(gatedCall, 403, "14-ب: store surfaces refuse until the employee owns his password");
  await staffPage.screenshot({
    path: `${artifactsDir}/phase14-staff-must-change-password.png`,
    fullPage: true,
  });
  const ownedPassword = `${staffPassword}-Own`;
  await staffPage.getByTestId("current-password").fill(staffPassword);
  await staffPage.getByTestId("new-password").fill(ownedPassword);
  await staffPage.getByTestId("confirm-password").fill(ownedPassword);
  await staffPage.getByTestId("password-change-submit").click();
  await staffPage.getByTestId("password-change-done").waitFor();
  await staffPage.waitForFunction(
    () => !document.querySelector('[data-testid="staff-must-change-password"]')
  );
  await staffPage.goto(`${base}/staff/stores/${storeSlug}/dashboard`);
  await staffPage.waitForURL(`**/staff/stores/${storeSlug}/dashboard`);
  // The staff shell renders desktop and mobile sidebars, so testids appear twice; target the first.
  await staffPage.getByTestId("staff-display-name").first().waitFor();

  // Navigation shows the permitted entries only (store_staff role).
  await staffPage.getByTestId("staff-nav-orders").first().waitFor();
  await staffPage.getByTestId("staff-nav-products").first().waitFor();
  await staffPage.getByTestId("staff-nav-inventory").first().waitFor();
  assert.equal(
    await staffPage.getByTestId("staff-nav-customers").count(),
    0,
    "customers entry must be hidden"
  );
  assert.equal(
    await staffPage.getByTestId("staff-nav-team").count(),
    0,
    "team entry must be hidden"
  );
  assert.equal(
    await staffPage.getByTestId("staff-nav-settings").count(),
    0,
    "settings entry must be hidden"
  );
  await staffPage.screenshot({
    path: `${artifactsDir}/phase14-staff-dashboard.png`,
    fullPage: true,
  });

  // Authorized action succeeds end-to-end: open the order and move it to processing.
  await staffPage.getByTestId("staff-nav-orders").first().click();
  await staffPage.waitForURL(`**/staff/stores/${storeSlug}/dashboard/orders`);
  await staffPage.getByText("P14-UI-0001").first().click();
  await staffPage.waitForURL(`**/staff/stores/${storeSlug}/dashboard/orders/${order.id}`);
  const transitionResponsePromise = staffPage.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/merchant/stores/${storeSlug}/orders/${order.id}/status`) &&
      response.request().method() === "POST"
  );
  await staffPage.getByRole("button", { name: "نقل إلى «قيد المعالجة»" }).click();
  const transitionResponse = await transitionResponsePromise;
  assert.equal(transitionResponse.status(), 200, "staff orders.update must succeed in the browser");
  await staffPage.screenshot({
    path: `${artifactsDir}/phase14-staff-order-transition.png`,
    fullPage: true,
  });
  const transitionEvent = await prisma.orderStatusEvent.findFirst({
    where: { orderId: order.id, toStatus: "processing" },
  });
  assert.equal(transitionEvent?.actorKind, "staff", "the audit event must record the staff actor");

  // Unauthorized action fails at the server even when the UI is bypassed.
  const deniedTeamCall = await staffPage.evaluate(async (slug) => {
    const response = await fetch(`/api/merchant/stores/${slug}/team`, {
      credentials: "same-origin",
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, code: body?.error?.code ?? null };
  }, storeSlug);
  assert.equal(
    deniedTeamCall.status,
    403,
    "direct team API access from a store_staff session must be refused"
  );
  assert.equal(deniedTeamCall.code, "STAFF_PERMISSION_DENIED");

  // ---------- disabling the membership kills the live session ----------
  const membership = await prisma.storeStaffMembership.findFirst({
    where: { staff: { email: staffEmail } },
    select: { id: true },
  });
  const disableResponsePromise = merchantPage.waitForResponse(
    (response) =>
      response.url().includes(`/api/merchant/stores/${storeSlug}/team/${membership.id}`) &&
      response.request().method() === "PATCH"
  );
  await merchantPage
    .getByTestId(`team-row-${staffEmail}`)
    .getByTestId("team-active-toggle")
    .click();
  const disableResponse = await disableResponsePromise;
  assert.equal(disableResponse.status(), 200, "membership disable must succeed");

  const revokedCheck = await staffPage.evaluate(async (slug) => {
    const response = await fetch(`/api/staff/stores/${slug}/session`, {
      credentials: "same-origin",
    });
    return response.status;
  }, storeSlug);
  assert.equal(
    revokedCheck,
    401,
    "the staff session must die the moment the membership is disabled"
  );
  await staffPage.reload();
  await staffPage.waitForURL("**/staff/login");
  await staffPage.screenshot({ path: `${artifactsDir}/phase14-staff-revoked.png`, fullPage: true });

  console.log(
    JSON.stringify(
      {
        phase: 14,
        flow: {
          merchantCreatedStaffViaUI: 201,
          staffLogin: "PASS",
          allowedNavVisible: ["orders", "products", "inventory"],
          hiddenNav: ["customers", "team", "settings"],
          authorizedOrderTransition: transitionResponse.status(),
          auditActor: transitionEvent?.actorKind,
          directTeamApiDenied: deniedTeamCall,
          membershipDisableCutsSession: revokedCheck,
          redirectedToLogin: true,
        },
        screenshots: [
          "phase14-merchant-team.png",
          "phase14-staff-dashboard.png",
          "phase14-staff-order-transition.png",
          "phase14-staff-revoked.png",
        ].map((name) => `${artifactsDir}/${name}`),
      },
      null,
      2
    )
  );
  await staffContext.close();
  await merchantContext.close();
} finally {
  await browser.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

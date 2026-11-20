/**
 * codiq طاقم المنصة (ق-143 / 19-ب) browser acceptance — the platform-staff
 * lifecycle driven in real Chromium, against the DATABASE after every screen:
 *
 *   the owner opens «طاقم المنصة» and creates a «محاسب» through the real form
 *   → the accountant signs in at his own door (password only — TOTP is not
 *   demanded before enrolment) → the MANDATORY enrolment screen blocks the
 *   shell; the secret on screen IS the secret that verifies (the code is
 *   computed from what the page shows, nothing leaks from fixtures) → the
 *   shell opens with ONLY his entries (المالية there; الخطط والتسجيلات
 *   absent) → a plans deep-link renders the denial screen, not the panel →
 *   sign out, sign back in: the door now DEMANDS the second factor and the
 *   real code passes → the owner flips him inactive; the accountant's next
 *   reload lands on the login page — revocation is live, not advisory →
 *   Postgres agrees: audit rows for creation and the flip, actor snapshots
 *   intact, isActive=false.
 *
 * Harness mirrors pos.browser-acceptance.mjs: built server from dist,
 * TRUNCATE fixture reset, screenshots into the artifacts dir.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `ps1-ui-${Date.now().toString(36)}`;
const port = 3234;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "ps1-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const { totpForCounter, base32Decode, currentStep } = await import("../src/auth/totp.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "ps1-browser-seed-secret-not-for-production", CODIQ_NOTIFICATIONS_WORKER: "off" },
  stdio: "ignore",
});

const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(artifactsDir, { recursive: true });
const executablePath = process.env.CODIQ_CHROMIUM_PATH ?? (process.platform === "linux" ? "/usr/bin/chromium" : undefined);

async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

// ---------------------------------------------------------------- tripwire
// One narrow allowance: this suite DELIBERATELY provokes 401s (the pre-flip
// probe of an expired page, the revoked accountant's session fetch, a login
// attempt the door refuses pending the second factor) and 403s (the denial
// screen's refused API call). Chromium logs each as a resource error before
// the page's handler sees it. Anything else — a 500, a pageerror — fails.
const BENIGN_CONSOLE = [
  /Failed to load resource: the server responded with a status of (401|403)/,
];
const consoleErrors = [];
function armTripwire(page, tag) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(`[${tag}] ${text}`);
  });
  page.on("pageerror", (error) => { consoleErrors.push(`[${tag}] pageerror: ${error.message}`); });
}
function assertConsoleClean(where) {
  assert.equal(consoleErrors.length, 0, `page console must stay clean (${where}):\n${consoleErrors.join("\n")}`);
}

/** Blocks until the TOTP step counter advances — a spent code cannot replay. */
async function waitForFreshTotpStep() {
  const start = currentStep();
  while (currentStep() === start) await new Promise((resolve) => setTimeout(resolve, 1000));
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, platform_staff_sessions, platform_staff_permission_overrides, platform_audit_events, platform_staff, settlements, plan_upgrade_requests, ledger_entries, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, order_status_events, order_items, store_orders, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

  // ------------------------------------------------------------- fixtures
  const ownerEmail = `${runId}.owner@codiq.test`;
  const staffEmail = `${runId}.accountant@codiq.test`;
  const ownerPassword = "Ps1OwnerPass123!";
  const staffPassword = "Ps1AccountantPass123!";
  const ownerRegister = await json("/api/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك قبول الطاقم" }) });
  assert.equal(ownerRegister.response.status, 201, JSON.stringify(ownerRegister.body));

  // ---------------------------- 1: the owner creates a member ON SCREEN
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(30000);
  ownerPage.setDefaultNavigationTimeout(30000);
  armTripwire(ownerPage, "owner");

  await ownerPage.goto(`${base}/platform/login`);
  await ownerPage.locator('input[name="email"]').fill(ownerEmail);
  await ownerPage.locator('input[name="password"]').fill(ownerPassword);
  await ownerPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await ownerPage.waitForURL("**/platform/dashboard**");

  await ownerPage.goto(`${base}/platform/dashboard/platform-staff`);
  await ownerPage.getByTestId("platform-team-create-email").fill(staffEmail);
  await ownerPage.getByTestId("platform-team-create-name").fill("محاسب القبول");
  await ownerPage.getByTestId("platform-team-create-password").fill(staffPassword);
  await ownerPage.getByTestId("platform-team-create-role").selectOption("accountant");
  await ownerPage.getByTestId("platform-team-create-submit").click();
  await ownerPage.getByTestId(`platform-team-row-${staffEmail}`).waitFor();
  await ownerPage.screenshot({ path: `${artifactsDir}/ps1-team-created.png`, fullPage: true });
  const created = await prisma.platformStaff.findFirstOrThrow({ where: { email: staffEmail, deletedAt: null } });
  assert.equal(created.roleCode, "accountant", "the role on screen is the role in the row");
  assertConsoleClean("owner created the accountant");

  // -------------- 2: first sign-in, then the enrolment screen blocks all
  const staffContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const staffPage = await staffContext.newPage();
  staffPage.setDefaultTimeout(30000);
  staffPage.setDefaultNavigationTimeout(30000);
  armTripwire(staffPage, "staff");

  await staffPage.goto(`${base}/platform/staff/login`);
  await staffPage.locator('input[name="email"]').fill(staffEmail);
  await staffPage.locator('input[name="password"]').fill(staffPassword);
  await staffPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await staffPage.waitForURL("**/platform/staff/dashboard**");
  // The secret the page SHOWS is the only secret this test ever knows —
  // proving screen and server hold the same enrolment material.
  await staffPage.getByTestId("platform-staff-totp-secret").waitFor();
  const shownSecret = (await staffPage.getByTestId("platform-staff-totp-secret").innerText()).trim();
  assert.match(shownSecret, /^[A-Z2-7]{16,}$/, "the enrolment screen shows a base32 secret");
  await staffPage.screenshot({ path: `${artifactsDir}/ps1-totp-enrolment.png`, fullPage: true });

  await staffPage.getByTestId("platform-staff-totp-code").fill(totpForCounter(base32Decode(shownSecret), currentStep()));
  await staffPage.getByTestId("platform-staff-totp-confirm").click();

  // ------------------- 3: the shell shows HIS entries and only his
  await staffPage.getByTestId("platform-staff-permission-chips").waitFor();
  // The nav renders in two <aside>s (a visible desktop rail + a hidden mobile
  // drawer), so a PRESENT entry resolves to two nodes — .first() takes the
  // desktop one; an ABSENT entry is 0 in both, so the count checks stand.
  await staffPage.getByTestId("platform-staff-nav-finance").first().waitFor();
  assert.equal(await staffPage.getByTestId("platform-staff-nav-plans").count(), 0, "no plans entry for an accountant");
  assert.equal(await staffPage.getByTestId("platform-staff-nav-registrations").count(), 0, "no registrations entry for an accountant");
  await staffPage.getByTestId("platform-staff-nav-finance").first().click();
  await staffPage.waitForURL("**/platform/staff/dashboard/finance");
  assert.equal(await staffPage.getByTestId("platform-staff-denied").count(), 0, "finance opens, not the denial screen");
  await staffPage.screenshot({ path: `${artifactsDir}/ps1-accountant-finance.png`, fullPage: true });

  // --------------------------- 4: a plans deep-link meets the denial wall
  await staffPage.goto(`${base}/platform/staff/dashboard/plans`);
  await staffPage.getByTestId("platform-staff-denied").waitFor();
  await staffPage.screenshot({ path: `${artifactsDir}/ps1-denied-plans.png`, fullPage: true });
  assertConsoleClean("accountant toured his shell");

  // -------------- 5: enrolled now — the door demands the second factor
  // Enrolment stamped totpLastStep, so the code that CONFIRMED it is spent
  // (replay protection, by design). Wait for a fresh 30s step before the door
  // asks for one — the same wait a real cashier's app imposes on him.
  await waitForFreshTotpStep();
  await staffPage.getByTestId("platform-staff-logout").click();
  await staffPage.waitForURL("**/platform/staff/login**");
  await staffPage.locator('input[name="email"]').fill(staffEmail);
  await staffPage.locator('input[name="password"]').fill(staffPassword);
  await staffPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  // No code yet → the form reveals the totpCode field instead of entering.
  await staffPage.locator('input[name="totpCode"]').waitFor();
  await staffPage.locator('input[name="totpCode"]').fill(totpForCounter(base32Decode(shownSecret), currentStep()));
  await staffPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  await staffPage.waitForURL("**/platform/staff/dashboard**");
  await staffPage.getByTestId("platform-staff-permission-chips").waitFor();
  assertConsoleClean("second-factor door");

  // ------------------------ 6: the owner flips him off — revocation LIVE
  await ownerPage.getByTestId("platform-team-active-toggle").first().click();
  // Wait for the button to become «تفعيل» — the roster reloads only after the
  // PATCH resolves, so the flipped label is the real completion signal. The
  // row itself was already on screen and would wait for nothing.
  await ownerPage.getByTestId("platform-team-active-toggle").first().filter({ hasText: "تفعيل" }).waitFor();
  const flipped = await prisma.platformStaff.findFirstOrThrow({ where: { email: staffEmail, deletedAt: null } });
  assert.equal(flipped.isActive, false, "the toggle wrote the row");
  await staffPage.reload();
  await staffPage.waitForURL("**/platform/staff/login**");
  await staffPage.screenshot({ path: `${artifactsDir}/ps1-revoked-login.png`, fullPage: true });

  // ---------------------------------------- 7: the book remembers it all
  const audit = await prisma.platformAuditEvent.findMany({ where: { entityType: "platform_staff" }, orderBy: { createdAt: "asc" } });
  const actions = audit.map((event) => event.action);
  assert.ok(actions.indexOf("staff_created") !== -1, `audit holds the creation (${actions.join(", ")})`);
  assert.ok(actions.indexOf("staff_updated") !== -1, `audit holds the flip (${actions.join(", ")})`);
  for (const event of audit) {
    assert.equal(event.actorKind, "platform_owner", "team management is owner-only, and the log says who");
    assert.ok(event.actorLabel.length > 0, "the actor label snapshot is real");
  }
  assertConsoleClean("full lifecycle");

  console.log("ps1-browser OK");
} finally {
  await browser.close();
  web.kill();
  await prisma.$disconnect();
}

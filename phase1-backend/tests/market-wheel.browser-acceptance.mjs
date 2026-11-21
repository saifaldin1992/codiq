/**
 * Marketplace M9 in a real browser.
 *
 *   desktop (owner): creates the wheel, adds a «حظّ أوفر» and a points prize, opens it.
 *   phone: the front page links the wheel; «باقيلك ١ لفّة»; spinning lands on the
 *   prize the server drew; the result offers claiming and sharing; «الجوائز
 *   مالتك» claims it; the board shows «مركزك»; no spins left after.
 *   desktop (owner): closes it; the phone sees «العجلة مسكّرة».
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";

const port = 3287;
const base = `http://127.0.0.1:${port}`;
const runId = `m9ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}9`.slice(0, 11);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");
await prisma.storefrontRateLimit.deleteMany({ where: { scope: { startsWith: "market_otp" } } });
await prisma.marketWheel.deleteMany({ where: { spins: { none: {} } } });
await prisma.marketWheel.updateMany({ data: { isOpen: false } });

const codes = [];
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log", CODIQ_ALLOW_OWNER_REGISTRATION: "true" },
  stdio: ["ignore", "pipe", "inherit"],
});
web.stdout.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (!line.includes("otp.code_logged_not_sent")) continue;
    try { codes.push(JSON.parse(line).ctx.code); } catch { /* not JSON */ }
  }
});
async function nextCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) { if (codes.length) return codes.pop(); await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("no code logged");
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let browser;
const summary = {};
let wheelId = null;
try {
  await waitFor(`${base}/api/health`);
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  assert.ok([200, 201].includes((await fetch(`${base}/api/auth/platform/register`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }) })).status));
  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const errors = [];
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  owner.on("pageerror", (error) => errors.push(`owner: ${error}`));
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-wheel`);
  await owner.getByTestId("wheel-create").click();
  await owner.getByTestId("market-wheel-admin-notice").waitFor();
  await owner.getByTestId("wheel-prizes").waitFor();
  wheelId = (await prisma.marketWheel.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).id;
  const addPrize = async (label, kind, weight, extra = {}) => {
    await owner.getByTestId("prize-label").fill(label);
    await owner.getByTestId("prize-kind").selectOption(kind);
    await owner.getByTestId("prize-weight").fill(String(weight));
    if (extra.stock) await owner.getByTestId("prize-stock").fill(String(extra.stock));
    if (extra.points) await owner.getByTestId("prize-points").fill(String(extra.points));
    await owner.getByTestId("prize-add").click();
    await owner.locator('[data-testid="wheel-prizes"] td', { hasText: label }).first().waitFor();
  };
  await addPrize("حظّ أوفر", "nothing", 0);
  await addPrize("٥٠ نقطة", "points", 100, { stock: 10, points: 50 });
  await owner.getByTestId("wheel-toggle").click();
  await owner.waitForFunction(() => /تسكير العجلة/.test(document.querySelector('[data-testid="wheel-toggle"]')?.textContent ?? ""));
  summary.ownerSetup = true;

  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  await page.goto(`${base}/market`);
  await page.getByTestId("market-home-wheel").click();
  await page.getByTestId("market-wheel-left").waitFor();
  assert.match(await page.getByTestId("market-wheel-left").innerText(), /باقيلك ١ لفّة|باقيلك 1/);
  await page.getByTestId("market-wheel-spin").click();
  await page.getByTestId("market-wheel-result").waitFor({ timeout: 15000 });
  assert.match(await page.getByTestId("market-wheel-result-prize").innerText(), /٥٠ نقطة/);
  await page.getByTestId("market-wheel-share").waitFor();
  assert.match(await page.getByTestId("market-wheel-left").innerText(), /لفّات جديدة بعد/);
  assert.equal(await page.getByTestId("market-wheel-spin").isDisabled(), true, "no spins left");
  summary.spun = true;

  await page.getByTestId("market-wheel-claim-link").click();
  const win = await prisma.wheelWin.findFirstOrThrow({ where: { wheelId }, orderBy: { createdAt: "desc" } });
  await page.getByTestId(`market-wheel-claim-${win.id}`).click();
  await page.waitForFunction((id) => /استلمتها/.test(document.querySelector(`[data-testid="market-wheel-win-status-${id}"]`)?.textContent ?? ""), win.id);
  await page.getByTestId("market-wheel-tab-board").click();
  await page.getByTestId("market-wheel-my-rank").waitFor();
  assert.match(await page.getByTestId("market-wheel-my-rank").innerText(), /مركزك/);
  summary.claimedAndRanked = true;

  await owner.getByTestId("wheel-toggle").click();
  await owner.waitForFunction(() => /فتح العجلة/.test(document.querySelector('[data-testid="wheel-toggle"]')?.textContent ?? ""));
  await page.goto(`${base}/market/wheel`);
  await page.getByTestId("market-wheel-closed").waitFor();
  summary.closed = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-wheel-browser", status: "passed", summary }, null, 2));
} finally {
  if (wheelId) await prisma.marketWheel.updateMany({ where: { id: wheelId }, data: { isOpen: false } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await prisma.$disconnect();
}

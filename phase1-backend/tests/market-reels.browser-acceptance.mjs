/**
 * Marketplace M10 in a real browser: a short video from upload to the feed.
 *
 *   desktop: the store uploads a video with its product; it waits for review.
 *   desktop: the owner previews it and approves it. phone: the reel is on the
 *   front page and the store page, the feed plays it with the product card, a
 *   view is counted, the shopper likes it, the shared link opens it first, the
 *   card leads to the product. desktop: the store takes it down; the link says so.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3292;
const s3Port = 4597;
const base = `http://127.0.0.1:${port}`;
const runId = `m10ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}2`.slice(0, 11);
const bucket = `codiq-${runId}`;
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "latin1"), Buffer.alloc(12), Buffer.alloc(4000, 7)]);
const clip = join(mkdtempSync(join(tmpdir(), "codiq-reel-")), "clip.mp4");
writeFileSync(clip, mp4);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const s3Env = { PRODUCT_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`, PRODUCT_S3_BUCKET: bucket, PRODUCT_S3_ACCESS_KEY_ID: "S3RVER", PRODUCT_S3_SECRET_ACCESS_KEY: "S3RVER", PRODUCT_S3_REGION: "us-east-1", PRODUCT_S3_FORCE_PATH_STYLE: "true" };
const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  if (attempt === 39) throw new Error("Moto S3-compatible test server did not start.");
}
await new S3Client({ endpoint: s3Env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } }).send(new CreateBucketCommand({ Bucket: bucket }));

const codes = [];
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, ...s3Env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log", CODIQ_ALLOW_OWNER_REGISTRATION: "true" },
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
const storeIds = [];
const summary = {};
try {
  await waitFor(`${base}/api/health`);
  await prisma.storefrontRateLimit.deleteMany({ where: { OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_reel" } }] } });
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  const registerOwner = await fetch(`${base}/api/auth/platform/register`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }) });
  assert.ok([200, 201].includes(registerOwner.status));
  const merchantEmail = `${runId}@codiq.test`;
  const merchantPassword = "MarketReelsUi!2026";
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}9`.slice(0, 14), email: merchantEmail, password: merchantPassword });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `أزياء ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  storeIds.push(store.id);
  const dress = await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-1`, name: `فستان ${runId}`, priceIqd: 45000, stockQuantity: 5 } });

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const errors = [];

  // ── the store uploads ───────────────────────────────────────────────────────
  const merchant = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  merchant.on("pageerror", (error) => errors.push(`merchant: ${error}`));
  await merchant.goto(`${base}/merchant/login`);
  await merchant.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchant.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchant.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchant.waitForURL((url) => url.pathname.startsWith(`/merchant/stores/${store.slug}/dashboard`));
  await merchant.goto(`${base}/merchant/stores/${store.slug}/dashboard/products/market-reels`);
  await merchant.getByTestId("merchant-reels-form").waitFor();
  await merchant.getByTestId("merchant-reels-video").setInputFiles(clip);
  await merchant.getByTestId("merchant-reels-caption").fill("القماش على الضوء");
  await merchant.locator('[data-testid="merchant-reels-product"] option', { hasText: dress.name }).waitFor({ state: "attached" });
  await merchant.getByTestId("merchant-reels-product").selectOption(dress.id);
  await merchant.getByTestId("merchant-reels-submit").click();
  await merchant.getByTestId("merchant-reels-notice").waitFor();
  await merchant.getByTestId("merchant-reel-status").filter({ hasText: "بانتظار مراجعة السوق" }).waitFor();
  const reel = await prisma.marketReel.findFirstOrThrow({ where: { storeId: store.id } });
  assert.deepEqual([reel.status, reel.productId, reel.caption], ["pending", dress.id, "القماش على الضوء"]);
  assert.equal((await fetch(`${base}/api/market/reels/${reel.id}`)).status, 404, "not public yet");
  summary.uploaded = true;

  // ── the owner approves ──────────────────────────────────────────────────────
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  owner.on("pageerror", (error) => errors.push(`owner: ${error}`));
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-reels`);
  const row = owner.getByTestId("platform-reel-row").filter({ hasText: store.name });
  await row.waitFor();
  assert.equal(await row.locator("video").getAttribute("src"), `/api/platform/market/reels/${reel.id}/video`);
  await row.getByTestId("platform-reel-approve").click();
  await owner.getByTestId("platform-reels-notice").waitFor();
  assert.equal((await prisma.marketReel.findUniqueOrThrow({ where: { id: reel.id } })).status, "approved");
  summary.approved = true;

  // ── the shopper watches ─────────────────────────────────────────────────────
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  await page.goto(`${base}/market`);
  await page.getByTestId("market-reels-shelf").waitFor();
  await page.goto(`${base}/market/s/${store.slug}`);
  await page.getByTestId("market-reels-shelf").getByText("ريلز المتجر").waitFor();
  await page.getByTestId("market-reels-shelf-item").first().click();
  await page.waitForURL((url) => url.pathname === `/market/reels/${reel.id}`);
  const slide = page.locator(`[data-testid="market-reel"][data-reel-id="${reel.id}"]`);
  await slide.waitFor();
  assert.equal(await page.getByTestId("market-reel").first().getAttribute("data-reel-id"), reel.id, "the shared link opens it first");
  assert.match(await slide.getByTestId("market-reel-caption").innerText(), /القماش على الضوء/);
  assert.ok((await slide.getByTestId("market-reel-product").innerText()).includes(dress.name));
  for (let attempt = 0; attempt < 50 && (await prisma.marketReel.findUniqueOrThrow({ where: { id: reel.id } })).viewCount < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await prisma.marketReel.findUniqueOrThrow({ where: { id: reel.id } })).viewCount, 1, "a view after it played a moment");
  summary.watched = true;

  await slide.getByTestId("market-reel-like").click();
  await page.waitForFunction((id) => document.querySelector(`[data-reel-id="${id}"] [data-testid="market-reel-likes"]`)?.textContent === "1", reel.id);
  assert.equal(await prisma.marketReelLike.count({ where: { reelId: reel.id } }), 1);
  await page.reload();
  await page.waitForFunction((id) => document.querySelector(`[data-reel-id="${id}"] [data-testid="market-reel-like"]`)?.getAttribute("aria-pressed") === "true", reel.id);
  summary.liked = true;

  await page.locator(`[data-reel-id="${reel.id}"]`).getByTestId("market-reel-product").click();
  await page.waitForURL((url) => url.pathname === `/market/p/${dress.id}`);
  summary.toProduct = true;

  // ── the store takes it down ─────────────────────────────────────────────────
  await merchant.getByTestId("merchant-reel-row").first().getByTestId("merchant-reel-delete").click();
  await merchant.getByTestId("merchant-reels-notice").filter({ hasText: "حُذف" }).waitFor();
  await page.goto(`${base}/market/reels/${reel.id}`);
  await page.getByTestId("market-reel-gone").waitFor();
  summary.takenDown = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-reels-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await killTree(moto);
  await prisma.$disconnect();
}

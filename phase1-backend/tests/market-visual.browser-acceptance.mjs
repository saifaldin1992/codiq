/**
 * Marketplace M12 in a real browser: «البحث بالصورة».
 *
 *   phone: the camera button in the search box takes a photo of a red dress;
 *   the results page shows the red dresses first with how close they are; the
 *   first opens its product page, where «يشبهه في الشكل» shows the other one.
 *   desktop: the owner's «البحث بالصورة» panel counts the indexed products.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { chromium, devices } from "playwright";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3294;
const s3Port = 4599;
const base = `http://127.0.0.1:${port}`;
const runId = `m12ui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const bucket = `codiq-${runId}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");

const svg = (inner, bg = "#ffffff") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="100%" height="100%" fill="${bg}"/>${inner}</svg>`);
const dress = (colour) => `<path d="M240 80 L360 80 L380 220 L470 720 L130 720 L220 220 Z" fill="${colour}"/>`;
const pictures = {
  red: await sharp(svg(dress("#dc2626"))).png().toBuffer(),
  red2: await sharp(svg(`<path d="M250 90 L350 90 L370 230 L460 720 L140 720 L230 230 Z" fill="#c81e1e"/>`, "#f4f4f4")).png().toBuffer(),
  ball: await sharp(svg(`<circle cx="300" cy="400" r="220" fill="#f97316"/>`)).png().toBuffer(),
};
const photo = join(mkdtempSync(join(tmpdir(), "codiq-photo-")), "photo.jpg");
writeFileSync(photo, await sharp(pictures.red).resize(320).jpeg({ quality: 60 }).toBuffer());

const s3Env = { PRODUCT_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`, PRODUCT_S3_BUCKET: bucket, PRODUCT_S3_ACCESS_KEY_ID: "S3RVER", PRODUCT_S3_SECRET_ACCESS_KEY: "S3RVER", PRODUCT_S3_REGION: "us-east-1", PRODUCT_S3_FORCE_PATH_STYLE: "true" };
const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  if (attempt === 39) throw new Error("Moto S3-compatible test server did not start.");
}
await new S3Client({ endpoint: s3Env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } }).send(new CreateBucketCommand({ Bucket: bucket }));
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, ...s3Env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, CODIQ_POSTGRES_URL: dbUrl, CODIQ_PUBLIC_BASE_URL: base, CODIQ_NOTIFICATIONS_WORKER: "off", CODIQ_OTP_PROVIDER: "insecure-log", CODIQ_ALLOW_OWNER_REGISTRATION: "true" },
  stdio: ["ignore", "ignore", "inherit"],
});
async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
const api = (token) => async (path, init = {}) => {
  const response = await fetch(`${base}/api${path}`, { ...init, headers: { origin: base, ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  return { status: response.status, payload: await response.json().catch(() => null) };
};

let browser;
const storeIds = [];
const summary = {};
try {
  await waitFor(`${base}/api/health`);
  await prisma.storefrontRateLimit.deleteMany({ where: { OR: [{ scope: { startsWith: "market_image" } }, { scope: { startsWith: "product_image" } }] } });
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  assert.ok([200, 201].includes((await api()("/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }) })).status));
  const email = `${runId}@codiq.test`;
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}6`.slice(0, 14), email, password: "MarketVisualUi!2026" });
  const store = await prisma.store.create({ data: { merchantId: registered.payload.account.id, name: `أزياء ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  storeIds.push(store.id);
  const merchant = api((await api()("/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: email, password: "MarketVisualUi!2026" }) })).payload.accessToken);
  const products = {};
  for (const [key, name] of [["red", "فستان أحمر"], ["red2", "فستان سهرة أحمر"], ["ball", "كرة برتقاليّة"]]) {
    const product = await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-${key}`, name: `${name} ${runId}`, priceIqd: 35000, stockQuantity: 4 } });
    const form = new FormData(); form.append("images", new Blob([pictures[key]], { type: "image/png" }), `${key}.png`);
    assert.equal((await merchant(`/merchant/stores/${store.slug}/catalog/products/${product.id}/images`, { method: "POST", body: form })).status, 201);
    products[key] = product;
  }
  const ids = Object.values(products).map((product) => product.id);
  for (let attempt = 0; attempt < 50 && (await prisma.productImageEmbedding.count({ where: { productId: { in: ids } } })) < 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await prisma.productImageEmbedding.count({ where: { productId: { in: ids } } }), 3, "fingerprinted on upload");

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const errors = [];
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));

  // ── the shopper photographs a red dress ─────────────────────────────────────
  await page.goto(`${base}/market`);
  await page.getByTestId("market-photo-search-file").setInputFiles(photo);
  await page.waitForURL((url) => url.pathname === "/market/search/image");
  await page.getByTestId("market-image-search-preview").waitFor();
  await page.getByTestId("market-image-search-results").waitFor();
  const cards = await page.getByTestId("market-image-search-result").allInnerTexts();
  const ours = cards.filter((text) => text.includes(runId));
  assert.ok(ours[0]?.includes(`فستان أحمر ${runId}`), `the same dress first: ${JSON.stringify(ours)}`);
  assert.ok(ours.some((text) => text.includes(`فستان سهرة أحمر ${runId}`)), "and its cousin");
  assert.ok(!ours.some((text) => text.includes("كرة")), "not the ball");
  assert.match(ours[0], /تشابه [٠-٩]+٪/);
  summary.search = true;

  // ── its page: «يشبهه في الشكل» ──────────────────────────────────────────────
  await page.getByTestId("market-image-search-result").filter({ hasText: `فستان أحمر ${runId}` }).first().locator("a").first().click();
  await page.waitForURL((url) => url.pathname === `/market/p/${products.red.id}`);
  await page.getByTestId("market-product-look-alike").getByText(`فستان سهرة أحمر ${runId}`).waitFor();
  summary.lookAlike = true;

  // ── a second photo from the results page ────────────────────────────────────
  await page.goto(`${base}/market/search/image`);
  await page.getByTestId("market-image-search-pick").waitFor();
  await page.getByTestId("market-image-search-pick-file").setInputFiles(photo);
  await page.getByTestId("market-image-search-results").waitFor();
  summary.pickOnPage = true;

  // ── the owner's panel ───────────────────────────────────────────────────────
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  owner.on("pageerror", (error) => errors.push(`owner: ${error}`));
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-image-index`);
  await owner.getByTestId("image-index-indexed").waitFor();
  assert.ok(Number((await owner.getByTestId("image-index-indexed").innerText()).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "")) >= 3);
  summary.owner = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-visual-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await killTree(moto);
  await prisma.$disconnect();
}

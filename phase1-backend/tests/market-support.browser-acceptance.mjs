/**
 * Marketplace M7b in a real browser: a support ticket end to end.
 *
 *   phone: on a delivered order the shopper opens a ticket with a picture; he
 *   cannot reply yet. desktop: the store reads it (with the picture) and
 *   answers. phone: «ردود جديدة», he replies. desktop: the store answers and
 *   marks it solved. phone: «هل حُلّت مشكلتك؟ نعم» closes it. desktop: the
 *   owner finds it among the closed tickets.
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

const port = 3284;
const s3Port = 4595;
const base = `http://127.0.0.1:${port}`;
const runId = `m7tui${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const phone = `077${digits}7`.slice(0, 11);
const bucket = `codiq-${runId}`;
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");
const picture = join(mkdtempSync(join(tmpdir(), "codiq-ticket-")), "broken.png");
writeFileSync(picture, png);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");
const { transitionOrderStatus } = await import("../src/services/order-lifecycle.service.ts");

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
  await prisma.storefrontRateLimit.deleteMany({ where: { OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_ticket" } }, { scope: { startsWith: "ticket_upload" } }] } });
  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "OwnerPass123!Strong";
  const registerOwner = await fetch(`${base}/api/auth/platform/register`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك" }) });
  assert.ok([200, 201].includes(registerOwner.status));
  const merchantEmail = `${runId}@codiq.test`;
  const merchantPassword = "MarketTicketsUi!2026";
  const registered = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+96475${digits}3`.slice(0, 14), email: merchantEmail, password: merchantPassword });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const merchantId = registered.payload.account.id;
  const store = await prisma.store.create({ data: { merchantId, name: `عطور ${runId}`, slug: `${runId}-a`, defaultSubdomain: `${runId}-a`, marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() } });
  storeIds.push(store.id);
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true } });
  const perfume = await prisma.product.create({ data: { storeId: store.id, sku: `${runId}-1`, name: `عطر ${runId}`, priceIqd: 25000, stockQuantity: 10 } });

  browser = await chromium.launch(process.env.CODIQ_CHROMIUM_PATH ? { executablePath: process.env.CODIQ_CHROMIUM_PATH } : {});
  const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${base}/market/account`);
  await page.getByTestId("market-sign-in-phone").fill(phone);
  await page.getByTestId("market-sign-in-send").click();
  await page.getByTestId("market-sign-in-code").fill(await nextCode());
  await page.getByTestId("market-account-name").waitFor();
  const shopper = await prisma.shopper.findUniqueOrThrow({ where: { phoneNormalized: `+964${phone.slice(1)}` } });
  const karrada = await prisma.district.findFirstOrThrow({ where: { governorateKey: "Baghdad", nameAr: "الكرادة" } });
  const address = await prisma.shopperAddress.create({ data: { shopperId: shopper.id, label: "البيت", recipientName: "سارة", phoneNormalized: shopper.phoneNormalized, phoneVerifiedAt: new Date(), governorateKey: "Baghdad", districtId: karrada.id, addressLine: "شارع ٦٢", isDefault: true } });
  const orderId = await page.evaluate(async ({ productId, slug, addressId, key }) => {
    await fetch("/api/market/cart/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId, quantity: 1 }) });
    const response = await fetch(`/api/market/checkout/${slug}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ addressId }) });
    const body = await response.json();
    if (!body.order) throw new Error(`checkout failed: ${JSON.stringify(body)}`);
    return body.order.id;
  }, { productId: perfume.id, slug: store.slug, addressId: address.id, key: `${runId}-order-1-idempotency` });
  for (const toStatus of ["processing", "preparation", "out_for_delivery", "completed"]) {
    const { version } = await prisma.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
    await transitionOrderStatus(store.id, { kind: "merchant", id: merchantId }, orderId, { toStatus, expectedVersion: version });
  }

  // ── the shopper opens it from the order ─────────────────────────────────────
  await page.goto(`${base}/market/orders/${orderId}`);
  await page.getByTestId("market-order-ticket-new").click();
  await page.getByTestId("market-ticket-type-damaged").click();
  await page.getByTestId("market-ticket-subject").fill("زجاجة مكسورة");
  await page.getByTestId("market-ticket-description").fill("وصل العطر والزجاجة مكسورة من الأسفل.");
  await page.getByTestId("market-ticket-files").setInputFiles(picture);
  await page.getByTestId("market-ticket-submit").click();
  await page.getByTestId("market-ticket-page").waitFor();
  assert.match(await page.getByTestId("market-ticket-status").innerText(), /فُتحت/);
  await page.getByTestId("market-ticket-hint").waitFor();
  assert.equal(await page.getByTestId("market-ticket-reply").count(), 0, "no reply before support answers");
  const ticket = await prisma.supportTicket.findFirstOrThrow({ where: { orderId } });
  assert.equal(await prisma.supportTicketAttachment.count({ where: { ticketId: ticket.id } }), 1, "the picture went with it");
  summary.opened = true;

  // ── the store answers ───────────────────────────────────────────────────────
  const merchant = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  merchant.on("pageerror", (error) => errors.push(`merchant: ${error}`));
  await merchant.goto(`${base}/merchant/login`);
  await merchant.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await merchant.getByLabel("كلمة المرور", { exact: true }).fill(merchantPassword);
  await merchant.getByRole("button", { name: "تسجيل الدخول" }).click();
  await merchant.waitForURL((url) => url.pathname.startsWith(`/merchant/stores/${store.slug}/dashboard`));
  await merchant.goto(`${base}/merchant/stores/${store.slug}/dashboard/orders/support-tickets`);
  await merchant.getByTestId(`support-ticket-row-${ticket.id}`).click();
  await merchant.getByTestId("support-ticket-detail").waitFor();
  await merchant.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="support-ticket-detail"] img')).some((img) => img.complete && img.naturalWidth > 0), null, { timeout: 15000 });
  await merchant.getByTestId("support-ticket-reply").fill("نعتذر جدّاً، هل الغطاء سليم؟");
  await merchant.getByTestId("support-ticket-send").click();
  await merchant.waitForFunction(() => /بانتظار ردّك/.test(document.querySelector('[data-testid="support-ticket-status"]')?.textContent ?? ""));
  summary.storeAnswered = true;

  // ── the shopper replies ─────────────────────────────────────────────────────
  await page.goto(`${base}/market/tickets`);
  await page.getByTestId(`market-ticket-new-${ticket.id}`).waitFor();
  await page.getByTestId(`market-ticket-${ticket.id}`).click();
  await page.getByTestId("market-ticket-reply").fill("نعم الغطاء سليم، الزجاجة فقط.");
  await page.getByTestId("market-ticket-send").click();
  await page.waitForFunction(() => /قيد المعالجة/.test(document.querySelector('[data-testid="market-ticket-status"]')?.textContent ?? ""));
  summary.shopperReplied = true;

  // ── solved ──────────────────────────────────────────────────────────────────
  await merchant.reload();
  await merchant.getByTestId(`support-ticket-row-${ticket.id}`).click();
  await merchant.getByTestId("support-ticket-reply").fill("سنرسل لك عطراً بديلاً غداً.");
  await merchant.getByTestId("support-ticket-send-resolve").click();
  await merchant.waitForFunction(() => /حُلّت/.test(document.querySelector('[data-testid="support-ticket-status"]')?.textContent ?? ""));
  await page.reload();
  await page.getByTestId("market-ticket-confirm-yes").click();
  await page.waitForFunction(() => /مغلقة/.test(document.querySelector('[data-testid="market-ticket-status"]')?.textContent ?? ""));
  assert.equal(await page.getByTestId("market-ticket-reply").count(), 0, "no reply on a closed ticket");
  summary.closed = true;

  // ── the owner sees it ───────────────────────────────────────────────────────
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  owner.on("pageerror", (error) => errors.push(`owner: ${error}`));
  await owner.goto(`${base}/platform/login`);
  await owner.locator('input[name="email"]').fill(ownerEmail);
  await owner.locator('input[name="password"]').fill(ownerPassword);
  await owner.getByRole("button", { name: "تسجيل الدخول" }).click();
  await owner.waitForURL(/\/platform\/dashboard/);
  await owner.goto(`${base}/platform/dashboard/market-support`);
  await owner.getByTestId("support-tickets-platform").waitFor();
  await owner.getByRole("button", { name: "مغلقة" }).click();
  await owner.getByTestId(`support-ticket-row-${ticket.id}`).click();
  await owner.getByTestId("support-ticket-detail").getByText("سنرسل لك عطراً بديلاً غداً.").waitFor();
  summary.owner = true;

  assert.deepEqual(errors, [], "no script errors");
  console.log(JSON.stringify({ suite: "market-support-browser", status: "passed", summary }, null, 2));
} finally {
  await prisma.store.updateMany({ where: { id: { in: storeIds } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  await browser?.close();
  await killTree(web);
  await killTree(moto);
  await prisma.$disconnect();
}

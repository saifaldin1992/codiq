import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { killTree } from "./helpers/child-process.mjs";

const runId = `phase7-ui-${Date.now()}`;
// Unique like the emails below, and for the same reason: a merchant's phone is
// unique across the whole platform, so a constant made this suite green exactly
// once per database and answered every rerun with 409 DUPLICATE_MERCHANT_PHONE.
const merchantPhone = `+96471${String(Date.now()).slice(-8)}`;
const webPort = 3121;
const s3Port = 4570;
const bucket = `codiq-${runId}`;
const s3Endpoint = `http://127.0.0.1:${s3Port}`;
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL is required for the phase 7 browser test.");
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");

const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
const web = spawn("node", ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(webPort), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "phase7-browser-session-secret-not-for-production", PRODUCT_S3_ENDPOINT: s3Endpoint, PRODUCT_S3_BUCKET: bucket, PRODUCT_S3_ACCESS_KEY_ID: "S3RVER", PRODUCT_S3_SECRET_ACCESS_KEY: "S3RVER", PRODUCT_S3_REGION: "us-east-1", PRODUCT_S3_FORCE_PATH_STYLE: "true" }, stdio: "ignore" });
const base = `http://127.0.0.1:${webPort}`;

// 60 x 200ms, matching phase20b: the original 6s window is enough for moto on
// the Linux runner but not for a cold Python start on a developer machine, so
// the suite failed locally for a reason that has nothing to do with the code.
async function waitFor(url) { for (let attempt = 0; attempt < 60; attempt += 1) { try { const response = await fetch(url); if (response.ok || response.status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 200)); } throw new Error(`Timed out waiting for ${url}`); }

try {
  await waitFor(s3Endpoint);
  const s3 = new S3Client({ endpoint: s3Endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await waitFor(`${base}/health`);

  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const ownerRegister = await fetch(`${base}/api/auth/platform/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ownerEmail, password: "OwnerPass123!", displayName: "Phase 7 Owner" }) });
  assert.equal(ownerRegister.status, 201);
  const ownerLogin = await fetch(`${base}/api/auth/platform/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ownerEmail, password: "OwnerPass123!" }) });
  const ownerCookieHeader = ownerLogin.headers.get("set-cookie"); assert.ok(ownerCookieHeader);
  const ownerCookie = ownerCookieHeader.split(";", 1)[0];
  const merchantCreated = await fetch(`${base}/api/platform/merchants/manual`, { method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie }, body: JSON.stringify({ ownerName: "صاحب المتجر", phone: merchantPhone, email: merchantEmail, temporaryPassword: "MerchantPass123!", businessName: "متجر اختبار المرحلة السابعة", firstStoreName: "متجر منتجات حي" }) });
  const merchantPayload = await merchantCreated.json();
  if (merchantCreated.status !== 201) throw new Error(`Manual merchant creation failed: ${merchantCreated.status} ${JSON.stringify(merchantPayload)}`);
  const storeSlug = merchantPayload.store.slug;
  // ق-218 / ق-226: a hand-provisioned merchant must replace the password his
  // provisioner typed before any merchant surface opens, and the shell sends him
  // to «الأمان» rather than the dashboard until he does. Proven end to end in
  // `phase6:test` and through the UI in `phase6:browser`; this suite is about the
  // CATALOGUE, so it does in two calls what he does on his first login.
  const merchantFirstLogin = await fetch(`${base}/api/auth/merchant/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: merchantEmail, password: "MerchantPass123!" }) });
  const merchantFirstSession = await merchantFirstLogin.json();
  if (merchantFirstLogin.status !== 200) throw new Error(`Merchant login failed: ${merchantFirstLogin.status} ${JSON.stringify(merchantFirstSession)}`);
  const ownedPassword = "MerchantPass123!-Owned1";
  const passwordChanged = await fetch(`${base}/api/auth/password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${merchantFirstSession.accessToken}` }, body: JSON.stringify({ currentPassword: "MerchantPass123!", newPassword: ownedPassword }) });
  if (passwordChanged.status !== 200) throw new Error(`Merchant password change failed: ${passwordChanged.status} ${JSON.stringify(await passwordChanged.json().catch(() => null))}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${base}/merchant/login`);
  await page.getByLabel("البريد الإلكتروني أو رقم الهاتف").fill(merchantEmail);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(ownedPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL(new RegExp(`/merchant/stores/${storeSlug}/dashboard`));
  await page.goto(`${base}/merchant/stores/${storeSlug}/dashboard/products/categories`);
  await page.getByLabel("اسم التصنيف").fill("تصنيف المتصفح");
  await page.getByRole("button", { name: "إضافة التصنيف" }).click();
  await page.getByText("تم إنشاء التصنيف.").waitFor();
  await page.getByTestId("category-edit-select").selectOption({ label: "تصنيف المتصفح" });
  await page.getByLabel("الاسم الجديد").fill("تصنيف متصفح محدّث");
  await page.getByRole("button", { name: "حفظ التعديلات" }).click();
  await page.getByText("تم حفظ تعديلات التصنيف.").waitFor();
  await page.goto(`${base}/merchant/stores/${storeSlug}/dashboard/products/add`);
  await page.getByLabel("اسم المنتج").fill("قهوة واجهة حية");
  await page.getByLabel("SKU").fill(`UI-${Date.now()}`);
  await page.getByLabel("السعر بالدينار العراقي").fill("17500");
  await page.getByLabel("كمية المخزون").fill("4");
  await page.getByLabel("حد تنبيه المخزون").fill("5");
  await page.locator("select").selectOption({ label: "تصنيف متصفح محدّث" });
  await page.locator('input[type="file"]').setInputFiles({ name: "ui-product.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "إنشاء المنتج" }).click();
  await page.getByText("تم إنشاء المنتج وصوره داخل المتجر الحالي.").waitFor();
  await page.goto(`${base}/merchant/stores/${storeSlug}/dashboard/products`);
  await page.getByText("قهوة واجهة حية").waitFor();
  await page.getByRole("button", { name: "تعديل" }).click();
  await page.getByLabel("الوصف").fill("وصف معدل من واجهة التاجر");
  await page.getByRole("button", { name: "حفظ" }).click();
  await page.getByText("تم تحديث المنتج.").waitFor();
  const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu";
  fs.mkdirSync(artifactsDir, { recursive: true });
  await page.screenshot({ path: `${artifactsDir}/phase7-product-browser-success.png`, fullPage: true });
  await browser.close();
  console.log(JSON.stringify({ storeSlug, merchantEmail, productCreatedFromBrowser: true, screenshot: `${artifactsDir}/phase7-product-browser-success.png` }, null, 2));
} finally {
  web.kill("SIGTERM");
  killTree(moto);
}

import fs from "node:fs";
import { chromium } from "playwright";

const base = process.env.PHASE6_WEB_BASE_URL ?? "http://127.0.0.1:3114";
const testSuffix = Date.now().toString(36);
// A merchant's phone is unique across the WHOLE platform, not per store, so a
// constant here made the claim below false: the suite was green exactly once
// per database and answered every rerun with 409 DUPLICATE_MERCHANT_PHONE — a
// fixture collision wearing a product error's clothes. CI hides it by handing
// each run a freshly migrated database; a rerun of the browser job, or anyone
// running this twice locally, does not get that. Same suffix as the emails, so
// the whole fixture is one identity.
const testPhone = `07701${String(Date.now()).slice(-6)}`;
// A unique, script-created owner keeps this flow independent from other suites' data.
const ownerEmail = `owner.phase6.browser.${testSuffix}@codiq.test`;
const ownerPassword = "phase6-owner-password";
const merchantEmail = `browser.session.${testSuffix}@codiq.test`;
const merchantPassword = "phase6-browser-session-password";
const screenshots = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(screenshots, { recursive: true });

const executablePath =
  process.env.CODIQ_CHROMIUM_PATH ??
  (process.platform === "linux" ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  const ownerRegistration = await fetch(`${base}/api/auth/platform/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: ownerEmail,
      password: ownerPassword,
      displayName: "مالك متصفح المرحلة 6",
    }),
  });
  if (ownerRegistration.status !== 201)
    throw new Error(`Unique browser owner registration failed with ${ownerRegistration.status}.`);
  await page.goto(`${base}/platform/login`);
  await page.locator('input[name="email"]').fill(ownerEmail);
  await page.locator('input[name="password"]').fill(ownerPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL("**/platform/dashboard");
  await page.goto(`${base}/platform/dashboard/merchants/add`);
  await page.locator('input[name="businessName"]').fill("تاجر اختبار المتصفح");
  await page.locator('input[name="firstStoreName"]').fill("متجر اختبار المتصفح");
  // P27-12 (ق-100): the owner's manual form now collects the merchant's own name
  // and number — the third creation path, and the one the acceptance criterion
  // for that item forgets.
  await page.locator('input[name="ownerName"]').fill("صاحب متجر المتصفح");
  await page.locator('input[name="phone"]').fill(testPhone);
  await page.locator('input[name="email"]').fill(merchantEmail);
  await page.locator('input[name="temporaryPassword"]').fill(merchantPassword);
  const merchantResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/platform/merchants/manual") &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "إنشاء تاجر ومتجر أول" }).click();
  const merchantResponse = await merchantResponsePromise;
  const merchantPayload = await merchantResponse.json();
  if (merchantResponse.status() !== 201)
    throw new Error(
      `Owner form response ${merchantResponse.status()}: ${JSON.stringify(merchantPayload)}`
    );
  await page.getByRole("status").waitFor();
  const ownerSuccess = await page.locator('[role="status"]').textContent();
  const storeSlug = ownerSuccess?.match(/store-[a-f0-9]+/)?.[0];
  if (!storeSlug) throw new Error(`Cannot extract store slug from: ${ownerSuccess}`);
  await page.screenshot({
    path: `${screenshots}/phase6-owner-browser-success.png`,
    fullPage: true,
  });

  const merchantContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const merchantPage = await merchantContext.newPage();
  await merchantPage.goto(`${base}/merchant/login`);
  await merchantPage.locator('input[name="identifier"]').fill(merchantEmail);
  await merchantPage.locator('input[name="password"]').fill(merchantPassword);
  await merchantPage.getByRole("button", { name: "تسجيل الدخول" }).click();
  // ق-218 — THE PROVISIONER'S PASSWORD OPENS ONE DOOR, AND THIS IS IT.
  //
  // The account was created moments ago by a platform owner who typed its first
  // password; until the merchant replaces it, that person holds a working key to
  // a live merchant account. So the login lands on «الأمان» rather than the
  // dashboard, the merchant sets a password nobody else has ever seen, and only
  // then does the rest of the platform open. Asserted here rather than only at
  // the API (`phase6:test`) because the redirect and the screen are the half a
  // person actually meets.
  await merchantPage.waitForURL("**/merchant/dashboard/account/security");
  const ownPassword = `${merchantPassword}-Owned1`;
  await merchantPage.locator('[data-testid="current-password"]').fill(merchantPassword);
  await merchantPage.locator('[data-testid="new-password"]').fill(ownPassword);
  await merchantPage.locator('[data-testid="confirm-password"]').fill(ownPassword);
  await merchantPage.locator('[data-testid="password-change-submit"]').click();
  await merchantPage.getByText("تم تغيير كلمة المرور.").waitFor();
  await merchantPage.screenshot({
    path: `${screenshots}/phase6-merchant-owns-his-password.png`,
    fullPage: true,
  });
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard`);
  await merchantPage.waitForURL(`**/merchant/stores/${storeSlug}/dashboard`);
  await merchantPage.goto(`${base}/merchant/stores/${storeSlug}/dashboard/customers/add`);
  await merchantPage.locator('input[name="fullName"]').fill("عميل اختبار المتصفح");
  await merchantPage
    .locator('input[name="email"]')
    .fill(`browser.customer.${testSuffix}@codiq.test`);
  await merchantPage.locator('input[name="phone"]').fill("07700000066");
  const customerResponsePromise = merchantPage.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/merchant/stores/${storeSlug}/customers/manual`) &&
      response.request().method() === "POST"
  );
  await merchantPage.getByRole("button", { name: "إضافة عميل للمتجر" }).click();
  const customerResponse = await customerResponsePromise;
  const customerPayload = await customerResponse.json();
  if (customerResponse.status() !== 201)
    throw new Error(
      `Merchant form response ${customerResponse.status()}: ${JSON.stringify(customerPayload)}`
    );
  await merchantPage.getByRole("status").waitFor();
  const merchantSuccess = await merchantPage.locator('[role="status"]').textContent();
  await merchantPage.screenshot({
    path: `${screenshots}/phase6-merchant-browser-success.png`,
    fullPage: true,
  });

  console.log(
    JSON.stringify(
      {
        ownerForm: { redirect: "/platform/dashboard", statusText: ownerSuccess, storeSlug },
        merchantForm: {
          redirect: `/merchant/stores/${storeSlug}/dashboard`,
          statusText: merchantSuccess,
        },
      },
      null,
      2
    )
  );
  await merchantContext.close();
} finally {
  await browser.close();
}

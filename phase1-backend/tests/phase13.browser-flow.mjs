import fs from "node:fs";
import { chromium } from "playwright";
import { ownProvisionedPassword } from "./helpers/own-provisioned-password.ts";

const base = process.env.PHASE13_WEB_BASE_URL ?? "http://127.0.0.1:3124";
const suffix = Date.now().toString(36);
// Unique like the emails below, and for the same reason: a merchant's phone is
// unique across the whole platform, so a constant made this suite green exactly
// once per database and answered every rerun with 409 DUPLICATE_MERCHANT_PHONE.
const merchantPhone = `+96471${String(Date.now()).slice(-8)}`;
const ownerEmail = `owner.phase13.${suffix}@codiq.test`;
const merchantEmail = `merchant.phase13.${suffix}@codiq.test`;
const password = "phase13-browser-password";
const firstStoreName = "متجر المرحلة 13 الأول";
const secondStoreName = "متجر المرحلة 13 الثاني";
const secondStoreSlug = `phase13-ui-${suffix}`;
const screenshots = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(screenshots, { recursive: true });

async function api(path, init = {}) {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return { payload, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

const executablePath =
  process.env.CODIQ_CHROMIUM_PATH ??
  (process.platform === "linux" ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const ownerRegistration = await api("/auth/platform/register", {
    method: "POST",
    body: JSON.stringify({ email: ownerEmail, password, displayName: "مالك اختبار المرحلة 13" }),
  });
  if (!ownerRegistration.payload.account?.id)
    throw new Error("Owner registration did not return an account.");
  const ownerLogin = await api("/auth/platform/login", {
    method: "POST",
    body: JSON.stringify({ email: ownerEmail, password }),
  });
  const provisioned = await api("/platform/merchants/manual", {
    method: "POST",
    headers: { cookie: ownerLogin.cookie },
    body: JSON.stringify({
      ownerName: "صاحب المتجر",
      phone: merchantPhone,
      businessName: "تاجر اختبار المرحلة 13",
      email: merchantEmail,
      temporaryPassword: password,
      firstStoreName,
    }),
  });
  const firstStoreSlug = provisioned.payload.store?.slug;
  if (!firstStoreSlug)
    throw new Error("Manual provisioning did not return the initial store slug.");
  // ق-218/ق-226: a hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens (the gate itself is proven in `phase6:test`
  // and through the UI in `phase6:browser`). This suite shares one `password`
  // between the owner and the merchant, so the merchant's own one starts here.
  const merchantPassword = await ownProvisionedPassword(base, merchantEmail, password);

  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desktop = await desktopContext.newPage();
  await desktop.goto(`${base}/merchant/login`);
  await desktop.locator('input[name="identifier"]').fill(merchantEmail);
  await desktop.locator('input[name="password"]').fill(merchantPassword);
  await desktop.getByRole("button", { name: "تسجيل الدخول" }).click();
  await desktop.waitForURL(`**/merchant/stores/${firstStoreSlug}/dashboard`);

  await desktop.getByRole("button", { name: "فتح مبدّل المتاجر" }).click();
  await desktop.getByRole("button", { name: "إنشاء متجر جديد" }).click();
  await desktop.locator('input[name="storeName"]').fill(secondStoreName);
  await desktop.locator('input[name="storeSlug"]').fill(secondStoreSlug);
  const createResponse = desktop.waitForResponse(
    (response) =>
      response.url().endsWith("/api/merchant/stores") && response.request().method() === "POST"
  );
  await desktop.getByRole("button", { name: "إنشاء المتجر", exact: true }).click();
  if ((await createResponse).status() !== 201)
    throw new Error("Store creation did not return 201.");
  await desktop.waitForURL(`**/merchant/stores/${secondStoreSlug}/dashboard`);
  await desktop.screenshot({
    path: `${screenshots}/phase13-store-switcher-desktop.png`,
    fullPage: true,
  });

  await desktop.getByRole("button", { name: "فتح مبدّل المتاجر" }).click();
  const desktopSwitchOption = desktop.locator(`[data-store-switch-option="${firstStoreSlug}"]`);
  await desktopSwitchOption.waitFor({ state: "visible" });
  const [switchResponse] = await Promise.all([
    desktop.waitForResponse(
      (response) =>
        response.url().endsWith("/api/merchant/stores/switch") &&
        response.request().method() === "POST"
    ),
    desktopSwitchOption.click(),
  ]);
  if (switchResponse.status() !== 200) throw new Error("Store switch did not return 200.");
  await desktop.waitForURL(`**/merchant/stores/${firstStoreSlug}/dashboard`);

  const mobileState = await desktopContext.storageState();
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: mobileState,
  });
  const mobile = await mobileContext.newPage();
  await mobile.goto(`${base}/merchant/stores/${firstStoreSlug}/dashboard`);
  await mobile.getByRole("button", { name: "فتح القائمة" }).click();
  await mobile.getByRole("button", { name: "فتح مبدّل المتاجر" }).click();
  const mobileSwitchOption = mobile.locator(`[data-store-switch-option="${secondStoreSlug}"]`);
  await mobileSwitchOption.waitFor({ state: "visible" });
  await mobileSwitchOption.click();
  await mobile.waitForURL(`**/merchant/stores/${secondStoreSlug}/dashboard`);
  await mobile.screenshot({
    path: `${screenshots}/phase13-store-switcher-mobile.png`,
    fullPage: true,
  });

  console.log(
    JSON.stringify(
      {
        phase: 13,
        desktop: { createdStore: secondStoreSlug, switchedBackTo: firstStoreSlug },
        mobile: { switchedTo: secondStoreSlug, width: 390 },
      },
      null,
      2
    )
  );
  await mobileContext.close();
  await desktopContext.close();
} finally {
  await browser.close();
}

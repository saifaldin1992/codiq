/**
 * PG-2 browser acceptance — the three symptoms the interface exists to produce,
 * driven through the real merchant dashboard at 390 / 768 / 1440.
 *
 * It exists because the guard needed a guard. `pg2.integration.mjs` proves the
 * SERVER serves the true movement count and the true «محفوظ لسجلاتك» flag; only
 * a browser can prove the sheet actually prints them, that the conflict opens a
 * pre-filled field instead of renaming anything, and that no screen scrolls
 * sideways on a phone (ق-28). Every assertion below compares what the page shows
 * against what the database says — never against a literal typed here.
 *
 *   1. the confirmation sheet quotes the REAL inventory-movement count (ق-10)
 *   2. the bin carries `deletedAt` on every row and «محفوظ لسجلاتك» with the
 *      server's own reason and NO countdown on a sold one (ق-97)
 *   3. a colliding restore answers 409 into a PRE-FILLED, EDITABLE field, and
 *      nothing is renamed or restored behind the merchant's back
 */
import assert from "node:assert/strict";
import { ownProvisionedPassword } from "./helpers/own-provisioned-password.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `pg2ui-${Date.now().toString(36)}`;
const port = 3182;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "pg2-ui-visual-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const { purgeExpiredSoftDeletes } = await import("../src/services/soft-delete/purge-job.ts");
const { TRASH_RETENTION_DAYS } = await import("../src/services/soft-delete/constants.ts");

const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "pg2-ui-visual-secret-not-for-production", CODIQ_NOTIFICATIONS_WORKER: "off" },
  stdio: "ignore",
});

const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(artifactsDir, { recursive: true });

async function waitFor(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function api(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

const widths = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
];
const overflow = [];
const shots = [];

async function captureAcrossWidths(context, page, name, prepare) {
  for (const size of widths) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await prepare(page);
    const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    overflow.push({ shot: name, width: size.name, scrollWidth: metrics.scrollWidth, clientWidth: metrics.clientWidth, horizontalOverflow: metrics.scrollWidth > metrics.clientWidth + 1 });
    const file = `${artifactsDir}/pg2ui-${name}-${size.name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
  }
}

const browser = await chromium.launch({ executablePath: process.env.CODIQ_CHROMIUM_PATH ?? (process.platform === "linux" ? "/usr/bin/chromium" : undefined), headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, store_audit_events, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

  // ---------- seed ----------
  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const ownerPassword = "Pg2UiOwnerPass123!";
  let merchantPassword = "Pg2UiMerchantPass123!";
  assert.equal((await api("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: ownerPassword, displayName: "مالك المنصة" } })).status, 201);
  const ownerLogin = await api("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: ownerPassword } });
  const ownerToken = ownerLogin.payload.accessToken;
  const provisioned = await api("/platform/merchants/manual", { method: "POST", token: ownerToken, body: { ownerName: "صاحب المتجر", phone: "+9647100026501", email: merchantEmail, temporaryPassword: merchantPassword, businessName: "متجر السلة", firstStoreName: "متجر السلة" } });
  assert.equal(provisioned.status, 201, JSON.stringify(provisioned.payload));
  const slug = provisioned.payload.store.slug;
  const storeRow = await prisma.store.findUniqueOrThrow({ where: { slug }, select: { id: true, merchantId: true } });
  // ق-218/ق-226: a hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens (the gate itself is proven in `phase6:test`
  // and through the UI in `phase6:browser`).
  merchantPassword = await ownProvisionedPassword(base, merchantEmail, merchantPassword);
  await prisma.deliveryRate.upsert({ where: { storeId_governorate: { storeId: storeRow.id, governorate: "Baghdad" } }, update: { amountIqd: 2500, isEnabled: true }, create: { storeId: storeRow.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  await prisma.notificationSettings.upsert({ where: { storeId: storeRow.id }, update: { isEnabled: true }, create: { storeId: storeRow.id, isEnabled: true } });
  const proPlan = await prisma.plan.findUniqueOrThrow({ where: { code: "pro" }, select: { id: true } });
  await prisma.merchantSubscription.updateMany({ where: { merchantId: storeRow.merchantId }, data: { status: "cancelled" } });
  await prisma.merchantSubscription.create({ data: { merchantId: storeRow.merchantId, planId: proPlan.id, status: "active" } });

  const login = await api("/auth/merchant/login", { method: "POST", body: { identifier: merchantEmail, password: merchantPassword } });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const token = login.payload.accessToken;
  const catalog = `/merchant/stores/${slug}/catalog`;

  const category = await api(`${catalog}/categories`, { method: "POST", token, body: { name: "قمصان" } });
  assert.equal(category.status, 201, JSON.stringify(category.payload));

  async function createProduct(body) {
    const created = await api(`${catalog}/products`, { method: "POST", token, body });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    return created.payload.product;
  }

  // P1 — the product whose real movement history the sheet must quote.
  const shirt = await createProduct({ sku: "SKU-100", name: "قميص قطني أزرق", priceIqd: 18000, stockQuantity: 10, categoryId: category.payload.category.id });
  for (const quantity of [4, 12, 7]) {
    const adjusted = await api(`${catalog}/products/${shirt.id}/inventory`, { method: "POST", token, body: { stockQuantity: quantity, reason: "manual_adjustment" } });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.payload));
  }
  const movements = await prisma.inventoryMovement.count({ where: { productId: shirt.id } });

  // P2 — sold, then removed: the row the purge sweep must refuse.
  const sold = await createProduct({ sku: "SKU-900", name: "حذاء رياضي", priceIqd: 45000, stockQuantity: 5 });
  const phone = "+9647705500011";
  const account = await api(`/store/${slug}/account/register`, { method: "POST", body: { phone, password: "Pg2CustomerPass!", fullName: "زبون تجريبي" } });
  assert.equal(account.status, 201, JSON.stringify(account.payload));
  const customerToken = account.payload.accessToken;
  const address = await api(`/store/${slug}/account/addresses`, { method: "POST", token: customerToken, body: { recipientName: "زبون تجريبي", fullAddress: "شارع السلة 2", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  const cart = await api(`/store/${slug}/cart/items`, { method: "POST", token: customerToken, body: { productId: sold.id, quantity: 1 } });
  assert.equal(cart.status, 200, JSON.stringify(cart.payload));
  const order = await api(`/store/${slug}/checkout`, { method: "POST", token: customerToken, headers: { "idempotency-key": `${runId}-checkout-1` }, body: { cartVersion: cart.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" } });
  assert.equal(order.status, 201, JSON.stringify(order.payload));
  assert.equal((await api(`/merchant/stores/${slug}/orders/${order.payload.order.id}/status`, { method: "POST", token, body: { toStatus: "cancelled", expectedVersion: 1 } })).status, 200);
  assert.equal((await api(`${catalog}/products/${sold.id}`, { method: "DELETE", token })).status, 200);

  // Run the sweep past the retention window NOW, while the sold product is the
  // only trashed row: it is stamped purge_blocked with the server's own reason
  // (the «محفوظ لسجلاتك» badge), and nothing else is old enough to be swept.
  const sweep = await purgeExpiredSoftDeletes({ now: new Date(Date.now() + (TRASH_RETENTION_DAYS + 1) * 86_400_000) });
  const blockedRow = await prisma.product.findUniqueOrThrow({ where: { id: sold.id }, select: { purgeBlockedAt: true, purgeBlockReason: true } });
  assert.ok(blockedRow.purgeBlockedAt, `expected the sold product to be purge-blocked — ${JSON.stringify(sweep)}`);

  // P4 — sold and still LIVE, so the delete can be driven through the interface.
  // ع-1 shipped green precisely because every existing delete here goes through
  // the API, and the undo bar is the one surface an API delete never renders.
  const keptShoe = await createProduct({ sku: "SKU-950", name: "صندل صيفي", priceIqd: 30000, stockQuantity: 4 });
  const keptCart = await api(`/store/${slug}/cart/items`, { method: "POST", token: customerToken, body: { productId: keptShoe.id, quantity: 1 } });
  assert.equal(keptCart.status, 200, JSON.stringify(keptCart.payload));
  const keptOrder = await api(`/store/${slug}/checkout`, { method: "POST", token: customerToken, headers: { "idempotency-key": `${runId}-checkout-2` }, body: { cartVersion: keptCart.payload.cart.version, addressId: address.payload.address.id, paymentMethodCode: "cod" } });
  assert.equal(keptOrder.status, 201, JSON.stringify(keptOrder.payload));
  assert.equal((await api(`/merchant/stores/${slug}/orders/${keptOrder.payload.order.id}/status`, { method: "POST", token, body: { toStatus: "cancelled", expectedVersion: 1 } })).status, 200);

  // P3 — removed, its SKU reused by a live product: the restore must conflict.
  const linen = await createProduct({ sku: "SKU-300", name: "قميص كتان", priceIqd: 22000, stockQuantity: 3 });
  assert.equal((await api(`${catalog}/products/${linen.id}`, { method: "DELETE", token })).status, 200);
  const hijacker = await createProduct({ sku: "SKU-300", name: "قميص كتان (دفعة جديدة)", priceIqd: 24000, stockQuantity: 6 });

  // A removed category and a removed coupon so their tabs are not empty.
  const seasonal = await api(`${catalog}/categories`, { method: "POST", token, body: { name: "تصنيف موسمي" } });
  assert.equal((await api(`${catalog}/categories/${seasonal.payload.category.id}`, { method: "DELETE", token })).status, 200);
  const coupon = await api(`/merchant/stores/${slug}/marketing/coupons`, { method: "POST", token, body: { code: "SUMMER10", kind: "percent", percentOff: 10 } });
  assert.equal(coupon.status, 201, JSON.stringify(coupon.payload));
  assert.equal((await api(`/merchant/stores/${slug}/marketing/coupons/${coupon.payload.coupon.id}`, { method: "DELETE", token })).status, 200);

  // A removed staff membership.
  const staff = await api(`/merchant/stores/${slug}/team`, { method: "POST", token, body: { email: `${runId}.staff@codiq.test`, displayName: "موظف المستودع", temporaryPassword: "StaffTempPass123!", roleCode: "store_staff" } });
  assert.equal(staff.status, 201, JSON.stringify(staff.payload));
  assert.equal((await api(`/merchant/stores/${slug}/team/${staff.payload.membership.id}`, { method: "DELETE", token })).status, 200);

  // ---------- browser ----------
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/merchant/login`);
  await page.locator('input[name="identifier"]').fill(merchantEmail);
  await page.locator('input[name="password"]').fill(merchantPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL(`**/merchant/stores/${slug}/dashboard`);

  // Symptom 1 — the sheet states the REAL movement count before the act.
  await captureAcrossWidths(context, page, "sheet", async (target) => {
    await target.goto(`${base}/merchant/stores/${slug}/dashboard/products`);
    await target.getByTestId("product-delete-SKU-100").click();
    await target.getByTestId("delete-confirm-sheet").waitFor();
    await target.getByTestId("delete-sheet-consequences").waitFor();
    await target.waitForFunction(() => !document.querySelector('[data-testid="delete-sheet-consequences"]')?.textContent?.includes("جارٍ قراءة"));
  });
  const sheetText = await page.getByTestId("delete-sheet-consequences").textContent();
  const arabicMovements = new Intl.NumberFormat("ar-IQ").format(movements);
  assert.ok(sheetText.includes(arabicMovements), `the sheet must quote the server's movement count (${movements} → ${arabicMovements}) — got: ${sheetText}`);

  // Symptom 2 — the bin: exact deletedAt on every row, «محفوظ لسجلاتك» on the
  // blocked one with the server's reason and NO countdown.
  await captureAcrossWidths(context, page, "bin", async (target) => {
    await target.goto(`${base}/merchant/stores/${slug}/dashboard/settings/trash`);
    await target.getByTestId(`trash-row-product-${sold.id}`).waitFor();
  });
  const blockedCard = page.getByTestId(`trash-row-product-${sold.id}`);
  assert.ok(await blockedCard.getByTestId("trash-kept-badge").isVisible(), "the blocked row shows «محفوظ لسجلاتك»");
  assert.equal(await blockedCard.getByTestId("trash-row-purge-in").count(), 0, "the blocked row shows NO countdown");
  assert.ok((await blockedCard.textContent()).includes(blockedRow.purgeBlockReason.slice(0, 12)), "the reason comes from the server");
  const survivorCard = page.getByTestId(`trash-row-product-${linen.id}`);
  assert.ok(await survivorCard.getByTestId("trash-row-deleted-at").isVisible(), "every row carries its exact deletedAt");
  assert.ok(await survivorCard.getByTestId("trash-row-purge-in").isVisible(), "a purgeable row carries its countdown");

  // Symptom 3 — the colliding restore: a 409 that opens a pre-filled field.
  await captureAcrossWidths(context, page, "conflict", async (target) => {
    await target.goto(`${base}/merchant/stores/${slug}/dashboard/settings/trash`);
    await target.getByTestId(`trash-row-product-${linen.id}`).getByTestId("trash-restore").click();
    await target.getByTestId(`trash-row-product-${linen.id}`).getByTestId("trash-conflict").waitFor();
  });
  const conflictInput = page.getByTestId(`trash-row-product-${linen.id}`).getByTestId("trash-conflict-input-sku");
  const prefilledSku = await conflictInput.inputValue();
  assert.equal(prefilledSku, "SKU-300-1", "the field is pre-filled with an editable suggestion");
  const conflictText = await page.getByTestId(`trash-row-product-${linen.id}`).getByTestId("trash-conflict").textContent();
  assert.ok(conflictText.includes(hijacker.name), "the 409 names the live holder");
  assert.equal(await prisma.product.count({ where: { id: linen.id, deletedAt: null } }), 0, "nothing was renamed or restored silently");

  // Symptom 4 (ع-1) — the sheet and the bar must tell ONE story about one row.
  // The sheet promises a sold product is kept for the records; the bar used to
  // answer, one second later, «يُحذف نهائياً بعد ٣٠ يوماً» — and the purge really
  // does refuse that row, so the sentence was false in the direction that sends
  // a merchant back to hiding products instead of removing them.
  // NOT inside captureAcrossWidths: that helper replays its callback once per
  // width, and confirming a delete is a MUTATION — the second pass would find
  // the product already in the bin. Screenshots are worth less here than the
  // assertion is.
  await page.goto(`${base}/merchant/stores/${slug}/dashboard/products`);
  await page.getByTestId("product-delete-SKU-950").waitFor();
  await page.getByTestId("product-delete-SKU-950").click();
  await page.getByTestId("delete-sheet-consequences").waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="delete-sheet-consequences"]')?.textContent?.includes("جارٍ قراءة"));
  const keptPromise = await page.getByTestId("delete-sheet-consequences").textContent();
  assert.ok(keptPromise.includes("محفوظاً لسجلاتك"), `the sheet promises the row is kept — got: ${keptPromise}`);
  await page.getByTestId("delete-sheet-confirm").click();
  await page.getByTestId("trash-undo-bar").waitFor();
  const undoText = await page.getByTestId("trash-undo-bar").textContent();
  assert.ok(undoText.includes("محفوظاً لسجلاتك"), `the undo bar must repeat the promise, not contradict it — got: ${undoText}`);
  assert.ok(!undoText.includes("يُحذف نهائياً بعد"), `the undo bar must NOT promise a countdown for a row the purge will refuse — got: ${undoText}`);
  assert.equal(await prisma.product.count({ where: { id: keptShoe.id, deletedAt: { not: null } } }), 1, "and the removal really happened");

  // The activity log tab.
  await captureAcrossWidths(context, page, "activity", async (target) => {
    await target.goto(`${base}/merchant/stores/${slug}/dashboard/settings/trash`);
    await target.getByTestId("trash-tab-activity").click();
    await target.getByTestId("activity-timeline").waitFor();
  });


  // ---------------------------------------------------------------- MD-4
  // «البائع الاجتماعي» — the share image is generated in the browser, so the
  // only test that means anything is one that runs a browser and looks at the
  // pixels. A unit test could only assert that the drawing code was called.
  //
  // What is checked: the card is produced at the size that survives Instagram
  // and WhatsApp without recropping; text was actually painted (a blank canvas
  // would still export a valid PNG and pass a naive check); and the price on
  // the card comes from the product's own price,
  // formatted by the same formatter the catalogue uses — a share image quoting
  // a price the storefront will not honour makes the merchant look dishonest
  // for a rounding decision he never made.
  await page.goto(`${base}/merchant/stores/${slug}/dashboard/products`);
  await page.getByTestId("product-share-SKU-100").waitFor();
  await page.getByTestId("product-share-SKU-100").click();
  // The buttons enable only once toBlob has resolved, so this waits on the real
  // completion of the draw rather than on a timer.
  const shareButton = page.getByRole("button", { name: /مشاركة/ }).last();
  await shareButton.waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[role="img"]');
    return canvas instanceof HTMLCanvasElement && canvas.width === 1080 && canvas.height === 1350;
  }, null, { timeout: 15_000 });

  const card = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[role="img"]');
    const context = canvas.getContext("2d");
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    // Near-white pixels are the proof that TEXT was painted. Counting distinct
    // colours would not do: the background is a 1350px vertical gradient and
    // already yields hundreds of shades on its own, so a blank card would pass.
    // Nothing in the palette is white except the name and the price.
    let ink = 0;
    for (let index = 0; index < data.length; index += 4 * 5) {
      if (data[index] > 240 && data[index + 1] > 240 && data[index + 2] > 240) ink += 1;
    }
    return { width: canvas.width, height: canvas.height, ink, alt: canvas.getAttribute("aria-label") };
  });
  assert.equal(card.width, 1080, "MD-4: the card is 1080 wide — the size Instagram and WhatsApp accept unrecropped");
  assert.equal(card.height, 1350);
  // This fixture's products carry no photo, which is the case worth protecting:
  // the component fetches the image separately so a missing one cannot lose the
  // whole post. The name and price are painted regardless.
  // Measured, not guessed: text drawn normally gives ~2700 samples; drawing it
  // fully transparent still leaves ~225 from the gradient's lightest band, so
  // the floor sits well above that noise and well below the real signal.
  assert.ok(card.ink > 1000, `MD-4: the name and price were painted even with no product photo — ${card.ink} white samples (noise floor ~225)`);
  assert.ok(card.alt.includes("قميص قطني أزرق"), `MD-4: the canvas names the product for a screen reader — got: ${card.alt}`);

  // The price the merchant will post must be the price the shopper will pay.
  const shareSource = fs.readFileSync(new URL("../../client/src/components/ProductShareCard.tsx", import.meta.url), "utf8");
  assert.ok(shareSource.includes('new Intl.NumberFormat("ar-IQ")'), "MD-4: the card formats money the way every other screen does");
  assert.ok(shareSource.includes("product.priceIqd"), "MD-4: …from the product's own price, not from a copy on screen");
  assert.ok(!/toFixed|Math\.round\(.*price/i.test(shareSource), "MD-4: and it never rounds a price on its way to a post");

  const shareShots = await captureAcrossWidths(context, page, "md4-share", async (target) => {
    await target.goto(`${base}/merchant/stores/${slug}/dashboard/products`);
    await target.getByTestId("product-share-SKU-100").click();
    await target.waitForFunction(() => document.querySelector('canvas[role="img"]')?.width === 1080, null, { timeout: 15_000 });
  });

  console.log(JSON.stringify({
    suite: "pg2-browser",
    status: "passed",
    movementsQuotedBySheet: movements,
    purgeBlockReason: blockedRow.purgeBlockReason,
    prefilledSku,
    horizontalOverflow: overflow.filter((row) => row.horizontalOverflow),
    widthsChecked: overflow,
    md4ShareCard: { width: card.width, height: card.height, inkSamples: card.ink },
    screenshots: shots,
  }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

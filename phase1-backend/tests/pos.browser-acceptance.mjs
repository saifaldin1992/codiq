/**
 * codiq الكاشير (ق-132 / ق-135) browser acceptance — the till driven in real
 * Chromium, end to end and against the DATABASE after every screen:
 *
 *   pair a device in the settings panel (the deviceShort badge is the receipt
 *   code) → open the till, scan box focused → ring up two variants — the
 *   barcode path (SKU + Enter) and the grid path — bump a quantity → F2, take
 *   cash, the change is arithmetic on screen → the done card names the order
 *   POS-<short>-… and the ledger stays SILENT (ق-135) → «بيعة جديدة» resets →
 *   an oversell is ACCEPTED, clamped at zero, and lands in the shortfall queue
 *   → the merchant reviews it and the row drains without being deleted
 *   → ق-144: with 522 products in the store, the merchant catalog AND the till
 *     both find a product that exists only PAST their old browser windows.
 *
 * Screen 10 lives here rather than in a suite of its own because it needs one
 * expensive fixture — a store bigger than both windows (the catalog's
 * `?limit=100` and the till's 5×100 snapshot loader) — and a merchant who is
 * already logged in with a paired till. Building that twice would double the
 * slowest part of the browser job to prove one claim on two screens.
 *
 * The integration suite (pos.integration.mjs) already pins the server's
 * claims; this suite pins that the SCREENS a cashier and a merchant actually
 * touch drive those same claims — what the browser showed is what Postgres
 * holds. Harness mirrors phase16.browser-acceptance.mjs: built server from
 * dist, TRUNCATE fixture reset, screenshots into the artifacts dir.
 */
import assert from "node:assert/strict";
import { ownProvisionedPassword } from "./helpers/own-provisioned-password.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `pos-ui-${Date.now().toString(36)}`;
const port = 3232;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "pos-browser-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "pos-browser-seed-secret-not-for-production", CODIQ_NOTIFICATIONS_WORKER: "off" },
  stdio: "ignore",
});

const artifactsDir = process.env.CODIQ_TEST_ARTIFACTS_DIR ?? "/home/ubuntu/webdev-static-assets";
fs.mkdirSync(artifactsDir, { recursive: true });
const executablePath = process.env.CODIQ_CHROMIUM_PATH ?? (process.platform === "linux" ? "/usr/bin/chromium" : undefined);

async function waitFor(url) {
  // CI machines are slow: 150 × 200ms = a 30s budget for the built server.
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

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Expected authenticated response to set a session cookie.");
  return setCookie.split(";", 1)[0];
}

// ---------------------------------------------------------------- tripwire
// Any console error on the page fails the run: a till that logs errors while
// "working" is one network blip away from not working. phase16 filters no
// benign messages, so this list starts EMPTY — add a RegExp here only for a
// message proven harmless, with a comment saying why.
const BENIGN_CONSOLE = [];
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

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  // phase16's reset plus the POS tables and the ledger — `plans` stays seeded.
  await prisma.$executeRawUnsafe("TRUNCATE TABLE pos_ticket_shortfalls, pos_tickets, pos_devices, ledger_entries, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE");

  // ------------------------------------------------------------- fixtures
  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const ownerPassword = "PosOwnerPass123!";
  let merchantPassword = "PosMerchantPass123!";

  const ownerRegister = await json("/api/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك قبول الكاشير" }) });
  assert.equal(ownerRegister.response.status, 201, JSON.stringify(ownerRegister.body));
  const ownerLogin = await json("/api/auth/platform/login", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword }) });
  const ownerCookie = sessionCookie(ownerLogin.response);
  const provisioned = await json("/api/platform/merchants/manual", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100396011", email: merchantEmail, temporaryPassword: merchantPassword, businessName: "تاجر الكاشير", firstStoreName: "متجر الكاشير" }) });
  assert.equal(provisioned.response.status, 201, JSON.stringify(provisioned.body));
  const store = provisioned.body.store;
  // ق-218/ق-226: a hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens (the gate itself is proven in `phase6:test`
  // and through the UI in `phase6:browser`).
  merchantPassword = await ownProvisionedPassword(base, merchantEmail, merchantPassword);

  // One product, TWO variants, the pos.integration.mjs shapes exactly: the
  // products AFTER INSERT trigger mints the default variant inheriting the
  // product's sku/price 1:1; the second variant is created explicitly.
  const product = await prisma.product.create({ data: { storeId: store.id, sku: "POS-SHIRT", name: "قميص المحل", priceIqd: 10000, isActive: true } });
  const defaultVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: defaultVariant.id }, data: { stockQuantity: 10, lowStockThreshold: 2 } });
  const bigVariant = await prisma.productVariant.create({ data: { storeId: store.id, productId: product.id, sku: "POS-SHIRT-L", name: "كبير", priceIqd: 15000, stockQuantity: 2, isDefault: false, position: 1 } });

  // ------------------------------------------------------- merchant login
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  armTripwire(page, "merchant");

  await page.goto(`${base}/merchant/login`);
  await page.locator('input[name="identifier"]').fill(merchantEmail);
  await page.locator('input[name="password"]').fill(merchantPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL(`**/merchant/stores/${store.slug}/dashboard`);

  // ------------------------------------- 2: pair a device THROUGH THE UI
  await page.goto(`${base}/merchant/stores/${store.slug}/dashboard/settings/pos`);
  await page.getByTestId("pos-device-label").fill("كاشير ١");
  await page.getByTestId("pos-pair-submit").click();
  await page.getByTestId("pos-paired-notice").waitFor();
  const shortBadge = (await page.getByTestId("pos-paired-notice").locator('span[dir="ltr"]').innerText()).trim();
  assert.match(shortBadge, /^[A-HJ-NP-Z2-9]{4}$/, "the paired notice shows the 4-char receipt code, no lookalike characters");
  await page.getByTestId(`pos-device-${shortBadge}`).waitFor();
  const device = await prisma.posDevice.findFirstOrThrow({ where: { storeId: store.id } });
  assert.equal(device.deviceShort, shortBadge, "the badge on screen IS the code the server minted");
  await page.screenshot({ path: `${artifactsDir}/pos-till-devices.png`, fullPage: true });
  assertConsoleClean("after pairing");

  // ------------------------------ 3: the till — one device auto-selected
  await page.goto(`${base}/merchant/stores/${store.slug}/till`);
  // The grid renders only once a device is selected AND the catalog loaded —
  // this one wait proves both, and the chooser must NOT appear for one device.
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  assert.equal(await page.getByTestId(`till-device-${device.id}`).count(), 0, "a single device is auto-selected — no chooser dialog");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "till-scan");
  await page.screenshot({ path: `${artifactsDir}/pos-till-empty.png`, fullPage: true });

  // ------------------------------------------- 4: scanner + grid + stepper
  // The barcode-scanner path: the scanner TYPES the SKU and presses Enter.
  await page.getByTestId("till-scan").pressSequentially("POS-SHIRT");
  await page.keyboard.press("Enter");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  // The grid path: the «كبير» variant button on the multi-variant card.
  await page.getByTestId(`till-add-${bigVariant.id}`).click();
  await page.getByTestId(`till-line-inc-${bigVariant.id}`).waitFor();
  assert.equal(await page.locator("aside li").count(), 2, "two variants, two cart lines");
  // Bump the first line to 3 with the + stepper.
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).click();
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).click();
  // The qty readout is the span between the − and + steppers, in ar-IQ digits.
  await page.waitForFunction(({ testId, digits }) => {
    const inc = document.querySelector(`[data-testid="${testId}"]`);
    const ascii = (inc?.previousElementSibling?.textContent ?? "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
    return ascii === digits;
  }, { testId: `till-line-inc-${defaultVariant.id}`, digits: "3" });
  // The cart footer total: 3×10,000 + 1×15,000 = 45,000 — read off the screen.
  await page.waitForFunction(() => {
    const spans = Array.from(document.querySelectorAll("aside span"));
    const label = spans.find((el) => el.textContent === "الإجمالي");
    const ascii = (label?.nextElementSibling?.textContent ?? "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
    return ascii === "45000";
  });
  await page.screenshot({ path: `${artifactsDir}/pos-till-cart.png`, fullPage: true });

  // ------------------------------------------------- 5: F2 → cash → change
  await page.keyboard.press("F2");
  await page.getByTestId("till-received").waitFor();
  await page.getByTestId("till-received").fill("100000");
  // Change = 100,000 − 45,000 = 55,000, in the tabular value span next to
  // «الباقي للزبون» — asserted digit-for-digit after normalising ar-IQ digits.
  await page.waitForFunction(({ label, digits }) => {
    const dialog = document.querySelector('[aria-label="تحصيل المبلغ"]');
    if (!dialog) return false;
    const spans = Array.from(dialog.querySelectorAll("span"));
    const labelEl = spans.find((el) => el.textContent === label);
    const value = labelEl?.nextElementSibling;
    if (!value || !value.classList.contains("tabular-nums")) return false;
    const ascii = (value.textContent ?? "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
    return ascii === digits;
  }, { label: "الباقي للزبون", digits: "55000" });
  await page.screenshot({ path: `${artifactsDir}/pos-till-payment.png`, fullPage: true });

  const saleResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/merchant/stores/${store.slug}/pos/tickets`) && response.request().method() === "POST");
  await page.getByTestId("till-confirm").click();
  const saleResponse = await saleResponsePromise;
  assert.equal(saleResponse.status(), 201, "a fresh ticket answers 201");
  const saleBody = await saleResponse.json();
  assert.equal(saleBody.replayed, false);
  assert.equal((saleBody.shortfalls ?? []).length, 0, "a within-stock sale reports no shortfall");

  // ------------------------------------- 6: done card, then Postgres agrees
  await page.getByTestId("till-order-number").waitFor();
  const orderNumber = (await page.getByTestId("till-order-number").innerText()).trim();
  assert.ok(orderNumber.startsWith("POS-"), `the receipt number is a POS number: ${orderNumber}`);
  assert.ok(orderNumber.startsWith(`POS-${device.deviceShort}-`), `ق-132: the receipt names WHICH till sold it: ${orderNumber}`);
  assert.equal(await page.getByTestId("till-shortfalls").count(), 0, "a clean sale shows no shortfall strip");
  await page.screenshot({ path: `${artifactsDir}/pos-till-done.png`, fullPage: true });

  const saleOrder = await prisma.storeOrder.findFirstOrThrow({ where: { storeId: store.id, source: "pos" } });
  assert.equal(saleOrder.orderNumber, orderNumber, "the number on the screen IS the order in the book");
  assert.equal(saleOrder.status, "completed", "ق-132: born completed — the customer left with the goods");
  assert.equal(saleOrder.paymentStatus, "paid");
  assert.equal(saleOrder.paymentMethodCode, "cash");
  assert.equal(saleOrder.totalIqd, 45000);
  assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: defaultVariant.id }, select: { stockQuantity: true } })).stockQuantity, 7, "10 − 3 sold");
  assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: bigVariant.id }, select: { stockQuantity: true } })).stockQuantity, 1, "2 − 1 sold");
  assert.equal(await prisma.ledgerEntry.count({ where: { storeId: store.id } }), 0, "ق-135: NO ledger entry — the platform never touched this cash");
  assertConsoleClean("after the first sale");

  // ------------------------------------------------- 7: «بيعة جديدة» resets
  await page.getByTestId("till-new-sale").click();
  await page.getByTestId("till-order-number").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "till-scan");

  // --------------------------- 8: oversell — accepted, clamped, recorded
  // «كبير» has 1 left; the till sells 5. The unit already left the shelf and
  // the cash is in the drawer — refusing at the till is the one thing this
  // screen must never do. The server clamps to 0 and writes the gap of 4.
  await page.getByTestId(`till-add-${bigVariant.id}`).click();
  await page.getByTestId(`till-line-inc-${bigVariant.id}`).waitFor();
  for (let bump = 0; bump < 4; bump += 1) await page.getByTestId(`till-line-inc-${bigVariant.id}`).click();
  await page.keyboard.press("F2");
  await page.getByTestId("till-received").waitFor();
  await page.getByTestId("till-quick-exact").click();
  const oversellResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/merchant/stores/${store.slug}/pos/tickets`) && response.request().method() === "POST");
  await page.getByTestId("till-confirm").click();
  const oversellResponse = await oversellResponsePromise;
  assert.equal(oversellResponse.status(), 201, "the oversell is ACCEPTED — the sale happened");
  const oversellBody = await oversellResponse.json();
  assert.equal(oversellBody.shortfalls.length, 1);
  assert.equal(oversellBody.shortfalls[0].shortfallQty, 4, "sold 5, had 1 — the gap is 4");

  await page.getByTestId("till-shortfalls").waitFor();
  assert.ok((await page.getByTestId("till-shortfalls").innerText()).includes("بيع فوق المخزون"), "the amber strip tells the cashier what happened");
  await page.screenshot({ path: `${artifactsDir}/pos-till-shortfall-done.png`, fullPage: true });

  assert.equal(await prisma.posTicketShortfall.count({ where: { storeId: store.id } }), 1, "one gap, one row");
  const shortfall = await prisma.posTicketShortfall.findFirstOrThrow({ where: { storeId: store.id } });
  assert.equal(shortfall.variantId, bigVariant.id);
  assert.equal(shortfall.soldQty, 5);
  assert.equal(shortfall.availableQty, 1);
  assert.equal(shortfall.shortfallQty, 4);
  assert.equal(shortfall.reviewedAt, null, "fresh gaps sit in the open queue");
  assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: bigVariant.id }, select: { stockQuantity: true } })).stockQuantity, 0, "clamped at zero, never negative");

  // ------------------------------- 9: the merchant reviews the shortfall
  await page.goto(`${base}/merchant/stores/${store.slug}/dashboard/settings/pos`);
  await page.getByTestId(`pos-shortfall-review-${shortfall.id}`).waitFor();
  const reviewResponsePromise = page.waitForResponse((response) => response.url().includes(`/pos/shortfalls/${shortfall.id}/review`) && response.request().method() === "POST");
  await page.getByTestId(`pos-shortfall-review-${shortfall.id}`).click();
  assert.equal((await reviewResponsePromise).status(), 204);
  await page.getByTestId("pos-shortfalls-empty").waitFor();
  const reviewed = await prisma.posTicketShortfall.findUniqueOrThrow({ where: { id: shortfall.id } });
  assert.ok(reviewed.reviewedAt instanceof Date, "reviewedAt is set — the queue drained, the fact remains");
  await page.screenshot({ path: `${artifactsDir}/pos-till-reviewed.png`, fullPage: true });

  // ---------- 10 (ق-144): the search sees the STORE, not the loaded page ----------
  // THE assertion this whole change exists for. Both screens used to filter an
  // array the browser happened to be holding — the catalog its first 100 rows,
  // the till its 500-row offline snapshot — so a merchant with a real catalog
  // was told «no results» for a product that was sitting right there in
  // Postgres. The fixture is therefore deliberately bigger than BOTH windows,
  // and the needle matches exactly one product, which lives outside both.
  //
  // The needle «ازار» is written with a bare alef and the product with a
  // hamza-under alef «إزار»: finding it proves the server's normalizer is on
  // the wire, not merely that some request was sent.
  const searchTarget = await prisma.product.create({ data: { storeId: store.id, sku: "POS-IZAR", name: "إزار قطني للبيت", priceIqd: 7000, isActive: true, createdAt: new Date("2020-01-01T00:00:00.000Z") } });
  const searchVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: searchTarget.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: searchVariant.id }, data: { stockQuantity: 6 } });
  // 520 fillers, every one NEWER than the target, so a createdAt-DESC list puts
  // the target past position 500. `createdAt` is explicit rather than left to
  // `now()`: rows written in the same millisecond would order by id and the
  // premise below would hold only by luck. None of them can match — «صنف»
  // shares no trigram with «ازار».
  await prisma.product.createMany({
    data: Array.from({ length: 520 }, (_, index) => ({
      storeId: store.id,
      sku: `POS-BULK-${String(index).padStart(4, "0")}`,
      name: `صنف تعبئة رقم ${index}`,
      priceIqd: 1000 + index,
      isActive: true,
      createdAt: new Date(Date.UTC(2021, 0, 1) + index * 1000),
    })),
  });

  // THE PREMISE, asserted rather than assumed: if the target ever drifts inside
  // either window this screen silently stops testing anything.
  const orderedIds = await prisma.product.findMany({ where: { storeId: store.id, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
  const targetPosition = orderedIds.findIndex((row) => row.id === searchTarget.id) + 1;
  assert.ok(targetPosition > 500, `the needle's product must sit past BOTH browser windows (catalog 100, till 5×100) — it is at position ${targetPosition} of ${orderedIds.length}`);

  // ---- 10a: the merchant catalog ----
  await page.goto(`${base}/merchant/stores/${store.slug}/dashboard/products`);
  await page.getByTestId("product-list-filter").waitFor();
  await page.getByTestId(`product-share-POS-BULK-0519`).waitFor();
  assert.equal(await page.getByTestId(`product-share-${searchTarget.sku}`).count(), 0,
    "page 1 must NOT contain the needle's product — this is the exact state in which the old browser filter answered «لا يطابق أي منتج هذه التصفية»");

  const catalogSearchPromise = page.waitForResponse((response) =>
    response.url().includes(`/api/merchant/stores/${store.slug}/catalog/products?`)
    && response.url().includes("q=")
    && response.request().method() === "GET");
  await page.getByTestId("product-list-filter").fill("ازار");
  const catalogSearch = await catalogSearchPromise;
  assert.equal(catalogSearch.status(), 200, "the catalog asks the SERVER for `q`");
  // The one assertion the change stands on.
  await page.getByTestId(`product-share-${searchTarget.sku}`).waitFor();
  const catalogBody = await catalogSearch.json();
  assert.equal(catalogBody.products.length, 1, `«ازار» matches exactly one product of ${orderedIds.length}: ${JSON.stringify(catalogBody.products.map((p) => p.sku))}`);
  assert.equal(catalogBody.products[0].sku, searchTarget.sku, "and it is the one past the first page");
  await page.screenshot({ path: `${artifactsDir}/pos-catalog-search-beyond-page-one.png`, fullPage: true });

  // The 2-character floor, in the palette's words — and NO request below it.
  await page.getByTestId("product-list-filter").fill("ا");
  await page.getByTestId("product-search-min-length").waitFor();
  assert.equal((await page.getByTestId("product-search-min-length").innerText()).trim(), "أدخل حرفين على الأقل للبحث.",
    "one message for every search box in the dashboard (owner decision 6)");

  // ---- 10b: the till ----
  await page.goto(`${base}/merchant/stores/${store.slug}/till`);
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  assert.equal(await page.getByTestId(`till-add-${searchVariant.id}`).count(), 0,
    "the till's 5×100 snapshot does not hold the needle's product — the state in which the old in-memory filter said «لا نتائج»");

  const posSearchPromise = page.waitForResponse((response) =>
    response.url().includes(`/api/merchant/stores/${store.slug}/pos/products?`)
    && response.request().method() === "GET");
  await page.getByTestId("till-scan").fill("ازار");
  assert.equal((await posSearchPromise).status(), 200, "the till asks the server while it can reach it");
  await page.getByTestId(`till-add-${searchVariant.id}`).waitFor();
  assert.equal(await page.getByTestId("till-grid").getAttribute("data-search-source"), "server",
    "the grid on screen IS the server's answer, not a re-filter of the snapshot");
  // And it SELLS: a row found only by the server rings up like any other.
  await page.getByTestId(`till-add-${searchVariant.id}`).click();
  await page.getByTestId(`till-line-inc-${searchVariant.id}`).waitFor();
  await page.screenshot({ path: `${artifactsDir}/pos-till-search-beyond-snapshot.png`, fullPage: true });
  await page.getByTestId("till-clear-cart").click();

  // The same floor on the till, and no 400 in the console for a lone letter.
  await page.getByTestId("till-scan").fill("ا");
  await page.getByTestId("till-search-min-length").waitFor();
  assert.equal((await page.getByTestId("till-search-min-length").innerText()).trim(), "أدخل حرفين على الأقل للبحث.");
  await page.getByTestId("till-scan").fill("");

  assertConsoleClean("end of run");

  console.log(JSON.stringify({
    suite: "pos.browser-acceptance",
    flow: {
      pairedShort: device.deviceShort,
      scanBoxFocused: true,
      sale: { orderNumber, totalIqd: 45000, changeShown: 55000, stockAfter: [7, 1], ledgerEntries: 0 },
      oversell: { accepted: 201, shortfallQty: 4, stockClampedTo: 0 },
      shortfallReviewed: true,
      search: { storeProducts: orderedIds.length, targetPosition, needle: "ازار", foundOn: ["merchant catalog", "till"], tillGridSource: "server" },
      consoleErrors: 0,
    },
    screenshots: [
      `${artifactsDir}/pos-till-devices.png`,
      `${artifactsDir}/pos-till-empty.png`,
      `${artifactsDir}/pos-till-cart.png`,
      `${artifactsDir}/pos-till-payment.png`,
      `${artifactsDir}/pos-till-done.png`,
      `${artifactsDir}/pos-till-shortfall-done.png`,
      `${artifactsDir}/pos-till-reviewed.png`,
      `${artifactsDir}/pos-catalog-search-beyond-page-one.png`,
      `${artifactsDir}/pos-till-search-beyond-snapshot.png`,
    ],
  }, null, 2));
  await context.close();
} catch (error) {
  // Before tearing the browser down, capture where every page was and what it
  // showed — a CI failure with no picture is a guessing game (phase20b idiom).
  console.error("--- pos browser acceptance failure context ---");
  if (consoleErrors.length) console.error(`console errors so far:\n${consoleErrors.join("\n")}`);
  for (const [contextIndex, openContext] of browser.contexts().entries()) {
    for (const [pageIndex, openPage] of openContext.pages().entries()) {
      const tag = `ctx${contextIndex}-page${pageIndex}`;
      try {
        console.error(`${tag} url: ${openPage.url()}`);
        await openPage.screenshot({ path: `${artifactsDir}/pos-FAILURE-${tag}.png`, fullPage: true });
      } catch (dumpError) {
        console.error(`${tag} could not be captured: ${dumpError.message}`);
      }
    }
  }
  console.error(`--- screenshots in ${artifactsDir} ---`);
  throw error;
} finally {
  await browser.close();
  web.kill("SIGTERM");
  await prisma.$disconnect();
}

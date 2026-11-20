/**
 * codiq الكاشير دون اتصال (ق-142) browser acceptance — the offline envelope
 * driven in real Chromium against the DATABASE, through BOTH honest outage
 * modes:
 *
 *   Playwright's context.setOffline() for the navigator-events path, and
 *   KILLING THE SPAWNED SERVER for the power-cut path — connection-refused
 *   with navigator.onLine still true, which is what an Iraqi till actually
 *   sees, and the only mode that exercises service-worker boot for real
 *   (setOffline does not reliably block SW-initiated fetches in Chromium).
 *
 * The seven screens, in dependency order (revocation is LAST — it is
 * permanent):
 *   1  baseline online sale with the SW registered and CONTROLLING — console
 *      clean proves the offline machinery logs nothing while idle
 *   2  two sales rung with the network cut → pending cards, amber pill,
 *      queue counters — zero new orders in Postgres — then reconnect →
 *      auto-flush in RING ORDER, sold_at = ring-up time (earlier than sync)
 *   3  power cut: server killed → sale queued → page.reload() BOOTS from the
 *      SW cache (shell + chunks + IDB catalog + cached device) → server
 *      respawns on the same port → the backoff timer drains the queue with
 *      no 'online' event ever firing
 *   4  dead-letter: a sale of a variant that got trashed mid-outage lands
 *      فشلت WITH the restore hint while the flush CONTINUES past it; restore
 *      from trash + «إعادة المحاولة» → confirmed
 *   5  session expiry mid-queue → the queue PAUSES behind the re-login
 *      banner (never discards); logging back in drains it
 *   6  scope hygiene: with the SW registered origin-wide, «/» and the
 *      dashboard load untouched
 *   7  device revoked mid-queue → flush HALTS at the fresh 403, the revoked
 *      screen names the retained count, the record survives reload — and a
 *      PREVIOUSLY committed ticket still replays 200 from the revoked device
 *
 * Harness mirrors pos.browser-acceptance.mjs: built server from dist,
 * TRUNCATE fixture reset, screenshots into the artifacts dir.
 */
import assert from "node:assert/strict";
import { ownProvisionedPassword } from "./helpers/own-provisioned-password.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

const runId = `pos-off-${Date.now().toString(36)}`;
const port = 3233;
const base = `http://127.0.0.1:${port}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
process.env.SESSION_JWT_SECRET = "pos-offline-seed-secret-not-for-production";

const { prisma } = await import("../src/db/prisma.ts");

// The server is a FUNCTION here, not a constant: screen 3 kills it and brings
// it back on the same port — that respawn IS the test.
function startServer() {
  return spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: dbUrl, SESSION_JWT_SECRET: "pos-offline-seed-secret-not-for-production", CODIQ_NOTIFICATIONS_WORKER: "off" },
    stdio: "ignore",
  });
}
let web = startServer();

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { response, body: await response.json().catch(() => null) };
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Expected authenticated response to set a session cookie.");
  return setCookie.split(";", 1)[0];
}

const asciiDigits = (text) => (text ?? "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[^0-9]/g, "");

// ---------------------------------------------------------------- tripwire
// The list is NOT empty here, deliberately and narrowly: this suite's whole
// subject is deliberate outages, and Chromium logs each refused/failed
// request as a console error before the page's own handler ever sees it.
// Three patterns, each provably the suite's own doing:
//   - connection refused / offline: screens 2-5 and 7 cut the network or
//     kill the server on purpose;
//   - 4xx resource lines: the flush INTENTIONALLY receives 401 (expired
//     session, screen 5), 403 (revoked device, screen 7) and 422 (trashed
//     variant, screen 4) — the classification of exactly these statuses is
//     what's under test.
// Anything else — a 500, a pageerror, a React warning — still fails the run.
const BENIGN_CONSOLE = [
  /net::ERR_(CONNECTION_REFUSED|INTERNET_DISCONNECTED|FAILED|NETWORK_CHANGED|CONNECTION_RESET)/,
  /Failed to load resource: the server responded with a status of (401|403|422)/,
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

// ------------------------------------------------- shared till gestures
async function ringLine(page, sku) {
  await page.getByTestId("till-scan").pressSequentially(sku);
  await page.keyboard.press("Enter");
}
async function payAndConfirm(page, receivedIqd) {
  await page.keyboard.press("F2");
  await page.getByTestId("till-received").waitFor();
  await page.getByTestId("till-received").fill(String(receivedIqd));
  // «تم — سجّل البيعة» is gated on `received >= total`, and this gesture used to
  // click it having settled NEITHER side. `fill` guarantees the box's DOM value,
  // never the React state behind it: while the till still pulled focus back to
  // the scan box a frame after a scan (ق-142), a confirm opened inside that
  // frame had its digits delivered to the catalog filter instead — the panel
  // charged its total against a received of zero, and the button stayed
  // disabled for the full thirty seconds naming neither number.
  //
  // The change line is `received − total`, so it can only read «الباقي للزبون»
  // and ZERO when BOTH are true: the amount reached the panel, and the cart is
  // the cart this suite rang (every payment here is the exact total). That is
  // the real precondition for the click, and it is what pos.browser-acceptance
  // already waits for before its own confirm.
  await page.waitForFunction(({ label, digits }) => {
    const dialog = document.querySelector('[aria-label="تحصيل المبلغ"]');
    if (!dialog) return false;
    const spans = Array.from(dialog.querySelectorAll("span"));
    const labelEl = spans.find((el) => el.textContent === label);
    const value = labelEl?.nextElementSibling;
    if (!value || !value.classList.contains("tabular-nums")) return false;
    const ascii = (value.textContent ?? "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
    return ascii === digits;
  }, { label: "الباقي للزبون", digits: "0" });
  await page.getByTestId("till-confirm").click();
}
async function newSale(page) {
  await page.getByRole("button", { name: "بيعة جديدة" }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "till-scan");
}
async function waitCounters(page, { confirmed, pending, failed }) {
  await page.waitForFunction(({ confirmed, pending, failed }) => {
    const el = document.querySelector('[data-testid="till-queue-counters"]');
    if (!el) return false;
    const ascii = (el.textContent ?? "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
    const nums = ascii.match(/\d+/g) ?? [];
    if (confirmed !== undefined && nums[0] !== String(confirmed)) return false;
    if (pending !== undefined && nums[1] !== String(pending)) return false;
    if (failed !== undefined && nums[2] !== String(failed)) return false;
    return true;
  }, { confirmed, pending, failed }, { timeout: 90000 });
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  await waitFor(`${base}/api/health`);
  await prisma.$executeRawUnsafe("TRUNCATE TABLE pos_ticket_shortfalls, pos_tickets, pos_devices, ledger_entries, notification_outbox, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners, storefront_rate_limits CASCADE");

  // ------------------------------------------------------------- fixtures
  const ownerEmail = `${runId}.owner@codiq.test`;
  const merchantEmail = `${runId}.merchant@codiq.test`;
  const ownerPassword = "PosOffOwnerPass123!";
  let merchantPassword = "PosOffMerchantPass123!";

  const ownerRegister = await json("/api/auth/platform/register", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword, displayName: "مالك قبول الأوفلاين" }) });
  assert.equal(ownerRegister.response.status, 201, JSON.stringify(ownerRegister.body));
  const ownerLogin = await json("/api/auth/platform/login", { method: "POST", body: JSON.stringify({ email: ownerEmail, password: ownerPassword }) });
  const ownerCookie = sessionCookie(ownerLogin.response);
  const provisioned = await json("/api/platform/merchants/manual", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ ownerName: "صاحب المتجر", phone: "+9647100396012", email: merchantEmail, temporaryPassword: merchantPassword, businessName: "تاجر الأوفلاين", firstStoreName: "متجر الأوفلاين" }) });
  assert.equal(provisioned.response.status, 201, JSON.stringify(provisioned.body));
  const store = provisioned.body.store;
  // ق-218/ق-226: a hand-provisioned merchant replaces the provisioner's password
  // before any merchant surface opens (the gate itself is proven in `phase6:test`
  // and through the UI in `phase6:browser`).
  merchantPassword = await ownProvisionedPassword(base, merchantEmail, merchantPassword);

  const product = await prisma.product.create({ data: { storeId: store.id, sku: "OFF-SHIRT", name: "قميص الأوفلاين", priceIqd: 10000, isActive: true } });
  const defaultVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: defaultVariant.id }, data: { stockQuantity: 10, lowStockThreshold: 2 } });
  // Screen 4 poisons a ticket by TRASHING THIS WHOLE PRODUCT: a lone variant
  // is never a trash entity (PG-2 §6.3 — deleteVariant is a guarded HARD
  // delete), so the restorable outage the blueprint describes is the parent
  // product riding to the trash with its variants. The healthy ticket behind
  // it rides a SECOND product so the flush has something to continue past.
  const trashableProduct = await prisma.product.create({ data: { storeId: store.id, sku: "OFF-SHIRT-L", name: "قميص كبير", priceIqd: 15000, isActive: true } });
  const trashableVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: trashableProduct.id, isDefault: true } });
  await prisma.productVariant.update({ where: { id: trashableVariant.id }, data: { stockQuantity: 2, lowStockThreshold: 1 } });

  // ------------------------------------------------------- merchant login
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  armTripwire(page, "till");

  await page.goto(`${base}/merchant/login`);
  await page.locator('input[name="identifier"]').fill(merchantEmail);
  await page.locator('input[name="password"]').fill(merchantPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL(`**/merchant/stores/${store.slug}/dashboard`);

  // Pair the till device through the settings UI, same as the online suite.
  await page.goto(`${base}/merchant/stores/${store.slug}/dashboard/settings/pos`);
  await page.getByTestId("pos-device-label").fill("كاشير أوفلاين");
  await page.getByTestId("pos-pair-submit").click();
  await page.getByTestId("pos-paired-notice").waitFor();
  const device = await prisma.posDevice.findFirstOrThrow({ where: { storeId: store.id } });

  // ------------------------- 1: baseline online sale, SW takes the origin
  await page.goto(`${base}/merchant/stores/${store.slug}/till`);
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  // The SW registers on till mount (PROD gate) and clientsClaim makes it
  // control THIS page without a reload — boot-from-cache in screen 3 depends
  // on this being true, so it is asserted, not hoped.
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, undefined, { timeout: 30000 });

  // Capture the exact POST body of the baseline sale — screen 7 replays it
  // byte-for-values from the revoked device to pin replay-before-revocation.
  const baselineRequestPromise = page.waitForRequest((request) => request.url().includes("/pos/tickets") && request.method() === "POST");
  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  const baselinePayload = (await baselineRequestPromise).postData();
  assert.ok(baselinePayload, "the baseline confirm posted a ticket body");
  await page.getByTestId("till-order-number").waitFor();
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 1, "one order after the baseline sale");
  await waitCounters(page, { confirmed: 1, pending: 0 });
  await newSale(page);
  assertConsoleClean("baseline online sale with the SW controlling");

  // ------------------------------- 2: setOffline — sell twice, reconnect
  await context.setOffline(true);

  // ق-144: the search box with the cable cut. The till STILL asks the server —
  // it has no way to know the request will die, and `navigator.onLine` is a
  // liar (this suite's own thesis) — and when the request dies the grid falls
  // back to the IndexedDB snapshot. What must be true afterwards: the tile is
  // on screen, the source says the snapshot answered, and NOTHING was logged.
  const offlineProbe = page.waitForRequest((request) => request.url().includes("/pos/products?"));
  await page.getByTestId("till-scan").fill("قميص");
  await offlineProbe;
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="till-grid"]')?.getAttribute("data-search-source") === "local", undefined, { timeout: 30000 });
  assert.equal(await page.getByTestId("till-search-min-length").count(), 0, "a real needle is never met with the short-query notice");
  await page.screenshot({ path: `${artifactsDir}/pos-offline-search-snapshot.png`, fullPage: true });
  // The console tripwire above allows the network failure and nothing else, so
  // this call is what pins «no console.error on the offline search path».
  assertConsoleClean("offline search fell back to the snapshot");
  await page.getByTestId("till-scan").fill("");

  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  await page.getByTestId("till-queue-pill").waitFor();
  await newSale(page);
  // A real second sale happens seconds after the first — keep that gap so
  // the sold_at ordering assertion below measures reality, not race luck.
  await sleep(1500);
  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  await waitCounters(page, { confirmed: 1, pending: 2 });
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 1, "offline sales write NOTHING to Postgres until sync");
  await page.screenshot({ path: `${artifactsDir}/pos-offline-pending.png`, fullPage: true });
  await newSale(page);

  await sleep(1500);
  await context.setOffline(false);
  await waitCounters(page, { confirmed: 3, pending: 0 });
  const flushed = await prisma.storeOrder.findMany({ where: { storeId: store.id, source: "pos" }, orderBy: { createdAt: "asc" }, skip: 1 });
  assert.equal(flushed.length, 2, "both queued sales landed on reconnect");
  for (const order of flushed) {
    assert.ok(order.soldAt !== null, "a flushed sale carries its ring-up time");
    // ≥1.2s, not merely <: a client that stamped deviceReportedAt at FLUSH
    // time instead of ring time would still be a few ms before createdAt and
    // slip past a bare inequality. The rings sit behind two deliberate 1.5s
    // sleeps, so the honest gap is well above this floor.
    assert.ok(order.createdAt.getTime() - order.soldAt.getTime() >= 1200, `sold_at is the RING time, not the flush time (gap ${order.createdAt.getTime() - order.soldAt.getTime()}ms)`);
  }
  assert.ok(flushed[1].soldAt.getTime() - flushed[0].soldAt.getTime() >= 1200, "ring order (and the real gap between rings) survives the flush");
  assertConsoleClean("setOffline round-trip");

  // --------------------------- 3: power cut — kill, sell, reboot, respawn
  web.kill();
  await sleep(1000);
  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  // The reboot: navigation is network-first → connection refused → the SW
  // serves the cached shell; the catalog and device come from IndexedDB.
  await page.reload();
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  await page.getByTestId("till-queue-pill").waitFor();
  await waitCounters(page, { pending: 1 });
  await page.screenshot({ path: `${artifactsDir}/pos-offline-sw-boot.png`, fullPage: true });

  web = startServer();
  await waitFor(`${base}/api/health`);
  // navigator.onLine never flipped, so no 'online' event rescues the queue —
  // ONLY the backoff timer can drain it. That is the claim under test.
  await waitCounters(page, { confirmed: 4, pending: 0 });
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 4, "the power-cut sale synced after the server came back");
  assertConsoleClean("power-cut reboot and drain");

  // ------------------- 4: dead-letter continues past, retry un-poisons
  await context.setOffline(true);
  await ringLine(page, "OFF-SHIRT-L");
  await page.getByTestId(`till-line-inc-${trashableVariant.id}`).waitFor();
  await payAndConfirm(page, 15000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  await newSale(page);
  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  // Back to the grid BEFORE the drawer work — the done card is a full-screen
  // state and would cover the header counters button.
  await newSale(page);
  // Trash the poisoned ticket's PRODUCT through the REAL PG-2 door (raw
  // prisma flips trip the deleted_pair CHECK — a trashed row must carry its
  // audit event, and only the door writes one).
  const trashLogin = await json("/api/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: merchantEmail, password: merchantPassword }) });
  const trashCookie = sessionCookie(trashLogin.response);
  const trashDrop = await json(`/api/merchant/stores/${store.slug}/catalog/products/${trashableProduct.id}`, { method: "DELETE", headers: { cookie: trashCookie, origin: base } });
  assert.equal(trashDrop.response.status, 200, `the product went to the trash through the merchant API: ${JSON.stringify(trashDrop.body)}`);
  await context.setOffline(false);
  // FIFO hits the poisoned ticket FIRST, dead-letters it, and must reach the
  // healthy one behind it — confirmed grows even though the head failed.
  await waitCounters(page, { confirmed: 5, pending: 0, failed: 1 });
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 5, "the healthy ticket landed; the poisoned one did not");

  await page.getByTestId("till-queue-counters").click();
  await page.getByTestId("till-queue-drawer").waitFor();
  await page.getByText("صنف محذوف من الكتالوج", { exact: false }).waitFor();
  await page.screenshot({ path: `${artifactsDir}/pos-offline-dead-letter.png`, fullPage: true });
  const failedRow = page.locator('[data-testid^="till-queue-row-"]').filter({ has: page.locator('[data-testid^="till-queue-retry-"]') });
  const failedTicketId = (await failedRow.first().getAttribute("data-testid")).replace("till-queue-row-", "");
  const trashRestore = await json(`/api/merchant/stores/${store.slug}/trash/product/${trashableProduct.id}/restore`, { method: "POST", headers: { cookie: trashCookie, origin: base } });
  assert.equal(trashRestore.response.status, 200, `restore-from-trash: ${JSON.stringify(trashRestore.body)}`);
  await page.getByTestId(`till-queue-retry-${failedTicketId}`).click();
  await waitCounters(page, { confirmed: 6, pending: 0 });
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 6, "restore-from-trash un-poisons the ticket");
  await page.getByTestId("till-queue-close").click();
  assertConsoleClean("dead-letter drill");

  // ---------------------- 5: session dies mid-queue — pause, never discard
  await context.setOffline(true);
  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  await newSale(page);
  await prisma.merchantSession.deleteMany({ where: {} });
  await context.setOffline(false);
  await page.getByTestId("till-queue-session").waitFor();
  await waitCounters(page, { confirmed: 6, pending: 1 });
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 6, "an expired session holds the money in the queue — nothing lands, nothing is dropped");
  await page.screenshot({ path: `${artifactsDir}/pos-offline-session-paused.png`, fullPage: true });

  await page.goto(`${base}/merchant/login`);
  await page.locator('input[name="identifier"]').fill(merchantEmail);
  await page.locator('input[name="password"]').fill(merchantPassword);
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await page.waitForURL(`**/merchant/stores/${store.slug}/dashboard`);
  await page.goto(`${base}/merchant/stores/${store.slug}/till`);
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  await waitCounters(page, { confirmed: 7, pending: 0 });
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 7, "re-login drained the paused queue");
  assertConsoleClean("session expiry drill");

  // ----------------------- 6: scope hygiene — the SW touches ONLY the till
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.title.includes("Codiq")); // ق-161: عنوان الصفحة صار «Codiq»
  await page.goto(`${base}/merchant/stores/${store.slug}/dashboard/orders`);
  await page.getByLabel("البحث برقم الطلب").waitFor();
  assertConsoleClean("landing and dashboard with the SW registered origin-wide");

  // ----------- 6b: a sale rung under ANOTHER user waits for that user
  // The server credits a sale to the session that SENDS it, so a queue that
  // flushed whatever it held would credit one cashier's offline sales to the
  // next one who signs in — and the owner's price-deviation queue names the
  // seller. A queued sale is sent only under the session that rang it.
  await page.goto(`${base}/merchant/stores/${store.slug}/till`);
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  const ordersBeforeOwnership = await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } });
  await context.setOffline(true);
  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  const reown = (ownerKeyOrNull) => page.evaluate(async ({ slug, ownerKeyOrNull }) => {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open(`codiq-till:${slug}`); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const read = (store, key) => new Promise((resolve) => { const r = db.transaction(store).objectStore(store)[key === undefined ? "getAll" : "get"](key); r.onsuccess = () => resolve(r.result); });
    const owner = ownerKeyOrNull ?? await read("kv", "owner");
    for (const record of await read("queue")) {
      if (record.state !== "pending") continue;
      await new Promise((resolve) => { const tx = db.transaction("queue", "readwrite"); tx.objectStore("queue").put({ ...record, ownerKey: owner }); tx.oncomplete = resolve; });
    }
    db.close();
    return owner;
  }, { slug: store.slug, ownerKeyOrNull });
  const merchantOwner = await reown("staff:00000000-0000-4000-8000-000000000000");
  // Rebooted while still offline, so the page holds the record as stored — the
  // open page's in-memory copy would otherwise flush the moment it reconnects.
  await page.reload();
  await page.getByTestId("till-queue-others").waitFor({ timeout: 30000 });
  await context.setOffline(false);
  await page.reload();
  await page.getByTestId("till-queue-others").waitFor({ timeout: 30000 });
  await sleep(6000);
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), ordersBeforeOwnership, "a sale rung by another user is NOT sent under this session");
  await page.screenshot({ path: `${artifactsDir}/pos-offline-other-owner.png`, fullPage: true });
  // Handed back to the signed-in user, it is his sale and it goes.
  await reown(null);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('[data-testid="till-queue-others"]'), undefined, { timeout: 30000 });
  for (let tries = 0; tries < 60 && await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }) === ordersBeforeOwnership; tries += 1) await sleep(1000);
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), ordersBeforeOwnership + 1, `…and under its own session it syncs (${merchantOwner})`);
  assertConsoleClean("queued sales wait for the user who rang them");

  // -------------------- 7: revoked mid-queue — LAST, revocation is forever
  await page.goto(`${base}/merchant/stores/${store.slug}/till`);
  await page.getByTestId(`till-add-${defaultVariant.id}`).waitFor();
  await context.setOffline(true);
  await ringLine(page, "OFF-SHIRT");
  await page.getByTestId(`till-line-inc-${defaultVariant.id}`).waitFor();
  await payAndConfirm(page, 10000);
  await page.getByTestId("till-queue-pending-chip").waitFor();
  await prisma.posDevice.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
  await context.setOffline(false);
  await page.getByTestId("till-queue-revoked-count").waitFor({ timeout: 90000 });
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 8, "a revoked device commits nothing new");
  // The retained sale must survive a reboot — IDB, not React state.
  await page.reload();
  await page.getByTestId("till-queue-revoked-count").waitFor({ timeout: 90000 });
  await page.screenshot({ path: `${artifactsDir}/pos-offline-revoked.png`, fullPage: true });

  // Replay-before-revocation: the ALREADY-COMMITTED baseline ticket, resent
  // verbatim from this same revoked device, still answers 200 replayed:true —
  // acknowledgments are never lost to a revocation.
  const replayLogin = await json("/api/auth/merchant/login", { method: "POST", body: JSON.stringify({ identifier: merchantEmail, password: merchantPassword }) });
  const replayCookie = sessionCookie(replayLogin.response);
  const replay = await json(`/api/merchant/stores/${store.slug}/pos/tickets`, { method: "POST", headers: { cookie: replayCookie, origin: base }, body: baselinePayload });
  assert.equal(replay.response.status, 200, `committed tickets replay from a revoked device: ${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.replayed, true, "the replay says so honestly");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: store.id, source: "pos" } }), 8, "the replay minted nothing");
  assertConsoleClean("revoked-device drill");

  console.log("pos-offline OK");
} finally {
  await browser.close();
  web.kill();
  await prisma.$disconnect();
}

/**
 * codiq phase 20B-1 — coupons engine + prescription products integration proof.
 * Follows the phase9a/20a harness (real HTTP app + raw pg client + the
 * pg_stat_activity lock barrier) and the phase7 moto S3 emulator, proving
 * against a real PostgreSQL the full plan §1.4 + §6.4 scenario lists:
 *
 * Coupons:
 *  1. the three kinds with integer math — percent floor, fixed clamped to the
 *     subtotal, free_shipping zeroing the delivery fee only;
 *  2. LOCK-ORDER PROOF (barrier): a checkout blocked on the coupon FOR UPDATE
 *     holds NO variant lock (NOWAIT probe succeeds) — coupon before variants;
 *  3. real-concurrency race on the coupon's LAST use — one 201, one
 *     COUPON_EXHAUSTED, exactly one redemption row;
 *  4. customer/time/min limits; 5. idempotency replay/mismatch + fingerprint
 *     unit assertions (absent key == pre-deploy bytes);
 *  6. ledger books the DISCOUNTED subtotal and the return reversal mirrors it;
 *  7. two-store isolation at the API and via raw SQL (23503) + append-only
 *     redemptions (23514); 8. no-coupon checkout byte-identical to 20A.
 *
 * Prescriptions:
 *  9. full lifecycle: pending_upload -> pending_review -> rejected -> re-upload
 *     -> approved, with new→processing 422 PRESCRIPTION_NOT_APPROVED at every
 *     pre-approval step and 200 after approval;
 * 10. fake magic bytes refused before any write; 11. private guarded streaming
 *     (owner + orders.view) with IDOR closed (404/403); 12. cancel/reject from
 *     `new` stay open; 13. raw-SQL cross-store insert refused (23503);
 * 14. an order without a prescription product behaves exactly as before.
 */
import assert from "node:assert/strict";
import { applyPlanTermsNow } from "./helpers/plan-terms.js";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import { killTree } from "./helpers/child-process.mjs";

const testId = `phase20b1-${Date.now()}`;
const bucket = `codiq-${testId}`;
const s3Port = 4573;
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");
process.env.SESSION_JWT_SECRET = "phase20b1-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;
process.env.PRODUCT_S3_ENDPOINT = `http://127.0.0.1:${s3Port}`;
process.env.PRODUCT_S3_BUCKET = bucket;
process.env.PRODUCT_S3_ACCESS_KEY_ID = "S3RVER";
process.env.PRODUCT_S3_SECRET_ACCESS_KEY = "S3RVER";
process.env.PRODUCT_S3_REGION = "us-east-1";
process.env.PRODUCT_S3_FORCE_PATH_STYLE = "true";

const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
for (let attempt = 0; attempt < 30; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  if (attempt === 29) throw new Error("Moto S3-compatible test server did not start.");
}
const s3 = new S3Client({ endpoint: process.env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { checkoutFingerprint } = await import("../src/services/storefront.service.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, form, token, headers = {} } = {}) {
  // This suite exceeds the per-store fixed-window limits (register 8, checkout
  // 12) by design; the limiter itself is phase9a's subject, so counters are
  // cleared before every write to keep scenarios independent of call volume.
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  const payload = response.status === 204 ? null : isJson ? await response.json().catch(() => null) : null;
  const bytes = !isJson && response.status === 200 ? Buffer.from(await response.arrayBuffer()) : null;
  return { status: response.status, payload, bytes, contentType: response.headers.get("content-type") };
}

async function merchantStatus(token, slug, orderId, toStatus, expectedVersion) {
  return request(`/merchant/stores/${slug}/orders/${orderId}/status`, { method: "POST", token, body: { toStatus, expectedVersion } });
}

async function completeOrder(token, slug, orderId, startVersion = 1) {
  const path = [["processing", startVersion], ["preparation", startVersion + 1], ["out_for_delivery", startVersion + 2], ["completed", startVersion + 3]];
  for (const [toStatus, version] of path) {
    const result = await merchantStatus(token, slug, orderId, toStatus, version);
    assert.equal(result.status, 200, `transition to ${toStatus} failed: ${JSON.stringify(result.payload)}`);
  }
}

async function waitForCheckoutLockWait(monitor) {
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const result = await monitor.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%' AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting");
    if (result.rows[0].waiting) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Phase 20B-1 synchronization barrier was not reached.");
}

let customerPhoneSuffix = 0;
async function registerCustomer(slug, fullName) {
  customerPhoneSuffix += 1;
  const phone = `+96477031${String(customerPhoneSuffix).padStart(5, "0")}`;
  const registered = await request(`/store/${slug}/account/register`, { method: "POST", body: { phone, password: "Phase20B1CustomerPass!", fullName } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const address = await request(`/store/${slug}/account/addresses`, { method: "POST", token: registered.payload.accessToken, body: { recipientName: fullName, fullAddress: "شارع الكوبونات 20", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  return { token: registered.payload.accessToken, account: registered.payload.account, addressId: address.payload.address.id };
}

async function cartWith(slug, token, productId, quantity = 1) {
  const added = await request(`/store/${slug}/cart/items`, { method: "POST", token, body: { productId, quantity } });
  assert.equal(added.status, 200, JSON.stringify(added.payload));
  return added.payload.cart;
}

let checkoutKeySuffix = 0;
async function doCheckout(slug, customer, cart, { couponCode, key } = {}) {
  checkoutKeySuffix += 1;
  const idempotencyKey = key ?? `phase20b1-key-${String(checkoutKeySuffix).padStart(4, "0")}`;
  const body = { cartVersion: cart.version, addressId: customer.addressId, paymentMethodCode: "cod", ...(couponCode ? { couponCode } : {}) };
  return { key: idempotencyKey, ...(await request(`/store/${slug}/checkout`, { method: "POST", token: customer.token, headers: { "idempotency-key": idempotencyKey }, body })) };
}

function pngForm() {
  const form = new FormData();
  form.append("prescription", new Blob([png], { type: "image/png" }), "prescription.png");
  return form;
}

const summary = {};

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100206601", email: `${testId}.merchant-a@codiq.test`, password: "Phase20BMerchantPass!", businessName: "متجر 20B ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100206602", email: `${testId}.merchant-b@codiq.test`, password: "Phase20BMerchantPass!", businessName: "متجر 20B باء" });
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر 20B ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر 20B باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  await prisma.deliveryRate.create({ data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  await prisma.notificationSettings.create({ data: { storeId: storeA.id, isEnabled: true } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-a@codiq.test`, password: "Phase20BMerchantPass!" } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-b@codiq.test`, password: "Phase20BMerchantPass!" } });
  assert.equal(loginA.status, 200); assert.equal(loginB.status, 200);
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;
  // Ledger math needs a real commission: 300 bps on the free plan for this run.
  // `plans` is GLOBAL and outside this suite's TRUNCATE, so whatever is changed
  // here has to be put back EXACTLY — restoring a guessed value corrupts it for
  // every later suite. phase17 asserts 300 (the value migration 20260825190000
  // seeds) and used to fail in a sweep while passing alone, which reads as flake.
  const seededFreeCommissionBps = (await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { commissionBps: true } })).commissionBps;
  await prisma.plan.update({ where: { code: "free" }, data: { commissionBps: 300 } });
  // ق-128 grants every new merchant a free MONTH on «growth» (200 bps), so
  // setting the FREE plan's commission above no longer reaches this suite's
  // merchants — they are not on it. Pinning them is what restores the premise
  // the ledger assertions below were written against.
  const freePlanId = (await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } })).id;
  await prisma.merchantSubscription.updateMany({
    where: { merchantId: { in: [merchantA.payload.account.id, merchantB.payload.account.id] }, status: "active" },
    data: { planId: freePlanId, endsAt: null },
  });

  const regular = await prisma.product.create({ data: { storeId: storeA.id, sku: "P20B-REG", name: "منتج عادي", priceIqd: 10000, stockQuantity: 50, lowStockThreshold: 0 } });
  const regularVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: regular.id, isDefault: true } });
  const rxCreate = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { method: "POST", token: tokenA, body: { sku: "P20B-RX", name: "دواء بوصفة", priceIqd: 15000, stockQuantity: 20, lowStockThreshold: 0, requiresPrescription: true } });
  assert.equal(rxCreate.status, 201, JSON.stringify(rxCreate.payload));
  assert.equal(rxCreate.payload.product.requiresPrescription, true, "merchant payload must carry requiresPrescription");
  const rxProduct = rxCreate.payload.product;
  await prisma.product.create({ data: { storeId: storeB.id, sku: "P20B-B", name: "منتج متجر باء", priceIqd: 9000, stockQuantity: 5 } });

  // ---------- coupons: merchant management API (settings.manage, no DELETE) ----------
  const couponsBase = `/merchant/stores/${storeA.slug}/marketing/coupons`;
  const percentCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "SAVE33", kind: "percent", percentOff: 33 } });
  assert.equal(percentCreate.status, 201, JSON.stringify(percentCreate.payload));
  const fixedCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "FLAT2000", kind: "fixed", amountOffIqd: 2000, minSubtotalIqd: 5000 } });
  assert.equal(fixedCreate.status, 201);
  const shippingCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "SHIPFREE", kind: "free_shipping" } });
  assert.equal(shippingCreate.status, 201);
  const lastUseCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "LAST1", kind: "percent", percentOff: 50, maxUsesTotal: 1 } });
  assert.equal(lastUseCreate.status, 201);
  const onePerCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "ONEPER", kind: "fixed", amountOffIqd: 1000, maxUsesPerCustomer: 1 } });
  assert.equal(onePerCreate.status, 201);
  const expiredCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "OLD10", kind: "percent", percentOff: 10, startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-02-01T00:00:00.000Z" } });
  assert.equal(expiredCreate.status, 201);
  const raceCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "RACE10", kind: "percent", percentOff: 10 } });
  assert.equal(raceCreate.status, 201);
  const bigMinCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "BIGMIN", kind: "fixed", amountOffIqd: 2000, minSubtotalIqd: 50000 } });
  assert.equal(bigMinCreate.status, 201);
  const hugeCreate = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "HUGE", kind: "fixed", amountOffIqd: 50000 } });
  assert.equal(hugeCreate.status, 201);
  const duplicateCode = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "save33", kind: "fixed", amountOffIqd: 1 } });
  assert.equal(duplicateCode.status, 409); assert.equal(duplicateCode.payload.error.code, "DUPLICATE_COUPON_CODE");
  const missingPercent = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "BROKEN", kind: "percent" } });
  assert.equal(missingPercent.status, 422);
  const badKind = await request(couponsBase, { method: "POST", token: tokenA, body: { code: "BROKEN2", kind: "bogus" } });
  assert.equal(badKind.status, 422);
  const couponList = await request(couponsBase, { token: tokenA });
  assert.equal(couponList.status, 200); assert.equal(couponList.payload.coupons.length, 9);
  const crossStoreList = await request(couponsBase, { token: tokenB });
  assert.equal(crossStoreList.status, 403); assert.equal(crossStoreList.payload.error.code, "STORE_BOUNDARY_DENIED");
  // PG-2 replaced «coupons have NO delete route» with a SOFT delete: the coupon
  // moves to the trash bin, its redemption ledger is untouched, and the purge is
  // refused by coupon_redemptions' foreign key for any coupon ever redeemed.
  // Restored immediately so the rest of this suite sees the same nine coupons.
  const softDeleteRoute = await request(`${couponsBase}/${percentCreate.payload.coupon.id}`, { method: "DELETE", token: tokenA });
  assert.equal(softDeleteRoute.status, 200, JSON.stringify(softDeleteRoute.payload));
  assert.ok(softDeleteRoute.payload.purgeAt, "PG-2: the coupon delete reports its purge date");
  assert.equal((await request(couponsBase, { token: tokenA })).payload.coupons.length, 8, "PG-2: the trashed coupon leaves the merchant list at once");
  const couponRestore = await request(`${couponsBase}/${percentCreate.payload.coupon.id}/restore`, { method: "POST", token: tokenA, body: {} });
  assert.equal(couponRestore.status, 200, JSON.stringify(couponRestore.payload));
  assert.equal((await request(couponsBase, { token: tokenA })).payload.coupons.length, 9, "PG-2: and comes back whole");
  const bCouponCreate = await request(`/merchant/stores/${storeB.slug}/marketing/coupons`, { method: "POST", token: tokenB, body: { code: "BCODE", kind: "fixed", amountOffIqd: 500 } });
  assert.equal(bCouponCreate.status, 201);
  summary.management = { created: 9, duplicate: duplicateCode.status, crossStoreList: crossStoreList.status, softDeleteRoute: softDeleteRoute.status, restore: couponRestore.status };

  // ---------- fingerprint unit assertions: absent key == pre-deploy bytes ----------
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const legacyShape = { cartVersion: 3, addressId: "addr-1", address: null, paymentMethodCode: "cod" };
  const fingerprintWithout = checkoutFingerprint({ addressId: "addr-1", paymentMethodCode: "cod" }, 3);
  assert.equal(fingerprintWithout, sha(JSON.stringify(legacyShape)), "no coupon => the fingerprint must be byte-identical to the pre-20B formula");
  const fingerprintWith = checkoutFingerprint({ addressId: "addr-1", paymentMethodCode: "cod", couponCode: " save33 " }, 3);
  assert.equal(fingerprintWith, sha(JSON.stringify({ ...legacyShape, couponCode: "SAVE33" })), "coupon => normalized code appended as the last key");
  assert.notEqual(fingerprintWith, fingerprintWithout);
  summary.fingerprint = { preDeployIdentical: true, couponAppendsNormalizedKey: true };

  // ---------- percent coupon checkout + idempotency + discounted ledger ----------
  const customer1 = await registerCustomer(storeA.slug, "زبونة النسبة");
  const cart1 = await cartWith(storeA.slug, customer1.token, regular.id, 1);
  const preview1 = await request(`/store/${storeA.slug}/cart/coupon-preview`, { method: "POST", token: customer1.token, body: { couponCode: "save33" } });
  assert.equal(preview1.status, 200, JSON.stringify(preview1.payload));
  assert.equal(preview1.payload.preview.discountIqd, 3300, "floor(10000*33/100) = 3300");
  assert.equal(preview1.payload.preview.freeShipping, false);
  const percentCheckout = await doCheckout(storeA.slug, customer1, cart1, { couponCode: "save33" });
  assert.equal(percentCheckout.status, 201, JSON.stringify(percentCheckout.payload));
  const percentOrder = percentCheckout.payload.order;
  assert.equal(percentOrder.discountIqd, 3300);
  assert.equal(percentOrder.deliveryFeeIqd, 2500);
  assert.equal(percentOrder.totalIqd, 10000 - 3300 + 2500);
  assert.equal(percentOrder.couponCode, "SAVE33");
  assert.equal(percentOrder.prescriptionStatus, null);
  const percentRedemption = await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: percentOrder.id } });
  assert.equal(percentRedemption.discountIqd, 3300); assert.equal(percentRedemption.waivedDeliveryFeeIqd, 0);
  const replay = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customer1.token, headers: { "idempotency-key": percentCheckout.key }, body: { cartVersion: cart1.version, addressId: customer1.addressId, paymentMethodCode: "cod", couponCode: "save33" } });
  assert.equal(replay.status, 200); assert.equal(replay.payload.replayed, true); assert.equal(replay.payload.order.id, percentOrder.id);
  assert.equal(await prisma.couponRedemption.count({ where: { orderId: percentOrder.id } }), 1, "replay must not add a redemption");
  const mismatchCoupon = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customer1.token, headers: { "idempotency-key": percentCheckout.key }, body: { cartVersion: cart1.version, addressId: customer1.addressId, paymentMethodCode: "cod", couponCode: "FLAT2000" } });
  assert.equal(mismatchCoupon.status, 409); assert.equal(mismatchCoupon.payload.error.code, "IDEMPOTENCY_KEY_REUSED");
  const mismatchNoCoupon = await request(`/store/${storeA.slug}/checkout`, { method: "POST", token: customer1.token, headers: { "idempotency-key": percentCheckout.key }, body: { cartVersion: cart1.version, addressId: customer1.addressId, paymentMethodCode: "cod" } });
  assert.equal(mismatchNoCoupon.status, 409); assert.equal(mismatchNoCoupon.payload.error.code, "IDEMPOTENCY_KEY_REUSED");
  await completeOrder(tokenA, storeA.slug, percentOrder.id);
  const completionEntry = await prisma.ledgerEntry.findFirstOrThrow({ where: { orderId: percentOrder.id, entryType: "order_completed" } });
  assert.equal(completionEntry.subtotalIqd, 6700, "ledger books the DISCOUNTED subtotal (10000 - 3300)");
  assert.equal(completionEntry.commissionBps, 300);
  assert.equal(completionEntry.commissionIqd, Math.round((6700 * 300) / 10000), "commission on the discounted subtotal");
  const toReturned = await merchantStatus(tokenA, storeA.slug, percentOrder.id, "returned", 5);
  assert.equal(toReturned.status, 200);
  const reversalEntry = await prisma.ledgerEntry.findFirstOrThrow({ where: { orderId: percentOrder.id, entryType: "order_returned" } });
  assert.equal(reversalEntry.subtotalIqd, 6700); assert.equal(reversalEntry.commissionIqd, completionEntry.commissionIqd);
  summary.percentAndLedger = { discount: 3300, total: percentOrder.totalIqd, replay: replay.status, mismatch: mismatchCoupon.status, ledgerSubtotal: completionEntry.subtotalIqd, commission: completionEntry.commissionIqd, reversalMirrors: true };

  // ---------- fixed coupon: flat amount, then clamped to the subtotal ----------
  const customer2 = await registerCustomer(storeA.slug, "زبونة الثابت");
  const cart2 = await cartWith(storeA.slug, customer2.token, regular.id, 1);
  const fixedCheckout = await doCheckout(storeA.slug, customer2, cart2, { couponCode: "FLAT2000" });
  assert.equal(fixedCheckout.status, 201, JSON.stringify(fixedCheckout.payload));
  assert.equal(fixedCheckout.payload.order.discountIqd, 2000);
  assert.equal(fixedCheckout.payload.order.totalIqd, 10000 - 2000 + 2500);
  const customer3 = await registerCustomer(storeA.slug, "زبونة السقف");
  const cart3 = await cartWith(storeA.slug, customer3.token, regular.id, 1);
  const clampedCheckout = await doCheckout(storeA.slug, customer3, cart3, { couponCode: "HUGE" });
  assert.equal(clampedCheckout.status, 201);
  assert.equal(clampedCheckout.payload.order.discountIqd, 10000, "fixed discount clamps to min(amount, subtotal)");
  assert.equal(clampedCheckout.payload.order.totalIqd, 2500, "delivery fee still owed after a full-subtotal discount");

  // ---------- free_shipping: fee zeroed, discount untouched, waiver snapshotted ----------
  const customer4 = await registerCustomer(storeA.slug, "زبونة الشحن");
  const cart4 = await cartWith(storeA.slug, customer4.token, regular.id, 2);
  const shippingCheckout = await doCheckout(storeA.slug, customer4, cart4, { couponCode: "shipfree" });
  assert.equal(shippingCheckout.status, 201, JSON.stringify(shippingCheckout.payload));
  const shippingOrder = shippingCheckout.payload.order;
  assert.equal(shippingOrder.deliveryFeeIqd, 0, "free_shipping zeroes the delivery fee");
  assert.equal(shippingOrder.discountIqd, 0, "free_shipping never touches discount_iqd");
  assert.equal(shippingOrder.totalIqd, 20000);
  const shippingRedemption = await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: shippingOrder.id } });
  assert.equal(shippingRedemption.waivedDeliveryFeeIqd, 2500, "the waived fee is snapshotted on the redemption");
  summary.kinds = { fixed: fixedCheckout.payload.order.discountIqd, clamped: clampedCheckout.payload.order.discountIqd, freeShippingFee: shippingOrder.deliveryFeeIqd, waived: shippingRedemption.waivedDeliveryFeeIqd };

  // ---------- limits: window, minimum subtotal, per-customer ----------
  const customer5 = await registerCustomer(storeA.slug, "زبونة الحدود");
  const cart5 = await cartWith(storeA.slug, customer5.token, regular.id, 1);
  const expiredPreview = await request(`/store/${storeA.slug}/cart/coupon-preview`, { method: "POST", token: customer5.token, body: { couponCode: "OLD10" } });
  assert.equal(expiredPreview.status, 422); assert.equal(expiredPreview.payload.error.code, "COUPON_EXPIRED");
  const expiredCheckout = await doCheckout(storeA.slug, customer5, cart5, { couponCode: "OLD10" });
  assert.equal(expiredCheckout.status, 422); assert.equal(expiredCheckout.payload.error.code, "COUPON_EXPIRED");
  const belowMin = await doCheckout(storeA.slug, customer5, cart5, { couponCode: "BIGMIN" });
  assert.equal(belowMin.status, 422); assert.equal(belowMin.payload.error.code, "COUPON_MIN_SUBTOTAL_NOT_MET");
  const notFound = await doCheckout(storeA.slug, customer5, cart5, { couponCode: "NOSUCH" });
  assert.equal(notFound.status, 422); assert.equal(notFound.payload.error.code, "COUPON_INVALID");
  const crossStoreCoupon = await doCheckout(storeA.slug, customer5, cart5, { couponCode: "BCODE" });
  assert.equal(crossStoreCoupon.status, 422, "a coupon of another store must be invisible");
  assert.equal(crossStoreCoupon.payload.error.code, "COUPON_INVALID");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id, customerId: customer5.account.id } }), 0, "every refused coupon leaves zero orders");
  const onePerFirst = await doCheckout(storeA.slug, customer5, cart5, { couponCode: "ONEPER" });
  assert.equal(onePerFirst.status, 201, JSON.stringify(onePerFirst.payload));
  const cart5b = await cartWith(storeA.slug, customer5.token, regular.id, 1);
  const onePerSecond = await doCheckout(storeA.slug, customer5, cart5b, { couponCode: "ONEPER" });
  assert.equal(onePerSecond.status, 422); assert.equal(onePerSecond.payload.error.code, "COUPON_CUSTOMER_LIMIT_REACHED");
  const customer6 = await registerCustomer(storeA.slug, "زبونة أخرى للحد");
  const cart6 = await cartWith(storeA.slug, customer6.token, regular.id, 1);
  const onePerOther = await doCheckout(storeA.slug, customer6, cart6, { couponCode: "ONEPER" });
  assert.equal(onePerOther.status, 201, "the per-customer limit binds one customer, not the coupon");
  summary.limits = { expired: expiredCheckout.status, belowMin: belowMin.status, notFound: notFound.payload.error.code, crossStore: crossStoreCoupon.payload.error.code, perCustomer: [onePerFirst.status, onePerSecond.status, onePerOther.status] };

  // ---------- LOCK-ORDER PROOF: coupon FOR UPDATE strictly BEFORE variant locks ----------
  const raceCouponId = raceCreate.payload.coupon.id;
  const customer7 = await registerCustomer(storeA.slug, "زبونة القفل");
  const cart7 = await cartWith(storeA.slug, customer7.token, regular.id, 1);
  const locker = new Client({ connectionString: process.env.DATABASE_URL });
  const monitor = new Client({ connectionString: process.env.DATABASE_URL });
  await locker.connect();
  await monitor.connect();
  await locker.query("BEGIN");
  await locker.query("SELECT id FROM coupons WHERE id = $1::uuid FOR UPDATE", [raceCouponId]);
  const ordersBeforeBarrier = await prisma.storeOrder.count({ where: { storeId: storeA.id } });
  const reservationsBeforeBarrier = await prisma.inventoryReservation.count({ where: { storeId: storeA.id } });
  const blockedCheckout = doCheckout(storeA.slug, customer7, cart7, { couponCode: "RACE10" });
  await waitForCheckoutLockWait(monitor);
  // While the checkout is provably blocked on the coupon row, its transaction
  // must hold NO variant lock — the NOWAIT probe succeeds only if the variant
  // is free, proving the coupon lock comes FIRST in the global order.
  await monitor.query("BEGIN");
  const probe = await monitor.query("SELECT id FROM product_variants WHERE id = $1::uuid FOR UPDATE NOWAIT", [regularVariant.id]);
  assert.equal(probe.rowCount, 1, "variant row must still be lockable while checkout waits on the coupon");
  await monitor.query("ROLLBACK");
  await locker.query("UPDATE coupons SET is_active = false WHERE id = $1::uuid", [raceCouponId]);
  await locker.query("COMMIT");
  const unblocked = await blockedCheckout;
  assert.equal(unblocked.status, 422, JSON.stringify(unblocked.payload));
  assert.equal(unblocked.payload.error.code, "COUPON_INVALID", "the deactivation committed under the lock must win");
  assert.equal(await prisma.storeOrder.count({ where: { storeId: storeA.id } }), ordersBeforeBarrier);
  assert.equal(await prisma.inventoryReservation.count({ where: { storeId: storeA.id } }), reservationsBeforeBarrier);
  assert.equal(await prisma.couponRedemption.count({ where: { couponId: raceCouponId } }), 0);
  await locker.end();
  await monitor.end();
  summary.lockOrder = { barrier: "checkout_waited_on_coupon_lock", variantProbe: "lockable (coupon first)", outcome: unblocked.payload.error.code, sideEffects: 0 };

  // ---------- real-concurrency race on the coupon's LAST use ----------
  const customerR1 = await registerCustomer(storeA.slug, "زبونة السباق الأولى");
  const customerR2 = await registerCustomer(storeA.slug, "زبونة السباق الثانية");
  const cartR1 = await cartWith(storeA.slug, customerR1.token, regular.id, 1);
  const cartR2 = await cartWith(storeA.slug, customerR2.token, regular.id, 1);
  const lastUseRace = await Promise.all([
    doCheckout(storeA.slug, customerR1, cartR1, { couponCode: "LAST1", key: "phase20b1-race-key-0001" }),
    doCheckout(storeA.slug, customerR2, cartR2, { couponCode: "LAST1", key: "phase20b1-race-key-0002" }),
  ]);
  const raceStatuses = lastUseRace.map((result) => result.status).sort();
  assert.deepEqual(raceStatuses, [201, 422], JSON.stringify(lastUseRace.map((result) => result.payload)));
  const raceLoser = lastUseRace.find((result) => result.status === 422);
  assert.equal(raceLoser.payload.error.code, "COUPON_EXHAUSTED");
  const raceWinner = lastUseRace.find((result) => result.status === 201);
  assert.equal(raceWinner.payload.order.discountIqd, 5000, "floor(10000*50/100)");
  assert.equal(await prisma.couponRedemption.count({ where: { couponId: lastUseCreate.payload.coupon.id } }), 1, "exactly ONE redemption after the race");
  summary.lastUseRace = { statuses: raceStatuses, loser: raceLoser.payload.error.code, redemptions: 1 };

  // ---------- no-coupon checkout: byte-identical legacy behavior ----------
  const customer8 = await registerCustomer(storeA.slug, "زبونة الإرث");
  const cart8 = await cartWith(storeA.slug, customer8.token, regular.id, 1);
  const plainCheckout = await doCheckout(storeA.slug, customer8, cart8, {});
  assert.equal(plainCheckout.status, 201);
  assert.equal(plainCheckout.payload.order.discountIqd, 0);
  assert.equal(plainCheckout.payload.order.couponCode, null);
  assert.equal(plainCheckout.payload.order.prescriptionStatus, null);
  assert.equal(plainCheckout.payload.order.totalIqd, 12500, "subtotal + delivery, exactly the 9A/20A math");
  assert.equal(await prisma.couponRedemption.count({ where: { orderId: plainCheckout.payload.order.id } }), 0);

  // ---------- two-store isolation: raw SQL composite FKs + append-only ----------
  // The target order carries NO redemption, so the composite FK — not
  // UNIQUE(order_id) — is what rejects each smuggled row.
  const bCoupon = await prisma.coupon.findFirstOrThrow({ where: { storeId: storeB.id } });
  let crossStoreCouponFk = null;
  try { await sql.query("INSERT INTO coupon_redemptions (store_id, coupon_id, order_id, customer_id, discount_iqd) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1)", [storeA.id, bCoupon.id, plainCheckout.payload.order.id, customer8.account.id]); } catch (error) { crossStoreCouponFk = error?.code ?? null; }
  assert.equal(crossStoreCouponFk, "23503", "a coupon of another store must be rejected by the composite FK");
  let crossStoreOrderFk = null;
  try { await sql.query("INSERT INTO coupon_redemptions (store_id, coupon_id, order_id, customer_id, discount_iqd) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1)", [storeB.id, bCoupon.id, plainCheckout.payload.order.id, customer8.account.id]); } catch (error) { crossStoreOrderFk = error?.code ?? null; }
  assert.equal(crossStoreOrderFk, "23503", "an order of another store must be rejected by the composite FK");
  let redemptionMutation = null;
  try { await sql.query("UPDATE coupon_redemptions SET discount_iqd = 0 WHERE order_id = $1::uuid", [shippingOrder.id]); } catch (error) { redemptionMutation = error?.code ?? null; }
  assert.equal(redemptionMutation, "23514", "redemptions are append-only (immutability trigger)");
  summary.isolation = { crossStoreCouponFk, crossStoreOrderFk, appendOnly: redemptionMutation };

  // ---------- prescriptions: storefront surfaces + checkout stamping ----------
  const publicRx = await request(`/store/${storeA.slug}/products/${rxProduct.id}`);
  assert.equal(publicRx.status, 200); assert.equal(publicRx.payload.product.requiresPrescription, true);
  const publicRegular = await request(`/store/${storeA.slug}/products/${regular.id}`);
  assert.equal(publicRegular.payload.product.requiresPrescription, false);
  const publicListing = await request(`/store/${storeA.slug}/products`);
  assert.equal(publicListing.payload.products.find((product) => product.id === rxProduct.id).requiresPrescription, true);

  const customerRx = await registerCustomer(storeA.slug, "زبونة الوصفة");
  const cartRx = await cartWith(storeA.slug, customerRx.token, rxProduct.id, 1);
  const rxCheckout = await doCheckout(storeA.slug, customerRx, cartRx, {});
  assert.equal(rxCheckout.status, 201, JSON.stringify(rxCheckout.payload));
  const rxOrder = rxCheckout.payload.order;
  assert.equal(rxOrder.prescriptionStatus, "pending_upload", "checkout stamps pending_upload from the SAME lock query");

  // state-machine gate: new→processing refused until approved; note the exact 422 code
  const gatePendingUpload = await merchantStatus(tokenA, storeA.slug, rxOrder.id, "processing", 1);
  assert.equal(gatePendingUpload.status, 422); assert.equal(gatePendingUpload.payload.error.code, "PRESCRIPTION_NOT_APPROVED");
  const rxStillNew = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}`, { token: tokenA });
  assert.equal(rxStillNew.payload.order.status, "new"); assert.equal(rxStillNew.payload.order.version, 1);

  // fake magic bytes: rejected BEFORE any write
  const fakeForm = new FormData();
  fakeForm.append("prescription", new Blob([Buffer.from("not a real png at all")], { type: "image/png" }), "fake.png");
  const fakeUpload = await request(`/store/${storeA.slug}/account/orders/${rxOrder.id}/prescription`, { method: "POST", token: customerRx.token, form: fakeForm });
  assert.equal(fakeUpload.status, 422); assert.equal(fakeUpload.payload.error.code, "INVALID_PRESCRIPTION_IMAGE");
  assert.equal(await prisma.orderPrescription.count({ where: { orderId: rxOrder.id } }), 0, "a fake file leaves zero rows");
  assert.equal((await prisma.storeOrder.findUniqueOrThrow({ where: { id: rxOrder.id } })).prescriptionStatus, "pending_upload");

  // real upload → pending_review; object key follows prescriptions/{storeId}/{orderId}/
  const upload1 = await request(`/store/${storeA.slug}/account/orders/${rxOrder.id}/prescription`, { method: "POST", token: customerRx.token, form: pngForm() });
  assert.equal(upload1.status, 201, JSON.stringify(upload1.payload));
  assert.equal(upload1.payload.prescriptionStatus, "pending_review");
  const storedRow = await prisma.orderPrescription.findFirstOrThrow({ where: { orderId: rxOrder.id } });
  assert.ok(storedRow.objectKey.startsWith(`prescriptions/${storeA.id}/${rxOrder.id}/`), "object keys follow prescriptions/{storeId}/{orderId}/{uuid}");
  const gatePendingReview = await merchantStatus(tokenA, storeA.slug, rxOrder.id, "processing", 1);
  assert.equal(gatePendingReview.status, 422); assert.equal(gatePendingReview.payload.error.code, "PRESCRIPTION_NOT_APPROVED");

  // guarded private streaming + IDOR
  const ownerStream = await request(`/store/${storeA.slug}/account/orders/${rxOrder.id}/prescription`, { token: customerRx.token });
  // The prescription is stored re-encoded (EXIF stripping is proven in
  // image-variants.unit.mjs): the same picture, not the same bytes.
  const { default: sharp } = await import("sharp");
  const storedRx = ownerStream.bytes;
  assert.equal(ownerStream.status, 200);
  assert.deepEqual([(await sharp(storedRx).metadata()).width, (await sharp(storedRx).metadata()).height], [2, 2], "the owner streams the same picture");
  assert.equal((await sharp(storedRx).metadata()).exif, undefined, "…with no EXIF block");
  assert.ok(ownerStream.contentType.includes("image/png"));
  const merchantStream = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}/prescription`, { token: tokenA });
  assert.equal(merchantStream.status, 200); assert.ok(merchantStream.bytes.equals(storedRx), "orders.view streams the same stored bytes");
  const strangerStream = await request(`/store/${storeA.slug}/account/orders/${rxOrder.id}/prescription`, { token: customer8.token });
  assert.equal(strangerStream.status, 404, "another customer of the same store gets a plain 404");
  const strangerUpload = await request(`/store/${storeA.slug}/account/orders/${rxOrder.id}/prescription`, { method: "POST", token: customer8.token, form: pngForm() });
  assert.equal(strangerUpload.status, 404, "another customer cannot upload into a foreign order");
  const crossStoreMerchantStream = await request(`/merchant/stores/${storeB.slug}/orders/${rxOrder.id}/prescription`, { token: tokenB });
  assert.equal(crossStoreMerchantStream.status, 404, "another store's merchant sees a plain 404 for a foreign order");
  const wrongStoreActor = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}/prescription`, { token: tokenB });
  assert.equal(wrongStoreActor.status, 403, "merchant B on store A is a store-boundary denial");

  // review: invalid decision, reject → re-upload → approve → processing opens
  const badDecision = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}/prescription/review`, { method: "POST", token: tokenA, body: { decision: "maybe" } });
  assert.equal(badDecision.status, 422); assert.equal(badDecision.payload.error.code, "INVALID_PRESCRIPTION_DECISION");
  const rejectReview = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}/prescription/review`, { method: "POST", token: tokenA, body: { decision: "rejected" } });
  assert.equal(rejectReview.status, 200); assert.equal(rejectReview.payload.prescriptionStatus, "rejected");
  assert.equal((await prisma.orderPrescription.findUniqueOrThrow({ where: { id: storedRow.id } })).reviewStatus, "rejected");
  const gateRejected = await merchantStatus(tokenA, storeA.slug, rxOrder.id, "processing", 1);
  assert.equal(gateRejected.status, 422); assert.equal(gateRejected.payload.error.code, "PRESCRIPTION_NOT_APPROVED");
  const upload2 = await request(`/store/${storeA.slug}/account/orders/${rxOrder.id}/prescription`, { method: "POST", token: customerRx.token, form: pngForm() });
  assert.equal(upload2.status, 201, "a rejection re-opens the upload");
  assert.equal(upload2.payload.prescriptionStatus, "pending_review");
  const approveReview = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}/prescription/review`, { method: "POST", token: tokenA, body: { decision: "approved" } });
  assert.equal(approveReview.status, 200); assert.equal(approveReview.payload.prescriptionStatus, "approved");
  const reviewAgain = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}/prescription/review`, { method: "POST", token: tokenA, body: { decision: "approved" } });
  assert.equal(reviewAgain.status, 422); assert.equal(reviewAgain.payload.error.code, "PRESCRIPTION_NOT_REVIEWABLE");
  const uploadAfterApproval = await request(`/store/${storeA.slug}/account/orders/${rxOrder.id}/prescription`, { method: "POST", token: customerRx.token, form: pngForm() });
  assert.equal(uploadAfterApproval.status, 422); assert.equal(uploadAfterApproval.payload.error.code, "PRESCRIPTION_ALREADY_SUBMITTED");
  await completeOrder(tokenA, storeA.slug, rxOrder.id);
  const rxCompleted = await request(`/merchant/stores/${storeA.slug}/orders/${rxOrder.id}`, { token: tokenA });
  assert.equal(rxCompleted.payload.order.status, "completed", "the approved order completes through the untouched lifecycle");
  summary.prescriptionLifecycle = {
    stamped: rxOrder.prescriptionStatus, gate: [gatePendingUpload.status, gatePendingReview.status, gateRejected.status], fakeMagicBytes: fakeUpload.status,
    idor: { strangerStream: strangerStream.status, strangerUpload: strangerUpload.status, crossStoreMerchant: crossStoreMerchantStream.status, wrongStoreActor: wrongStoreActor.status },
    rejectedReupload: upload2.status, approvedThenCompleted: rxCompleted.payload.order.status,
  };

  // upload on a non-prescription order is refused
  const notRequiredUpload = await request(`/store/${storeA.slug}/account/orders/${plainCheckout.payload.order.id}/prescription`, { method: "POST", token: customer8.token, form: pngForm() });
  assert.equal(notRequiredUpload.status, 422); assert.equal(notRequiredUpload.payload.error.code, "PRESCRIPTION_NOT_REQUIRED");

  // cancel and reject from `new` stay open without any approval
  const customerRx2 = await registerCustomer(storeA.slug, "زبونة الإلغاء");
  const cartRx2 = await cartWith(storeA.slug, customerRx2.token, rxProduct.id, 1);
  const rxCancelOrder = (await doCheckout(storeA.slug, customerRx2, cartRx2, {})).payload.order;
  assert.equal(rxCancelOrder.prescriptionStatus, "pending_upload");
  const cancelFromNew = await merchantStatus(tokenA, storeA.slug, rxCancelOrder.id, "cancelled", 1);
  assert.equal(cancelFromNew.status, 200, "cancel from new must stay open with an unapproved prescription");
  const customerRx3 = await registerCustomer(storeA.slug, "زبونة الرفض");
  const cartRx3 = await cartWith(storeA.slug, customerRx3.token, rxProduct.id, 1);
  const rxRejectOrder = (await doCheckout(storeA.slug, customerRx3, cartRx3, {})).payload.order;
  const rejectFromNew = await merchantStatus(tokenA, storeA.slug, rxRejectOrder.id, "rejected", 1);
  assert.equal(rejectFromNew.status, 200, "reject from new must stay open with an unapproved prescription");
  summary.prescriptionEdges = { notRequiredUpload: notRequiredUpload.status, cancelFromNew: cancelFromNew.status, rejectFromNew: rejectFromNew.status };

  // ============================================================
  // 19-د (ATTACK-SURFACE) — the prescription upload used to leave bytes in the
  // bucket that NOTHING pointed at, that NO plan was charged for, and that NO
  // code path could ever delete.
  //
  // The S3 put runs before the transaction on purpose (§8.10: a bad file must
  // not reach the database). But the transaction can still fail — the guarded
  // updateMany answers 409 PRESCRIPTION_ALREADY_SUBMITTED — and when it did, the
  // row rolled back while the object stayed. Its key existed nowhere else once
  // the row was gone, so nobody could enumerate the waste, bill it, or erase it.
  //
  // The race below is how an attacker reaches that on purpose: N concurrent
  // uploads all read `pending_upload` off an unlocked snapshot, all store 5 MB,
  // one wins and the losers roll back. The sharp assertion is not the status
  // codes — it is that the BUCKET and the TABLE agree afterwards.
  // ============================================================
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const objectKeysUnder = async (prefix) => {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    return (listed.Contents ?? []).map((entry) => entry.Key).sort();
  };

  const customerRace = await registerCustomer(storeA.slug, "زبونة السباق");
  const cartRace = await cartWith(storeA.slug, customerRace.token, rxProduct.id, 1);
  const raceOrder = (await doCheckout(storeA.slug, customerRace, cartRace, {})).payload.order;
  assert.equal(raceOrder.prescriptionStatus, "pending_upload");
  const CONCURRENT_UPLOADS = 6;
  const raceResults = await Promise.all(Array.from({ length: CONCURRENT_UPLOADS }, () =>
    request(`/store/${storeA.slug}/account/orders/${raceOrder.id}/prescription`, { method: "POST", token: customerRace.token, form: pngForm() })));
  const rxRaceStatuses = raceResults.map((result) => result.status).sort();
  assert.equal(rxRaceStatuses.filter((status) => status === 201).length, 1, `exactly one concurrent upload may win — got ${rxRaceStatuses.join(",")}`);
  const racePrefix = `prescriptions/${storeA.id}/${raceOrder.id}/`;
  const raceObjects = await objectKeysUnder(racePrefix);
  const raceRows = await prisma.orderPrescription.findMany({ where: { orderId: raceOrder.id }, select: { objectKey: true } });
  assert.deepEqual(
    raceObjects,
    raceRows.map((row) => row.objectKey).sort(),
    `19-د: ${raceObjects.length} object(s) under ${racePrefix} against ${raceRows.length} row(s) — every losing upload orphaned 5 MB nobody can find, bill or erase`,
  );

  // The plan is charged. Before this, `merchantUsage` aggregated product images
  // ALONE, so a shopper could push megabytes into the merchant's bucket at the
  // platform's cost and no limit ever moved. The proof is differential — bump
  // one prescription row's recorded size and watch the merchant's storage usage
  // move by exactly that much — so it does not depend on what else this suite
  // has uploaded by now.
  const { merchantUsage } = await import("../src/services/entitlement.service.ts");
  const merchantAId = merchantA.payload.account.id;
  const usageBefore = (await merchantUsage(prisma, merchantAId)).max_image_storage_mb;
  const bumped = await prisma.orderPrescription.findFirstOrThrow({ where: { orderId: raceOrder.id }, select: { id: true, byteSize: true } });
  await prisma.orderPrescription.update({ where: { id: bumped.id }, data: { byteSize: bumped.byteSize + 3 * 1024 * 1024 } });
  const usageAfter = (await merchantUsage(prisma, merchantAId)).max_image_storage_mb;
  assert.equal(usageAfter - usageBefore, 3, `19-د: prescription bytes must count against max_image_storage_mb (${usageBefore} → ${usageAfter})`);
  await prisma.orderPrescription.update({ where: { id: bumped.id }, data: { byteSize: bumped.byteSize } });

  // …and the charge is a real refusal, not bookkeeping: pin the plan's storage
  // allowance to what is already used and the next upload is turned away.
  const customerCap = await registerCustomer(storeA.slug, "زبونة السقف");
  const cartCap = await cartWith(storeA.slug, customerCap.token, rxProduct.id, 1);
  const capOrder = (await doCheckout(storeA.slug, customerCap, cartCap, {})).payload.order;
  const freePlanRow = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  const storageFeature = await prisma.planFeature.findFirstOrThrow({ where: { planId: freePlanRow.id, featureCode: "max_image_storage_mb" }, select: { id: true, limitValue: true } });
  await prisma.planFeature.update({ where: { id: storageFeature.id }, data: { limitValue: (await merchantUsage(prisma, merchantAId)).max_image_storage_mb } });
  await applyPlanTermsNow(prisma, freePlanRow.id); // phase 30: publish + renew so the clamp applies
  const overCap = await request(`/store/${storeA.slug}/account/orders/${capOrder.id}/prescription`, { method: "POST", token: customerCap.token, form: pngForm() });
  await prisma.planFeature.update({ where: { id: storageFeature.id }, data: { limitValue: storageFeature.limitValue } });
  await applyPlanTermsNow(prisma, freePlanRow.id); // phase 30: publish + renew so the clamp applies
  assert.equal(overCap.status, 403, `19-د: an upload past the plan's storage allowance must be refused — ${JSON.stringify(overCap.payload)}`);
  assert.equal(overCap.payload.error.code, "PLAN_LIMIT_EXCEEDED");
  // Refused BEFORE the put, so the refusal itself stores nothing.
  assert.deepEqual(await objectKeysUnder(`prescriptions/${storeA.id}/${capOrder.id}/`), [], "a refused upload must leave no object behind");

  summary.prescriptionWaste = {
    concurrentUploads: CONCURRENT_UPLOADS,
    winners: rxRaceStatuses.filter((status) => status === 201).length,
    objectsInBucket: raceObjects.length,
    rowsInTable: raceRows.length,
    storageChargedMb: usageAfter - usageBefore,
    overPlanUpload: overCap.status,
  };

  // raw-SQL cross-store prescription insert refused by the composite FK
  let crossStorePrescriptionFk = null;
  try { await sql.query("INSERT INTO order_prescriptions (store_id, order_id, customer_id, object_key, content_type, byte_size) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'image/png', 1)", [storeB.id, rxOrder.id, customerRx.account.id, `smuggle/${testId}`]); } catch (error) { crossStorePrescriptionFk = error?.code ?? null; }
  assert.equal(crossStorePrescriptionFk, "23503", "a prescription row pointing at another store's order must be rejected");
  summary.prescriptionIsolation = { crossStoreFk: crossStorePrescriptionFk };

  // restore the shared plan so later suites see the seeded default
  await prisma.plan.update({ where: { code: "free" }, data: { commissionBps: seededFreeCommissionBps } });

  console.log(JSON.stringify(summary, null, 2));
} finally {
  killTree(moto);
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

/**
 * codiq PG-2 — soft delete + trash bin integration proof.
 *
 * Follows the phase20b1/phase7 harness (real HTTP app + a raw pg client + the
 * moto S3 emulator) and proves the five acceptance criteria of
 * docs/history/reports/PG2_SOFT_DELETE_PLAN.md §5 against a real PostgreSQL:
 *
 *  1. instant disappearance (T1–T4) — every merchant AND public surface, in the
 *     same request, with no job in between;
 *  2. no inventory audit trail is ever lost (T5–T8) — this is debt item D-48,
 *     and T7 is the one that fails without the trigger-landmine fix;
 *  3. restore with the complete state (T9–T12), including the selective-restore
 *     edge case that `deleted_event_id` exists to make impossible;
 *  4. the 30-day purge (T13–T17) — the foreign-key wall, the mandatory pass
 *     order, and the single end-of-pass retry;
 *  5. clear 409s instead of a bare 500 (T18–T22).
 *
 * Plus the six reviewer edge cases (E1–E6), the RUNTIME schema guard (the
 * constraints and partial indexes must exist and the old full constraints must
 * be gone), and the STATIC leak guard — so `pnpm pg2:test` is the single
 * blocking gate for the whole item.
 *
 * Owner decision «ب» (2026-08-28) is reflected in T18: a product that was SOLD
 * enters the trash bin like any other and is stopped at PURGE time by the
 * ledger's foreign keys, not at delete time by a 409.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import { killTree } from "./helpers/child-process.mjs";

const testId = `pg2-${Date.now()}`;
const bucket = `codiq-${testId}`;
const s3Port = 4581;
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");
process.env.SESSION_JWT_SECRET = "pg2-test-secret-only-not-for-production";
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

const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore", shell: process.platform === "win32" });
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  if (attempt === 39) throw new Error("Moto S3-compatible test server did not start.");
}
const s3 = new S3Client({ endpoint: process.env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

/**
 * ق-128: put ONE merchant on «free», because this suite tests that plan's caps.
 *
 * Scoped to a merchant on purpose. A blanket updateMany lowers the cap for every
 * merchant in the suite mid-run, which retroactively puts ones that already used
 * a higher plan's allowance over their limit — and the next unrelated assertion
 * fails with a 403 that has nothing to do with what it was testing.
 */
async function pinToFreePlan(merchantId) {
  const free = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  await prisma.merchantSubscription.updateMany({ where: { merchantId, status: "active" }, data: { planId: free.id, endsAt: null } });
}

const { classifyError } = await import("../src/http/errors.ts");
const { purgeExpiredSoftDeletes } = await import("../src/services/soft-delete/purge-job.ts");
const { softDelete, restore, listTrash } = await import("../src/services/soft-delete/soft-delete.service.ts");
const { TRASH_RETENTION_DAYS } = await import("../src/services/soft-delete/constants.ts");
const { lockCouponForCheckout, previewCoupon } = await import("../src/services/coupon.service.ts");
const { fkRuleFor, foreignKeyConstraintName, isForeignKeyViolation } = await import("../src/services/soft-delete/fk-violations.ts");
const { findDeletedLeaks, formatViolations, staleAllowlistKeys } = await import("./helpers/deleted-leak-guard.ts");
const { PERMISSION_CODES } = await import("../src/auth/staff-permissions.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY_MS);

async function request(path, { method = "GET", body, form, token, headers = {} } = {}) {
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  const payload = response.status === 204 ? null : isJson ? await response.json().catch(() => null) : null;
  const text = !isJson && response.status === 200 ? await response.text() : null;
  return { status: response.status, payload, text };
}

const summary = {};
let phoneSuffix = 0;
let checkoutKeySuffix = 0;

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, store_audit_events, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE");

  // ---------------------------------------------------------------- fixtures
  const merchantEmail = `${testId}.merchant@codiq.test`;
  const registered = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100590901", email: merchantEmail, password: "Pg2MerchantPass!", businessName: "متجر الحذف الناعم" });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const merchantId = registered.payload.account.id;
  const store = await prisma.store.create({ data: { merchantId, name: "متجر الحذف الناعم", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  await prisma.deliveryRate.create({ data: { storeId: store.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  await prisma.notificationSettings.create({ data: { storeId: store.id, isEnabled: true } });
  // This suite creates several staff memberships and dozens of products; the
  // free plan's own limits are phase16's subject, so the merchant is put on the
  // `pro` plan and entitlements stay out of the way.
  const proPlan = await prisma.plan.findUniqueOrThrow({ where: { code: "pro" }, select: { id: true } });
  await prisma.merchantSubscription.updateMany({ where: { merchantId }, data: { status: "cancelled" } });
  await prisma.merchantSubscription.create({ data: { merchantId, planId: proPlan.id, status: "active" } });
  const login = await request("/auth/merchant/login", { method: "POST", body: { identifier: merchantEmail, password: "Pg2MerchantPass!" } });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const token = login.payload.accessToken;
  const slug = store.slug;
  const merchantActor = { kind: "merchant", id: merchantId };
  const catalog = `/merchant/stores/${slug}/catalog`;

  async function createProduct(body) {
    const created = await request(`${catalog}/products`, { method: "POST", token, body });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    return created.payload.product;
  }
  async function deleteProduct(productId) {
    return request(`${catalog}/products/${productId}`, { method: "DELETE", token });
  }
  async function restoreVia(entityType, id, body = {}) {
    return request(`/merchant/stores/${slug}/trash/${entityType}/${id}/restore`, { method: "POST", token, body });
  }
  async function registerCustomer(fullName) {
    phoneSuffix += 1;
    const phone = `+96477055${String(phoneSuffix).padStart(5, "0")}`;
    const account = await request(`/store/${slug}/account/register`, { method: "POST", body: { phone, password: "Pg2CustomerPass!", fullName } });
    assert.equal(account.status, 201, JSON.stringify(account.payload));
    const address = await request(`/store/${slug}/account/addresses`, { method: "POST", token: account.payload.accessToken, body: { recipientName: fullName, fullAddress: "شارع السلة 2", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
    assert.equal(address.status, 201, JSON.stringify(address.payload));
    return { token: account.payload.accessToken, addressId: address.payload.address.id };
  }
  async function addToCart(customer, productId, quantity = 1) {
    const added = await request(`/store/${slug}/cart/items`, { method: "POST", token: customer.token, body: { productId, quantity } });
    assert.equal(added.status, 200, JSON.stringify(added.payload));
    return added.payload.cart;
  }
  async function checkout(customer, cart, extra = {}) {
    checkoutKeySuffix += 1;
    return request(`/store/${slug}/checkout`, {
      method: "POST", token: customer.token,
      headers: { "idempotency-key": `pg2-idempotency-key-${String(checkoutKeySuffix).padStart(4, "0")}` },
      body: { cartVersion: cart.version, addressId: customer.addressId, paymentMethodCode: "cod", ...extra },
    });
  }
  async function uploadImage(productId) {
    const form = new FormData();
    form.append("images", new Blob([png], { type: "image/png" }), "p.png");
    const uploaded = await request(`${catalog}/products/${productId}/images`, { method: "POST", token, form });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.payload));
    return uploaded.payload.images[0];
  }
  /**
   * A raw soft delete that bypasses the service guards entirely. Used ONLY to
   * prove that the structural invariant — not the service — is what protects the
   * raw-SQL checkout path (T2), and to fabricate a variant killed by a DIFFERENT
   * audit event (T11).
   */
  async function rawSoftDelete(table, id, label) {
    const event = await sql.query(
      `INSERT INTO store_audit_events (store_id, entity_type, entity_id, entity_label, action, actor_kind, actor_id, actor_label)
       VALUES ($1, $2, $3, $4, 'soft_deleted', 'merchant', $5, 'raw') RETURNING id`,
      [store.id, table === "products" ? "product" : "product_variant", id, label, merchantId],
    );
    await sql.query(`UPDATE ${table} SET deleted_at = now(), deleted_event_id = $2, deleted_was_active = is_active, is_active = false WHERE id = $1`, [id, event.rows[0].id]);
    return event.rows[0].id;
  }

  // =========================================================================
  // Criterion 1 — instant disappearance
  // =========================================================================
  const category1 = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "الصيف" } });
  assert.equal(category1.status, 201, JSON.stringify(category1.payload));
  const t1Product = await createProduct({ sku: "PG2-T1", name: "قميص قطني", priceIqd: 12000, stockQuantity: 5, categoryId: category1.payload.category.id });
  const t1Image = await uploadImage(t1Product.id);

  const beforeDelete = await request(`/store/${slug}/products`);
  assert.ok(beforeDelete.payload.products.some((product) => product.id === t1Product.id), "T1 precondition: the product is public before the delete");

  const t1Delete = await deleteProduct(t1Product.id);
  assert.equal(t1Delete.status, 200, `T1: the delete answers 200, not 204 — ${JSON.stringify(t1Delete.payload)}`);
  assert.equal(t1Delete.payload.id, t1Product.id);
  assert.ok(t1Delete.payload.deletedAt && t1Delete.payload.purgeAt, "T1: the body carries deletedAt and purgeAt for the «تراجع» button");
  assert.equal(Math.round((new Date(t1Delete.payload.purgeAt) - new Date(t1Delete.payload.deletedAt)) / DAY_MS), TRASH_RETENTION_DAYS, "T1: purgeAt is deletedAt + the retention window");

  const publicList = await request(`/store/${slug}/products`);
  assert.ok(!publicList.payload.products.some((product) => product.id === t1Product.id), "T1: gone from the public list");
  assert.equal((await request(`/store/${slug}/products/${t1Product.id}`)).status, 404, "T1: public detail is 404");
  assert.equal((await request(`/store/${slug}/products/${t1Product.id}/images/${t1Image.id}`)).status, 404, "T1: the public image is 404");
  assert.equal((await request(`${catalog}/products/${t1Product.id}/images/${t1Image.id}`, { token })).status, 404, "T1: the merchant image route is 404 too");
  const merchantList = await request(`${catalog}/products`, { token });
  assert.ok(!merchantList.payload.products.some((product) => product.id === t1Product.id), "T1: gone from the merchant catalogue");
  const search = await request(`/merchant/stores/${slug}/search?q=${encodeURIComponent("قميص")}`, { token });
  assert.ok(!(search.payload.products ?? []).some((product) => product.id === t1Product.id), "T1: gone from the unified search");
  const exported = await request(`${catalog}/export/products.csv`, { token });
  assert.ok(!exported.text.includes("PG2-T1"), "T1: gone from the CSV export");
  const picker = await request(`/merchant/stores/${slug}/products`, { token });
  assert.ok(!picker.payload.products.some((product) => product.id === t1Product.id), "T1: gone from the manual-order product picker");
  summary.T1 = "instant disappearance across 8 surfaces";

  // T2 — buying DURING a delete. The service refuses to trash a product that is
  // in a live cart (T19), so the delete here is done in RAW SQL: what is under
  // test is that the CHECK invariant, not the service, protects the raw-SQL
  // checkout lock.
  const t2Product = await createProduct({ sku: "PG2-T2", name: "منتج الشراء أثناء الحذف", priceIqd: 9000, stockQuantity: 4 });
  const buyer = await registerCustomer("زبون السباق");
  const t2Cart = await addToCart(buyer, t2Product.id);
  await rawSoftDelete("products", t2Product.id, "منتج الشراء أثناء الحذف");
  const t2Checkout = await checkout(buyer, t2Cart);
  assert.equal(t2Checkout.status, 422, `T2: the checkout is refused, never a 500 — ${JSON.stringify(t2Checkout.payload)}`);
  assert.equal(t2Checkout.payload.error.code, "PRODUCT_UNAVAILABLE");
  // Empty that cart again: T2's row was trashed behind the service's back, so it
  // still holds a live cart_items reference that would show up as an unrelated
  // `blocked` in the sharp T7 assertion below. T14/T18 test the block on purpose.
  await sql.query("DELETE FROM cart_items WHERE product_id = $1", [t2Product.id]);
  summary.T2 = "422 PRODUCT_UNAVAILABLE on a checkout racing a raw-SQL delete";

  // T3 — a deleted category disappears from both surfaces.
  const t3Category = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "الشتاء" } });
  const t3Delete = await request(`${catalog}/categories/${t3Category.payload.category.id}`, { method: "DELETE", token });
  assert.equal(t3Delete.status, 200, JSON.stringify(t3Delete.payload));
  assert.ok(t3Delete.payload.purgeAt, "T3: the category delete carries purgeAt too");
  const merchantCategories = await request(`${catalog}/categories`, { token });
  assert.ok(!merchantCategories.payload.categories.some((category) => category.id === t3Category.payload.category.id), "T3: gone from listCategories");
  const publicCategories = await request(`/store/${slug}/categories`);
  assert.ok(!publicCategories.payload.categories.some((category) => category.id === t3Category.payload.category.id), "T3: gone from publicCategories");
  summary.T3 = "category vanishes from both category surfaces";

  // T4 — adding a deleted product's variant to a cart is a 404, not a 500.
  const t4Product = await createProduct({ sku: "PG2-T4", name: "منتج السلة", priceIqd: 7000, stockQuantity: 3 });
  const t4Variant = t4Product.variants.find((variant) => variant.isDefault);
  assert.equal((await deleteProduct(t4Product.id)).status, 200);
  const t4Add = await request(`/store/${slug}/cart/items`, { method: "POST", token: buyer.token, body: { variantId: t4Variant.id, quantity: 1 } });
  assert.equal(t4Add.status, 404, `T4: 404 not 500 — ${JSON.stringify(t4Add.payload)}`);
  summary.T4 = "addCartItem on a trashed variant is 404";

  // =========================================================================
  // Criterion 2 — no inventory audit trail is ever lost (D-48)
  // =========================================================================
  const t5Product = await createProduct({ sku: "PG2-T5", name: "منتج السجل", priceIqd: 5000, stockQuantity: 10 });
  const t5Adjust = await request(`${catalog}/products/${t5Product.id}/inventory`, { method: "POST", token, body: { stockQuantity: 4, reason: "manual_adjustment" } });
  assert.equal(t5Adjust.status, 200, JSON.stringify(t5Adjust.payload));
  assert.equal((await deleteProduct(t5Product.id)).status, 200);
  const t5Movements = await sql.query("SELECT product_id, product_name, product_sku, delta, reason FROM inventory_movements WHERE product_name = $1 ORDER BY created_at", ["منتج السجل"]);
  assert.equal(t5Movements.rows.length, 2, "T5: both movements survive the soft delete");
  assert.ok(t5Movements.rows.every((row) => row.product_id === t5Product.id), "T5: product_id is still intact before the purge");
  summary.T5 = "both movements intact after the soft delete";

  // T6/T7 — the purge. On `main` this scenario loses the history entirely, and
  // without the codiq_guard_product_child_store fix the purge ABORTS with 23514.
  const t6 = await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.equal(await prisma.product.count({ where: { id: t5Product.id } }), 0, "T6: the product row is gone");
  const t6Movements = await sql.query("SELECT product_id, variant_id, product_name, product_sku FROM inventory_movements WHERE product_name = $1 ORDER BY created_at", ["منتج السجل"]);
  assert.equal(t6Movements.rows.length, 2, "T6: BOTH movements are still there after the hard delete");
  assert.ok(t6Movements.rows.every((row) => row.product_id === null), "T6: product_id was SET NULL, not cascaded away");
  assert.ok(t6Movements.rows.every((row) => row.product_name === "منتج السجل" && row.product_sku === "PG2-T5"), "T6: the snapshot columns read the ORIGINAL values");
  assert.ok(t6.purged >= 1, `T7: the purge reports what it did — ${JSON.stringify(t6)}`);
  assert.equal(t6.blocked, 0, `T7: nothing was blocked in this pass, and no CODIQ_PRODUCT_STORE_MISMATCH escaped — ${JSON.stringify(t6)}`);
  summary.T6_T7 = `purge kept the history: ${JSON.stringify(t6)}`;

  // T8 — a movement whose BOTH references are nulled.
  const t8Product = await createProduct({ sku: "PG2-T8", name: "منتج المرجعين", priceIqd: 4000, stockQuantity: 2 });
  const t8Variant = await request(`${catalog}/products/${t8Product.id}/variants`, { method: "POST", token, body: { sku: "PG2-T8-RED", name: "أحمر", priceIqd: 4200, stockQuantity: 6 } });
  assert.equal(t8Variant.status, 201, JSON.stringify(t8Variant.payload));
  assert.equal((await request(`${catalog}/products/${t8Product.id}/variants/${t8Variant.payload.variant.id}`, { method: "DELETE", token })).status, 204, "T8: deleteVariant stays a HARD delete (plan §6.3)");
  assert.equal((await deleteProduct(t8Product.id)).status, 200);
  await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  const t8Movements = await sql.query("SELECT product_id, variant_id, product_name, product_sku, variant_name FROM inventory_movements WHERE product_name = $1", ["منتج المرجعين"]);
  assert.ok(t8Movements.rows.length >= 2, "T8: the movements are all still there");
  const orphan = t8Movements.rows.find((row) => row.variant_name === "أحمر");
  assert.ok(orphan && orphan.product_id === null && orphan.variant_id === null, "T8: a movement with BOTH keys NULL exists and is readable");
  assert.equal(orphan.product_sku, "PG2-T8");
  const t8List = await sql.query("SELECT count(*)::int AS total FROM inventory_movements WHERE store_id = $1", [store.id]);
  assert.ok(t8List.rows[0].total > 0, "T8: the store movement list still reads without error");
  summary.T8 = "movement with two NULL references stays readable";

  // =========================================================================
  // Criterion 3 — restore with the complete state
  // =========================================================================
  const t9Category = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "الملابس" } });
  const t9Product = await createProduct({ sku: "PG2-T9", name: "منتج الاستعادة", priceIqd: 15000, stockQuantity: 7, categoryId: t9Category.payload.category.id, requiresPrescription: true });
  for (const variant of [{ sku: "PG2-T9-S", name: "صغير", priceIqd: 15000, stockQuantity: 3, isActive: true }, { sku: "PG2-T9-M", name: "وسط", priceIqd: 16000, stockQuantity: 2, isActive: false }]) {
    assert.equal((await request(`${catalog}/products/${t9Product.id}/variants`, { method: "POST", token, body: variant })).status, 201);
  }
  await uploadImage(t9Product.id);
  await uploadImage(t9Product.id);
  const t9Before = (await request(`${catalog}/products/${t9Product.id}`, { token })).payload.product;
  assert.equal((await deleteProduct(t9Product.id)).status, 200);
  const t9Restore = await restoreVia("product", t9Product.id);
  assert.equal(t9Restore.status, 200, JSON.stringify(t9Restore.payload));
  const t9After = (await request(`${catalog}/products/${t9Product.id}`, { token })).payload.product;
  assert.deepEqual(t9After, t9Before, "T9: the payload round-trips byte for byte, variant order included");
  summary.T9 = "full-state restore (category, 3 variants, 2 images, prescription, stock)";

  // T10 — a DRAFT comes back a draft. This is what deleted_was_active buys.
  const t10Product = await createProduct({ sku: "PG2-T10", name: "مسودة", priceIqd: 3000, stockQuantity: 1, isActive: false });
  assert.equal(t10Product.isActive, false);
  assert.equal((await deleteProduct(t10Product.id)).status, 200);
  assert.equal((await restoreVia("product", t10Product.id)).status, 200);
  const t10After = (await request(`${catalog}/products/${t10Product.id}`, { token })).payload.product;
  assert.equal(t10After.isActive, false, "T10: the draft did NOT come back published");
  summary.T10 = "a draft restores as a draft";

  // T11 — selective restore. `deleteVariant` is a HARD delete (plan §6.3), so
  // the literal «delete the variant on Monday» scenario cannot leave a row in
  // the bin at all; the mechanism actually under test is that a restore revives
  // ONLY what died in the SAME audit event, so the variant is trashed here under
  // its OWN event, exactly as a future per-variant soft delete would do.
  const t11Product = await createProduct({ sku: "PG2-T11", name: "منتج الحدث", priceIqd: 8000, stockQuantity: 5 });
  const t11Extra = await request(`${catalog}/products/${t11Product.id}/variants`, { method: "POST", token, body: { sku: "PG2-T11-RL", name: "أحمر — L", priceIqd: 8500, stockQuantity: 4 } });
  assert.equal(t11Extra.status, 201);
  await rawSoftDelete("product_variants", t11Extra.payload.variant.id, "أحمر — L");
  assert.equal((await deleteProduct(t11Product.id)).status, 200);
  assert.equal((await restoreVia("product", t11Product.id)).status, 200);
  const t11After = (await request(`${catalog}/products/${t11Product.id}`, { token })).payload.product;
  assert.ok(!t11After.variants.some((variant) => variant.sku === "PG2-T11-RL"), "T11: the variant killed by a DIFFERENT event was NOT resurrected");
  assert.ok(t11After.variants.some((variant) => variant.sku === "PG2-T11"), "T11: the variants killed by the SAME event came back");
  summary.T11 = "deleted_event_id blocks a silent resurrection";

  // T12 — membership restore: overrides return, sessions do not.
  const staffEmail = `${testId}.staff@codiq.test`;
  const teamUrl = `/merchant/stores/${slug}/team`;
  const created = await request(teamUrl, { method: "POST", token, body: { email: staffEmail, displayName: "سارة", temporaryPassword: "Pg2StaffPass!", roleCode: "store_manager" } });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const membershipId = created.payload.membership.id;
  // A second manager, so the «last team manager» guard does not fire on T12.
  const second = await request(teamUrl, { method: "POST", token, body: { email: `${testId}.staff2@codiq.test`, displayName: "علي", temporaryPassword: "Pg2StaffPass!", roleCode: "store_manager" } });
  assert.equal(second.status, 201, JSON.stringify(second.payload));
  assert.equal((await request(`${teamUrl}/${membershipId}/overrides`, { method: "PUT", token, body: { overrides: [{ permissionCode: "orders.update", effect: "deny" }] } })).status, 200);
  const staffLogin = await request(`/auth/staff/stores/${slug}/login`, { method: "POST", body: { email: staffEmail, password: "Pg2StaffPass!" } });
  assert.equal(staffLogin.status, 200, JSON.stringify(staffLogin.payload));
  const staffToken = staffLogin.payload.accessToken;
  assert.equal((await request(`/staff/stores/${slug}/session`, { token: staffToken })).status, 200, "T12 precondition: the staff session works before the removal");
  const removal = await request(`${teamUrl}/${membershipId}`, { method: "DELETE", token });
  assert.equal(removal.status, 200, JSON.stringify(removal.payload));
  assert.equal((await request(`/staff/stores/${slug}/session`, { token: staffToken })).status, 401, "T12: the removal kills open sessions immediately");
  assert.ok(!(await request(teamUrl, { token })).payload.team.some((member) => member.id === membershipId), "T12: gone from the roster");
  assert.equal((await request(`${teamUrl}/${membershipId}/restore`, { method: "POST", token })).status, 200);
  const restoredMember = (await request(teamUrl, { token })).payload.team.find((member) => member.id === membershipId);
  assert.ok(restoredMember, "T12: back on the roster");
  assert.deepEqual(restoredMember.overrides, [{ permissionCode: "orders.update", effect: "deny" }], "T12: the permission overrides came back");
  assert.equal((await request(`/staff/stores/${slug}/session`, { token: staffToken })).status, 401, "T12: the OLD session stays dead — the person signs in again");
  summary.T12 = "membership restore returns overrides, never sessions";

  // =========================================================================
  // Criterion 4 — the 30-day purge
  // =========================================================================
  const t13Product = await createProduct({ sku: "PG2-T13", name: "منتج التنقية", priceIqd: 2000, stockQuantity: 1 });
  assert.equal((await deleteProduct(t13Product.id)).status, 200);
  const early = await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS - 1) });
  assert.equal(early.purged, 0, `T13: nothing is purged before the window closes — ${JSON.stringify(early)}`);
  assert.equal(await prisma.product.count({ where: { id: t13Product.id } }), 1);
  const late = await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.ok(late.purged >= 1, `T13: purged after the window — ${JSON.stringify(late)}`);
  assert.equal(await prisma.product.count({ where: { id: t13Product.id } }), 0);
  const again = await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.deepEqual({ purged: again.purged, blocked: again.blocked }, { purged: 0, blocked: 0 }, "T13: a second sweep is a no-op (idempotent)");
  summary.T13 = "29d → 0, 31d → purged, second sweep is a no-op";

  // T14 — the ledger wall. Also T18 under owner decision «ب»: the product was
  // SOLD, entered the bin anyway, and is stopped HERE, not at delete time.
  const soldProduct = await createProduct({ sku: "PG2-SOLD", name: "منتج مباع", priceIqd: 6000, stockQuantity: 9 });
  const soldBuyer = await registerCustomer("زبون البيع");
  const soldCart = await addToCart(soldBuyer, soldProduct.id, 2);
  const soldOrder = await checkout(soldBuyer, soldCart);
  assert.equal(soldOrder.status, 201, JSON.stringify(soldOrder.payload));
  // Release the reservation so only the ORDER (not the live reservation) is what
  // the delete has to survive.
  assert.equal((await request(`/merchant/stores/${slug}/orders/${soldOrder.payload.order.id}/status`, { method: "POST", token, body: { toStatus: "cancelled", expectedVersion: 1 } })).status, 200);
  const soldDelete = await deleteProduct(soldProduct.id);
  assert.equal(soldDelete.status, 200, `T18 (owner decision ب): a SOLD product enters the trash bin — ${JSON.stringify(soldDelete.payload)}`);
  const trashAfterSold = await request(`/merchant/stores/${slug}/trash?entityType=product`, { token });
  assert.ok(trashAfterSold.payload.items.some((item) => item.id === soldProduct.id), "T18: it is visible in the bin");
  const blockedSweep = await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.equal(await prisma.product.count({ where: { id: soldProduct.id } }), 1, "T14: the sold product was NOT hard-deleted");
  assert.ok(blockedSweep.blocked >= 1, `T14: the block is a reported outcome, not an exception — ${JSON.stringify(blockedSweep)}`);
  const blockedRow = await prisma.product.findUniqueOrThrow({ where: { id: soldProduct.id }, select: { purgeBlockedAt: true, purgeBlockReason: true } });
  assert.ok(blockedRow.purgeBlockedAt, "T14: purge_blocked_at is stamped");
  assert.ok(blockedRow.purgeBlockReason && blockedRow.purgeBlockReason.length > 4, `T14: the reason is human-readable — ${blockedRow.purgeBlockReason}`);
  assert.ok((await sql.query("SELECT count(*)::int AS total FROM order_items WHERE product_id = $1", [soldProduct.id])).rows[0].total > 0, "T14: order_items is intact");
  const trashBadge = (await request(`/merchant/stores/${slug}/trash?entityType=product`, { token })).payload.items.find((item) => item.id === soldProduct.id);
  assert.ok(trashBadge.purgeBlockedAt && trashBadge.purgeBlockReason, "T18: the bin shows «محفوظ لسجلاتك» with a reason and no countdown");
  summary.T14_T18 = `sold product: enters the bin, blocked at purge — ${blockedRow.purgeBlockReason}`;

  // T15 — a redeemed coupon is blocked; an untouched one is purged.
  const couponsUrl = `/merchant/stores/${slug}/marketing/coupons`;
  const usedCoupon = await request(couponsUrl, { method: "POST", token, body: { code: "PG2USED", kind: "percent", percentOff: 10 } });
  assert.equal(usedCoupon.status, 201, JSON.stringify(usedCoupon.payload));
  const cleanCoupon = await request(couponsUrl, { method: "POST", token, body: { code: "PG2CLEAN", kind: "percent", percentOff: 5 } });
  assert.equal(cleanCoupon.status, 201);
  const couponProduct = await createProduct({ sku: "PG2-COUPON", name: "منتج الكوبون", priceIqd: 20000, stockQuantity: 9 });
  const couponBuyer = await registerCustomer("زبون الكوبون");
  const couponCart = await addToCart(couponBuyer, couponProduct.id);
  const couponOrder = await checkout(couponBuyer, couponCart, { couponCode: "PG2USED" });
  assert.equal(couponOrder.status, 201, JSON.stringify(couponOrder.payload));
  assert.equal((await request(`${couponsUrl}/${usedCoupon.payload.coupon.id}`, { method: "DELETE", token })).status, 200);
  assert.equal((await request(`${couponsUrl}/${cleanCoupon.payload.coupon.id}`, { method: "DELETE", token })).status, 200);
  await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.equal(await prisma.coupon.count({ where: { id: usedCoupon.payload.coupon.id } }), 1, "T15: the redeemed coupon survives");
  assert.equal(await prisma.coupon.count({ where: { id: cleanCoupon.payload.coupon.id } }), 0, "T15: the untouched coupon is really purged");
  summary.T15 = "redeemed coupon blocked, clean coupon purged";

  // T16 — a membership with revoked sessions: sessions first, then the row; the
  // Staff identity itself is never touched.
  const t16Email = `${testId}.staff3@codiq.test`;
  const t16 = await request(teamUrl, { method: "POST", token, body: { email: t16Email, displayName: "نور", temporaryPassword: "Pg2StaffPass!", roleCode: "store_staff" } });
  assert.equal(t16.status, 201, JSON.stringify(t16.payload));
  const t16Membership = t16.payload.membership.id;
  const t16Login = await request(`/auth/staff/stores/${slug}/login`, { method: "POST", body: { email: t16Email, password: "Pg2StaffPass!" } });
  assert.equal(t16Login.status, 200, JSON.stringify(t16Login.payload));
  assert.ok((await sql.query("SELECT count(*)::int AS total FROM staff_sessions WHERE membership_id = $1", [t16Membership])).rows[0].total > 0);
  assert.equal((await request(`${teamUrl}/${t16Membership}`, { method: "DELETE", token })).status, 200);
  await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.equal(await prisma.storeStaffMembership.count({ where: { id: t16Membership } }), 0, "T16: the membership row is gone");
  assert.equal((await sql.query("SELECT count(*)::int AS total FROM staff_sessions WHERE membership_id = $1", [t16Membership])).rows[0].total, 0, "T16: its revoked sessions went first");
  assert.equal(await prisma.staff.count({ where: { email: t16Email } }), 1, "T16: the Staff identity is NEVER deleted — it crosses stores");
  summary.T16 = "membership purged with its sessions; the Staff row survives";

  // T17 — the pass order plus the single end-of-pass retry.
  const t17Category = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "تصنيف المرور" } });
  const t17CategoryId = t17Category.payload.category.id;
  const t17Product = await createProduct({ sku: "PG2-T17", name: "منتج المرور", priceIqd: 3000, stockQuantity: 1, categoryId: t17CategoryId });
  assert.equal((await deleteProduct(t17Product.id)).status, 200);
  assert.equal((await request(`${catalog}/categories/${t17CategoryId}`, { method: "DELETE", token })).status, 200, "T17: the category is deletable because it has zero LIVE products");
  const onePass = await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.equal(await prisma.product.count({ where: { id: t17Product.id } }), 0, "T17: the product went");
  assert.equal(await prisma.productCategory.count({ where: { id: t17CategoryId } }), 0, "T17: and its category went in the SAME pass, thanks to the retry");
  // Scoped to categories: the sold product and the redeemed coupon planted by
  // T14/T15 are SUPPOSED to be blocked in every later pass, so a global
  // `blocked === 0` here would assert the opposite of what T14 proved.
  assert.equal(onePass.byEntity.product_category?.blocked ?? 0, 0, `T17: no category was stamped purge_blocked — ${JSON.stringify(onePass)}`);
  // The inverse: a category whose only product is blocked is blocked too, with a reason.
  const t17bCategory = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "تصنيف محجوب" } });
  const t17bCategoryId = t17bCategory.payload.category.id;
  await prisma.product.update({ where: { id: soldProduct.id }, data: { categoryId: t17bCategoryId } });
  assert.equal((await request(`${catalog}/categories/${t17bCategoryId}`, { method: "DELETE", token })).status, 200);
  await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  const blockedCategory = await prisma.productCategory.findUniqueOrThrow({ where: { id: t17bCategoryId }, select: { purgeBlockedAt: true, purgeBlockReason: true } });
  assert.ok(blockedCategory.purgeBlockedAt && blockedCategory.purgeBlockReason, `T17: the category is blocked with a readable reason — ${blockedCategory.purgeBlockReason}`);
  summary.T17 = "one pass clears product+category; a blocked product blocks its category with a reason";

  // =========================================================================
  // Criterion 5 — clear 409s, never a bare 500
  // =========================================================================
  // T19 — the live cart. This is the case that returns 500 INTERNAL_ERROR on main.
  const t19Product = await createProduct({ sku: "PG2-T19", name: "منتج في سلة حيّة", priceIqd: 5000, stockQuantity: 5 });
  const t19Buyer = await registerCustomer("زبون السلة الحيّة");
  await addToCart(t19Buyer, t19Product.id);
  const t19Delete = await deleteProduct(t19Product.id);
  assert.equal(t19Delete.status, 409, `T19: 409, not the 500 main returns — ${JSON.stringify(t19Delete.payload)}`);
  assert.equal(t19Delete.payload.error.code, "PRODUCT_IN_ACTIVE_CART");
  assert.equal(t19Delete.payload.error.hint, "deactivate", "T19: the body offers «أخفِه بدلاً من ذلك»");
  summary.T19 = "409 PRODUCT_IN_ACTIVE_CART (500 on main)";

  // T20 — an active reservation.
  const t20Product = await createProduct({ sku: "PG2-T20", name: "منتج محجوز", priceIqd: 5000, stockQuantity: 5 });
  const t20Buyer = await registerCustomer("زبون الحجز");
  const t20Cart = await addToCart(t20Buyer, t20Product.id);
  assert.equal((await checkout(t20Buyer, t20Cart)).status, 201);
  const t20Delete = await deleteProduct(t20Product.id);
  assert.equal(t20Delete.status, 409, `T20: ${JSON.stringify(t20Delete.payload)}`);
  assert.equal(t20Delete.payload.error.code, "PRODUCT_HAS_ACTIVE_RESERVATION");
  summary.T20 = "409 PRODUCT_HAS_ACTIVE_RESERVATION";

  // T21 — a RAW hard delete on a product referenced by an order must reach the
  // error handler as a 409, not a 500. The raw path never becomes a Prisma
  // P2003, which is exactly why the handler has a 23503 text branch.
  let rawError = null;
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM products WHERE id = '${soldProduct.id}'`);
  } catch (error) { rawError = error; }
  assert.ok(rawError, "T21: the raw delete is refused by Postgres");
  assert.ok(isForeignKeyViolation(rawError), "T21: recognised as a foreign-key violation");
  const rawRule = fkRuleFor(foreignKeyConstraintName(rawError));
  assert.ok(rawRule, `T21: the constraint maps to a rule — ${foreignKeyConstraintName(rawError)}`);
  assert.equal(rawRule.code, "PRODUCT_REFERENCED_BY_ORDER");
  const handled = { status: null, body: null };
  // D-41: the pure classifier is what this asserts — status and body, with no
  // response object. The old hand-rolled stub lacked `getHeader` and only ever
  // worked because the handler did not yet stamp a correlation header.
  {
    const outcome = classifyError(rawError, { path: "/merchant/stores/x/catalog/products/y" });
    handled.status = outcome.status;
    handled.body = { error: outcome.error };
  }
  assert.equal(handled.status, 409, `T21: the error handler answers 409, not 500 — ${JSON.stringify(handled.body)}`);
  assert.equal(handled.body.error.code, "PRODUCT_REFERENCED_BY_ORDER");
  summary.T21 = "raw 23503 becomes a 409 in the error handler";

  // T22 — restoring onto a taken SKU: 409 that NAMES the holder, then the same
  // endpoint accepts an override in one more call. No silent rename, ever.
  const t22Product = await createProduct({ sku: "SKU-100", name: "المنتج الأول", priceIqd: 4000, stockQuantity: 2 });
  assert.equal((await deleteProduct(t22Product.id)).status, 200);
  const t22Live = await createProduct({ sku: "SKU-100", name: "قميص قطني أزرق", priceIqd: 4500, stockQuantity: 2 });
  const t22Conflict = await restoreVia("product", t22Product.id);
  assert.equal(t22Conflict.status, 409, JSON.stringify(t22Conflict.payload));
  assert.equal(t22Conflict.payload.error.code, "SKU_TAKEN_BY_ACTIVE_PRODUCT");
  const conflict = t22Conflict.payload.error.conflicts.find((entry) => entry.scope === "product");
  assert.equal(conflict.sku, "SKU-100");
  assert.equal(conflict.liveId, t22Live.id);
  assert.equal(conflict.liveName, "قميص قطني أزرق", "T22: the payload NAMES the live holder");
  const t22Ok = await restoreVia("product", t22Product.id, { sku: "SKU-100-1", variantSkus: { [t22Product.variants.find((variant) => variant.isDefault).id]: "SKU-100-1" } });
  assert.equal(t22Ok.status, 200, JSON.stringify(t22Ok.payload));
  assert.equal((await request(`${catalog}/products/${t22Product.id}`, { token })).payload.product.sku, "SKU-100-1");
  summary.T22 = "409 names the holder; the override in the same endpoint succeeds";

  // =========================================================================
  // Reviewer edge cases
  // =========================================================================
  // E1 — THE coupon lock. A live SUMMER beside a trashed SUMMER: without
  // `AND deleted_at IS NULL` the FOR UPDATE returns several rows and rows[0]
  // picks at random, refusing a valid coupon with 422 on the payment path.
  // Run ten times, because the bug is intermittent by nature.
  const summerFirst = await request(couponsUrl, { method: "POST", token, body: { code: "SUMMER", kind: "percent", percentOff: 20 } });
  assert.equal(summerFirst.status, 201, JSON.stringify(summerFirst.payload));
  assert.equal((await request(`${couponsUrl}/${summerFirst.payload.coupon.id}`, { method: "DELETE", token })).status, 200);
  const summerSecond = await request(couponsUrl, { method: "POST", token, body: { code: "SUMMER", kind: "percent", percentOff: 20 } });
  assert.equal(summerSecond.status, 201, "E1: the code is free again the moment the first one is trashed");
  const liveSummerId = summerSecond.payload.coupon.id;
  const e1Buyer = await registerCustomer("زبون الكوبون المزدوج");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const preview = await previewCoupon(store.id, undefined, "SUMMER", 50_000);
    assert.equal(preview.discountIqd, 10_000, `E1 attempt ${attempt}: previewCoupon found the LIVE coupon`);
    const locked = await prisma.$transaction((tx) => lockCouponForCheckout(tx, store.id, e1Buyer.token ? undefined : undefined, "SUMMER"));
    assert.equal(locked.id, liveSummerId, `E1 attempt ${attempt}: the checkout lock found the LIVE row, not a trashed one`);
  }
  const e1Product = await createProduct({ sku: "PG2-E1", name: "منتج الكوبون المزدوج", priceIqd: 50000, stockQuantity: 3 });
  const e1Cart = await addToCart(e1Buyer, e1Product.id);
  const e1Checkout = await checkout(e1Buyer, e1Cart, { couponCode: "SUMMER" });
  assert.equal(e1Checkout.status, 201, `E1: the purchase succeeds with the live coupon — ${JSON.stringify(e1Checkout.payload)}`);
  assert.equal(e1Checkout.payload.order.discountIqd, 10_000);
  summary.E1 = "10/10 coupon locks resolved to the live row; checkout succeeded";

  // E2 — the CSV importer must not refuse a SKU held by a trashed product.
  const e2Old = await createProduct({ sku: "ABC", name: "منتج قديم", priceIqd: 1000, stockQuantity: 1 });
  assert.equal((await deleteProduct(e2Old.id)).status, 200);
  const csv = "﻿product_sku,product_name,description,category_path,requires_prescription,variant_sku,variant_name,price_iqd,stock_quantity,low_stock_threshold,is_active,options_json\nABC,منتج جديد,,,false,ABC,افتراضي,1500,4,0,true,\n";
  const csvForm = new FormData();
  csvForm.append("file", new Blob([csv], { type: "text/csv" }), "products.csv");
  const imported = await request(`${catalog}/import/products`, { method: "POST", token, form: csvForm });
  assert.equal(imported.status, 201, `E2: the import succeeds — ${JSON.stringify(imported.payload)}`);
  const abcRows = await prisma.product.findMany({ where: { storeId: store.id, sku: "ABC" }, select: { id: true, deletedAt: true } });
  assert.equal(abcRows.length, 2, "E2: two rows share the SKU — one live, one trashed");
  assert.equal(abcRows.filter((row) => row.deletedAt === null).length, 1, "E2: exactly one is live, so the partial unique index is intact");
  await purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  assert.equal(await prisma.product.count({ where: { id: e2Old.id } }), 0, "E2: only the old row was purged");
  assert.equal(await prisma.product.count({ where: { storeId: store.id, sku: "ABC", deletedAt: null } }), 1, "E2: the new row is untouched");
  summary.E2 = "CSV import reuses a SKU freed by the trash bin";

  // E3 — two trashed rows may legitimately share a SKU; the bin distinguishes
  // them by deletedAt, and the SECOND restore is refused naming the first.
  const e3First = await createProduct({ sku: "DUP", name: "مكرر أول", priceIqd: 1000, stockQuantity: 1 });
  assert.equal((await deleteProduct(e3First.id)).status, 200);
  const e3Second = await createProduct({ sku: "DUP", name: "مكرر ثان", priceIqd: 1100, stockQuantity: 1 });
  assert.equal((await deleteProduct(e3Second.id)).status, 200);
  const e3Bin = (await request(`/merchant/stores/${slug}/trash?entityType=product`, { token })).payload.items.filter((item) => item.secondary === "DUP");
  assert.equal(e3Bin.length, 2, "E3: both trashed rows are listed");
  assert.notEqual(e3Bin[0].deletedAt, e3Bin[1].deletedAt, "E3: deletedAt is the discriminator the UI needs");
  assert.equal((await restoreVia("product", e3First.id)).status, 200, "E3: the first restore succeeds");
  const e3Conflict = await restoreVia("product", e3Second.id);
  assert.equal(e3Conflict.status, 409);
  assert.equal(e3Conflict.payload.error.code, "SKU_TAKEN_BY_ACTIVE_PRODUCT");
  assert.equal(e3Conflict.payload.error.conflicts[0].liveId, e3First.id, "E3: the 409 names the row just restored");
  summary.E3 = "two trashed rows share a SKU; the second restore is a naming 409";

  // E4 — the default-variant trigger against the partial index: creating a
  // product with a SKU freed by a trashed one inserts a default variant with the
  // same SKU, which only works because the trashed product's variants were
  // trashed WITH it.
  const e4Old = await createProduct({ sku: "REUSE-1", name: "قديم", priceIqd: 1000, stockQuantity: 1 });
  assert.equal((await deleteProduct(e4Old.id)).status, 200);
  const e4New = await createProduct({ sku: "REUSE-1", name: "جديد", priceIqd: 1200, stockQuantity: 1 });
  assert.equal(e4New.variants.find((variant) => variant.isDefault).sku, "REUSE-1");
  assert.equal(await prisma.productVariant.count({ where: { storeId: store.id, sku: "REUSE-1", deletedAt: null } }), 1, "E4: exactly one LIVE variant holds the SKU");
  summary.E4 = "default-variant trigger works on a SKU freed by the bin";

  // E5 — the invariant itself. This is what closes the storefront structurally.
  let invariantError = null;
  try {
    await prisma.$executeRawUnsafe("UPDATE products SET is_active = true WHERE deleted_at IS NOT NULL");
  } catch (error) { invariantError = error; }
  assert.ok(invariantError, "E5: reactivating a trashed product is refused by the DATABASE");
  assert.ok(String(invariantError.message).includes("products_deleted_implies_inactive") || String(invariantError.message).includes("23514"), `E5: refused by the CHECK constraint — ${invariantError.message}`);
  summary.E5 = "UPDATE … SET is_active = true on a trashed row is refused (23514)";

  // E6 — restoring a product revives its trashed category; a name taken by a
  // live category is a 409 that the same endpoint resolves.
  const e6Category = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "تصنيف الاستعادة" } });
  const e6CategoryId = e6Category.payload.category.id;
  const e6Product = await createProduct({ sku: "PG2-E6", name: "منتج التصنيف", priceIqd: 3000, stockQuantity: 1, categoryId: e6CategoryId });
  assert.equal((await deleteProduct(e6Product.id)).status, 200);
  assert.equal((await request(`${catalog}/categories/${e6CategoryId}`, { method: "DELETE", token })).status, 200);
  assert.equal((await restoreVia("product", e6Product.id)).status, 200);
  const e6After = (await request(`${catalog}/products/${e6Product.id}`, { token })).payload.product;
  assert.equal(e6After.category.id, e6CategoryId, "E6: the category was revived in the SAME transaction");

  const e6bCategory = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "تصنيف مختطف" } });
  const e6bCategoryId = e6bCategory.payload.category.id;
  const e6bProduct = await createProduct({ sku: "PG2-E6B", name: "منتج التصنيف المختطف", priceIqd: 3000, stockQuantity: 1, categoryId: e6bCategoryId });
  assert.equal((await deleteProduct(e6bProduct.id)).status, 200);
  assert.equal((await request(`${catalog}/categories/${e6bCategoryId}`, { method: "DELETE", token })).status, 200);
  const e6bLive = await request(`${catalog}/categories`, { method: "POST", token, body: { name: "تصنيف مختطف" } });
  assert.equal(e6bLive.status, 201, "E6: the name is free again once the category is in the bin");
  const e6bConflict = await restoreVia("product", e6bProduct.id);
  assert.equal(e6bConflict.status, 409, JSON.stringify(e6bConflict.payload));
  assert.equal(e6bConflict.payload.error.code, "CATEGORY_NAME_TAKEN");
  assert.equal((await restoreVia("product", e6bProduct.id, { categoryId: null })).status, 200);
  assert.equal((await request(`${catalog}/products/${e6bProduct.id}`, { token })).payload.product.category, null, "E6: it comes back with no category, as asked");
  summary.E6 = "category revived with its product; a hijacked name is a resolvable 409";

  // =========================================================================
  // The audit log and the bin surface
  // =========================================================================
  const auditEvents = await request(`/merchant/stores/${slug}/audit-events?limit=100`, { token });
  assert.equal(auditEvents.status, 200, JSON.stringify(auditEvents.payload));
  assert.ok(auditEvents.payload.events.length > 0);
  const soldEvent = auditEvents.payload.events.find((event) => event.entityId === soldProduct.id && event.action === "soft_deleted");
  assert.ok(soldEvent, "audit: the soft delete was recorded");
  assert.equal(soldEvent.entityLabel, "منتج مباع");
  assert.equal(soldEvent.entitySecondary, "PG2-SOLD");
  assert.equal(soldEvent.actorKind, "merchant");
  assert.ok(soldEvent.actorLabel.length > 0, "audit: the actor label is a text snapshot, not an id");
  assert.ok(auditEvents.payload.events.some((event) => event.action === "purged" && event.actorKind === "system"), "audit: the purge writes as `system`");
  assert.ok(auditEvents.payload.events.some((event) => event.action === "purge_blocked"), "audit: a block is recorded once");
  let auditMutation = null;
  try { await prisma.$executeRawUnsafe(`UPDATE store_audit_events SET action = 'restored' WHERE id = '${soldEvent.id}'`); } catch (error) { auditMutation = error; }
  assert.ok(auditMutation, "audit: the log is append-only — an UPDATE is refused");
  const trashAll = await request(`/merchant/stores/${slug}/trash`, { token });
  assert.equal(trashAll.status, 200);
  assert.equal(trashAll.payload.retentionDays, TRASH_RETENTION_DAYS);
  assert.ok(trashAll.payload.items.every((item) => item.purgeAt && item.deletedAt), "trash: every row carries deletedAt and purgeAt");
  assert.ok(trashAll.payload.items.some((item) => item.deletedBy), "trash: «من حذفه» comes from the audit event");
  summary.audit = `${auditEvents.payload.events.length} events; append-only enforced; bin lists ${trashAll.payload.items.length} rows`;

  // =========================================================================
  // The pre-delete preview, and the bin's forward-looking «محفوظ لسجلاتك».
  //
  // Both exist for ق-10. The confirmation sheet is required to state the REAL
  // movement count before the merchant acts, and the bin must not promise a
  // purge for thirty days on a row the foreign-key wall is already holding —
  // the sheet and the bin would otherwise contradict each other on the flagship
  // case of owner decision ق-97 (sold, then retired).
  // =========================================================================
  const previewProduct = await createProduct({ sku: "PG2-PREVIEW", name: "منتج المعاينة", priceIqd: 5000, stockQuantity: 6 });
  await request(`${catalog}/products/${previewProduct.id}/inventory`, { method: "POST", token, body: { stockQuantity: 2, reason: "manual_adjustment" } });
  const realMovements = await prisma.inventoryMovement.count({ where: { productId: previewProduct.id } });
  const preview = await request(`/merchant/stores/${slug}/trash/preview/product/${previewProduct.id}`, { token });
  assert.equal(preview.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.preview.effects.inventoryMovements, realMovements, "preview: the movement count is the database's, not an estimate");
  assert.equal(preview.payload.preview.retentionDays, TRASH_RETENTION_DAYS, "preview: the retention window comes from the same constant the purge obeys");
  assert.equal(preview.payload.preview.effects.orders, 0, "preview: an unsold product reports zero ORDERS");
  // `orders` counts orders, not order_items: one order with two variants of the
  // same product is ONE sale, and calling it two would be a fabricated figure.
  const twoLineBuyer = await registerCustomer("زبون سطرين");
  const twoLineProduct = await createProduct({ sku: "PG2-TWOLINE", name: "قميص بمقاسين", priceIqd: 7000, stockQuantity: 0 });
  const sizeM = await request(`${catalog}/products/${twoLineProduct.id}/variants`, { method: "POST", token, body: { sku: "PG2-TWOLINE-M", name: "M", priceIqd: 7000, stockQuantity: 5 } });
  assert.equal(sizeM.status, 201, JSON.stringify(sizeM.payload));
  const sizeL = await request(`${catalog}/products/${twoLineProduct.id}/variants`, { method: "POST", token, body: { sku: "PG2-TWOLINE-L", name: "L", priceIqd: 7000, stockQuantity: 5 } });
  assert.equal(sizeL.status, 201, JSON.stringify(sizeL.payload));
  await request(`/store/${slug}/cart/items`, { method: "POST", token: twoLineBuyer.token, body: { variantId: sizeM.payload.variant.id, quantity: 1 } });
  const twoLineCart = await request(`/store/${slug}/cart/items`, { method: "POST", token: twoLineBuyer.token, body: { variantId: sizeL.payload.variant.id, quantity: 1 } });
  const twoLineOrder = await checkout(twoLineBuyer, twoLineCart.payload.cart);
  assert.equal(twoLineOrder.status, 201, JSON.stringify(twoLineOrder.payload));
  const twoLinePreview = await request(`/merchant/stores/${slug}/trash/preview/product/${twoLineProduct.id}`, { token });
  assert.equal(twoLinePreview.payload.preview.effects.orders, 1, "preview: two order LINES in one order are one ORDER");
  assert.ok((await prisma.orderItem.count({ where: { productId: twoLineProduct.id } })) === 2, "preview: …and the underlying order_items really are two");
  summary.preview = `movement count served from the database (${realMovements}); two order lines in one order report 1 order`;

  // The bin says «محفوظ لسجلاتك» on day one, not on day 31.
  await request(`/merchant/stores/${slug}/orders/${twoLineOrder.payload.order.id}/status`, { method: "POST", token, body: { toStatus: "cancelled", expectedVersion: 1 } });
  assert.equal((await deleteProduct(twoLineProduct.id)).status, 200);
  const freshBin = await request(`/merchant/stores/${slug}/trash?entityType=product`, { token });
  const freshRow = freshBin.payload.items.find((item) => item.id === twoLineProduct.id);
  assert.ok(freshRow, "bin: the just-deleted sold product is listed");
  assert.equal(freshRow.purgeBlockedAt, null, "bin: the sweep has NOT run on it yet");
  assert.equal(freshRow.keptForRecords, true, "bin: …and it is still marked kept, because order_items already holds it");
  assert.ok(freshRow.keptReason && freshRow.keptReason.length > 4, `bin: with a readable reason — ${freshRow.keptReason}`);
  // The inverse, so the flag is proven to discriminate rather than to be always true.
  const unsold = await createProduct({ sku: "PG2-UNSOLD", name: "منتج بلا مبيعات", priceIqd: 3000, stockQuantity: 1 });
  assert.equal((await deleteProduct(unsold.id)).status, 200);
  const binWithUnsold = await request(`/merchant/stores/${slug}/trash?entityType=product`, { token });
  const unsoldRow = binWithUnsold.payload.items.find((item) => item.id === unsold.id);
  assert.ok(unsoldRow, "bin: the unsold trashed product is listed");
  assert.equal(unsoldRow.keptForRecords, false, "bin: an unsold trashed product is NOT marked kept — it really will be purged");
  summary.keptForRecords = `predicted on day one — ${freshRow.keptReason}`;

  // The «last team manager» guard.
  const remaining = (await request(teamUrl, { token })).payload.team.filter((member) => member.roleCode === "store_manager" && member.isActive);
  for (const member of remaining.slice(0, -1)) {
    assert.equal((await request(`${teamUrl}/${member.id}`, { method: "DELETE", token })).status, 200);
  }
  const lastManager = remaining[remaining.length - 1];
  const lastRemoval = await request(`${teamUrl}/${lastManager.id}`, { method: "DELETE", token });
  assert.equal(lastRemoval.status, 409, `last-manager guard: ${JSON.stringify(lastRemoval.payload)}`);
  assert.equal(lastRemoval.payload.error.code, "LAST_TEAM_MANAGER");
  summary.lastManager = "409 LAST_TEAM_MANAGER protects the store's own roster";

  // =========================================================================
  // Adversarial-review fixes (2026-08-29) — ح-1 … ح-4 and ع-6.
  //
  // Every scenario below reproduces a defect the multi-lens review PROVED by
  // running it against this branch, so each one fails on the commit before its
  // fix. None of them restates an acceptance criterion the plan already owns.
  // =========================================================================

  // ---- ح-1 · a restore RE-SPENDS the plan quota the delete released --------
  // The ladder the review walked: delete → create a replacement (allowed, the
  // live count dropped) → restore what was deleted → a store sits ABOVE its cap
  // for good, because nothing re-checks it afterwards.
  //
  // The seeded `free` plan is used as-is (100 products, 2 seats) and the filler
  // rows go in through Prisma, not HTTP: this suite must not write a `plans` row,
  // because `plans` is deliberately outside its TRUNCATE and phase16 asserts the
  // exact set of plan codes on the same database.
  const capMerchantEmail = `${testId}.cap@codiq.test`;
  const capRegistered = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100590902", email: capMerchantEmail, password: "Pg2MerchantPass!", businessName: "متجر السقف" });
  assert.equal(capRegistered.status, 201, JSON.stringify(capRegistered.payload));
  const capMerchantId = capRegistered.payload.account.id;
  const capStore = await prisma.store.create({ data: { merchantId: capMerchantId, name: "متجر السقف", slug: `${testId}-cap`, defaultSubdomain: `${testId}-cap` } });
  // ق-128 grants every new merchant a free MONTH on «growth», whose product cap
  // is ten times «free»'s — so this must run AFTER the cap merchant exists, or
  // it pins everyone except the one being tested.
  await pinToFreePlan(capMerchantId);
  const capLimits = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { features: { select: { featureCode: true, limitValue: true } } } });
  const capOf = (code) => capLimits.features.find((feature) => feature.featureCode === code).limitValue;
  const capProducts = capOf("max_products");
  const capSeats = capOf("max_staff");
  await prisma.product.createMany({
    data: Array.from({ length: capProducts - 1 }, (_, index) => ({ storeId: capStore.id, sku: `CAP-FILL-${index}`, name: `منتج تعبئة ${index}`, priceIqd: 1000 })),
  });
  const capLogin = await request("/auth/merchant/login", { method: "POST", body: { identifier: capMerchantEmail, password: "Pg2MerchantPass!" } });
  assert.equal(capLogin.status, 200, JSON.stringify(capLogin.payload));
  const capToken = capLogin.payload.accessToken;
  const capCatalog = `/merchant/stores/${capStore.slug}/catalog`;
  const capCreate = (sku) => request(`${capCatalog}/products`, { method: "POST", token: capToken, body: { sku, name: `منتج ${sku}`, priceIqd: 1000, stockQuantity: 1 } });

  const capLast = await capCreate("CAP-LAST");
  assert.equal(capLast.status, 201, `ح-1: the last free slot is usable — ${JSON.stringify(capLast.payload)}`);
  const capRefused = await capCreate("CAP-OVER");
  assert.equal(capRefused.status, 403, "ح-1: the cap is real before anything is deleted");
  assert.equal(capRefused.payload.error.code, "PLAN_LIMIT_EXCEEDED");
  assert.equal((await request(`${capCatalog}/products/${capLast.payload.product.id}`, { method: "DELETE", token: capToken })).status, 200);
  assert.equal((await capCreate("CAP-OVER")).status, 201, "ح-1: deleting RELEASES the quota — a merchant at his cap can still replace a product (§6.6)");
  const capRestore = await request(`/merchant/stores/${capStore.slug}/trash/product/${capLast.payload.product.id}/restore`, { method: "POST", token: capToken, body: {} });
  assert.equal(capRestore.status, 403, `ح-1: and restoring RE-SPENDS it — ${JSON.stringify(capRestore.payload)}`);
  assert.equal(capRestore.payload.error.code, "PLAN_LIMIT_EXCEEDED");
  assert.ok(capRestore.payload.error.message.includes("لاستعادة هذا المنتج"), `ح-1: the message says what to do, not only that a limit exists — ${capRestore.payload.error.message}`);
  assert.equal(await prisma.product.count({ where: { storeId: capStore.id, deletedAt: null } }), capProducts, "ح-1: the store is still AT its cap, never above it");

  // ---- ح-1 · the same hole on `max_staff` ---------------------------------
  const capTeamUrl = `/merchant/stores/${capStore.slug}/team`;
  const hireStaff = (index) => request(capTeamUrl, { method: "POST", token: capToken, body: { email: `${testId}.capstaff${index}@codiq.test`, displayName: `موظف السقف ${index}`, temporaryPassword: "Pg2StaffPass!", roleCode: "store_staff" } });
  const capSeatIds = [];
  for (let seat = 1; seat <= capSeats; seat += 1) {
    const hired = await hireStaff(seat);
    assert.equal(hired.status, 201, JSON.stringify(hired.payload));
    capSeatIds.push(hired.payload.membership.id);
  }
  assert.equal((await hireStaff(capSeats + 1)).status, 403, "ح-1: the seat cap is real too");
  assert.equal((await request(`${capTeamUrl}/${capSeatIds[0]}`, { method: "DELETE", token: capToken })).status, 200);
  assert.equal((await hireStaff(capSeats + 1)).status, 201, "ح-1: the freed seat is usable");
  const capSeatRestore = await request(`/merchant/stores/${capStore.slug}/trash/staff_membership/${capSeatIds[0]}/restore`, { method: "POST", token: capToken, body: {} });
  assert.equal(capSeatRestore.status, 403, `ح-1: an occupied seat cannot come back over the cap — ${JSON.stringify(capSeatRestore.payload)}`);
  assert.equal(capSeatRestore.payload.error.code, "PLAN_LIMIT_EXCEEDED");
  summary.H1 = `restore re-spends max_products (${capProducts}) and max_staff (${capSeats}); the ladder answers 403 instead of parking the store above its cap`;

  // ---- ح-2 · service and trigger must agree on the depth budget -----------
  // Before the fix the service filtered trashed rows out of the depth walk and
  // the trigger did not, so this exact move passed the service, was refused by
  // Postgres with 23514, and reached the merchant as a bare 500 in English.
  const mkCategory = async (name, parentCategoryId) => {
    const created = await request(`${catalog}/categories`, { method: "POST", token, body: { name, ...(parentCategoryId ? { parentCategoryId } : {}) } });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    return created.payload.category.id;
  };
  const depthRootA = await mkCategory("أدوية");
  const depthMid = await mkCategory("مسكنات", depthRootA);
  const depthLeaf = await mkCategory("حبوب", depthMid);
  assert.equal((await request(`${catalog}/categories/${depthLeaf}`, { method: "DELETE", token })).status, 200, "ح-2: the leaf goes to the bin");
  const depthRootB = await mkCategory("العناية");
  const depthPocket = await mkCategory("جلدية", depthRootB);
  const depthMove = await request(`${catalog}/categories/${depthMid}`, { method: "PATCH", token, body: { name: "مسكنات", parentCategoryId: depthPocket } });
  assert.equal(depthMove.status, 422, `ح-2: a trashed leaf still spends the budget — 422, never 500 — ${JSON.stringify(depthMove.payload)}`);
  assert.equal(depthMove.payload.error.code, "CATEGORY_DEPTH_EXCEEDED");
  // And the half only the SERVICE walk protects (ق-أ): the trigger fires on
  // `parent_category_id`, and a RESTORE never touches it. Had the move above been
  // allowed, restoring «حبوب» would have quietly produced a LIVE four-level tree
  // with nothing left in either layer to refuse it.
  assert.equal((await request(`/merchant/stores/${slug}/trash/product_category/${depthLeaf}/restore`, { method: "POST", token, body: {} })).status, 200, "ح-2: the trashed leaf comes back");
  const depthTree = (await request(`${catalog}/categories`, { token })).payload.categories;
  const parentOf = (id) => depthTree.find((row) => row.id === id)?.parentCategoryId ?? null;
  assert.equal(parentOf(depthMid), depthRootA, "ح-2: the refused move left the tree exactly where it was");
  assert.equal(parentOf(depthLeaf), depthMid, "ح-2: and the restored leaf is back at level 3, never level 4");
  assert.equal(parentOf(parentOf(parentOf(depthLeaf))), null, "ح-2: three levels, counted from the leaf up to the root");

  // The belt to that braces: if the two layers ever disagree again, the 23514
  // the trigger raises must still not surface as INTERNAL_ERROR.
  const checkViolations = [
    ["product_categories depth for 0a1 would exceed 3 levels", "CATEGORY_DEPTH_EXCEEDED", 422],
    ["product_categories cycle: category 0a1 cannot be its own parent", "INVALID_CATEGORY_PARENT", 422],
    ['new row for relation "products" violates check constraint "products_deleted_implies_inactive"', "INTERNAL_ERROR", 500],
  ];
  for (const [text, expectedCode, expectedStatus] of checkViolations) {
    const mapped = { status: null, body: null };
    const asError = Object.assign(new Error(text), { code: "23514" });
    {
      const outcome = classifyError(asError, { path: "/merchant/stores/x/catalog/categories/y" });
      mapped.status = outcome.status;
      mapped.body = { error: outcome.error };
    }
    assert.equal(mapped.body.error.code, expectedCode, `ح-2: 23514 «${text.slice(0, 46)}…» must map to ${expectedCode} — got ${JSON.stringify(mapped.body)}`);
    assert.equal(mapped.status, expectedStatus, "ح-2: a broken INVARIANT stays a 500; a rule the merchant broke is a 422");
  }
  summary.H2 = "the depth walk counts trashed rows exactly as the trigger does; 23514 maps to 422 for the category rules only";

  // ---- ح-3 · one permission must not open four doors ----------------------
  // `catalog.trash.restore` used to gate all four entity types, so a member the
  // merchant had deliberately stripped of `team.manage` could still put a
  // dismissed colleague back on the team — and the merchant could not even see
  // the code to revoke it, because the client mirror was three codes behind.
  const gateEmail = `${testId}.gate@codiq.test`;
  const gateMember = await request(teamUrl, { method: "POST", token, body: { email: gateEmail, displayName: "حارس السلة", temporaryPassword: "Pg2StaffPass!", roleCode: "store_staff" } });
  assert.equal(gateMember.status, 201, JSON.stringify(gateMember.payload));
  const gateOverrides = (codes) => request(`${teamUrl}/${gateMember.payload.membership.id}/overrides`, { method: "PUT", token, body: { overrides: codes.map((permissionCode) => ({ permissionCode, effect: "allow" })) } });
  const gateLogin = async () => {
    const signed = await request(`/auth/staff/stores/${slug}/login`, { method: "POST", body: { email: gateEmail, password: "Pg2StaffPass!" } });
    assert.equal(signed.status, 200, JSON.stringify(signed.payload));
    return signed.payload.accessToken;
  };
  // A membership and a coupon genuinely in the bin, to aim at.
  const targetEmail = `${testId}.dismissed@codiq.test`;
  const targetMember = await request(teamUrl, { method: "POST", token, body: { email: targetEmail, displayName: "زميل مُقال", temporaryPassword: "Pg2StaffPass!", roleCode: "store_staff" } });
  assert.equal(targetMember.status, 201, JSON.stringify(targetMember.payload));
  assert.equal((await request(`${teamUrl}/${targetMember.payload.membership.id}`, { method: "DELETE", token })).status, 200);
  const gateCoupon = await request(`/merchant/stores/${slug}/marketing/coupons`, { method: "POST", token, body: { code: "PG2GATE", kind: "percent", percentOff: 15 } });
  assert.equal(gateCoupon.status, 201, JSON.stringify(gateCoupon.payload));
  assert.equal((await request(`/merchant/stores/${slug}/marketing/coupons/${gateCoupon.payload.coupon.id}`, { method: "DELETE", token })).status, 200);

  assert.equal((await gateOverrides(["catalog.trash.view", "catalog.trash.restore"])).status, 200);
  const gateToken = await gateLogin();
  const gateBin = await request(`/merchant/stores/${slug}/trash?limit=100`, { token: gateToken });
  assert.equal(gateBin.status, 200, JSON.stringify(gateBin.payload));
  assert.ok(gateBin.payload.items.some((item) => item.entityType === "product"), "ح-3: he still sees what his own permission covers");
  assert.ok(!gateBin.payload.items.some((item) => item.entityType === "staff_membership"), "ح-3: the bin hides team seats from a reader without team.manage");
  assert.ok(!gateBin.payload.items.some((item) => item.entityType === "coupon"), "ح-3: and coupons from a reader without settings.manage");
  assert.equal((await request(`/merchant/stores/${slug}/trash?entityType=staff_membership`, { token: gateToken })).status, 403, "ح-3: asking for the tab directly is refused too");
  const gateSeatDenied = await request(`/merchant/stores/${slug}/trash/staff_membership/${targetMember.payload.membership.id}/restore`, { method: "POST", token: gateToken, body: {} });
  assert.equal(gateSeatDenied.status, 403, `ح-3: he cannot re-hire the dismissed colleague — ${JSON.stringify(gateSeatDenied.payload)}`);
  assert.equal(gateSeatDenied.payload.error.code, "STAFF_PERMISSION_DENIED");
  assert.equal(await prisma.storeStaffMembership.count({ where: { id: targetMember.payload.membership.id, deletedAt: null } }), 0, "ح-3: and nothing was written");
  assert.equal((await request(`/merchant/stores/${slug}/trash/coupon/${gateCoupon.payload.coupon.id}/restore`, { method: "POST", token: gateToken, body: {} })).status, 403, "ح-3: nor revive a discount with a financial effect");

  // The gate is the PERMISSION, not a blanket ban: grant the governing code and
  // the very same call goes through.
  assert.equal((await gateOverrides(["catalog.trash.view", "catalog.trash.restore", "team.manage"])).status, 200);
  const gateTokenTwo = await gateLogin();
  const gateSeatAllowed = await request(`/merchant/stores/${slug}/trash/staff_membership/${targetMember.payload.membership.id}/restore`, { method: "POST", token: gateTokenTwo, body: {} });
  assert.equal(gateSeatAllowed.status, 200, `ح-3: with team.manage the restore is his to make — ${JSON.stringify(gateSeatAllowed.payload)}`);
  assert.equal((await request(`/merchant/stores/${slug}/trash?entityType=staff_membership`, { token: gateTokenTwo })).status, 200, "ح-3: and the tab opens");
  summary.H3 = "every trash entity answers to its governing permission (team.manage / settings.manage), listing included";

  // ---- ح-4 · the purge must never destroy a row the merchant just restored -
  // Deterministic, not statistical: a held row lock puts the sweep's DELETE and
  // the restore's UPDATE in a known order.
  const raceProduct = await createProduct({ sku: "PG2-RACE", name: "منتج السباق", priceIqd: 3000, stockQuantity: 1 });
  assert.equal((await deleteProduct(raceProduct.id)).status, 200);
  await sql.query("BEGIN");
  await sql.query("SELECT id FROM products WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE", [raceProduct.id]);
  const sweepDuringRestore = purgeExpiredSoftDeletes({ now: inDays(TRASH_RETENTION_DAYS + 1) });
  await new Promise((resolve) => setTimeout(resolve, 700));
  // What `restore()` writes, written here by the lock holder: the sweep's DELETE
  // is already queued behind this row and re-evaluates its WHERE after COMMIT.
  await sql.query("UPDATE products SET deleted_at = NULL, deleted_event_id = NULL, purge_blocked_at = NULL, purge_block_reason = NULL, is_active = false WHERE id = $1", [raceProduct.id]);
  await sql.query("COMMIT");
  const raceOutcome = await sweepDuringRestore;
  assert.equal(await prisma.product.count({ where: { id: raceProduct.id } }), 1, "ح-4: the restored product SURVIVES the sweep it was racing");
  assert.ok(raceOutcome.skipped >= 1, `ح-4: and the sweep reports it as skipped, not purged — ${JSON.stringify(raceOutcome)}`);
  assert.equal(await prisma.storeAuditEvent.count({ where: { storeId: store.id, entityId: raceProduct.id, action: "purged" } }), 0, "ح-4: no «purged» event is written for a row that was not purged");

  // The mirror direction: a restore that LOSES the race answers a clean 404,
  // never a 500 from updating a row that vanished under it.
  const lostProduct = await createProduct({ sku: "PG2-LOST", name: "منتج خسر السباق", priceIqd: 3000, stockQuantity: 1 });
  assert.equal((await deleteProduct(lostProduct.id)).status, 200);
  await sql.query("BEGIN");
  await sql.query("DELETE FROM products WHERE id = $1", [lostProduct.id]);
  const lateRestore = restoreVia("product", lostProduct.id);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await sql.query("COMMIT");
  const lostOutcome = await lateRestore;
  assert.equal(lostOutcome.status, 404, `ح-4: the loser gets a 404, not a 500 — ${JSON.stringify(lostOutcome.payload)}`);
  summary.H4 = "purge re-checks deleted_at under the row lock and restore takes the matching FOR UPDATE — proven in both directions";

  // ---- ع-6 · the bin is paginated BEFORE a client is built on it -----------
  for (const sku of ["PG2-PAGE-1", "PG2-PAGE-2", "PG2-PAGE-3", "PG2-PAGE-4", "PG2-PAGE-5"]) {
    const made = await createProduct({ sku, name: `منتج ${sku}`, priceIqd: 1500, stockQuantity: 1 });
    assert.equal((await deleteProduct(made.id)).status, 200);
  }
  const wholeBin = await request(`/merchant/stores/${slug}/trash?entityType=product&limit=100`, { token });
  assert.equal(wholeBin.status, 200, JSON.stringify(wholeBin.payload));
  assert.equal(wholeBin.payload.nextCursor, null, "ع-6: a page that fits carries no cursor");
  const walked = [];
  let trashCursor = null;
  for (let page = 0; page < 40; page += 1) {
    const query = `entityType=product&limit=2${trashCursor ? `&cursor=${encodeURIComponent(trashCursor)}` : ""}`;
    const step = await request(`/merchant/stores/${slug}/trash?${query}`, { token });
    assert.equal(step.status, 200, JSON.stringify(step.payload));
    assert.ok(step.payload.items.length <= 2, "ع-6: the limit is honoured");
    walked.push(...step.payload.items.map((item) => item.id));
    trashCursor = step.payload.nextCursor;
    if (!trashCursor) break;
  }
  assert.equal(trashCursor, null, "ع-6: the walk terminates");
  assert.equal(new Set(walked).size, walked.length, "ع-6: no row is served twice across pages");
  assert.deepEqual(walked, wholeBin.payload.items.map((item) => item.id), "ع-6: paging by 2 yields EXACTLY the rows of one big page, in the same order");
  // 20-2: `limit` is REFUSED outside 1..100, not silently clamped to it. Nine
  // services clamped and one rejected; a client that asks for 9999, is handed
  // 100, and then pages from a cursor it believes is row 9999 skips the rest of
  // the bin and blames the server. One behaviour, one code, everywhere.
  const oversizeLimit = await request(`/merchant/stores/${slug}/trash?limit=9999`, { token });
  assert.equal(oversizeLimit.status, 400, `ع-6/20-2: an out-of-window limit is refused — ${JSON.stringify(oversizeLimit.payload)}`);
  assert.equal(oversizeLimit.payload.error.code, "INVALID_LIMIT", "ع-6/20-2: with the platform's one limit code");
  // 20-2: a malformed cursor is `400 INVALID_CURSOR` on EVERY list. It used to
  // be this module's own 422 INVALID_INPUT; phase 22 translates codes, and one
  // code that means «bad input» here and «bad cursor» there cannot be
  // translated once.
  const badCursor = await request(`/merchant/stores/${slug}/trash?cursor=not-a-cursor`, { token });
  assert.equal(badCursor.status, 400, `ع-6/20-2: a malformed cursor is a 400, not a 500 — ${JSON.stringify(badCursor.payload)}`);
  assert.equal(badCursor.payload.error.code, "INVALID_CURSOR", "ع-6/20-2: with the platform's one cursor code");
  // 20-2: a cursor minted by ANOTHER list is refused just as cleanly. The kind
  // tag is what makes that a 4xx rather than an empty page or a wrong one.
  const foreignCursor = await request(`/merchant/stores/${slug}/trash?cursor=${encodeURIComponent(Buffer.from(JSON.stringify({ v: 1, k: "merchant.orders", c: new Date().toISOString(), i: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }), "utf8").toString("base64url"))}`, { token });
  assert.equal(foreignCursor.status, 400, `20-2: a foreign cursor is refused, never a 500 — ${JSON.stringify(foreignCursor.payload)}`);
  assert.equal(foreignCursor.payload.error.code, "INVALID_CURSOR");
  summary.P6 = `trash bin is keyset-paginated across the four streams (${walked.length} rows walked two at a time, identical to one page)`;

  // =========================================================================
  // =========================================================================
  // Adversarial-review fixes on the PG-2 INTERFACE (2026-08-29) — و-1 … ع-9.
  //
  // The headline one is ع-1: the undo bar promised «يُحذف نهائياً بعد ٣٠ يوماً»
  // for a row the confirmation sheet had, one second earlier, promised would be
  // kept forever — and the purge really does refuse that row, so the sentence was
  // false. It shipped green because the acceptance test deletes the sold product
  // through the API and never passes the bar.
  // =========================================================================

  // ---- و-1 · the delete response carries the row's real fate ---------------
  const fateBuyer = await registerCustomer("زبون المصير");
  const fateSold = await createProduct({ sku: "PG2-FATE-SOLD", name: "منتج بِيع فعلاً", priceIqd: 9000, stockQuantity: 5 });
  const fateCart = await addToCart(fateBuyer, fateSold.id, 1);
  const fateOrder = await checkout(fateBuyer, fateCart);
  assert.equal(fateOrder.status, 201, JSON.stringify(fateOrder.payload));
  await request(`/merchant/stores/${slug}/orders/${fateOrder.payload.order.id}/status`, { method: "POST", token, body: { toStatus: "cancelled", expectedVersion: 1 } });
  const fateSoldDelete = await deleteProduct(fateSold.id);
  assert.equal(fateSoldDelete.status, 200, JSON.stringify(fateSoldDelete.payload));
  assert.equal(fateSoldDelete.payload.keptForRecords, true, "و-1: the DELETE response itself says the row will be kept — the undo bar has no excuse to promise a countdown");
  assert.ok(typeof fateSoldDelete.payload.keptReason === "string" && fateSoldDelete.payload.keptReason.length > 4, `و-1: and it says WHY, in the sweep's own words — ${fateSoldDelete.payload.keptReason}`);

  const fateClean = await createProduct({ sku: "PG2-FATE-CLEAN", name: "منتج لم يُبَع", priceIqd: 4000, stockQuantity: 3 });
  const fateCleanDelete = await deleteProduct(fateClean.id);
  assert.equal(fateCleanDelete.payload.keptForRecords, false, "و-1: a product nobody ever ordered really does get a countdown");
  assert.equal(fateCleanDelete.payload.keptReason, null);
  // The two surfaces must agree — that is the whole point of the fix.
  const fateBin = await request(`/merchant/stores/${slug}/trash?entityType=product&limit=100`, { token });
  const fateBinRow = fateBin.payload.items.find((item) => item.id === fateSold.id);
  assert.equal(fateBinRow.keptForRecords, fateSoldDelete.payload.keptForRecords, "و-1: the bin and the delete response tell ONE story about one row");

  // ---- و-6 · «مباع» may not stand on a cancelled order --------------------
  const cancelledPreview = await request(`/merchant/stores/${slug}/trash/preview/product/${fateSold.id}`, { token });
  assert.equal(cancelledPreview.status, 404, "و-6: a trashed product has no delete preview — it is already gone");
  const cancelBuyer = await registerCustomer("زبون ألغى");
  const cancelProduct = await createProduct({ sku: "PG2-CANCELLED", name: "حذاء ألغي طلبه", priceIqd: 12000, stockQuantity: 4 });
  const cancelCart = await addToCart(cancelBuyer, cancelProduct.id, 1);
  const cancelOrder = await checkout(cancelBuyer, cancelCart);
  assert.equal(cancelOrder.status, 201, JSON.stringify(cancelOrder.payload));
  assert.equal((await request(`/merchant/stores/${slug}/orders/${cancelOrder.payload.order.id}/status`, { method: "POST", token, body: { toStatus: "cancelled", expectedVersion: 1 } })).status, 200);
  const cancelledEffects = (await request(`/merchant/stores/${slug}/trash/preview/product/${cancelProduct.id}`, { token })).payload.preview.effects;
  assert.equal(cancelledEffects.orders, 1, "و-6: the RESTRICT key holds the row whatever the order status — so the block prediction counts it");
  assert.equal(cancelledEffects.soldOrders, 0, "و-6: …but the merchant never sold it, and the sheet must not say «مباع»");
  assert.equal(cancelledEffects.keptForRecords, true, "و-6: kept for records all the same, which is the sentence ق-97 requires");

  // ---- و-2 · sales figures answer to `orders.view`, not to «delete» --------
  // A stock keeper the merchant deliberately allowed to delete and denied orders.
  const keeperEmail = `${testId}.keeper@codiq.test`;
  const keeper = await request(teamUrl, { method: "POST", token, body: { email: keeperEmail, displayName: "أمين المخزن", temporaryPassword: "Pg2StaffPass!", roleCode: "store_staff" } });
  assert.equal(keeper.status, 201, JSON.stringify(keeper.payload));
  assert.equal((await request(`${teamUrl}/${keeper.payload.membership.id}/overrides`, { method: "PUT", token, body: { overrides: [
    { permissionCode: "catalog.products.delete", effect: "allow" },
    { permissionCode: "orders.view", effect: "deny" },
  ] } })).status, 200);
  const keeperLogin = await request(`/auth/staff/stores/${slug}/login`, { method: "POST", body: { email: keeperEmail, password: "Pg2StaffPass!" } });
  assert.equal(keeperLogin.status, 200, JSON.stringify(keeperLogin.payload));
  const keeperToken = keeperLogin.payload.accessToken;
  // The platform refuses him the order surfaces…
  assert.equal((await request(`/merchant/stores/${slug}/orders`, { token: keeperToken })).status, 403, "و-2: he is refused the orders list, as the merchant intended");
  // …so the delete preview must not hand him the same numbers one product at a time.
  const keeperPreview = await request(`/merchant/stores/${slug}/trash/preview/product/${cancelProduct.id}`, { token: keeperToken });
  assert.equal(keeperPreview.status, 200, "و-2: he may still see the consequences of a delete he is allowed to make");
  assert.equal(keeperPreview.payload.preview.effects.orders, undefined, "و-2: but not the per-product order count he could walk the catalogue with");
  assert.equal(keeperPreview.payload.preview.effects.soldOrders, undefined, "و-2: nor the sales figure");
  assert.equal(keeperPreview.payload.preview.effects.inventoryMovements, undefined, "و-2: nor the movement volume, which is the same signal by another name");
  assert.equal(keeperPreview.payload.preview.effects.keptForRecords, true, "و-2: he still gets the PROMISE ق-97 requires — the fate, without the figures");
  assert.ok(keeperPreview.payload.preview.effects.liveCartItems !== undefined, "و-2: and the refusal conditions, which his own permission already exposes via 409");
  // The owning merchant loses nothing.
  const ownerPreview = await request(`/merchant/stores/${slug}/trash/preview/product/${cancelProduct.id}`, { token });
  assert.equal(ownerPreview.payload.preview.effects.orders, 1, "و-2: the merchant himself sees every number as before");

  // ---- و-4 · «open sessions» must mean sessions that would be accepted -----
  const sessionEmail = `${testId}.sessions@codiq.test`;
  const sessionMember = await request(teamUrl, { method: "POST", token, body: { email: sessionEmail, displayName: "موظف الجلسات", temporaryPassword: "Pg2StaffPass!", roleCode: "store_staff" } });
  assert.equal(sessionMember.status, 201, JSON.stringify(sessionMember.payload));
  const sessionMembershipId = sessionMember.payload.membership.id;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await request(`/auth/staff/stores/${slug}/login`, { method: "POST", body: { email: sessionEmail, password: "Pg2StaffPass!" } })).status, 200);
  }
  const beforeExpiry = (await request(`/merchant/stores/${slug}/trash/preview/staff_membership/${sessionMembershipId}`, { token })).payload.preview.effects.openSessions;
  assert.equal(beforeExpiry, 3, "و-4: three live sign-ins are three open doors");
  // Age two of them past their eight-hour life. Nothing sweeps expired staff
  // sessions and there is no staff sign-out route, so this accumulation is
  // certain in production, not hypothetical.
  // `staff_sessions_expiry` is a CHECK that expires_at > created_at, so the row
  // has to be aged as a whole — which is also the truthful shape of the bug: an
  // eight-hour session created nine hours ago.
  await sql.query("UPDATE staff_sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 hour' WHERE id IN (SELECT id FROM staff_sessions WHERE membership_id = $1 LIMIT 2)", [sessionMembershipId]);
  const afterExpiry = (await request(`/merchant/stores/${slug}/trash/preview/staff_membership/${sessionMembershipId}`, { token })).payload.preview.effects.openSessions;
  assert.equal(afterExpiry, 1, "و-4: an expired session is not an open door — the sheet counted sign-ins, not doors");

  // ---- و-3 · the activity log must not lose an event at a page boundary ----
  const allCouponEvents = await request(`/merchant/stores/${slug}/audit-events?entityType=coupon&limit=100`, { token });
  assert.equal(allCouponEvents.status, 200, JSON.stringify(allCouponEvents.payload));
  const couponIds = allCouponEvents.payload.events.map((event) => event.id);
  assert.ok(couponIds.length >= 3, `و-3: the fixture needs at least three coupon events — found ${couponIds.length}`);
  // Walking one at a time must reproduce the list exactly.
  const walkedEvents = [];
  let auditCursor = null;
  for (let page = 0; page < 60; page += 1) {
    const step = await request(`/merchant/stores/${slug}/audit-events?entityType=coupon&limit=1${auditCursor ? `&cursor=${encodeURIComponent(auditCursor)}` : ""}`, { token });
    assert.equal(step.status, 200, JSON.stringify(step.payload));
    walkedEvents.push(...step.payload.events.map((event) => event.id));
    auditCursor = step.payload.nextCursor;
    if (!auditCursor) break;
  }
  assert.deepEqual(walkedEvents, couponIds, "و-3: paging one at a time yields EXACTLY the same events in the same order");
  // The case that used to drop a row: a cursor taken from the UNFILTERED page,
  // then reused with a filter that excludes that very row. `cursor` + `skip: 1`
  // anchored on a row the filter removes and silently swallowed the first match
  // after it; a keyset predicate cannot.
  const unfiltered = await request(`/merchant/stores/${slug}/audit-events?limit=100`, { token });
  const foreignAnchor = unfiltered.payload.events.find((event) => event.entityType !== "coupon");
  assert.ok(foreignAnchor, "و-3: the fixture needs a non-coupon event to anchor on");
  const afterForeign = await request(`/merchant/stores/${slug}/audit-events?entityType=coupon&limit=100&cursor=${encodeURIComponent(foreignAnchor.id)}`, { token });
  assert.equal(afterForeign.status, 200, JSON.stringify(afterForeign.payload));
  const anchorIndex = unfiltered.payload.events.findIndex((event) => event.id === foreignAnchor.id);
  const expectedAfter = unfiltered.payload.events.slice(anchorIndex + 1).filter((event) => event.entityType === "coupon").map((event) => event.id);
  assert.deepEqual(afterForeign.payload.events.map((event) => event.id), expectedAfter, "و-3: every coupon event older than the anchor is returned — none is swallowed");

  // ---- و-9 · the block prediction is store-scoped -------------------------
  // Not a leak — a trigger forces a product's category into its own store — so
  // there is no runtime behaviour to assert. The defect was a PLAN: without
  // storeId the query cannot use products_store_category_idx by its LEADING
  // column, so Postgres scanned the whole products heap from inside an HTTP
  // handler even for a category holding zero products.
  //
  // Asserting the plan itself would be a lie in CI: on a table holding a handful
  // of rows Postgres correctly prefers a sequential scan, and the assertion would
  // then pass or fail on fixture SIZE rather than on the code. It is guarded the
  // way this repository already guards `deletedAt` — statically, on the source.
  const softDeleteSource = readFileSync(new URL("../src/services/soft-delete/soft-delete.service.ts", import.meta.url), "utf8");
  for (const scopedQuery of [
    "where: { categoryId: { in: ids }, storeId }",
    "where: { productId: { in: ids }, order: { storeId } }",
    "where: { couponId: { in: ids }, storeId }",
  ]) {
    assert.ok(softDeleteSource.includes(scopedQuery), `و-9: the kept-for-records prediction must stay store-scoped — missing ${scopedQuery}`);
  }
  summary.uiReview = "undo bar tells the row's real fate; sales figures ride orders.view; open sessions exclude expired; the audit cursor cannot swallow an event";

  // =========================================================================
  // Runtime schema guard (plan §5.5) — a future migration must not restore a
  // FULL unique constraint and re-lock the SKU on a trashed product.
  // =========================================================================
  const checks = await sql.query("SELECT conname FROM pg_constraint WHERE conname = ANY($1)", [[
    "products_deleted_implies_inactive", "product_variants_deleted_implies_inactive",
    "coupons_deleted_implies_inactive", "ssm_deleted_implies_inactive",
    "products_deleted_pair", "product_categories_deleted_pair",
  ]]);
  assert.equal(checks.rows.length, 6, `schema guard: every deleted-state CHECK exists — found ${checks.rows.map((row) => row.conname).join(", ")}`);
  const partial = await sql.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)", [[
    "products_store_sku_live_key", "product_variants_store_sku_live_key",
    "product_categories_store_name_live_key", "coupons_store_code_live_key",
    "store_staff_memberships_staff_store_live_key",
    // ق-227 joined the idiom: a departed employee's address is released, so
    // uniqueness on `staff.email` is a claim on the LIVING — the same shape
    // `platform_staff_email_live_key` took in ق-143.
    "staff_email_live_key",
  ]]);
  assert.equal(partial.rows.length, 6, `schema guard: all six partial unique indexes exist — found ${partial.rows.map((row) => row.indexname).join(", ")}`);
  const removed = await sql.query("SELECT conname FROM pg_constraint WHERE conname = ANY($1)", [[
    "products_store_id_sku_key", "product_variants_store_sku_key",
    "product_categories_store_normalized_name_key", "coupons_store_code_unique",
    "store_staff_memberships_unique_staff_store",
    // ق-227: the FULL unique on staff.email is what burned a stranger's address
    // forever; a future migration must not put it back.
    "staff_email_key",
  ]]);
  assert.equal(removed.rows.length, 0, `schema guard: the old FULL unique constraints are gone — still present: ${removed.rows.map((row) => row.conname).join(", ")}`);
  const fk = await sql.query("SELECT confdeltype FROM pg_constraint WHERE conname = 'inventory_movements_product_id_fkey'");
  assert.equal(fk.rows[0].confdeltype, "n", "schema guard: inventory_movements.product_id is ON DELETE SET NULL, not CASCADE");
  const notNull = await sql.query("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'inventory_movements'::regclass AND attname = 'product_name'");
  assert.equal(notNull.rows[0].attnotnull, true, "schema guard: the snapshot column is NOT NULL");
  // The enum-shaped CHECK on permission overrides is a classic trap: adding a
  // code in TypeScript alone type-checks and then fails at RUNTIME with 23514
  // the first time a merchant grants it (docs/DEVELOPMENT_ENVIRONMENT.md §4).
  const overrideCheck = await sql.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'staff_membership_permission_overrides_code'");
  for (const code of PERMISSION_CODES) {
    assert.ok(overrideCheck.rows[0].definition.includes(`'${code}'`), `schema guard: the permission-override CHECK is missing «${code}» — widen it in a migration`);
  }
  summary.schemaGuard = `6 CHECKs, 5 partial unique indexes, 0 legacy full constraints, SET NULL confirmed, ${PERMISSION_CODES.length} permission codes accepted by the override CHECK`;

  // =========================================================================
  // Static leak guard (plan §5, the AST rules)
  // =========================================================================
  const leaks = findDeletedLeaks();
  assert.equal(leaks.length, 0, `static leak guard:\n${formatViolations(leaks)}`);
  const stale = staleAllowlistKeys();
  assert.deepEqual(stale, [], `static leak guard: stale allowlist entries must be deleted — ${stale.join(", ")}`);
  summary.leakGuard = "no unfiltered read on the five watched models; allowlist has no stale entry";

  console.log(JSON.stringify({ suite: "pg2", status: "passed", summary }, null, 2));
} catch (error) {
  console.error("PG-2 integration failure:", error);
  process.exitCode = 1;
} finally {
  await sql.end().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  killTree(moto);
}

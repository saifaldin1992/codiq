/**
 * codiq phase 20B-3 — CSV import/export (D-25) + ad pixels (D-26) proof.
 * Phase-20B2-style harness: the real HTTP app over a real PostgreSQL.
 * Coverage per plan §4/§5 + the closing-batch spec:
 *
 * CSV:
 *  1. parser unit cases (quoted fields/commas, escaped quotes, CRLF/LF mix,
 *     BOM strip, quoted newlines, serializer round-trip);
 *  2. dry-run: full preview counts + ZERO writes (products/variants/categories/
 *     movements all unchanged);
 *  3. commit: product + 3 variants with exact prices/stock, nested category
 *     chain (depth 3) created, default-variant rename, inventory movements;
 *  4. one bad row rejects EVERYTHING (422, zero inserts);
 *  5. plan limit charges the NEW-PRODUCTS count -> 403 PLAN_LIMIT_EXCEEDED
 *     with zero partial inserts;
 *  6. create-only: existing SKU = row error; row cap 2000 = CSV_TOO_LARGE;
 *     broken encoding = CSV_INVALID_ENCODING;
 *  7. category isolation across two stores (same path, separate trees);
 *  8. export -> reimport round-trip into a fresh store (BOM, header, data
 *     fidelity: prices, stock, options, category path, prescription flag);
 *  9. orders export: one row per order item, order columns + coupon code,
 *     status filter, guard (orders.view boundary).
 *
 * Pixels:
 * 10. strict format validation (XSS strings and malformed ids -> 422, nothing
 *     stored); valid ids persist;
 * 11. public-config gating: absent while disabled, present when enabled,
 *     absent again after disabling, 404 for an inactive store;
 * 12. two-store isolation (store B never sees store A's ids).
 *
 * Established lessons applied: storefront_rate_limits cleared before every
 * non-GET request; notification_outbox untouched (no fake event types needed).
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `phase20b3-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "phase20b3-test-secret-only-not-for-production";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { parseCsv, csvField, csvLine, CSV_UTF8_BOM } = await import("../src/services/csv.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  // Rate-limit counters are phase 9A's subject — cleared before every write so
  // scenarios stay independent of call volume (established 20B lesson).
  if (method !== "GET") await sql.query("DELETE FROM storefront_rate_limits");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

/** Multipart CSV upload (Node's own FormData/Blob). */
async function uploadCsv(path, token, csvContent) {
  await sql.query("DELETE FROM storefront_rate_limits");
  const form = new FormData();
  const body = typeof csvContent === "string" ? new Blob([csvContent], { type: "text/csv" }) : new Blob([csvContent], { type: "text/csv" });
  form.append("file", body, "products.csv");
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: form });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function downloadCsv(path, token) {
  const response = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  // response.text() strips a leading UTF-8 BOM per the encoding spec, so the
  // BOM must be asserted on the raw bytes.
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  return { status: response.status, headers: response.headers, text, bytes };
}

let customerPhoneSuffix = 0;
async function registerCustomer(slug, fullName, email) {
  customerPhoneSuffix += 1;
  const phone = `+96477043${String(customerPhoneSuffix).padStart(5, "0")}`;
  const registered = await request(`/store/${slug}/account/register`, { method: "POST", body: { phone, password: "Phase20B3CustomerPass!", fullName, ...(email ? { email } : {}) } });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const address = await request(`/store/${slug}/account/addresses`, { method: "POST", token: registered.payload.accessToken, body: { recipientName: fullName, fullAddress: "شارع الاستيراد 20", city: "Baghdad", governorate: "Baghdad", phoneContact: phone, isDefault: true } });
  assert.equal(address.status, 201, JSON.stringify(address.payload));
  return { token: registered.payload.accessToken, account: registered.payload.account, addressId: address.payload.address.id };
}

let checkoutKeySuffix = 0;
async function doCheckout(slug, customer, cart, { couponCode } = {}) {
  checkoutKeySuffix += 1;
  const body = { cartVersion: cart.version, addressId: customer.addressId, paymentMethodCode: "cod", ...(couponCode ? { couponCode } : {}) };
  return request(`/store/${slug}/checkout`, { method: "POST", token: customer.token, headers: { "idempotency-key": `phase20b3-key-${String(checkoutKeySuffix).padStart(4, "0")}` }, body });
}

const summary = {};

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, store_marketing_settings, order_prescriptions, coupon_redemptions, coupons, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, staff_sessions, staff_membership_permission_overrides, store_staff_memberships, staff, platform_owner_sessions, platform_owners CASCADE");

  // ---------- 1. parser unit cases ----------
  assert.deepEqual(parseCsv("a,b,c\r\n1,2,3\r\n"), [["a", "b", "c"], ["1", "2", "3"]], "plain CRLF records");
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]], "LF records without trailing newline");
  assert.deepEqual(parseCsv('"قميص, كبير","قال ""مرحبا""",عادي'), [["قميص, كبير", 'قال "مرحبا"', "عادي"]], "quoted comma + escaped quotes");
  assert.deepEqual(parseCsv('"سطر أول\r\nسطر ثانٍ",x'), [["سطر أول\r\nسطر ثانٍ", "x"]], "quoted CRLF stays inside the field");
  assert.deepEqual(parseCsv("﻿sku,name\r\nA,منتج"), [["sku", "name"], ["A", "منتج"]], "UTF-8 BOM stripped");
  assert.deepEqual(parseCsv("a,b\r\n\r\n1,2\r\n,\r\n"), [["a", "b"], ["1", "2"]], "fully-empty lines dropped");
  assert.deepEqual(parseCsv('a,"",c'), [["a", "", "c"]], "empty quoted field");
  assert.throws(() => parseCsv('"unterminated,field'), /CSV_UNTERMINATED_QUOTE/, "unterminated quote throws");
  assert.equal(csvField('قيمة "خاصة", هنا'), '"قيمة ""خاصة"", هنا"', "serializer quotes and escapes");
  assert.equal(csvField(12500), "12500");
  const roundTripRow = ["SKU-1", 'اسم "المنتج"', "وصف، بفاصلة\nوسطر جديد", "أب > فرع"];
  assert.deepEqual(parseCsv(csvLine(roundTripRow)), [roundTripRow], "serialize -> parse round-trip");
  assert.equal(CSV_UTF8_BOM, "﻿");
  summary.parser = { cases: 11, ok: true };

  // ---------- fixtures ----------
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100622801", email: `${testId}.merchant-a@codiq.test`, password: "Phase20B3MerchantPass!", businessName: "متجر 20B3 ألف" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100622802", email: `${testId}.merchant-b@codiq.test`, password: "Phase20B3MerchantPass!", businessName: "متجر 20B3 باء" });
  assert.equal(merchantA.status, 201); assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر 20B3 ألف", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر 20B3 باء", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  const storeC = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر 20B3 جيم", slug: `${testId}-c`, defaultSubdomain: `${testId}-c` } });
  await prisma.deliveryRate.create({ data: { storeId: storeA.id, governorate: "Baghdad", amountIqd: 2500, isEnabled: true } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-a@codiq.test`, password: "Phase20B3MerchantPass!" } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-b@codiq.test`, password: "Phase20B3MerchantPass!" } });
  const loginC = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.merchant-b@codiq.test`, password: "Phase20B3MerchantPass!" } });
  assert.equal(loginA.status, 200); assert.equal(loginB.status, 200); assert.equal(loginC.status, 200);
  const tokenA = loginA.payload.accessToken;
  // merchant-b owns storeB and storeC, so identity sign-in binds him to the
  // older one. `storeCount` proves the server told him there was another.
  assert.equal(loginB.payload.storeCount, 2, "the second merchant really does own two stores");
  const switchTo = async (token, storeSlug) => {
    const switched = await request("/merchant/stores/switch", { method: "POST", token, body: { storeSlug } });
    assert.equal(switched.status, 200, `switch to ${storeSlug}: ${JSON.stringify(switched.payload)}`);
    return switched.payload.accessToken;
  };
  const tokenB = await switchTo(loginB.payload.accessToken, storeB.slug);
  const tokenC = await switchTo(loginC.payload.accessToken, storeC.slug);
  const importPathA = `/merchant/stores/${storeA.slug}/catalog/import/products`;

  const CSV_HEADER = "product_sku,product_name,description,category_path,requires_prescription,variant_sku,variant_name,price_iqd,stock_quantity,low_stock_threshold,is_active,options_json";
  const goodCsv = [
    CSV_HEADER,
    'CSV-SHIRT,قميص مستورد,"وصف, بفاصلة",الملابس > رجالي > قمصان,false,CSV-SHIRT-S,صغير,10000,5,1,true,"{""المقاس"":""S""}"',
    'CSV-SHIRT,,,,,CSV-SHIRT-M,وسط,12000,7,1,true,"{""المقاس"":""M""}"',
    'CSV-SHIRT,,,,,CSV-SHIRT-L,كبير,15000,3,1,true,"{""المقاس"":""L""}"',
    "CSV-RX,دواء مستورد,,,true,CSV-RX,,4000,9,2,true,",
  ].join("\r\n");

  // ---------- 2. dry-run: preview counts + ZERO writes ----------
  const baseline = {
    products: await prisma.product.count({ where: { storeId: storeA.id } }),
    variants: await prisma.productVariant.count({ where: { storeId: storeA.id } }),
    categories: await prisma.productCategory.count({ where: { storeId: storeA.id } }),
    movements: await prisma.inventoryMovement.count({ where: { storeId: storeA.id } }),
  };
  const dryRun = await uploadCsv(`${importPathA}?dryRun=true`, tokenA, goodCsv);
  assert.equal(dryRun.status, 200, JSON.stringify(dryRun.payload));
  assert.equal(dryRun.payload.dryRun, true);
  assert.equal(dryRun.payload.totalRows, 4);
  assert.equal(dryRun.payload.newProducts, 2);
  assert.equal(dryRun.payload.newVariants, 2, "additional-variant rows only (the default variant rides the product)");
  assert.deepEqual(dryRun.payload.errors, []);
  assert.equal(await prisma.product.count({ where: { storeId: storeA.id } }), baseline.products, "dry-run wrote NO products");
  assert.equal(await prisma.productVariant.count({ where: { storeId: storeA.id } }), baseline.variants, "dry-run wrote NO variants");
  assert.equal(await prisma.productCategory.count({ where: { storeId: storeA.id } }), baseline.categories, "dry-run wrote NO categories");
  assert.equal(await prisma.inventoryMovement.count({ where: { storeId: storeA.id } }), baseline.movements, "dry-run wrote NO movements");
  summary.dryRun = { totalRows: 4, newProducts: 2, newVariants: 2, zeroWrites: true };

  // ---------- 3. commit: product + 3 variants, nested categories, movements ----------
  const commit = await uploadCsv(importPathA, tokenA, goodCsv);
  assert.equal(commit.status, 201, JSON.stringify(commit.payload));
  assert.equal(commit.payload.createdProducts, 2);
  assert.equal(commit.payload.createdVariants, 2);
  const shirt = await prisma.product.findFirst({ where: { storeId: storeA.id, sku: "CSV-SHIRT" }, include: { variants: { orderBy: [{ isDefault: "desc" }, { position: "asc" }] }, category: true } });
  assert.ok(shirt, "CSV-SHIRT created");
  assert.equal(shirt.variants.length, 3, "product carries exactly three variants");
  const [defaultVariant, mediumVariant, largeVariant] = shirt.variants;
  assert.equal(defaultVariant.isDefault, true);
  assert.equal(defaultVariant.sku, "CSV-SHIRT-S", "first row RENAMES the trigger-created default variant");
  assert.equal(defaultVariant.name, "صغير");
  assert.equal(defaultVariant.priceIqd, 10000);
  assert.equal(defaultVariant.stockQuantity, 5);
  assert.deepEqual(defaultVariant.options, { المقاس: "S" });
  assert.equal(mediumVariant.sku, "CSV-SHIRT-M"); assert.equal(mediumVariant.priceIqd, 12000); assert.equal(mediumVariant.stockQuantity, 7);
  assert.equal(largeVariant.sku, "CSV-SHIRT-L"); assert.equal(largeVariant.priceIqd, 15000); assert.equal(largeVariant.stockQuantity, 3);
  assert.equal(shirt.category.name, "قمصان", "product hangs on the LEAF of the path");
  const leaf = await prisma.productCategory.findFirst({ where: { storeId: storeA.id, name: "قمصان" }, include: { parent: { include: { parent: true } } } });
  assert.equal(leaf.parent.name, "رجالي");
  assert.equal(leaf.parent.parent.name, "الملابس");
  assert.equal(leaf.parent.parent.parentCategoryId, null, "three-level chain rooted correctly");
  const rx = await prisma.product.findFirst({ where: { storeId: storeA.id, sku: "CSV-RX" }, include: { variants: true } });
  assert.equal(rx.requiresPrescription, true);
  assert.equal(rx.variants.length, 1);
  assert.equal(rx.variants[0].name, "دواء مستورد", "variant name defaults to the product name");
  const shirtMovements = await prisma.inventoryMovement.findMany({ where: { storeId: storeA.id, productId: shirt.id } });
  assert.equal(shirtMovements.length, 3, "an initial_stock movement per stocked variant");
  assert.ok(shirtMovements.every((movement) => movement.reason === "initial_stock"));
  summary.commit = { createdProducts: 2, createdVariants: 2, defaultRenamed: true, categoryDepth: 3 };

  // ---------- 4. one bad row rejects EVERYTHING ----------
  const badCsv = [
    CSV_HEADER,
    "CSV-OK1,منتج سليم,,,,CSV-OK1,,5000,1,0,true,",
    "CSV-BAD,منتج معطوب,,,,CSV-BAD,,not-a-price,1,0,true,",
    "CSV-OK2,منتج سليم آخر,,,,CSV-OK2,,6000,1,0,true,",
  ].join("\r\n");
  const badPreview = await uploadCsv(`${importPathA}?dryRun=true`, tokenA, badCsv);
  assert.equal(badPreview.status, 200);
  assert.equal(badPreview.payload.errors.length, 1);
  assert.deepEqual({ row: badPreview.payload.errors[0].row, column: badPreview.payload.errors[0].column, code: badPreview.payload.errors[0].code }, { row: 3, column: "price_iqd", code: "INVALID_NUMBER" });
  const badCommit = await uploadCsv(importPathA, tokenA, badCsv);
  assert.equal(badCommit.status, 422);
  assert.equal(badCommit.payload.error.code, "CSV_VALIDATION_FAILED");
  assert.equal(badCommit.payload.validation.errors.length, 1);
  assert.equal(await prisma.product.count({ where: { storeId: storeA.id, sku: { in: ["CSV-OK1", "CSV-OK2", "CSV-BAD"] } } }), 0, "all-or-nothing: the valid rows were NOT inserted");
  summary.allOrNothing = { commitStatus: 422, insertedFromBadFile: 0 };

  // ---------- 5. plan limit charges the NEW-PRODUCTS count ----------
  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { code: "free" }, select: { id: true } });
  // ق-128 grants every new merchant a free MONTH on «growth», so tightening the
  // FREE plan below no longer reaches this merchant — he is not on it. Pinning
  // him is what restores the premise this section was written against.
  await prisma.merchantSubscription.updateMany({
    where: { merchantId: merchantA.payload.account.id, status: "active" },
    data: { planId: freePlan.id, endsAt: null },
  });
  const merchantAProducts = await prisma.product.count({ where: { store: { merchantId: merchantA.payload.account.id } } });
  await prisma.planFeature.update({ where: { planId_featureCode: { planId: freePlan.id, featureCode: "max_products" } }, data: { limitValue: merchantAProducts + 1 } });
  const limitCsv = [
    CSV_HEADER,
    "CSV-LIM1,منتج حد أول,,,,CSV-LIM1,,1000,0,0,true,",
    "CSV-LIM2,منتج حد ثانٍ,,,,CSV-LIM2,,1000,0,0,true,",
  ].join("\r\n");
  const limited = await uploadCsv(importPathA, tokenA, limitCsv);
  assert.equal(limited.status, 403, JSON.stringify(limited.payload));
  assert.equal(limited.payload.error.code, "PLAN_LIMIT_EXCEEDED", "TWO new products exceed the remaining-one budget");
  assert.equal(await prisma.product.count({ where: { storeId: storeA.id, sku: { in: ["CSV-LIM1", "CSV-LIM2"] } } }), 0, "zero partial inserts under the plan refusal");
  await prisma.planFeature.update({ where: { planId_featureCode: { planId: freePlan.id, featureCode: "max_products" } }, data: { limitValue: 100 } });
  summary.planLimit = { status: 403, code: "PLAN_LIMIT_EXCEEDED", partialInserts: 0 };

  // ---------- 6. create-only + row cap + encoding ----------
  const duplicate = await uploadCsv(`${importPathA}?dryRun=true`, tokenA, [CSV_HEADER, "CSV-SHIRT,قميص مكرر,,,,CSV-SHIRT-XL,مكرر,9000,1,0,true,"].join("\r\n"));
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.payload.errors[0].code, "SKU_EXISTS", "existing product SKU is a row error (create-only v1)");
  const variantDuplicate = await uploadCsv(`${importPathA}?dryRun=true`, tokenA, [CSV_HEADER, "CSV-NEW,منتج جديد,,,,CSV-SHIRT-M,متغير مكرر,9000,1,0,true,"].join("\r\n"));
  assert.equal(variantDuplicate.payload.errors[0].code, "SKU_EXISTS", "existing VARIANT SKU is a row error too");
  const oversizedRows = [CSV_HEADER];
  for (let index = 0; index < 2001; index += 1) oversizedRows.push(`CSV-CAP-${index},منتج,,,,CSV-CAP-${index},,1000,0,0,true,`);
  const oversized = await uploadCsv(`${importPathA}?dryRun=true`, tokenA, oversizedRows.join("\r\n"));
  assert.equal(oversized.status, 422);
  assert.equal(oversized.payload.error.code, "CSV_TOO_LARGE");
  const broken = await uploadCsv(`${importPathA}?dryRun=true`, tokenA, Buffer.from([0x70, 0x72, 0xff, 0xfe, 0x00, 0xc0, 0x2c, 0x31]));
  assert.equal(broken.status, 422);
  assert.equal(broken.payload.error.code, "CSV_INVALID_ENCODING", "non-UTF-8 bytes get the clear encoding message");
  const crossStore = await uploadCsv(`${importPathA}?dryRun=true`, tokenB, goodCsv);
  assert.equal(crossStore.status, 403, "cross-store merchant token is refused at the boundary");
  summary.createOnly = { productSku: "SKU_EXISTS", variantSku: "SKU_EXISTS", cap: "CSV_TOO_LARGE", encoding: "CSV_INVALID_ENCODING", crossStore: 403 };

  // ---------- 7. category isolation across two stores ----------
  const bImport = await uploadCsv(`/merchant/stores/${storeB.slug}/catalog/import/products`, tokenB, [
    CSV_HEADER,
    "B-SHIRT,قميص باء,,الملابس > رجالي > قمصان,false,B-SHIRT,,7000,2,0,true,",
  ].join("\r\n"));
  assert.equal(bImport.status, 201, JSON.stringify(bImport.payload));
  const aChain = await prisma.productCategory.count({ where: { storeId: storeA.id, name: { in: ["الملابس", "رجالي", "قمصان"] } } });
  const bChain = await prisma.productCategory.count({ where: { storeId: storeB.id, name: { in: ["الملابس", "رجالي", "قمصان"] } } });
  assert.equal(aChain, 3); assert.equal(bChain, 3);
  const bLeaf = await prisma.productCategory.findFirst({ where: { storeId: storeB.id, name: "قمصان" } });
  assert.notEqual(bLeaf.id, leaf.id, "same path, two fully separate trees — no cross-store reuse");
  summary.categoryIsolation = { aChain, bChain, separateRows: true };

  // ---------- 8. export -> reimport round-trip into a fresh store ----------
  const exported = await downloadCsv(`/merchant/stores/${storeA.slug}/catalog/export/products.csv`, tokenA);
  assert.equal(exported.status, 200);
  assert.ok(exported.headers.get("content-type").includes("text/csv"));
  assert.ok(exported.headers.get("content-disposition").includes(`products-${storeA.slug}.csv`));
  assert.deepEqual([exported.bytes[0], exported.bytes[1], exported.bytes[2]], [0xef, 0xbb, 0xbf], "export starts with the UTF-8 BOM bytes");
  const exportedRows = parseCsv(exported.text);
  assert.equal(exportedRows[0].join(","), CSV_HEADER, "export header matches the import contract exactly");
  assert.equal(exportedRows.length, 1 + 4, "one row per variant (3 shirt + 1 rx)");
  const reimport = await uploadCsv(`/merchant/stores/${storeC.slug}/catalog/import/products`, tokenC, exported.text);
  assert.equal(reimport.status, 201, JSON.stringify(reimport.payload));
  assert.equal(reimport.payload.createdProducts, 2);
  assert.equal(reimport.payload.createdVariants, 2);
  const cShirt = await prisma.product.findFirst({ where: { storeId: storeC.id, sku: "CSV-SHIRT" }, include: { variants: { orderBy: [{ isDefault: "desc" }, { position: "asc" }] }, category: { include: { parent: { include: { parent: true } } } } } });
  assert.equal(cShirt.variants.length, 3);
  assert.equal(cShirt.variants[2].priceIqd, 15000, "variant prices survive the round-trip");
  assert.deepEqual(cShirt.variants[1].options, { المقاس: "M" }, "variant options survive the round-trip");
  assert.equal(cShirt.category.name, "قمصان");
  assert.equal(cShirt.category.parent.parent.name, "الملابس", "category path survives the round-trip");
  const cRx = await prisma.product.findFirst({ where: { storeId: storeC.id, sku: "CSV-RX" } });
  assert.equal(cRx.requiresPrescription, true, "prescription flag survives the round-trip");
  summary.roundTrip = { bom: true, rows: exportedRows.length - 1, reimported: { products: 2, variants: 2 } };

  // ---------- 9. orders export: one row per item + coupon column + filters ----------
  const couponCreate = await request(`/merchant/stores/${storeA.slug}/marketing/coupons`, { method: "POST", token: tokenA, body: { code: "CSV10", kind: "percent", percentOff: 10 } });
  assert.equal(couponCreate.status, 201);
  const shopper = await registerCustomer(storeA.slug, "زبونة التصدير", `${testId}.c1@codiq.test`);
  const addSmall = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: shopper.token, body: { variantId: defaultVariant.id, quantity: 2 } });
  assert.equal(addSmall.status, 200);
  const addLarge = await request(`/store/${storeA.slug}/cart/items`, { method: "POST", token: shopper.token, body: { variantId: largeVariant.id, quantity: 1 } });
  assert.equal(addLarge.status, 200);
  const checkedOut = await doCheckout(storeA.slug, shopper, addLarge.payload.cart, { couponCode: "CSV10" });
  assert.equal(checkedOut.status, 201, JSON.stringify(checkedOut.payload));
  const order = checkedOut.payload.order;
  assert.equal(order.discountIqd, 3500, "10% of 35000");
  const ordersExport = await downloadCsv(`/merchant/stores/${storeA.slug}/orders/export.csv`, tokenA);
  assert.equal(ordersExport.status, 200);
  assert.deepEqual([ordersExport.bytes[0], ordersExport.bytes[1], ordersExport.bytes[2]], [0xef, 0xbb, 0xbf]);
  const orderRows = parseCsv(ordersExport.text);
  const header = orderRows[0];
  assert.deepEqual(header.slice(0, 4), ["order_number", "status", "created_at", "customer_name"]);
  const itemRows = orderRows.slice(1).filter((row) => row[header.indexOf("order_number")] === order.orderNumber);
  assert.equal(itemRows.length, 2, "one CSV row per order ITEM");
  const col = (row, name) => row[header.indexOf(name)];
  const smallRow = itemRows.find((row) => col(row, "sku") === "CSV-SHIRT-S");
  const largeRow = itemRows.find((row) => col(row, "sku") === "CSV-SHIRT-L");
  assert.ok(smallRow && largeRow, "both variants appear with their own SKUs (variant-aware)");
  assert.equal(col(smallRow, "quantity"), "2");
  assert.equal(col(smallRow, "unit_price_iqd"), "10000");
  assert.equal(col(smallRow, "line_total_iqd"), "20000");
  assert.equal(col(smallRow, "variant_name"), "صغير");
  assert.equal(col(smallRow, "status"), "new");
  assert.equal(col(smallRow, "customer_name"), "زبونة التصدير");
  assert.equal(col(smallRow, "coupon_code"), "CSV10");
  assert.equal(col(smallRow, "discount_iqd"), "3500");
  assert.equal(col(smallRow, "subtotal_iqd"), "35000");
  assert.equal(col(smallRow, "delivery_fee_iqd"), "2500");
  assert.equal(col(smallRow, "total_iqd"), "34000");
  const filtered = await downloadCsv(`/merchant/stores/${storeA.slug}/orders/export.csv?status=completed`, tokenA);
  assert.equal(parseCsv(filtered.text).length, 1, "status filter leaves only the header when nothing matches");
  const badFilter = await fetch(`${base}/merchant/stores/${storeA.slug}/orders/export.csv?status=bogus`, { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(badFilter.status, 422);
  const exportDenied = await downloadCsv(`/merchant/stores/${storeA.slug}/orders/export.csv`, tokenB);
  assert.equal(exportDenied.status, 403, "orders export respects the store boundary");
  summary.ordersExport = { rowsPerItem: 2, couponCode: "CSV10", filterWorks: true, boundary: 403 };

  // ---------- 10. pixels: strict format validation ----------
  const integrationsA = `/merchant/stores/${storeA.slug}/marketing/integrations`;
  for (const attack of [
    { metaPixelId: "<script>alert(1)</script>" },
    { metaPixelId: "123abc" },
    { metaPixelId: "1234" },
    { tiktokPixelId: "abc123lowercase" },
    { tiktokPixelId: 'X"onload="x' },
    { ga4MeasurementId: "G-<script>" },
    { ga4MeasurementId: "UA-1234567-1" },
    { ga4MeasurementId: "g-abc123" },
  ]) {
    const refused = await request(integrationsA, { method: "PUT", token: tokenA, body: attack });
    assert.equal(refused.status, 422, `${JSON.stringify(attack)} must be refused`);
    assert.equal(refused.payload.error.code, "INVALID_PIXEL_FORMAT");
  }
  assert.equal(await prisma.storeMarketingSettings.count({ where: { storeId: storeA.id } }), 0, "nothing stored after refused writes");
  const saved = await request(integrationsA, { method: "PUT", token: tokenA, body: { metaPixelId: "1234567890123", tiktokPixelId: "ABC123DEF456G", ga4MeasurementId: "G-ABC123XYZ" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.settings.metaPixelId, "1234567890123");
  assert.equal(saved.payload.settings.isEnabled, false, "enable is a separate explicit opt-in");
  const boundaryDenied = await request(integrationsA, { method: "PUT", token: tokenB, body: { isEnabled: true } });
  assert.equal(boundaryDenied.status, 403, "settings.manage boundary holds");
  summary.pixelValidation = { refusedShapes: 8, stored: "valid only", boundary: 403 };

  // ---------- 11. public-config gating ----------
  const disabledConfig = await request(`/store/${storeA.slug}/public-config`);
  assert.equal(disabledConfig.status, 200);
  assert.equal(disabledConfig.payload.pixels, undefined, "pixels ABSENT while the integration is disabled");
  assert.equal((await request(integrationsA, { method: "PUT", token: tokenA, body: { isEnabled: true } })).status, 200);
  const enabledConfig = await request(`/store/${storeA.slug}/public-config`);
  assert.deepEqual(enabledConfig.payload.pixels, { metaPixelId: "1234567890123", tiktokPixelId: "ABC123DEF456G", ga4MeasurementId: "G-ABC123XYZ" });
  assert.equal((await request(integrationsA, { method: "PUT", token: tokenA, body: { isEnabled: false } })).status, 200);
  assert.equal((await request(`/store/${storeA.slug}/public-config`)).payload.pixels, undefined, "disabling removes the pixels again");
  assert.equal((await request(integrationsA, { method: "PUT", token: tokenA, body: { isEnabled: true } })).status, 200);
  await prisma.store.update({ where: { id: storeA.id }, data: { isActive: false } });
  assert.equal((await request(`/store/${storeA.slug}/public-config`)).status, 404, "an inactive store exposes NO public config at all");
  await prisma.store.update({ where: { id: storeA.id }, data: { isActive: true } });
  summary.publicConfig = { disabledAbsent: true, enabledPresent: true, inactiveStore: 404 };

  // ---------- 12. two-store pixel isolation ----------
  const bConfig = await request(`/store/${storeB.slug}/public-config`);
  assert.equal(bConfig.status, 200);
  assert.equal(bConfig.payload.pixels, undefined, "store B never sees store A's pixels");
  const bSettings = await request(`/merchant/stores/${storeB.slug}/marketing/integrations`, { token: tokenB });
  assert.equal(bSettings.payload.settings.metaPixelId, null);
  await request(`/merchant/stores/${storeB.slug}/marketing/integrations`, { method: "PUT", token: tokenB, body: { metaPixelId: "9876543210987", isEnabled: true } });
  const aConfigAfterB = await request(`/store/${storeA.slug}/public-config`);
  assert.equal(aConfigAfterB.payload.pixels.metaPixelId, "1234567890123", "store A keeps its own id after store B configures");
  const bConfigAfter = await request(`/store/${storeB.slug}/public-config`);
  assert.equal(bConfigAfter.payload.pixels.metaPixelId, "9876543210987");
  assert.equal(bConfigAfter.payload.pixels.tiktokPixelId, undefined, "store B only exposes what it configured");
  summary.pixelIsolation = { a: "1234567890123", b: "9876543210987", crossLeak: false };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}

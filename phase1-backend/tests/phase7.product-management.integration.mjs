import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import http from "node:http";
import { spawn } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createApp } from "../src/http/app.ts";
import { prisma } from "../src/db/prisma.ts";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.ts";
import { killTree } from "./helpers/child-process.mjs";

const testId = `phase7-${Date.now()}`;
const bucket = `codiq-${testId}`;
const s3Port = 4569;
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
if (process.env.DATABASE_URL !== testDatabaseUrl || process.env.CODIQ_POSTGRES_URL !== testDatabaseUrl) throw new Error("Refusing TRUNCATE: runtime database variables must both equal CODIQ_TEST_DATABASE_URL.");

process.env.PRODUCT_S3_ENDPOINT = `http://127.0.0.1:${s3Port}`;
process.env.PRODUCT_S3_BUCKET = bucket;
process.env.PRODUCT_S3_ACCESS_KEY_ID = "S3RVER";
process.env.PRODUCT_S3_SECRET_ACCESS_KEY = "S3RVER";
process.env.PRODUCT_S3_REGION = "us-east-1";
process.env.PRODUCT_S3_FORCE_PATH_STYLE = "true";
process.env.SESSION_JWT_SECRET = "phase7-test-secret-only-not-for-production";

const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
// 12s, not 3s: a cold Python start on a loaded developer machine overruns the
// original window, and the suite then fails for a reason unrelated to the code.
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  if (attempt === 59) throw new Error("Moto S3-compatible test server did not start.");
}
const s3 = new S3Client({ endpoint: process.env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { token, method = "GET", body, form } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

/**
 * 19-د (ATTACK-SURFACE) — does an upload route decide BEFORE it reads the body?
 *
 * The probe announces a 40 MB multipart body in `Content-Length`, writes a small
 * prefix, and then DELIBERATELY NEVER FINISHES THE REQUEST. Two outcomes, and
 * they mean opposite things:
 *
 *   · a status arrives  → the route answered on the headers alone. The 40 MB was
 *     never buffered, and the socket carrying the rest is dropped rather than
 *     held. This is the behaviour the fix installs.
 *   · the probe times out → the server is still waiting for the body it was
 *     promised, holding whatever arrived, and will only reach its guard once the
 *     last byte lands. That is the pre-fix ordering: multer in the middleware
 *     slot, the guard inside the handler. Twenty of these connections are an
 *     OOM-kill of the one container serving the API, the dashboard and every
 *     storefront — from a stranger with no account at all.
 */
function probeUploadOrdering(path, { token, method = "POST", field = "images", timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(`${base}${path}`);
    const boundary = "----codiq19dOrderingProbe";
    const prefix = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="payload.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      // A real prefix, so a server that DOES buffer has something to hold.
      Buffer.alloc(64 * 1024, 0x41),
    ]);
    const probe = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        // The promise the attacker makes and never keeps.
        "content-length": String(40 * 1024 * 1024),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve({ ...value, bytesSent: prefix.length });
    };
    const timer = setTimeout(() => finish({ status: null, waitedForBody: true }), timeoutMs);
    probe.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => finish({ status: response.statusCode, waitedForBody: false, body: Buffer.concat(chunks).toString("utf8") }));
      // A refusal may close the socket before `end` — the status line is what matters.
      response.on("aborted", () => finish({ status: response.statusCode, waitedForBody: false, body: Buffer.concat(chunks).toString("utf8") }));
    });
    probe.on("error", () => finish({ status: null, waitedForBody: false, transportError: true }));
    probe.write(prefix);
  });
}

try {
  await prisma.inventoryMovement.deleteMany({});
  await prisma.productImage.deleteMany({});
  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, settlements, ledger_entries, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders CASCADE");
  await prisma.orderItem.deleteMany({});
  await prisma.storeOrder.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.productCategory.deleteMany({});
  await prisma.customerSession.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.merchantSession.deleteMany({});
  await prisma.staffSession.deleteMany({});
  await prisma.staffMembershipPermissionOverride.deleteMany({});
  await prisma.storeStaffMembership.deleteMany({});
  await prisma.staff.deleteMany({});
  await prisma.merchantSubscription.deleteMany({});
  await prisma.store.deleteMany({});
  await prisma.merchant.deleteMany({});
  await prisma.platformOwnerSession.deleteMany({});
  await prisma.platformOwner.deleteMany({});

  const owner = await request("/auth/platform/register", { method: "POST", body: { email: `${testId}.owner@codiq.test`, password: "OwnerPass123!", displayName: "Owner phase 7" } });
  assert.equal(owner.status, 201);
  const merchantA = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100602901", email: `${testId}.a@codiq.test`, password: "MerchantPass123!", businessName: "متجر A" });
  const merchantB = await registerMerchantDirect({ ownerName: "صاحب المتجر", phone: "+9647100602902", email: `${testId}.b@codiq.test`, password: "MerchantPass123!", businessName: "متجر B" });
  const storeA = await prisma.store.create({ data: { merchantId: merchantA.payload.account.id, name: "متجر A", slug: `${testId}-a`, defaultSubdomain: `${testId}-a` } });
  const storeB = await prisma.store.create({ data: { merchantId: merchantB.payload.account.id, name: "متجر B", slug: `${testId}-b`, defaultSubdomain: `${testId}-b` } });
  const loginA = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.a@codiq.test`, password: "MerchantPass123!" } });
  const loginB = await request("/auth/merchant/login", { method: "POST", body: { identifier: `${testId}.b@codiq.test`, password: "MerchantPass123!" } });
  assert.equal(loginA.status, 200); assert.equal(loginB.status, 200);
  const tokenA = loginA.payload.accessToken; const tokenB = loginB.payload.accessToken;

  const categoryA = await request(`/merchant/stores/${storeA.slug}/catalog/categories`, { token: tokenA, method: "POST", body: { name: "قهوة" } });
  const categoryB = await request(`/merchant/stores/${storeB.slug}/catalog/categories`, { token: tokenB, method: "POST", body: { name: "أدوات مكتبية" } });
  assert.equal(categoryA.status, 201); assert.equal(categoryB.status, 201);
  const categoryAUpdated = await request(`/merchant/stores/${storeA.slug}/catalog/categories/${categoryA.payload.category.id}`, { token: tokenA, method: "PATCH", body: { name: "قهوة عربية" } });
  assert.equal(categoryAUpdated.status, 200); assert.equal(categoryAUpdated.payload.category.name, "قهوة عربية");
  const duplicateCategory = await request(`/merchant/stores/${storeA.slug}/catalog/categories`, { token: tokenA, method: "POST", body: { name: "  قهوة عربية " } });
  assert.equal(duplicateCategory.status, 409); assert.equal(duplicateCategory.payload.error.code, "DUPLICATE_CATEGORY");

  const productA = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { token: tokenA, method: "POST", body: { sku: "COFFEE-001", name: "قهوة عربية أصلية", description: "حبوب محمصة طازجة", priceIqd: 12000, stockQuantity: 2, lowStockThreshold: 3, categoryId: categoryA.payload.category.id } });
  const productB = await request(`/merchant/stores/${storeB.slug}/catalog/products`, { token: tokenB, method: "POST", body: { sku: "DESK-001", name: "مصباح مكتبي", description: "إضاءة LED", priceIqd: 24500, stockQuantity: 15, lowStockThreshold: 3, categoryId: categoryB.payload.category.id } });
  assert.equal(productA.status, 201); assert.equal(productB.status, 201);
  const productAUpdated = await request(`/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}`, { token: tokenA, method: "PATCH", body: { name: "قهوة عربية محمصة", description: "حبوب محمصة طازجة", priceIqd: 13000, categoryId: categoryA.payload.category.id } });
  assert.equal(productAUpdated.status, 200); assert.equal(productAUpdated.payload.product.priceIqd, 13000); assert.equal(productAUpdated.payload.product.description, "حبوب محمصة طازجة");
  const deleteCandidate = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { token: tokenA, method: "POST", body: { sku: "REMOVE-001", name: "منتج حذف تجريبي", priceIqd: 1, stockQuantity: 0, lowStockThreshold: 0 } });
  const ownDelete = await request(`/merchant/stores/${storeA.slug}/catalog/products/${deleteCandidate.payload.product.id}`, { token: tokenA, method: "DELETE" });
  // PG-2: the delete became a SOFT delete and answers 200 with
  // { id, deletedAt, purgeAt } instead of a bare 204 — the client needs purgeAt
  // for the retention countdown and the id for the «تراجع» button.
  assert.equal(ownDelete.status, 200, JSON.stringify(ownDelete.payload));
  assert.ok(ownDelete.payload.deletedAt && ownDelete.payload.purgeAt, "PG-2: the soft delete reports its purge date");

  const foreignCategoryOnProduct = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { token: tokenA, method: "POST", body: { sku: "INVALID-001", name: "غير مسموح", priceIqd: 1, stockQuantity: 0, lowStockThreshold: 0, categoryId: categoryB.payload.category.id } });
  assert.equal(foreignCategoryOnProduct.status, 404); assert.equal(foreignCategoryOnProduct.payload.error.code, "CATEGORY_NOT_FOUND");
  // Phase 19-ج: a categoryId that is not a uuid is refused HERE. It used to be
  // handed to Prisma, which raised P2023 on the uuid column — a code the error
  // handler has no branch for — so a typo answered 500 instead of 404.
  const malformedCategory = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { token: tokenA, method: "POST", body: { sku: "INVALID-002", name: "تصنيف غير صالح", priceIqd: 1, categoryId: "shoes" } });
  assert.equal(malformedCategory.status, 422, JSON.stringify(malformedCategory.payload));
  assert.equal(malformedCategory.payload.error.code, "VALIDATION_FAILED");
  assert.equal(malformedCategory.payload.error.fields[0].path, "categoryId");
  // …and the shape refusals the catalog used to spell out one by one are now one
  // code that names the field a form has to point at.
  const blankName = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { token: tokenA, method: "POST", body: { sku: "INVALID-003", name: "   ", priceIqd: 1 } });
  assert.equal(blankName.status, 422, JSON.stringify(blankName.payload));
  assert.equal(blankName.payload.error.code, "VALIDATION_FAILED");
  assert.equal(blankName.payload.error.fields[0].path, "name");
  // The Number() leniency the catalog has had since phase 7 survives: «5» is five.
  const numericStrings = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { token: tokenA, method: "POST", body: { sku: "COERCE-001", name: "منتج بأرقام نصية", priceIqd: "1500", stockQuantity: "4" } });
  assert.equal(numericStrings.status, 201, JSON.stringify(numericStrings.payload));
  assert.equal(numericStrings.payload.product.priceIqd, 1500);
  assert.equal(numericStrings.payload.product.stockQuantity, 4);
  let directTriggerCode = null;
  try { await prisma.$executeRaw`UPDATE products SET category_id = ${categoryB.payload.category.id}::uuid WHERE id = ${productA.payload.product.id}::uuid`; }
  catch (error) { directTriggerCode = error?.meta?.code ?? null; }
  assert.equal(directTriggerCode, "23514");

  const form = new FormData(); form.append("images", new Blob([png], { type: "image/png" }), "coffee.png");
  const uploaded = await request(`/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}/images`, { token: tokenA, method: "POST", form });
  assert.equal(uploaded.status, 201); assert.equal(uploaded.payload.images.length, 1);
  const unsupportedImage = new FormData(); unsupportedImage.append("images", new Blob([Buffer.from("not an image")], { type: "text/plain" }), "invalid.txt");
  const unsupportedUpload = await request(`/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}/images`, { token: tokenA, method: "POST", form: unsupportedImage });
  assert.equal(unsupportedUpload.status, 422); assert.equal(unsupportedUpload.payload.error.code, "INVALID_PRODUCT_IMAGE");
  // ق-238: five megabytes of zeros is no longer refused for its SIZE — the
  // product ceiling is fifteen now, because the upload is re-encoded and the old
  // number was a storage limit wearing an upload rule's clothes. It is still
  // refused, and for the better reason: five megabytes of zeros is not an image,
  // and the magic-byte check has always said so.
  const oversizedImage = new FormData(); oversizedImage.append("images", new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
  const oversizedUpload = await request(`/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}/images`, { token: tokenA, method: "POST", form: oversizedImage });
  assert.equal(oversizedUpload.status, 422); assert.equal(oversizedUpload.payload.error.code, "INVALID_PRODUCT_IMAGE");
  // ---------- 19-د (ATTACK-SURFACE): the guard runs BEFORE multer buffers ----
  // All four upload routes, probed with NO session at all. The slug, product id
  // and order id are invented on the spot — that was the finding's sharpest
  // point: the route matches and used to parse regardless of whether any of
  // them exist, because nothing had looked at the caller yet.
  const orderingProbes = {
    productImages: await probeUploadOrdering(`/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}/images`),
    csvImport: await probeUploadOrdering(`/merchant/stores/${storeA.slug}/catalog/import/products`, { field: "file" }),
    prescription: await probeUploadOrdering("/store/no-such-store/account/orders/00000000-0000-4000-8000-000000000000/prescription", { field: "prescription" }),
    platformLogo: await probeUploadOrdering("/platform/brand/logo", { method: "PUT", field: "file" }),
  };
  for (const [name, probe] of Object.entries(orderingProbes)) {
    assert.equal(probe.waitedForBody, false, `${name}: the route waited for the 40 MB body before deciding — the guard is still downstream of multer`);
    assert.ok(probe.status >= 400 && probe.status < 500, `${name}: an anonymous upload must be refused with a 4xx, got ${probe.status}`);
  }

  // The control that keeps the assertion honest: with a REAL session the route
  // does not short-circuit — it accepts the connection and waits for the body,
  // which is what an upload route is supposed to do. Without this, deleting the
  // routes entirely would pass the block above.
  const authorizedProbe = await probeUploadOrdering(`/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}/images`, { token: tokenA, timeoutMs: 2000 });
  assert.equal(authorizedProbe.waitedForBody, true, "an authorized upload must still be accepted and read, not refused on its headers");

  // ق-238 — WHAT COMES BACK IS NOT WHAT WENT IN, AND THAT IS THE POINT.
  //
  // This used to assert the response was byte-for-byte the uploaded file. It no
  // longer can be: the upload is re-encoded to three webp sizes on the way in,
  // because one product picture rides twenty-four cards of a catalog page and a
  // phone photo made that page thirty-six megabytes. What is worth pinning now
  // is the CONTRACT: every size is served, each is a real webp, and `?v=` picks
  // between them rather than being ignored.
  const imageA = uploaded.payload.images[0];
  const imageBase = `${base}/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}/images/${imageA.id}`;
  const auth = { headers: { authorization: `Bearer ${tokenA}` } };
  const served = {};
  for (const variant of ["", "?v=thumb", "?v=card", "?v=full"]) {
    const response = await fetch(`${imageBase}${variant}`, auth);
    assert.equal(response.status, 200, `the ${variant || "default"} variant must be served`);
    assert.equal(response.headers.get("content-type"), "image/webp", "every stored variant is webp whatever the merchant uploaded");
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.length > 0, `the ${variant || "default"} variant must carry bytes`);
    // RIFF....WEBP — the file's own word, not the header's claim.
    assert.equal(body.subarray(0, 4).toString(), "RIFF", "the bytes must decode as a real webp container");
    assert.equal(body.subarray(8, 12).toString(), "WEBP", "the bytes must decode as a real webp container");
    served[variant || "default"] = body.length;
  }
  // An absent `?v=` must be the CARD, not the original and not a third thing.
  assert.equal(served.default, served["?v=card"], "no ?v= must serve exactly the card — a forgetful client fails toward the small picture");
  // And the row is charged for what STORAGE holds, not for what was sent.
  assert.notEqual(imageA.byteSize, png.length, "byteSize is the variant set, not the upload");
  assert.ok(imageA.byteSize > 0, "byteSize must still be a real number");

  const lowStock = await request(`/merchant/stores/${storeA.slug}/catalog/products?lowStock=true`, { token: tokenA });
  assert.equal(lowStock.status, 200); assert.equal(lowStock.payload.products[0].id, productA.payload.product.id); assert.equal(lowStock.payload.products[0].isLowStock, true);
  const inventory = await request(`/merchant/stores/${storeA.slug}/catalog/products/${productA.payload.product.id}/inventory`, { token: tokenA, method: "POST", body: { stockQuantity: 10, reason: "استلام شحنة" } });
  assert.equal(inventory.status, 200); assert.equal(inventory.payload.product.isLowStock, false);

  const crossUpdate = await request(`/merchant/stores/${storeB.slug}/catalog/products/${productA.payload.product.id}`, { token: tokenB, method: "PATCH", body: { name: "محاولة اختراق" } });
  const crossDelete = await request(`/merchant/stores/${storeB.slug}/catalog/products/${productA.payload.product.id}`, { token: tokenB, method: "DELETE" });
  const crossImage = await fetch(`${base}/merchant/stores/${storeB.slug}/catalog/products/${productB.payload.product.id}/images/${imageA.id}`, { headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(crossUpdate.status, 404); assert.equal(crossUpdate.payload.error.code, "RESOURCE_NOT_FOUND");
  assert.equal(crossDelete.status, 404); assert.equal(crossDelete.payload.error.code, "RESOURCE_NOT_FOUND");
  assert.equal(crossImage.status, 404);

  const crossCategoryEdit = await request(`/merchant/stores/${storeB.slug}/catalog/categories/${categoryA.payload.category.id}`, { token: tokenB, method: "PATCH", body: { name: "محاولة اختراق" } });
  const categoryListB = await request(`/merchant/stores/${storeB.slug}/catalog/categories`, { token: tokenB });
  assert.equal(crossCategoryEdit.status, 404); assert.equal(crossCategoryEdit.payload.error.code, "CATEGORY_NOT_FOUND");
  assert.equal(categoryListB.payload.categories.some((category) => category.id === categoryA.payload.category.id), false);

  const categoryInUse = await request(`/merchant/stores/${storeA.slug}/catalog/categories/${categoryA.payload.category.id}`, { token: tokenA, method: "DELETE" });
  assert.equal(categoryInUse.status, 409); assert.equal(categoryInUse.payload.error.code, "CATEGORY_IN_USE");

  // Keyset pagination over rows that share a createdAt.
  //
  // A CSV import writes its products in one transaction, so they all carry the
  // same created_at. Ordering by created_at alone leaves their relative order
  // undefined, and PostgreSQL is free to return a different permutation per
  // query — which lets the cursor skip rows or repeat them across pages. The
  // fixture forces that collision on purpose: nine products, one timestamp.
  const sameInstant = new Date("2026-03-01T09:00:00.000Z");
  const paginationIds = [];
  for (let index = 0; index < 9; index += 1) {
    const created = await request(`/merchant/stores/${storeA.slug}/catalog/products`, { token: tokenA, method: "POST", body: { sku: `PAGE-${index}`, name: `منتج ترقيم ${index}`, priceIqd: 1000 + index, stockQuantity: 5 } });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    paginationIds.push(created.payload.product.id);
  }
  await prisma.product.updateMany({ where: { id: { in: paginationIds } }, data: { createdAt: sameInstant } });

  const walked = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const query = `limit=4${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await request(`/merchant/stores/${storeA.slug}/catalog/products?${query}`, { token: tokenA });
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    walked.push(...response.payload.products.map((product) => product.id));
    cursor = response.payload.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null, "the walk must terminate rather than cycle");
  const collided = walked.filter((id) => paginationIds.includes(id));
  assert.equal(collided.length, paginationIds.length, "no same-instant product is dropped or returned twice");
  assert.deepEqual([...new Set(collided)], collided, "every same-instant product appears exactly once across the pages");
  // The sharp assertion: with a tiebreaker the group falls in descending id
  // order, which is the only stable order available once createdAt ties. A
  // canonical uuid is fixed-width hex, so a JS string sort matches PostgreSQL's
  // uuid ordering. Without the tiebreaker this is whatever the planner returns.
  assert.deepEqual(collided, [...paginationIds].sort().reverse(), "same-instant rows fall back to a descending id order");

  console.log(JSON.stringify({ categoryIsolation: { crossEdit: crossCategoryEdit.status, categoryVisibleToOtherStore: false, directDatabaseTrigger: directTriggerCode }, productIdor: { update: crossUpdate.status, delete: crossDelete.status, image: crossImage.status }, imageUpload: { status: uploaded.status, byteSize: png.length, unsupported: unsupportedUpload.status, oversized: oversizedUpload.status }, uploadOrdering: { ...Object.fromEntries(Object.entries(orderingProbes).map(([name, probe]) => [name, { status: probe.status, waitedForBody: probe.waitedForBody }])), authorizedControlWaited: authorizedProbe.waitedForBody }, inventory: { lowStockBefore: true, lowStockAfter: inventory.payload.product.isLowStock }, pagination: { sameInstantProducts: paginationIds.length, walkedPages: Math.ceil(walked.length / 4), duplicates: 0, missing: 0 }, products: { storeA: productA.payload.product.id, storeB: productB.payload.product.id } }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  killTree(moto);
  await prisma.$disconnect();
}

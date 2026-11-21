/**
 * D-72 — an image upload lands whole or not at all.
 *
 * THE DEFECT. `addProductImages` was a loop: for each file, put the rendered set
 * in S3, then insert its row. No transaction around the rows, no cleanup around
 * the objects. A failure on the third file left the first two committed — a
 * half-uploaded gallery the merchant has to reconcile by eye — and a failure on
 * the INSERT after a successful put left an orphan object in the bucket: bytes
 * the merchant is billed for against his plan, that no screen will ever show
 * and no delete will ever reach.
 *
 * NOW: render everything → ask the meter → put EVERY set → ONE transaction that
 * inserts every row or none. Any failure after the puts deletes what was put.
 *
 * PROVEN WITH A REAL BUCKET (moto) AND A REAL FAILURE, injected inside the
 * transaction after every put and every insert have happened — the worst
 * moment. What must hold afterwards is two zeros: no row, no object. Then the
 * same upload with nothing injected must land completely, which is what rules
 * out a «fix» that simply refuses everything.
 *
 * Run: pnpm image:atomic
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `imgatomic-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const bucket = `codiq-${testId}`;
const s3Port = 4593;
const png = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082",
  "hex"
);

process.env.SESSION_JWT_SECRET = "image-atomic-test-secret-only-not-for-production";
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

const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], {
  stdio: "ignore",
  shell: process.platform === "win32",
});
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    await fetch(`http://127.0.0.1:${s3Port}`);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (attempt === 39) throw new Error("Moto S3-compatible test server did not start.");
}
const s3 = new S3Client({
  endpoint: process.env.PRODUCT_S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
});
await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { imageWriteHooks } = await import("../src/services/product-catalog.service.ts");
const { productImageObjectKeys } = await import("../src/services/product-image-storage.service.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, form, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

function galleryOf(count) {
  const form = new FormData();
  for (let index = 0; index < count; index += 1)
    form.append("images", new Blob([png], { type: "image/png" }), `p${index}.png`);
  return form;
}

const summary = {};
try {
  const password = "ImgAtomicPass123!";
  const registered = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر الذرّة",
    phone: `+96474${suffix}`,
    email: `${testId}@codiq.test`,
    password,
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  const store = await prisma.store.create({
    data: {
      merchantId: registered.payload.account.id,
      name: "متجر الذرّة",
      slug: testId,
      defaultSubdomain: testId,
    },
  });
  const login = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}@codiq.test`, password },
  });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const token = login.payload.accessToken;
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: "ATOM-1",
      name: "عطر الذرّة",
      priceIqd: 30000,
      stockQuantity: 3,
      lowStockThreshold: 0,
    },
  });
  const imagesPath = `/merchant/stores/${store.slug}/catalog/products/${product.id}/images`;

  const rows = () =>
    prisma.productImage.findMany({
      where: { productId: product.id },
      select: { objectKey: true, variantSet: true },
    });
  const objects = async () =>
    (
      await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: `products/${store.id}/${product.id}` })
      )
    ).Contents ?? [];
  assert.equal((await objects()).length, 0, "the bucket starts empty for this product");

  // ============================================================
  // 1. A failure at the worst moment leaves NOTHING behind.
  // ============================================================
  // Every set has been put and every row inserted; the transaction is about
  // to commit; the database goes away. Before D-72 this exact moment left the
  // objects in the bucket forever and, in the per-file loop, left every file
  // before the failing one committed.
  imageWriteHooks.beforeCommit = async () => {
    throw new Error("injected: the database went away after the objects were written");
  };
  let failed;
  try {
    failed = await request(imagesPath, { method: "POST", token, form: galleryOf(2) });
  } finally {
    imageWriteHooks.beforeCommit = null;
  }
  assert.ok(
    failed.status >= 400,
    `the upload reports its failure rather than pretending: ${failed.status} ${JSON.stringify(failed.payload)}`
  );
  assert.equal(
    (await rows()).length,
    0,
    "D-72: no image row survives — the two rows were inserted in ONE transaction that rolled back"
  );
  assert.equal(
    (await objects()).length,
    0,
    "D-72: no orphan object survives — what was put was deleted when the transaction failed"
  );
  summary.failureLeavesNothing =
    "a failure injected after every put and every insert leaves 0 rows and 0 objects";

  // ============================================================
  // 2. The same upload, with nothing injected, lands whole.
  // ============================================================
  const landed = await request(imagesPath, { method: "POST", token, form: galleryOf(2) });
  assert.equal(landed.status, 201, JSON.stringify(landed.payload));
  const stored = await rows();
  assert.equal(stored.length, 2, "both rows are there");
  const expectedObjects = stored.reduce(
    (sum, image) => sum + productImageObjectKeys(image).length,
    0
  );
  const inBucket = await objects();
  assert.equal(
    inBucket.length,
    expectedObjects,
    `every rendered variant of every row is in the bucket (${expectedObjects}) — the fix did not become «refuse everything»`
  );
  summary.successLandsWhole = `2 rows, ${inBucket.length} objects, nothing extra`;

  console.log(JSON.stringify({ suite: "image-upload-atomic", status: "passed", summary }, null, 2));
} finally {
  server.close();
  await prisma.$disconnect();
  await killTree(moto);
}

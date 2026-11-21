/**
 * Marketplace M12 — «البحث بالصورة» over HTTP, with a real bucket (moto) and pgvector.
 *
 *   1. Indexing: a picture uploaded by the store gets its fingerprint right after
 *      the upload; the owner's sweep fills what is missing.
 *   2. Search: a shopper's photo of the red dress (smaller, re-compressed) finds
 *      the red dresses first, with a similarity; not the ball or the shirt;
 *      never an unlisted store's product or one taken off sale. The photo is not kept.
 *   3. «يشبهه في الشكل»: the other red dress, not itself.
 *   4. Refused: a script named .jpg, no file, a foreign origin; the owner's
 *      routes are the owner's.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const testId = `m12${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const s3Port = 4598;
const bucket = `codiq-${testId}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
Object.assign(process.env, {
  PRODUCT_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
  PRODUCT_S3_BUCKET: bucket,
  PRODUCT_S3_ACCESS_KEY_ID: "S3RVER",
  PRODUCT_S3_SECRET_ACCESS_KEY: "S3RVER",
  PRODUCT_S3_REGION: "us-east-1",
  PRODUCT_S3_FORCE_PATH_STYLE: "true",
});
const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
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

const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
await prisma.storefrontRateLimit.deleteMany({
  where: {
    OR: [{ scope: { startsWith: "market_image" } }, { scope: { startsWith: "product_image" } }],
  },
});
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function client(bearer) {
  return async (path, { method = "GET", body, form, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        origin: base,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    return {
      status: response.status,
      headers: response.headers,
      payload: await response.json().catch(() => null),
    };
  };
}
const anyone = client();

// Pictures drawn here: two red dresses, a blue dress, a striped shirt, an orange ball.
const svg = (inner, bg = "#ffffff") =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="100%" height="100%" fill="${bg}"/>${inner}</svg>`
  );
const dress = (colour) =>
  `<path d="M240 80 L360 80 L380 220 L470 720 L130 720 L220 220 Z" fill="${colour}"/>`;
const shirt = `<defs><pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="20" height="40" fill="#1e3a8a"/><rect x="20" width="20" height="40" fill="#f5f5f5"/></pattern></defs><path d="M150 150 L250 100 L350 100 L450 150 L520 300 L440 330 L420 260 L420 720 L180 720 L180 260 L160 330 L80 300 Z" fill="url(#s)"/>`;
const ball = `<circle cx="300" cy="400" r="220" fill="#f97316"/><path d="M80 400 Q300 300 520 400" stroke="#111" stroke-width="10" fill="none"/>`;
const png = (buffer) => sharp(buffer).png().toBuffer();
const pictures = {
  redDress: await png(svg(dress("#dc2626"))),
  redDress2: await png(
    svg(
      `<path d="M250 90 L350 90 L370 230 L460 720 L140 720 L230 230 Z" fill="#c81e1e"/>`,
      "#f4f4f4"
    )
  ),
  blueDress: await png(svg(dress("#2563eb"))),
  shirt: await png(svg(shirt)),
  ball: await png(svg(ball)),
};
const photoOfRedDress = await sharp(pictures.redDress).resize(300).jpeg({ quality: 60 }).toBuffer();
const photoForm = (buffer, name = "photo.jpg", type = "image/jpeg") => {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type }), name);
  return form;
};

const summary = {};
const storeIds = [];
try {
  const ownerEmail = `${testId}.owner@codiq.test`;
  await anyone("/auth/platform/register", {
    method: "POST",
    body: { email: ownerEmail, password: "OwnerPass123!Strong", displayName: "مالك" },
  });
  const owner = client(
    (
      await anyone("/auth/platform/login", {
        method: "POST",
        body: { email: ownerEmail, password: "OwnerPass123!Strong" },
      })
    ).payload.accessToken
  );
  async function merchant(label, n, marketStatus) {
    const email = `${testId}.${label}@codiq.test`;
    const reg = await registerMerchantDirect({
      ownerName: "تاجر",
      businessName: "متجر",
      phone: `+9647${n}${digits}2`.slice(0, 14),
      email,
      password: "MarketVisual!2026",
    });
    const store = await prisma.store.create({
      data: {
        merchantId: reg.payload.account.id,
        name: `أزياء ${testId} ${label}`,
        slug: `${testId}-${label}`,
        defaultSubdomain: `${testId}-${label}`,
        marketStatus,
        marketStatusAt: new Date(),
        ...(marketStatus === "listed" ? { marketListedAt: new Date() } : {}),
      },
    });
    storeIds.push(store.id);
    const token = (
      await anyone("/auth/merchant/login", {
        method: "POST",
        body: { identifier: email, password: "MarketVisual!2026" },
      })
    ).payload.accessToken;
    return { store, api: client(token) };
  }
  const A = await merchant("a", 5, "listed");
  const hidden = await merchant("h", 8, "unlisted");
  const products = {};
  async function productWith(m, key, name, picture) {
    const product = await prisma.product.create({
      data: {
        storeId: m.store.id,
        sku: `${testId}-${key}`,
        name: `${name} ${testId}`,
        priceIqd: 30000,
        stockQuantity: 5,
      },
    });
    const form = new FormData();
    form.append("images", new Blob([picture], { type: "image/png" }), `${key}.png`);
    const uploaded = await m.api(
      `/merchant/stores/${m.store.slug}/catalog/products/${product.id}/images`,
      { method: "POST", form }
    );
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.payload));
    products[key] = product;
    return product;
  }
  await productWith(A, "redDress", "فستان أحمر", pictures.redDress);
  await productWith(A, "redDress2", "فستان سهرة أحمر", pictures.redDress2);
  await productWith(A, "blueDress", "فستان أزرق", pictures.blueDress);
  await productWith(A, "shirt", "قميص مقلّم", pictures.shirt);
  await productWith(A, "ball", "كرة", pictures.ball);
  await productWith(hidden, "hiddenRed", "فستان أحمر مخفي", pictures.redDress);
  const mine = (rows) => rows.filter((row) => row.name.endsWith(testId));

  // ── 1. indexing ──────────────────────────────────────────────────────────
  const listedIds = ["redDress", "redDress2", "blueDress", "shirt", "ball"].map(
    (key) => products[key].id
  );
  for (
    let attempt = 0;
    attempt < 50 &&
    (await prisma.productImageEmbedding.count({ where: { productId: { in: listedIds } } })) < 5;
    attempt += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    await prisma.productImageEmbedding.count({ where: { productId: { in: listedIds } } }),
    5,
    "fingerprinted right after the upload"
  );
  assert.equal(
    await prisma.productImageEmbedding.count({ where: { productId: products.hiddenRed.id } }),
    0,
    "an unlisted store's product is not indexed"
  );
  await prisma.productImageEmbedding.delete({ where: { productId: products.ball.id } });
  assert.ok((await owner("/platform/market/image-index")).payload.pending >= 1);
  const run = await owner("/platform/market/image-index/run", {
    method: "POST",
    body: { limit: 500 },
  });
  assert.equal(run.status, 200, JSON.stringify(run.payload));
  assert.ok(run.payload.indexedNow >= 1 && run.payload.model === "codiq-visual-v1");
  assert.equal(
    await prisma.productImageEmbedding.count({ where: { productId: products.ball.id } }),
    1,
    "the sweep fills the gap"
  );
  summary.indexing = true;

  // ── 2. search by photo ───────────────────────────────────────────────────
  const objectsBefore = (await s3.send(new ListObjectsV2Command({ Bucket: bucket }))).KeyCount;
  const found = await anyone("/market/search/image", {
    method: "POST",
    form: photoForm(photoOfRedDress),
  });
  assert.equal(found.status, 200, JSON.stringify(found.payload));
  assert.equal(found.headers.get("cache-control"), "private, no-store");
  const results = mine(found.payload.products);
  assert.ok(results.length >= 2, JSON.stringify(results.map((row) => [row.name, row.similarity])));
  assert.deepEqual(
    results
      .slice(0, 2)
      .map((row) => row.id)
      .sort(),
    [products.redDress.id, products.redDress2.id].sort(),
    "the red dresses first"
  );
  assert.equal(results[0].id, products.redDress.id, "the same dress before its cousin");
  assert.ok(results[0].similarity >= 90, `similarity ${results[0].similarity}`);
  assert.ok(results.every((row) => row.similarity >= found.payload.floor));
  assert.ok(
    !results.some((row) => [products.ball.id, products.shirt.id].includes(row.id)),
    "not the ball or the shirt"
  );
  assert.ok(
    !found.payload.products.some((row) => row.id === products.hiddenRed.id),
    "never an unlisted store's"
  );
  assert.equal(
    (await s3.send(new ListObjectsV2Command({ Bucket: bucket }))).KeyCount,
    objectsBefore,
    "the shopper's photo is not stored"
  );
  await prisma.product.update({ where: { id: products.redDress2.id }, data: { isActive: false } });
  assert.ok(
    !mine(
      (await anyone("/market/search/image", { method: "POST", form: photoForm(photoOfRedDress) }))
        .payload.products
    ).some((row) => row.id === products.redDress2.id),
    "a product taken off sale drops out"
  );
  await prisma.product.update({ where: { id: products.redDress2.id }, data: { isActive: true } });
  summary.search = true;

  // ── 3. look-alike ────────────────────────────────────────────────────────
  const alike = await anyone(`/market/products/${products.redDress.id}/look-alike`);
  assert.equal(alike.status, 200);
  assert.equal(mine(alike.payload.products)[0]?.id, products.redDress2.id, "its cousin");
  assert.ok(!alike.payload.products.some((row) => row.id === products.redDress.id), "not itself");
  assert.equal((await anyone(`/market/products/${products.hiddenRed.id}/look-alike`)).status, 404);
  summary.lookAlike = true;

  // ── 4. refused ───────────────────────────────────────────────────────────
  assert.equal(
    (
      await anyone("/market/search/image", {
        method: "POST",
        form: photoForm(Buffer.from("<?php system($_GET['c']); ?>"), "x.jpg"),
      })
    ).payload.error.code,
    "IMAGE_TYPE_NOT_ALLOWED"
  );
  assert.equal(
    (await anyone("/market/search/image", { method: "POST", form: new FormData() })).payload.error
      .code,
    "IMAGE_REQUIRED"
  );
  assert.equal(
    (
      await anyone("/market/search/image", {
        method: "POST",
        form: photoForm(photoOfRedDress),
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403
  );
  const tooBig = await anyone("/market/search/image", {
    method: "POST",
    form: photoForm(Buffer.concat([photoOfRedDress, Buffer.alloc(9 * 1024 * 1024)])),
  });
  assert.deepEqual([tooBig.status, tooBig.payload.error.code], [422, "INVALID_SEARCH_IMAGE"]);
  assert.match(
    tooBig.payload.error.message,
    /8 MB/,
    "the search photo's own ceiling, not the product picture's"
  );
  assert.ok(
    [401, 403].includes((await A.api("/platform/market/image-index")).status),
    "a store is not the owner"
  );
  assert.ok(
    [401, 403].includes(
      (await anyone("/platform/market/image-index/run", { method: "POST", body: {} })).status
    )
  );
  summary.refused = true;

  console.log(JSON.stringify({ suite: "market-visual", ok: true, summary }, null, 2));
} finally {
  await prisma.store
    .updateMany({
      where: { id: { in: storeIds } },
      data: { marketStatus: "unlisted", marketStatusAt: new Date() },
    })
    .catch(() => undefined);
  server.close();
  await prisma.$disconnect();
  await killTree(moto);
}

/**
 * ق-198 / ق-210 — the merchant's own front-page images, proven end to end.
 *
 * The storefront had nothing a merchant could change above the fold. This proves
 * the whole path: he uploads, orders, hides and deletes; a shopper sees only the
 * live slides and can fetch their bytes; another tenant sees none of it; and the
 * two things that could hurt someone are refused — a `javascript:` link, and an
 * unbounded slider quietly eating the storage plan. Section 9 adds ق-210: the two
 * placements are two sliders with two ceilings, and a slide moves between them
 * without a re-upload.
 *
 * Run: pnpm banners:test
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const testId = `ban-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
process.env.CODIQ_ALLOW_OWNER_REGISTRATION = "true";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);

// ── an S3 the suite owns, exactly as phase 7 does ────────────────────────────
// The upload path is the point of this suite, so it must run against a real
// object store rather than be skipped when one is absent. moto is what CI uses.
const { spawn } = await import("node:child_process");
const { CreateBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
const { killTree } = await import("./helpers/child-process.mjs");
const bucket = `codiq-${testId}`;
const s3Port = 4571;
process.env.PRODUCT_S3_ENDPOINT = `http://127.0.0.1:${s3Port}`;
process.env.PRODUCT_S3_BUCKET = bucket;
process.env.PRODUCT_S3_ACCESS_KEY_ID = "S3RVER";
process.env.PRODUCT_S3_SECRET_ACCESS_KEY = "S3RVER";
process.env.PRODUCT_S3_REGION = "us-east-1";
process.env.PRODUCT_S3_FORCE_PATH_STYLE = "true";
const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    await fetch(`http://127.0.0.1:${s3Port}`);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (attempt === 59) throw new Error("Moto S3-compatible test server did not start.");
}
await new S3Client({
  endpoint: process.env.PRODUCT_S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
}).send(new CreateBucketCommand({ Bucket: bucket }));

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");
const { createTypedSession } = await import("../src/auth/identity.ts");
const { MAX_STORE_BANNERS } = await import("../src/services/store-banner.service.ts");
await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits");

const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** A real 1x1 PNG — the storage validator reads MAGIC BYTES, so a fake buffer is refused. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload, headers: response.headers };
}

async function upload(slug, token, { linkUrl, altText, placement, image } = {}) {
  const form = new FormData();
  const file = image ?? { bytes: PNG, type: "image/png", name: "slide.png" };
  form.append("image", new Blob([file.bytes], { type: file.type }), file.name);
  if (linkUrl !== undefined) form.append("linkUrl", linkUrl);
  if (altText !== undefined) form.append("altText", altText);
  if (placement !== undefined) form.append("placement", placement);
  const response = await fetch(`${base}/merchant/stores/${slug}/banners`, {
    method: "POST",
    headers: { origin: base, authorization: `Bearer ${token}` },
    body: form,
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

const summary = {};
try {
  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    businessName: "متجر اللافتات",
    phone: `+96479${suffix}`,
    email: `${testId}.a@codiq.test`,
    password: "BannerMerchant!2026",
  });
  assert.equal(merchantA.status, 201, JSON.stringify(merchantA.payload));
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.payload.account.id,
      name: "متجر اللافتات",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const tokenA = await createTypedSession("merchant", merchantA.payload.account.id, storeA.id);

  const merchantB = await registerMerchantDirect({
    ownerName: "تاجر آخر",
    businessName: "متجر الجار",
    phone: `+96477${suffix}`,
    email: `${testId}.b@codiq.test`,
    password: "BannerNeighbour!2026",
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.payload.account.id,
      name: "متجر الجار",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const tokenB = await createTypedSession("merchant", merchantB.payload.account.id, storeB.id);

  // ── 1. an empty storefront says so, rather than failing ──────────────────
  const empty = await request(`/store/${storeA.slug}/banners`);
  assert.equal(empty.status, 200, JSON.stringify(empty.payload));
  assert.deepEqual(
    empty.payload.banners,
    [],
    "a store with no slides answers an empty list, not a 404"
  );
  summary.emptyIsAList = true;

  // ── 2. the merchant uploads, and the shopper sees it ─────────────────────
  const first = await upload(storeA.slug, tokenA, { altText: "عرض العيد" });
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  assert.equal(
    first.payload.banner.altText,
    "عرض العيد",
    "ق-198: the Arabic alt text survives — phase 22 owes WCAG and a hero of pure images is unreadable without it"
  );
  assert.equal(
    first.payload.banner.isActive,
    true,
    "a new slide is live by default; hiding is the deliberate act"
  );
  const second = await upload(storeA.slug, tokenA, { linkUrl: "https://example.com/eid" });
  assert.equal(second.status, 201, JSON.stringify(second.payload));
  assert.equal(
    second.payload.banner.sortOrder,
    first.payload.banner.sortOrder + 1,
    "slides queue in upload order"
  );

  const shopper = await request(`/store/${storeA.slug}/banners`);
  assert.equal(shopper.payload.banners.length, 2);
  assert.deepEqual(
    shopper.payload.banners.map((row) => row.id),
    [first.payload.banner.id, second.payload.banner.id],
    "…and the shopper sees them in that order"
  );
  summary.uploadedAndVisible = 2;

  // ── 3. the bytes come back, cacheable and typed ──────────────────────────
  const bytes = await fetch(
    `${base}/store/${storeA.slug}/banners/${first.payload.banner.id}/image`
  );
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.match(
    bytes.headers.get("cache-control") ?? "",
    /immutable/,
    "the object key carries a uuid, so the bytes under one id never change"
  );
  // Review batch 3, م-٤: the SAME PICTURE comes back — not the same bytes, which carried the
  // uploader's EXIF; it is re-encoded in its own format, so its type and size are kept.
  const sharpCheck = (await import("sharp")).default;
  const servedMeta = await sharpCheck(Buffer.from(await bytes.arrayBuffer())).metadata();
  const sentMeta = await sharpCheck(PNG).metadata();
  assert.deepEqual(
    [servedMeta.format, servedMeta.width, servedMeta.height],
    [sentMeta.format, sentMeta.width, sentMeta.height],
    "the same picture comes back"
  );
  summary.bytesServed = true;

  // ── 4. hiding removes it from the shop and NOT from the merchant ─────────
  const hidden = await request(
    `/merchant/stores/${storeA.slug}/banners/${second.payload.banner.id}`,
    { method: "PATCH", token: tokenA, body: { isActive: false } }
  );
  assert.equal(hidden.status, 200, JSON.stringify(hidden.payload));
  assert.equal(
    (await request(`/store/${storeA.slug}/banners`)).payload.banners.length,
    1,
    "ق-198: a hidden slide leaves the shop"
  );
  assert.equal(
    (await request(`/merchant/stores/${storeA.slug}/banners`, { token: tokenA })).payload.banners
      .length,
    2,
    "…and stays in the merchant's own list, because he is the one who hid it"
  );
  assert.equal(
    (await fetch(`${base}/store/${storeA.slug}/banners/${second.payload.banner.id}/image`)).status,
    404,
    "…and its bytes stop being public with it"
  );
  summary.hideIsNotDelete = true;

  // ── 5. a javascript: link is refused — this is the one that hurts someone ─
  const poisoned = await upload(storeA.slug, tokenA, { linkUrl: "javascript:alert(1)" });
  assert.equal(
    poisoned.status,
    422,
    "ق-198: a slide is an anchor the merchant shows every one of his shoppers"
  );
  assert.equal(poisoned.payload.error.code, "VALIDATION_FAILED");
  const poisonedPatch = await request(
    `/merchant/stores/${storeA.slug}/banners/${first.payload.banner.id}`,
    { method: "PATCH", token: tokenA, body: { linkUrl: "javascript:alert(1)" } }
  );
  assert.equal(poisonedPatch.status, 422, "…and PATCH is not the way around POST");
  summary.javascriptLinkRefused = { onCreate: 422, onUpdate: 422 };

  // ── 6. another tenant's slide is not found, not forbidden ────────────────
  const foreignPatch = await request(
    `/merchant/stores/${storeB.slug}/banners/${first.payload.banner.id}`,
    { method: "PATCH", token: tokenB, body: { isActive: false } }
  );
  assert.equal(
    foreignPatch.status,
    404,
    "the query is scoped to the store, so a foreign row is simply absent"
  );
  const foreignDelete = await request(
    `/merchant/stores/${storeB.slug}/banners/${first.payload.banner.id}`,
    { method: "DELETE", token: tokenB }
  );
  assert.equal(foreignDelete.status, 404);
  assert.equal(
    (await request(`/merchant/stores/${storeA.slug}/banners`, { token: tokenA })).payload.banners
      .length,
    2,
    "…and store A still has both"
  );
  summary.tenantIsolation = 404;

  // ── 7. the slider is bounded ─────────────────────────────────────────────
  //
  // Twelve is a ceiling, not a policy: nobody scrolls twelve hero images, and an
  // unbounded slider is a way to spend the storage plan without noticing.
  const already = (await request(`/merchant/stores/${storeA.slug}/banners`, { token: tokenA }))
    .payload.banners.length;
  for (let index = already; index < MAX_STORE_BANNERS; index += 1) {
    const filler = await upload(storeA.slug, tokenA);
    assert.equal(
      filler.status,
      201,
      `filling to the cap failed at ${index}: ${JSON.stringify(filler.payload)}`
    );
  }
  const overflow = await upload(storeA.slug, tokenA);
  assert.equal(overflow.status, 422, "ق-198: the slider is bounded");
  assert.equal(overflow.payload.error.code, "BANNER_LIMIT_REACHED");
  summary.cap = MAX_STORE_BANNERS;

  // ── 8. deleting frees the row ────────────────────────────────────────────
  const del = await request(`/merchant/stores/${storeA.slug}/banners/${first.payload.banner.id}`, {
    method: "DELETE",
    token: tokenA,
  });
  assert.equal(del.status, 204);
  assert.equal(await prisma.storeBanner.count({ where: { id: first.payload.banner.id } }), 0);
  assert.equal(
    (await upload(storeA.slug, tokenA)).status,
    201,
    "…and the freed slot is usable again"
  );
  summary.deleteFreesASlot = true;

  // ── 9. ق-210 — the front page has TWO sliders, and they are two decisions ─
  //
  // Store A's HERO slider is at its cap by now (section 7 filled it). If the cap
  // were counted over the table instead of over the placement, the merchant could
  // not put a single promo strip in the middle of his page — which is exactly the
  // defect this asserts against.
  const heroFull = (
    await request(`/merchant/stores/${storeA.slug}/banners`, { token: tokenA })
  ).payload.banners.filter((row) => row.placement === "hero").length;
  assert.equal(
    heroFull,
    MAX_STORE_BANNERS,
    "the hero slider is at its ceiling before the mid one is touched"
  );
  const mid = await upload(storeA.slug, tokenA, { placement: "mid", altText: "شريط العيد" });
  assert.equal(
    mid.status,
    201,
    `ق-210: a full hero slider must not block the middle strip — ${JSON.stringify(mid.payload)}`
  );
  assert.equal(mid.payload.banner.placement, "mid");
  assert.equal(
    mid.payload.banner.sortOrder,
    0,
    "the middle strip keeps its own order, starting from the beginning"
  );

  const defaulted = await upload(storeB.slug, tokenB);
  assert.equal(defaulted.status, 201, JSON.stringify(defaulted.payload));
  assert.equal(
    defaulted.payload.banner.placement,
    "hero",
    "ق-210: a slide uploaded without a placement opens the page, where every slide from before this existed belongs"
  );

  const withPlacement = await request(`/store/${storeA.slug}/banners`);
  assert.equal(withPlacement.status, 200);
  assert.ok(
    withPlacement.payload.banners.every(
      (row) => row.placement === "hero" || row.placement === "mid"
    ),
    "every public slide says which slider it belongs to"
  );
  assert.equal(
    withPlacement.payload.banners.filter((row) => row.placement === "mid").length,
    1,
    "…and the shopper's payload carries the middle strip beside the hero slides, in one request"
  );

  const moved = await request(`/merchant/stores/${storeA.slug}/banners/${mid.payload.banner.id}`, {
    method: "PATCH",
    token: tokenA,
    body: { placement: "hero" },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.payload));
  assert.equal(
    moved.payload.banner.placement,
    "hero",
    "a slide moves between the sliders as an edit"
  );
  assert.equal(
    moved.payload.banner.altText,
    "شريط العيد",
    "…and keeps its bytes, its link and its description, which a delete-and-re-upload would not"
  );
  const movedBack = await request(
    `/merchant/stores/${storeA.slug}/banners/${mid.payload.banner.id}`,
    { method: "PATCH", token: tokenA, body: { placement: "mid" } }
  );
  assert.equal(movedBack.payload.banner.placement, "mid");

  const nonsense = await upload(storeA.slug, tokenA, { placement: "sidebar" });
  assert.equal(
    nonsense.status,
    422,
    "ق-210: a placement the storefront cannot draw is an invisible slide the merchant paid storage for"
  );
  assert.equal(nonsense.payload.error.code, "VALIDATION_FAILED");
  summary.placements = {
    heroCap: MAX_STORE_BANNERS,
    midAcceptedWhileHeroFull: true,
    defaultsToHero: true,
    movesWithoutReupload: true,
    unknownRefused: 422,
  };

  // Review batch 3, م-٤: a phone photo carries EXIF — its GPS among it. A banner is public, so
  // what the merchant uploads must not tell the world where he stood. Product images were
  // re-encoded for exactly this; the store's own images were stored byte for byte.
  const sharp = (await import("sharp")).default;
  const MARKER = "CODIQ-REVIEW-GPS-31.5N-44.3E";
  const photo = await sharp({
    create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: MARKER, Artist: MARKER } } })
    .toBuffer();
  assert.ok(photo.includes(Buffer.from(MARKER)), "the test photo does carry the marker");
  const withExif = await upload(storeA.slug, tokenA, {
    placement: "mid",
    image: { bytes: photo, type: "image/jpeg", name: "phone.jpg" },
  });
  assert.equal(withExif.status, 201, JSON.stringify(withExif.payload));
  const served = Buffer.from(
    await (
      await fetch(`${base}/store/${storeA.slug}/banners/${withExif.payload.banner.id}/image`)
    ).arrayBuffer()
  );
  assert.ok(served.length > 0);
  assert.ok(!served.includes(Buffer.from(MARKER)), "the public banner carries no EXIF");
  summary.metadataStripped = true;

  console.log(JSON.stringify({ suite: "store-banners", status: "passed", summary }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  await killTree(moto);
}

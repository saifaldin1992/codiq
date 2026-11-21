/**
 * Marketplace M10 — short videos, over HTTP, with a real bucket (moto).
 *
 *   1. Upload: the video's bytes decide its type (a script named .mp4 is
 *      refused), only the store's own product may be tagged, at most ten wait
 *      for review.
 *   2. Review: nothing is public before the owner approves; the store and the
 *      owner can preview; a rejection needs a reason.
 *   3. The feed and the deep link: approved reels of listed stores, with the
 *      product card; one store's reels; an unlisted store's reel is hidden.
 *   4. Streaming: a Range request answers 206 with the exact bytes.
 *   5. Counts: a view once per viewer per day, likes once per shopper.
 *   6. The store takes a reel down: gone from the feed, the bytes deleted.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

process.env.CODIQ_ALLOW_OWNER_REGISTRATION ??= "true";
const testId = `m10${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const s3Port = 4596;
const bucket = `codiq-${testId}`;
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
Object.assign(process.env, { PRODUCT_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`, PRODUCT_S3_BUCKET: bucket, PRODUCT_S3_ACCESS_KEY_ID: "S3RVER", PRODUCT_S3_SECRET_ACCESS_KEY: "S3RVER", PRODUCT_S3_REGION: "us-east-1", PRODUCT_S3_FORCE_PATH_STYLE: "true" });
const moto = spawn("moto_server", ["-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { await fetch(`http://127.0.0.1:${s3Port}`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  if (attempt === 39) throw new Error("Moto S3-compatible test server did not start.");
}
const s3 = new S3Client({ endpoint: process.env.PRODUCT_S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" } });
await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const { prisma } = await import("../src/db/prisma.ts");
const { createApp } = await import("../src/http/app.ts");
const { setOtpProviderForTests } = await import("../src/modules/market-account/otp.service.ts");
await prisma.storefrontRateLimit.deleteMany({ where: { OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_reel" } }] } });

const sent = [];
setOtpProviderForTests({ name: "capture", async send(phone, code) { sent.push({ phone, code }); } });
const server = createApp().listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = {};

// A minimal ISO-BMFF header (ftyp, brand mp42) followed by bytes the test can recognise.
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "latin1"), Buffer.alloc(12), Buffer.from("0123456789abcdefghij".repeat(50), "latin1")]);
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000000970485973000003e8000003e801b57b526b000000114944415408d763e0d10bfb0fc20c300600322c063d26facb460000000049454e44ae426082", "hex");

function client(bearer) {
  const jar = new Map();
  return {
    async request(path, { method = "GET", body, form, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), origin: base, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...headers },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
      for (const line of response.headers.getSetCookie?.() ?? []) { const [pair] = line.split(";"); const eq = pair.indexOf("="); jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1)); }
      const type = response.headers.get("content-type") ?? "";
      return { status: response.status, headers: response.headers, payload: type.includes("json") ? await response.json().catch(() => null) : Buffer.from(await response.arrayBuffer()) };
    },
  };
}
const reelForm = (video, fields = {}, poster) => {
  const form = new FormData();
  if (video) form.append("video", new Blob([video], { type: "video/mp4" }), "clip.mp4");
  if (poster) form.append("poster", new Blob([poster], { type: "image/png" }), "poster.png");
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
};

const created = { stores: [] };
try {
  const ownerEmail = `${testId}.owner@codiq.test`;
  assert.ok([200, 201].includes((await client().request("/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: "OwnerPass123!Strong", displayName: "مالك" } })).status));
  const owner = client((await client().request("/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: "OwnerPass123!Strong" } })).payload.accessToken);
  const listed = { marketStatus: "listed", marketStatusAt: new Date(), marketListedAt: new Date() };
  async function merchantWithStore(label, n) {
    const email = `${testId}.${label}@codiq.test`;
    const reg = await registerMerchantDirect({ ownerName: "تاجر", businessName: "متجر", phone: `+9647${n}${digits}6`.slice(0, 14), email, password: "MarketReels!2026" });
    const store = await prisma.store.create({ data: { merchantId: reg.payload.account.id, name: `متجر ${testId} ${label}`, slug: `${testId}-${label}`, defaultSubdomain: `${testId}-${label}`, ...listed } });
    created.stores.push(store.id);
    const product = await prisma.product.create({ data: { storeId: store.id, sku: `${testId}-${label}`, name: `منتج ${label}`, priceIqd: 15000, stockQuantity: 10 } });
    const token = (await client().request("/auth/merchant/login", { method: "POST", body: { identifier: email, password: "MarketReels!2026" } })).payload.accessToken;
    return { store, product, api: client(token) };
  }
  const A = await merchantWithStore("a", 5);
  const B = await merchantWithStore("b", 8);
  const up = (m, form) => m.api.request(`/merchant/stores/${m.store.slug}/market-reels`, { method: "POST", form });

  // ── 1. upload ────────────────────────────────────────────────────────────
  assert.equal((await up(A, reelForm(null))).payload.error.code, "REEL_VIDEO_REQUIRED");
  assert.equal((await up(A, reelForm(Buffer.from("<?php system($_GET['c']); ?> not a video at all")))).payload.error.code, "REEL_TYPE_NOT_ALLOWED", "a script named .mp4 is refused");
  assert.equal((await up(A, reelForm(mp4, { productId: B.product.id }))).status, 404, "another store's product");
  const first = await up(A, reelForm(mp4, { caption: "طريقة الاستعمال", productId: A.product.id }, png));
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  const reelId = first.payload.reel.id;
  assert.equal(first.payload.reel.status, "pending");
  summary.upload = true;

  // ── 2. review ────────────────────────────────────────────────────────────
  assert.equal((await client().request(`/market/reels/${reelId}`)).status, 404, "not public before review");
  assert.equal((await client().request(`/market/reels/${reelId}/video`)).status, 404);
  const preview = await A.api.request(`/merchant/stores/${A.store.slug}/market-reels/${reelId}/video`);
  assert.deepEqual([preview.status, preview.payload.equals(mp4)], [200, true], "the store previews its own");
  assert.equal((await B.api.request(`/merchant/stores/${B.store.slug}/market-reels/${reelId}/video`)).status, 404, "not another store's");
  const queue = (await owner.request("/platform/market/reels")).payload.reels;
  assert.ok(queue.some((row) => row.id === reelId));
  assert.equal((await owner.request(`/platform/market/reels/${reelId}/video`)).status, 200, "the owner previews");
  assert.equal((await owner.request(`/platform/market/reels/${reelId}/decision`, { method: "POST", body: { approve: false } })).payload.error.code, "REEL_REJECTION_NOTE_REQUIRED");
  assert.ok([401, 403].includes((await A.api.request(`/platform/market/reels/${reelId}/decision`, { method: "POST", body: { approve: true } })).status), "a store cannot approve itself");
  assert.equal((await owner.request(`/platform/market/reels/${reelId}/decision`, { method: "POST", body: { approve: true } })).payload.reel.status, "approved");
  summary.review = true;

  // ── 3. feed + deep link ──────────────────────────────────────────────────
  const feed = (await client().request("/market/reels")).payload.reels;
  const mine = feed.find((row) => row.id === reelId);
  assert.ok(mine, "approved: in the feed");
  assert.deepEqual([mine.caption, mine.product.id, mine.product.priceIqd, mine.store.slug, Boolean(mine.posterUrl)], ["طريقة الاستعمال", A.product.id, 15000, A.store.slug, true]);
  assert.equal((await client().request(`/market/reels/${reelId}`)).payload.reel.id, reelId, "the deep link");
  assert.equal((await client().request(`/market/reels/${reelId}/poster`)).status, 200);
  assert.ok((await client().request(`/market/reels?store=${B.store.slug}`)).payload.reels.every((row) => row.store.slug === B.store.slug), "one store's reels");
  const bReel = (await up(B, reelForm(mp4))).payload.reel.id;
  await owner.request(`/platform/market/reels/${bReel}/decision`, { method: "POST", body: { approve: true } });
  await prisma.store.update({ where: { id: B.store.id }, data: { marketStatus: "unlisted" } });
  assert.ok(!(await client().request("/market/reels")).payload.reels.some((row) => row.id === bReel), "an unlisted store's reel is hidden");
  summary.feed = true;

  // ── 4. streaming ─────────────────────────────────────────────────────────
  const partial = await client().request(`/market/reels/${reelId}/video`, { headers: { range: "bytes=4-11" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 4-11/${mp4.length}`);
  assert.equal(partial.payload.toString("latin1"), "ftypmp42", "exactly the bytes asked for");
  const whole = await client().request(`/market/reels/${reelId}/video`);
  assert.deepEqual([whole.status, whole.headers.get("accept-ranges"), whole.payload.length], [200, "bytes", mp4.length]);
  summary.streaming = true;

  // ── 5. counts ────────────────────────────────────────────────────────────
  const shopper = client();
  const asked = await shopper.request("/market/auth/code", { method: "POST", body: { phone: `+96477${digits}4`.slice(0, 14) } });
  await shopper.request("/market/auth/verify", { method: "POST", body: { challengeId: asked.payload.challengeId, code: sent.at(-1).code } });
  assert.equal((await shopper.request(`/market/reels/${reelId}/view`, { method: "POST" })).payload.counted, true);
  assert.equal((await shopper.request(`/market/reels/${reelId}/view`, { method: "POST" })).payload.counted, false, "the same viewer the same day counts once");
  assert.equal((await client().request(`/market/reels/${reelId}/view`, { method: "POST" })).payload.counted, true, "a visitor is a different viewer");
  assert.equal((await client().request(`/market/reels/${reelId}/view`, { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await client().request(`/market/reels/${reelId}/like`, { method: "PUT", body: { liked: true } })).status, 401, "a like needs a shopper");
  assert.equal((await shopper.request(`/market/reels/${reelId}/like`, { method: "PUT", body: { liked: true } })).payload.likes, 1);
  assert.equal((await shopper.request(`/market/reels/${reelId}/like`, { method: "PUT", body: { liked: true } })).payload.likes, 1, "twice is still one");
  const seen = (await shopper.request(`/market/reels/${reelId}`)).payload.reel;
  assert.deepEqual([seen.views, seen.likes, seen.liked], [2, 1, true]);
  assert.equal((await shopper.request(`/market/reels/${reelId}/like`, { method: "PUT", body: { liked: false } })).payload.likes, 0);
  summary.counts = true;

  // ── 6. taken down; the queue limit ───────────────────────────────────────
  const stored = await prisma.marketReel.findUniqueOrThrow({ where: { id: reelId } });
  assert.equal((await A.api.request(`/merchant/stores/${A.store.slug}/market-reels/${reelId}`, { method: "DELETE" })).status, 200);
  assert.equal((await client().request(`/market/reels/${reelId}`)).status, 404);
  await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: stored.videoObjectKey })), "the bytes are deleted");
  for (let i = 0; i < 10; i += 1) assert.equal((await up(A, reelForm(mp4))).status, 201);
  assert.equal((await up(A, reelForm(mp4))).payload.error.code, "REEL_QUEUE_FULL", "ten waiting at most");
  assert.equal((await A.api.request(`/merchant/stores/${A.store.slug}/market-reels?limit=5`)).payload.reels.length, 5);
  summary.takenDown = true;

  // ── 7. a reel is charged to the plan's storage, like the store's images ────
  const { merchantUsage, activePlanForMerchant } = await import("../src/services/entitlement.service.ts");
  const { applyPlanTermsNow } = await import("./helpers/plan-terms.ts");
  const merchantB = B.store.merchantId;
  const usageBefore = (await merchantUsage(prisma, merchantB)).max_image_storage_mb;
  const big = await prisma.marketReel.create({ data: { storeId: B.store.id, videoObjectKey: `test/${testId}/big.mp4`, videoContentType: "video/mp4", videoByteSize: 3 * 1024 * 1024 } });
  assert.equal((await merchantUsage(prisma, merchantB)).max_image_storage_mb - usageBefore, 3, "a stored reel counts in the storage meter");
  await prisma.marketReel.update({ where: { id: big.id }, data: { status: "removed" } });
  assert.equal((await merchantUsage(prisma, merchantB)).max_image_storage_mb, usageBefore, "…and a removed one (its bytes deleted) does not");
  const planB = await activePlanForMerchant(prisma, merchantB);
  const planRow = await prisma.plan.findUniqueOrThrow({ where: { code: planB.code }, select: { id: true } });
  const storageFeature = await prisma.planFeature.findFirstOrThrow({ where: { planId: planRow.id, featureCode: "max_image_storage_mb" }, select: { id: true, limitValue: true } });
  await prisma.planFeature.update({ where: { id: storageFeature.id }, data: { limitValue: usageBefore } });
  await applyPlanTermsNow(prisma, planRow.id);
  let overCap;
  try {
    overCap = await up(B, reelForm(mp4));
  } finally {
    await prisma.planFeature.update({ where: { id: storageFeature.id }, data: { limitValue: storageFeature.limitValue } });
    await applyPlanTermsNow(prisma, planRow.id);
  }
  assert.equal(overCap.status, 403, `an upload past the plan's storage is refused — ${JSON.stringify(overCap.payload)}`);
  assert.equal(overCap.payload.error.code, "PLAN_LIMIT_EXCEEDED");
  summary.storageMeter = true;

  console.log(JSON.stringify({ suite: "market-reels", ok: true, summary }, null, 2));
} finally {
  setOtpProviderForTests(null);
  await prisma.store.updateMany({ where: { id: { in: created.stores } }, data: { marketStatus: "unlisted", marketStatusAt: new Date() } }).catch(() => undefined);
  server.close();
  await prisma.$disconnect();
  await killTree(moto);
}

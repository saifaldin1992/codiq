/**
 * P27-20 (ق-107) — the platform logo the owner uploads.
 *
 * What this suite is really guarding is a set of promises that are cheap to make
 * and easy to break:
 *   - a raster below 512×512 is REFUSED, because the owner cannot see softness
 *     on his own screen and would only learn about it from a customer;
 *   - the stored URL carries a VERSION, so replacing the logo actually changes
 *     what a cached browser shows;
 *   - the public endpoint serves the CURRENT logo only, and is not a reader for
 *     any key an attacker can name in the bucket;
 *   - reverting always works, because the default lives in the code.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { killTree } from "./helpers/child-process.mjs";
import { assertSafeTestDatabaseUrl } from "./helpers/test-database-guard.js";

const databaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
const port = Number(process.env.P27_BRAND_PORT ?? 3212);
const base = `http://127.0.0.1:${port}`;
const s3Port = Number(process.env.P27_BRAND_S3_PORT ?? 5212);
const s3Endpoint = `http://127.0.0.1:${s3Port}`;
const bucket = "codiq-brand-test";
const runId = `brand-${Date.now().toString(36)}`;

const runSeed = Number.parseInt(Date.now().toString().slice(-8), 10);

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

/** A real PNG of the requested size — the header is what the server reads. */
function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let server;
let moto;

async function request(path, { method = "GET", token, body, headers = {} } = {}) {
  const init = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, payload, headers: response.headers, raw: text };
}

function upload(buffer, filename, type) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), filename);
  return form;
}

async function main() {
  const summary = {};

  moto = spawn("moto_server", ["-p", String(s3Port)], { shell: true, stdio: "ignore" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await fetch(s3Endpoint); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const s3 = new S3Client({ endpoint: s3Endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));

  await prisma.$executeRawUnsafe("TRUNCATE TABLE storefront_rate_limits, platform_settings CASCADE");
  await prisma.$executeRawUnsafe("TRUNCATE TABLE platform_owner_sessions, platform_owners CASCADE");

  server = spawn("node", ["dist/index.js"], {
    shell: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      CODIQ_POSTGRES_URL: databaseUrl,
      CODIQ_POSTGRES_URL_UNPOOLED: databaseUrl,
      CODIQ_ALLOW_OWNER_REGISTRATION: "true",
      PRODUCT_S3_ENDPOINT: s3Endpoint,
      PRODUCT_S3_BUCKET: bucket,
      PRODUCT_S3_ACCESS_KEY_ID: "test",
      PRODUCT_S3_SECRET_ACCESS_KEY: "test",
      PRODUCT_S3_REGION: "us-east-1",
    },
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const health = await fetch(`${base}/api/health`); if (health.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const ownerEmail = `${runId}.owner@codiq.test`;
  const ownerPassword = "BrandOwnerPass123!";
  assert.equal((await request("/api/auth/platform/register", { method: "POST", body: { email: ownerEmail, password: ownerPassword, displayName: "مالك العلامة" } })).status, 201);
  const login = await request("/api/auth/platform/login", { method: "POST", body: { email: ownerEmail, password: ownerPassword } });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const token = login.payload.accessToken;

  // ---- the default is always a correct answer ------------------------------
  const beforeUpload = await request("/api/public/brand");
  assert.equal(beforeUpload.status, 200);
  assert.equal(beforeUpload.payload.logo, null, "with nothing uploaded the platform answers «no logo» and the code's vector mark renders");
  summary.defaultState = "public brand endpoint answers null, not an error";

  // ---- a raster below the minimum is refused -------------------------------
  const tooSmall = await request("/api/platform/brand/logo", { method: "PUT", token, body: upload(png(256, 256), "small.png", "image/png") });
  assert.equal(tooSmall.status, 422, JSON.stringify(tooSmall.payload));
  assert.equal(tooSmall.payload.error.code, "PLATFORM_LOGO_TOO_SMALL");
  assert.ok(tooSmall.payload.error.message.includes("256"), "the refusal names the size that was actually uploaded, not a generic rule");
  assert.equal((await request("/api/public/brand")).payload.logo, null, "a refused upload changes nothing");

  // ---- a non-image is refused ---------------------------------------------
  const notAnImage = await request("/api/platform/brand/logo", { method: "PUT", token, body: upload(Buffer.from("GIF89a not really"), "x.gif", "image/gif") });
  assert.equal(notAnImage.status, 422, JSON.stringify(notAnImage.payload));
  assert.equal(notAnImage.payload.error.code, "INVALID_PLATFORM_LOGO");
  // The bytes decide, not the declared type: a GIF renamed .png is still refused.
  const liar = await request("/api/platform/brand/logo", { method: "PUT", token, body: upload(Buffer.from("GIF89a"), "liar.png", "image/png") });
  assert.equal(liar.status, 422, "a file claiming to be a PNG is checked by its header, not its name");
  summary.validation = "under 512 refused with its real size named; content type read from the bytes";

  // ---- a good PNG is accepted and served ----------------------------------
  const accepted = await request("/api/platform/brand/logo", { method: "PUT", token, body: upload(png(512, 512), "logo.png", "image/png") });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.logo.width, 512);
  const publicBrand = await request("/api/public/brand");
  assert.ok(publicBrand.payload.logo?.url, "the public endpoint now serves a URL for every surface to read");
  const firstUrl = publicBrand.payload.logo.url;
  const bytes = await request(firstUrl);
  assert.equal(bytes.status, 200, "the logo bytes are readable without a session — the storefront has no owner to authenticate");
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.ok(bytes.headers.get("cache-control")?.includes("immutable"), "the bytes at a versioned URL never change, so they are cached hard");
  // 19-د: the hardening below is not an SVG special case — every uploaded byte
  // this route hands back carries it, so no future accepted format can slip out
  // inline by having been added to a branch nobody thought about.
  assert.ok(bytes.headers.get("content-disposition")?.startsWith("attachment"), "uploaded logo bytes are served as a download, never as a document");

  // ---- replacing it must actually change what a cached browser sees --------
  await new Promise((r) => setTimeout(r, 1100));
  const replaced = await request("/api/platform/brand/logo", { method: "PUT", token, body: upload(png(1024, 1024), "logo2.png", "image/png") });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.payload));
  const secondUrl = (await request("/api/public/brand")).payload.logo.url;
  assert.notEqual(secondUrl, firstUrl, "a replacement mints a NEW url — a fixed key would leave every cache showing the old logo");
  assert.equal((await request(firstUrl)).status, 404, "and the previous url stops serving, so nothing shows a stale brand");
  summary.versioning = "replacement changes the url; the old url 404s";

  // ---- the public reader is not a bucket browser --------------------------
  const foreign = await request("/api/public/brand/logo/products%2Fsomeone%2Fsecret.png");
  assert.equal(foreign.status, 404, "the endpoint serves the CURRENT logo only — it is not a reader for any key in the bucket");
  summary.notABucketReader = "an arbitrary object key answers 404";

  // ---- 19-د: an SVG logo can never execute on this origin ------------------
  //
  // ق-23 keeps SVG the PREFERRED logo format, so this is not solved by refusing
  // the upload. But an SVG is a script-bearing DOCUMENT, and these bytes are
  // proxied by the app itself — same origin as the dashboards and the
  // `codiq_session` cookie. `brand.manage` is delegable to a platform staff
  // member who is explicitly NOT the owner, so «he uploaded a logo» must not be
  // «he ran script as whoever opens the link». Before this suite covered it the
  // route sent content-type and cache-control and nothing else, and a top-level
  // navigation to the logo URL executed the uploader's <script> as the visitor.
  //
  // The guarantee asserted is about the RESPONSE, not about the bytes: a
  // browser must have no way to treat this URL as a same-origin script host.
  await new Promise((r) => setTimeout(r, 5));
  const hostileSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><script>fetch("/api/platform/staff/team",{method:"POST",credentials:"include"})</script><circle cx="48" cy="48" r="48" fill="#1E6FDB"/></svg>`,
    "utf8",
  );
  const svgUpload = await request("/api/platform/brand/logo", { method: "PUT", token, body: upload(hostileSvg, "logo.svg", "image/svg+xml") });
  assert.equal(svgUpload.status, 200, `the SVG upload itself stays allowed (ق-23) — ${JSON.stringify(svgUpload.payload)}`);
  assert.equal(svgUpload.payload.logo.contentType, "image/svg+xml");
  const svgUrl = (await request("/api/public/brand")).payload.logo.url;
  const svgBytes = await request(svgUrl);
  assert.equal(svgBytes.status, 200, "and the logo still serves, so <img> in BrandMark keeps drawing it");

  // A top-level navigation DOWNLOADS it instead of rendering a document.
  // Content-Disposition is ignored for <img src> subresource loads, which is
  // exactly why the legitimate render above is unaffected.
  const disposition = svgBytes.headers.get("content-disposition");
  assert.ok(
    disposition && /^attachment(;|$)/.test(disposition),
    `an uploaded SVG must be served as a download, never inline on this origin — got content-disposition: ${disposition}`,
  );

  // …and if any client renders it anyway, the response's own policy leaves it
  // nothing to run. `default-src 'none'` covers script-src by fallback.
  const svgCsp = svgBytes.headers.get("content-security-policy");
  assert.ok(svgCsp, "the logo response carries its own CSP — this route serves bytes a PERSON uploaded");
  assert.ok(svgCsp.includes("default-src 'none'"), `the policy must deny script by default — got: ${svgCsp}`);
  assert.equal(/(^|;)\s*script-src\s/.test(svgCsp), false, "and must not re-open script-src after denying it");
  assert.equal(svgBytes.headers.get("x-content-type-options"), "nosniff", "nosniff on the response itself, so it cannot be lost");
  summary.svgLogoCannotExecute = "an uploaded SVG is still accepted, and is served as an attachment under default-src 'none' + nosniff — no same-origin script";

  // ---- permissions ---------------------------------------------------------
  assert.equal((await request("/api/platform/brand/logo", { method: "PUT", body: upload(png(512, 512), "l.png", "image/png") })).status, 401, "no session cannot upload a logo");
  assert.equal((await request("/api/platform/brand/logo", { method: "DELETE" })).status, 401, "nor revert one");

  // ---- reverting always works ---------------------------------------------
  const reverted = await request("/api/platform/brand/logo", { method: "DELETE", token });
  assert.equal(reverted.status, 200, JSON.stringify(reverted.payload));
  assert.equal(reverted.payload.logo, null);
  assert.equal((await request("/api/public/brand")).payload.logo, null, "back on the built-in mark, which needs no storage and cannot fail");
  summary.revert = "deleting the setting restores the code's default";

  // =========================================================================
  // P27-13 (ق-101) — the owner's home page reads ONE server aggregate.
  //
  // The three cards it replaces each fetched a list and counted its length in
  // the browser, so «عدد التجار» stopped being true the moment the platform held
  // more merchants than one page returns. That is the defect this suite exists
  // to keep out: a number that looks right and is not.
  // =========================================================================
  const overviewBefore = await request("/api/platform/overview", { token });
  assert.equal(overviewBefore.status, 200, JSON.stringify(overviewBefore.payload));
  const merchantsInDatabase = await prisma.merchant.count();
  assert.equal(
    overviewBefore.payload.overview.scale.merchants,
    merchantsInDatabase,
    "P27-13: the merchant count is the DATABASE count, not the length of one page",
  );

  // Prove it stays the database's answer past a page boundary. The page size of
  // the merchants list is what the old card was silently capped at.
  // The list this replaced has NO limit (D-18), so "one page" is the whole table.
  const merchantsListBefore = await request("/api/platform/merchants", { token });
  const pageSize = merchantsListBefore.payload.merchants.length;
  const listBytesBefore = merchantsListBefore.raw.length;
  const extraNeeded = Math.max(3, pageSize + 2 - merchantsInDatabase);
  for (let index = 0; index < extraNeeded; index += 1) {
    const created = await request("/api/platform/merchants/manual", {
      method: "POST",
      token,
      body: {
        email: `${runId}.overview-${index}@codiq.test`,
        temporaryPassword: "OverviewPass123!",
        businessName: `تاجر النظرة ${index}`,
        firstStoreName: `متجر النظرة ${index}`,
        ownerName: "صاحب المتجر",
        // Unique per RUN as well as per index: the suite does not truncate merchants,
        // so a fixed number collides with the previous run on the platform-unique
        // phone and answers 409 — a failure that reads like a bug in the feature.
        phone: `+9647${String(100000000 + (runSeed + index) % 899999999).slice(0, 9)}`,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
  }
  const overviewAfter = await request("/api/platform/overview", { token });
  const trueCount = await prisma.merchant.count();
  assert.equal(overviewAfter.payload.overview.scale.merchants, trueCount, `P27-13: still the true count at ${trueCount} merchants`);
  // And the REAL cost of the old card, stated as the property that holds at ANY
  // size rather than as a ratio that depends on the fixture: the old card read
  // /platform/merchants — an endpoint with no limit at all (pre-existing debt
  // D-18) — so the browser downloaded every merchant row, with its subscription
  // joined, to display one integer. The list GROWS with the platform. The
  // aggregate does not.
  const listBytesAfter = (await request("/api/platform/merchants", { token })).raw.length;
  assert.ok(
    listBytesAfter > listBytesBefore,
    `P27-13: the fixture must actually have grown the list — ${listBytesBefore}B then ${listBytesAfter}B`,
  );
  // Not byte-IDENTICAL — the counters themselves gain digits — but BOUNDED: the
  // aggregate grows by the width of a number while the list grows by a row.
  const overviewGrowth = overviewAfter.raw.length - overviewBefore.raw.length;
  const listGrowth = listBytesAfter - listBytesBefore;
  assert.ok(
    overviewGrowth <= 32,
    `P27-13: the aggregate must grow only by the digits of its counters — grew ${overviewGrowth}B for ${extraNeeded} merchants`,
  );
  assert.ok(
    listGrowth > overviewGrowth * 10,
    `P27-13: while the list it replaced grows by a ROW each time — ${listBytesBefore}B → ${listBytesAfter}B (+${listGrowth}) against +${overviewGrowth} on the aggregate`,
  );

  // Nothing on this page is readable without the owner's session.
  assert.equal((await request("/api/platform/overview")).status, 401, "P27-13: the overview needs a platform-owner session");

  // The window is bounded and comparable, and «no baseline» is not «+100%».
  const windowed = await request("/api/platform/overview?days=7", { token });
  assert.equal(windowed.status, 200);
  const period = windowed.payload.overview.commerce.period;
  const spanDays = Math.round((new Date(period.to) - new Date(period.from)) / 86_400_000);
  assert.equal(spanDays, 7, "P27-13: the requested window is the window returned");
  const absurd = await request("/api/platform/overview?days=99999", { token });
  const absurdSpan = Math.round((new Date(absurd.payload.overview.commerce.period.to) - new Date(absurd.payload.overview.commerce.period.from)) / 86_400_000);
  assert.ok(absurdSpan <= 365, `P27-13: an absurd window is clamped, not obeyed — got ${absurdSpan} days`);
  assert.ok(Number.isFinite(windowed.payload.overview.commerce.sales.current), "P27-13: sales is a number, present even when zero");
  summary.ownerOverview = `merchant count is the database's at ${trueCount} merchants (the unbounded list grew to ${listBytesAfter} bytes while the aggregate did not); window clamped to <= 365 days`;

  // =========================================================================
  // P27-16 (ق-104) — a merchant's store must be findable and shareable.
  //
  // Measured before this was written: EVERY store page served the platform's own
  // title, because the app is a single page with a static shell. Ten thousand
  // stores shared one title, and `robots.txt` answered with HTML — which is
  // worse than answering 404.
  // =========================================================================
  const seoMerchantEmail = `${runId}.seo@codiq.test`;
  const seoProvisioned = await request("/api/platform/merchants/manual", {
    method: "POST",
    token,
    body: {
      email: seoMerchantEmail,
      temporaryPassword: "SeoMerchantPass123!",
      businessName: "متجر البحث",
      firstStoreName: "متجر البحث",
      ownerName: "صاحب متجر البحث",
      phone: `+9647${String(200000000 + (runSeed % 700000000)).slice(0, 9)}`,
    },
  });
  assert.equal(seoProvisioned.status, 201, JSON.stringify(seoProvisioned.payload));
  const seoSlug = seoProvisioned.payload.store.slug;
  const seoLogin = await request("/api/auth/merchant/login", { method: "POST", body: { identifier: seoMerchantEmail, password: "SeoMerchantPass123!" } });
  assert.equal(seoLogin.status, 200, JSON.stringify(seoLogin.payload));
  // ق-218: he was provisioned by hand a moment ago, so every merchant surface is
  // refused until he replaces the password the owner typed — proven end to end in
  // `phase6:test`. This suite is about the BRAND and the storefront's head tags,
  // so it does here what he does on his first login.
  const seoOwnedPassword = await request("/api/auth/password", { method: "POST", token: seoLogin.payload.accessToken, body: { currentPassword: "SeoMerchantPass123!", newPassword: "SeoMerchantOwned123!" } });
  assert.equal(seoOwnedPassword.status, 200, JSON.stringify(seoOwnedPassword.payload));
  const seoProduct = await request(`/api/merchant/stores/${seoSlug}/catalog/products`, {
    method: "POST",
    token: seoLogin.payload.accessToken,
    body: { sku: `SEO-${runSeed}`, name: "عطر الياسمين", description: "عطر شرقي بنفحات الياسمين.", priceIqd: 25000, stockQuantity: 7 },
  });
  assert.equal(seoProduct.status, 201, JSON.stringify(seoProduct.payload));
  const seoProductId = seoProduct.payload.product.id;

  const html = async (path) => (await request(path)).raw;

  // ---- robots.txt is a FILE ------------------------------------------------
  const robots = await request("/robots.txt");
  assert.equal(robots.status, 200);
  assert.ok(robots.raw.startsWith("User-agent:"), `robots.txt must be text, not the app shell — got: ${robots.raw.slice(0, 40)}`);
  assert.ok(robots.raw.includes("Disallow: /platform/"), "the owner dashboard is not for crawlers");
  assert.ok(robots.raw.includes("Sitemap:"), "and it points at the sitemap");

  // ---- a store page carries the STORE's identity --------------------------
  const storeHtml = await html(`/store/${seoSlug}`);
  assert.ok(storeHtml.includes("<title>متجر البحث"), `the store page must carry the store's name — got: ${/<title>[^<]*<\/title>/.exec(storeHtml)?.[0]}`);
  assert.ok(storeHtml.includes('"@type":"OnlineStore"'), "and structured data a search engine can read");
  assert.equal((storeHtml.match(/rel="canonical"/g) ?? []).length, 1, "EXACTLY one canonical: a page with two is treated as having none");
  assert.ok(storeHtml.includes(`/store/${seoSlug}"`), "the canonical points at the store, not the platform");

  // ---- a product page carries the PRODUCT, with real price and stock -------
  const productHtml = await html(`/store/${seoSlug}/products/${seoProductId}`);
  assert.ok(productHtml.includes("<title>عطر الياسمين"), "the product page is titled by the product");
  assert.ok(productHtml.includes('"@type":"Product"'), "with Product structured data");
  assert.ok(productHtml.includes('"price":25000'), "the price is the real one from the database");
  assert.ok(productHtml.includes('"availability":"https://schema.org/InStock"'), "and availability is read from real stock, not assumed");
  assert.ok(productHtml.includes('"@type":"BreadcrumbList"'), "with a breadcrumb trail");
  assert.equal(productHtml.includes("aggregateRating"), false, "ق-10: NO rating fields — reviews are CD-2 and do not exist yet");
  assert.equal((productHtml.match(/rel="canonical"/g) ?? []).length, 1, "one canonical here too");

  // Out of stock must say so rather than always claiming availability.
  assert.equal((await request(`/api/merchant/stores/${seoSlug}/catalog/products/${seoProductId}/inventory`, { method: "POST", token: seoLogin.payload.accessToken, body: { stockQuantity: 0, reason: "manual_adjustment" } })).status, 200);
  const soldOutHtml = await html(`/store/${seoSlug}/products/${seoProductId}`);
  assert.ok(soldOutHtml.includes('"availability":"https://schema.org/OutOfStock"'), "a sold-out product says OutOfStock");

  // ---- 19-د: `$` in a merchant's text is TEXT, not a replacement pattern ---
  //
  // The head is rewritten with String.replace. In a replacement STRING the
  // engine expands `$&`, "$`", `$'` and `$1`/`$2` AFTER escapeHtml has run — and
  // escapeHtml covers `[&<>"']`, never `$`, because escaping `$` would corrupt
  // the merchant's own words. So `$2` used to expand to capture group 2, a
  // literal `"`, closing the attribute and letting the merchant choose the
  // markup of a page the PLATFORM serves; `$&` and "$`" spliced whole runs of
  // the shell into the title and into the JSON-LD. The trigger is not even
  // hostile by nature: an Iraqi merchant quoting a price in dollars writes `$1`.
  //
  // Asserted against the REAL served document, because the bug lives in what
  // reaches the visitor, not in what the function was asked to produce.
  const dollarName = "Widget $& $` $' $1 $2 END";
  const dollarNameEscaped = "Widget $&amp; $` $&#39; $1 $2 END";
  const dollarDescription = "Price $100 and $& and $2 TAIL";
  const dollarDescriptionEscaped = "Price $100 and $&amp; and $2 TAIL";
  const seoStoreName = (await prisma.store.findFirst({ where: { slug: seoSlug }, select: { name: true } })).name;
  const dollarProduct = await request(`/api/merchant/stores/${seoSlug}/catalog/products`, {
    method: "POST",
    token: seoLogin.payload.accessToken,
    body: { sku: `SEO-DOLLAR-${runSeed}`, name: dollarName, description: dollarDescription, priceIqd: 31000, stockQuantity: 3 },
  });
  assert.equal(dollarProduct.status, 201, JSON.stringify(dollarProduct.payload));
  const dollarHtml = await html(`/store/${seoSlug}/products/${dollarProduct.payload.product.id}`);

  // 1. The merchant's text arrives ESCAPED and LITERAL — every `$` still a `$`.
  const dollarTitle = /<title>([\s\S]*?)<\/title>/.exec(dollarHtml);
  assert.ok(dollarTitle, "the product page still has a title");
  assert.equal(dollarTitle[1], `${dollarNameEscaped} — ${seoStoreName}`, "the title is the product's name, escaped — no capture group, no spliced shell");
  assert.equal(
    /<meta\s+name="description"\s+content="([^"]*)"/.exec(dollarHtml)?.[1],
    dollarDescriptionEscaped,
    "the description attribute holds exactly the merchant's words, escaped, and is closed where the shell closes it",
  );
  assert.equal(/<meta\s+property="og:description"\s*\n?\s*content="([^"]*)"/.exec(dollarHtml)?.[1], dollarDescriptionEscaped, "og:description likewise");
  assert.equal(/<meta\s+name="twitter:title"\s*\n?\s*content="([^"]*)"/.exec(dollarHtml)?.[1], `${dollarNameEscaped} — ${seoStoreName}`, "twitter:title likewise");

  // 2. The SHELL's own markup is intact — nothing duplicated, nothing spliced.
  //    Counted against the benign product's page, which is the same shell with
  //    the same tag set, so any expansion shows up as a difference.
  const tags = (source, pattern) => (source.match(pattern) ?? []).length;
  assert.equal(tags(dollarHtml, /<title>/g), 1, "exactly one <title> — `$&` used to splice the shell's own title inside it");
  assert.equal(tags(dollarHtml, /<\/head>/g), 1, "exactly one </head>");
  assert.equal(tags(dollarHtml, /<meta\b/g), tags(productHtml, /<meta\b/g), "the same number of <meta> tags as a benign product page");
  assert.equal(tags(dollarHtml, /<link\b/g), tags(productHtml, /<link\b/g), "and the same number of <link> tags");
  assert.equal(tags(dollarHtml, /rel="canonical"/g), 1, "still exactly one canonical");
  assert.equal(/http-equiv/i.test(dollarHtml), false, "no attribute the shell never wrote — a broken-out `content=\"` used to let the merchant add http-equiv=refresh");

  // 3. The JSON-LD is still the product's, not a fragment of the head.
  const dollarLd = [...dollarHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.equal(dollarLd.length, 2, "Product and BreadcrumbList, as for any product page");
  assert.equal(dollarLd[0].name, dollarName, "the structured data carries the merchant's real name — the `</head>` insert is a replacement too, and expanded `$&` into it");
  summary.seoDollarPatterns = "`$&`, \"$`\", `$'`, `$1` and `$2` in a product's name and description stay literal text: escaped in every tag, shell markup untouched";

  // ---- the rest of the app is untouched -----------------------------------
  const landing = await html("/");
  assert.ok(landing.includes("<title>Codiq"), "the landing page keeps its own title");
  assert.equal(landing.includes('"@type":"Product"'), false, "and gains no storefront structured data");
  const unknownStore = await html("/store/does-not-exist-at-all");
  assert.ok(unknownStore.includes("<title>Codiq"), "an unknown store falls back to the plain shell rather than inventing a page for it");

  // ---- sitemaps -----------------------------------------------------------
  const sitemap = await request("/sitemap.xml");
  assert.ok(sitemap.raw.startsWith("<?xml"), "the sitemap is XML, not the app shell");
  assert.ok(sitemap.raw.includes(`/store/${seoSlug}`), "and lists the active store");
  const storeSitemap = await request(`/store/${seoSlug}/sitemap.xml`);
  assert.ok(storeSitemap.raw.includes(seoProductId), "the store's own sitemap lists its products, so a large catalogue never bloats the index");
  assert.equal((await request("/store/does-not-exist-at-all/sitemap.xml")).status, 404, "and an unknown store has no sitemap");

  summary.storefrontSeo = "store and product pages carry their own title, canonical and structured data; robots.txt and both sitemaps are real files; no invented ratings";

  // =========================================================================
  // PG-7 (ق-75) — business health, and the definition it stands on.
  //
  // The decision this suite pins down: «نشط» means SOLD, not «signed in». A
  // merchant who opens his dashboard every morning and sells nothing is not an
  // active merchant — he is a merchant about to leave, and counting him as
  // active would hide the one number that predicts it.
  // =========================================================================
  const pulseBase = await request("/api/platform/pulse?days=7", { token });
  assert.equal(pulseBase.status, 200, JSON.stringify(pulseBase.payload));
  assert.ok(pulseBase.payload.pulse.definitions.active.includes("الدخول إلى اللوحة وحده لا يجعله نشطاً"),
    "PG-7: the endpoint SHIPS its definition, so the interface can state it rather than leave the owner guessing (ق-10)");
  const activeBefore = pulseBase.payload.pulse.active;
  const signedInIdleBefore = pulseBase.payload.pulse.signedInWithoutSelling;

  // A merchant who signs in and sells NOTHING.
  const idleEmail = `${runId}.idle@codiq.test`;
  const idle = await request("/api/platform/merchants/manual", {
    method: "POST", token,
    body: { email: idleEmail, temporaryPassword: "IdleMerchant123!", businessName: "تاجر يدخل ولا يبيع", firstStoreName: "متجر ساكن", ownerName: "صاحب ساكن", phone: `+9647${String(300000000 + (runSeed % 600000000)).slice(0, 9)}` },
  });
  assert.equal(idle.status, 201, JSON.stringify(idle.payload));
  assert.equal((await request("/api/auth/merchant/login", { method: "POST", body: { identifier: idleEmail, password: "IdleMerchant123!" } })).status, 200);

  const pulseAfterIdle = (await request("/api/platform/pulse?days=7", { token })).payload.pulse;
  assert.equal(pulseAfterIdle.active, activeBefore, "PG-7: signing in did NOT make him active — this is the whole point of the definition");
  assert.equal(pulseAfterIdle.signedInWithoutSelling, signedInIdleBefore + 1, "PG-7: …he appears in «دخل ولم يبع», which is the early warning the owner needs");

  // The same merchant, now with a real sale.
  const idleSlug = idle.payload.store.slug;
  const idleFirstSession = (await request("/api/auth/merchant/login", { method: "POST", body: { identifier: idleEmail, password: "IdleMerchant123!" } })).payload.accessToken;
  // ق-218: hand-provisioned, so he replaces the owner's password before any
  // merchant surface opens — exactly as the two sign-ins above (which are the
  // subject of this section) already proved are allowed without it.
  assert.equal((await request("/api/auth/password", { method: "POST", token: idleFirstSession, body: { currentPassword: "IdleMerchant123!", newPassword: "IdleMerchantOwned123!" } })).status, 200);
  const idleToken = (await request("/api/auth/merchant/login", { method: "POST", body: { identifier: idleEmail, password: "IdleMerchantOwned123!" } })).payload.accessToken;
  assert.equal((await request(`/api/merchant/stores/${idleSlug}/delivery-rates/Baghdad`, { method: "PUT", token: idleToken, body: { amountIqd: 3000, isEnabled: true } })).status, 200);
  const pulseProduct = await request(`/api/merchant/stores/${idleSlug}/catalog/products`, { method: "POST", token: idleToken, body: { sku: `PULSE-${runSeed}`, name: "منتج النبض", priceIqd: 10000, stockQuantity: 5 } });
  assert.equal(pulseProduct.status, 201, JSON.stringify(pulseProduct.payload));
  const pulseCustomer = await request(`/api/store/${idleSlug}/account/register`, { method: "POST", body: { phone: `+9647${String(400000000 + (runSeed % 500000000)).slice(0, 9)}`, password: "PulseCustomer123!", fullName: "زبون النبض" } });
  assert.equal(pulseCustomer.status, 201, JSON.stringify(pulseCustomer.payload));
  const pulseAddress = await request(`/api/store/${idleSlug}/account/addresses`, { method: "POST", token: pulseCustomer.payload.accessToken, body: { recipientName: "زبون النبض", fullAddress: "شارع النبض", city: "Baghdad", governorate: "Baghdad", phoneContact: `+9647${String(400000000 + (runSeed % 500000000)).slice(0, 9)}`, isDefault: true } });
  assert.equal(pulseAddress.status, 201, JSON.stringify(pulseAddress.payload));
  const pulseCart = await request(`/api/store/${idleSlug}/cart/items`, { method: "POST", token: pulseCustomer.payload.accessToken, body: { productId: pulseProduct.payload.product.id, quantity: 1 } });
  assert.equal(pulseCart.status, 200, JSON.stringify(pulseCart.payload));
  const pulseOrder = await request(`/api/store/${idleSlug}/checkout`, { method: "POST", token: pulseCustomer.payload.accessToken, headers: { "idempotency-key": `${runId}-pulse` }, body: { cartVersion: pulseCart.payload.cart.version, addressId: pulseAddress.payload.address.id, paymentMethodCode: "cod" } });
  assert.equal(pulseOrder.status, 201, JSON.stringify(pulseOrder.payload));

  const pulseAfterSale = (await request("/api/platform/pulse?days=7", { token })).payload.pulse;
  assert.equal(pulseAfterSale.active, activeBefore + 1, "PG-7: one real sale makes him active");
  assert.equal(pulseAfterSale.signedInWithoutSelling, signedInIdleBefore, "PG-7: and he leaves the early-warning bucket, rather than sitting in both");

  // A cancelled order is not a sale, here as everywhere else.
  const cancelledMerchantActive = pulseAfterSale.active;
  assert.equal((await request(`/api/merchant/stores/${idleSlug}/orders/${pulseOrder.payload.order.id}/status`, { method: "POST", token: idleToken, body: { toStatus: "cancelled", expectedVersion: 1 } })).status, 200);
  const pulseAfterCancel = (await request("/api/platform/pulse?days=7", { token })).payload.pulse;
  assert.equal(pulseAfterCancel.active, cancelledMerchantActive - 1, "PG-7: a cancelled order consumed nothing, so it does not make a merchant active");

  // Every number opens: «who are they exactly» is the acceptance criterion.
  const stalledCohort = await request("/api/platform/pulse/stalled?days=7", { token });
  assert.equal(stalledCohort.status, 200, JSON.stringify(stalledCohort.payload));
  assert.ok(Array.isArray(stalledCohort.payload.merchants), "PG-7: the stalled figure opens into the merchants behind it");
  const neverSold = await request("/api/platform/pulse/never_sold?days=7", { token });
  assert.ok(neverSold.payload.merchants.some((m) => m.email === idleEmail), "PG-7: after his only order was cancelled he is «لم يبدأ», not «متوقف» — a different problem with a different fix");
  assert.equal((await request("/api/platform/pulse/not_a_cohort", { token })).status, 404, "PG-7: an unknown cohort is a 404, not a 500");
  assert.equal((await request("/api/platform/pulse")).status, 401, "PG-7: business health needs the owner's session");
  summary.platformPulse = "«active» means SOLD: signing in does not count, a cancelled order does not count, and every figure opens into its merchants";

  console.log(JSON.stringify({ suite: "p27-owner-surfaces", status: "passed", summary }, null, 2));
}

main()
  .catch((error) => { console.error("P27 brand integration failure:", error); process.exitCode = 1; })
  .finally(async () => {
    await prisma.$disconnect();
    if (server) killTree(server);
    if (moto) killTree(moto);
  });

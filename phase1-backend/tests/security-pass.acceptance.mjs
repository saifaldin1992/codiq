/**
 * Security pass 2026-11 — the platform as an attacker meets it: the PRODUCTION
 * build, over HTTP, from outside. Each block is one item of the security
 * checklist; the in-process checks at the end cover what HTTP cannot reach.
 *
 *   https        plain http is redirected (GET) or refused (writes) where deployed on TLS
 *   files        dot paths, source, env files, lockfile and source maps are not served
 *   headers      CSP without inline script, nosniff, frame-ancestors, referrer policy, no X-Powered-By
 *   cors         a foreign origin is granted nothing; its writes are refused (CSRF)
 *   cookies      the session cookie is HttpOnly, SameSite=Lax, path /
 *   errors       production answers carry no stack and no internals
 *   sql          an injection-shaped search is data, not SQL
 *   xss          a script payload is stored and returned as inert text in JSON
 *   uploads      a non-image disguised as one, and an oversized file, are refused
 *   prices       a price sent by the browser is ignored; the server's is charged
 *   admin        a shopper's or merchant's session opens no owner route
 *   coupons      guessing store coupon codes through the market is rate limited
 *   hashing      passwords are stored as bcrypt (cost 12), never in clear
 *   database     a remote database URL without TLS fails the preflight
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killTree } from "./helpers/child-process.mjs";
import { registerMerchantDirect } from "./helpers/register-merchant.js";

const port = 3291;
const base = `http://127.0.0.1:${port}`;
const runId = `sec${Date.now().toString(36)}`;
const digits = String(Date.now()).slice(-7);
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const dbUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = dbUrl;
process.env.CODIQ_POSTGRES_URL = dbUrl;
const { prisma } = await import("../src/db/prisma.ts");
const { httpsOnly, httpsEnforcementEnabled } = await import("../src/http/https-only.ts");
const { databaseTlsWeakness } = await import("../src/config/environment-report.ts");
await prisma.storefrontRateLimit.deleteMany({
  where: {
    OR: [{ scope: { startsWith: "market_otp" } }, { scope: { startsWith: "market_coupon" } }],
  },
});

const codes = [];
const web = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: dbUrl,
    CODIQ_POSTGRES_URL: dbUrl,
    CODIQ_PUBLIC_BASE_URL: base,
    CODIQ_NOTIFICATIONS_WORKER: "off",
    CODIQ_OTP_PROVIDER: "insecure-log",
    CODIQ_ALLOW_OWNER_REGISTRATION: "true",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
web.stdout.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (!line.includes("otp.code_logged_not_sent")) continue;
    try {
      codes.push(JSON.parse(line).ctx.code);
    } catch {
      /* not JSON */
    }
  }
});
async function nextCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (codes.length) return codes.pop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("no code logged");
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
async function call(path, { method = "GET", body, headers = {}, cookie, form } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: response.status, headers: response.headers, text, payload };
}

const summary = {};
const storeIds = [];
try {
  await waitFor(`${base}/api/health`);

  // ── https ────────────────────────────────────────────────────────────────
  {
    const deployed = { NODE_ENV: "production", CODIQ_PUBLIC_BASE_URL: "https://codiq.example" };
    assert.equal(httpsEnforcementEnabled(deployed), true);
    assert.equal(
      httpsEnforcementEnabled({
        NODE_ENV: "production",
        CODIQ_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      }),
      false,
      "local production builds stay on http"
    );
    assert.equal(
      httpsEnforcementEnabled({ ...deployed, CODIQ_ENFORCE_HTTPS: "false" }),
      false,
      "the escape hatch is explicit"
    );
    const run = (request) =>
      new Promise((resolve) => {
        const response = {
          headers: {},
          statusCode: 200,
          setHeader(name, value) {
            this.headers[name] = value;
            return this;
          },
          status(code) {
            this.statusCode = code;
            return this;
          },
          redirect(code, url) {
            resolve({ redirect: code, url, headers: this.headers });
          },
          json(body) {
            resolve({ status: this.statusCode, body, headers: this.headers });
          },
        };
        httpsOnly(deployed)(request, response, () => resolve({ next: true }));
      });
    const plainGet = await run({
      method: "GET",
      path: "/market/cart",
      originalUrl: "/market/cart?x=1",
      secure: false,
      hostname: "shop.merchant.iq",
    });
    assert.deepEqual(
      [plainGet.redirect, plainGet.url, plainGet.headers["cache-control"]],
      [301, "https://shop.merchant.iq/market/cart?x=1", "no-store"],
      "http GET → https, same host, not cached"
    );
    const plainPost = await run({
      method: "POST",
      path: "/api/auth/merchant/login",
      originalUrl: "/api/auth/merchant/login",
      secure: false,
      hostname: "codiq.example",
    });
    assert.equal(
      plainPost.status,
      426,
      "a write over http is refused, never redirected with its body"
    );
    assert.equal(
      (await run({ method: "GET", path: "/health", secure: false })).next,
      true,
      "health probes are exempt"
    );
    assert.equal(
      (await run({ method: "POST", path: "/x", secure: true })).next,
      true,
      "https passes"
    );
    summary.https = true;
  }

  // ── files ────────────────────────────────────────────────────────────────
  for (const path of [
    "/.env",
    "/.git/config",
    "/.git/HEAD",
    "/.DS_Store",
    "/.github/workflows/ci.yml",
    "/package.json",
    "/pnpm-lock.yaml",
    "/prisma/schema.prisma",
    "/server/index.ts",
    "/phase1-backend/src/config.ts",
    "/node_modules/express/package.json",
    "/assets/index.js.map",
  ]) {
    const answer = await call(path);
    assert.equal(answer.status, 404, `${path} → ${answer.status}`);
    assert.ok(
      !/DATABASE_URL|SESSION_JWT_SECRET|\[core\]|datasource db/.test(answer.text),
      `${path} leaks nothing`
    );
  }
  summary.files = true;

  // ── headers ──────────────────────────────────────────────────────────────
  {
    const page = await call("/market");
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src [^;]*'self'/);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "no inline script allowed");
    assert.match(csp, /frame-ancestors 'none'|frame-ancestors 'self'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.ok(page.headers.get("referrer-policy"));
    assert.equal(page.headers.get("x-powered-by"), null, "the framework is not announced");
    summary.headers = true;
  }

  // ── cors ─────────────────────────────────────────────────────────────────
  {
    const preflight = await call("/api/market/cart/items", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      null,
      "no origin is granted cross-site access"
    );
    const read = await call("/api/market/products", {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(read.headers.get("access-control-allow-origin"), null);
    const write = await call("/api/market/auth/code", {
      method: "POST",
      body: { phone: "07701234567" },
      headers: { origin: "https://evil.example" },
    });
    assert.deepEqual(
      [write.status, write.payload?.error?.code],
      [403, "CSRF_ORIGIN_DENIED"],
      "a foreign site cannot write"
    );
    const fetchSite = await call("/api/market/auth/code", {
      method: "POST",
      body: { phone: "07701234567" },
      headers: { origin: "", "sec-fetch-site": "cross-site" },
    });
    assert.equal(fetchSite.status, 403, "no Origin but Sec-Fetch-Site: cross-site is refused too");
    summary.cors = true;
  }

  // ── cookies + a shopper ──────────────────────────────────────────────────
  const phone = `077${digits}1`.slice(0, 11);
  const asked = await call("/api/market/auth/code", { method: "POST", body: { phone } });
  const verified = await fetch(`${base}/api/market/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ challengeId: asked.payload.challengeId, code: await nextCode() }),
  });
  const setCookie = verified.headers.getSetCookie().find((line) => /shopper_session=/.test(line));
  assert.ok(setCookie, "a session cookie is set");
  assert.match(setCookie, /HttpOnly/i, "unreadable from script");
  assert.match(setCookie, /SameSite=Lax/i, "not sent on cross-site writes");
  assert.match(setCookie, /Path=\//);
  const cookie = setCookie.split(";")[0];
  summary.cookies = true;

  // ── errors ───────────────────────────────────────────────────────────────
  {
    const broken = await fetch(`${base}/api/market/cart/items`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: "{not json",
    });
    const text = await broken.text();
    assert.ok(
      broken.status >= 400 && broken.status < 500,
      `malformed JSON is a client error (${broken.status})`
    );
    assert.ok(
      !/at .*\.(ts|js):\d+|node_modules|SyntaxError: Unexpected|prisma\./i.test(text),
      "no stack, no internals"
    );
    const missing = await call("/api/nope-not-a-route");
    assert.ok(!/stack|\.ts:\d+/.test(missing.text));
    summary.errors = true;
  }

  // ── sql ──────────────────────────────────────────────────────────────────
  {
    for (const q of [
      "' OR 1=1 --",
      '"; DROP TABLE stores; --',
      "%' UNION SELECT password_hash FROM merchants --",
    ]) {
      const answer = await call(`/api/market/products?q=${encodeURIComponent(q)}`);
      assert.equal(answer.status, 200, `searching «${q}» is just a search`);
      assert.ok(!/password_hash|\$2b\$/.test(answer.text));
    }
    assert.ok((await prisma.store.count()) >= 0, "stores still exist");
    summary.sql = true;
  }

  // ── xss ──────────────────────────────────────────────────────────────────
  {
    const payload = `<script>alert('${runId}')</script><img src=x onerror=alert(1)>`;
    const saved = await call("/api/market/contact", {
      method: "POST",
      body: {
        kind: "question",
        name: payload.slice(0, 60),
        phone: "07801234567",
        body: `${payload} — رسالة اختبار`,
      },
      cookie,
    });
    assert.equal(saved.status, 201, saved.text);
    const row = await prisma.marketContactMessage.findUniqueOrThrow({
      where: { id: saved.payload.message.id },
    });
    assert.equal(row.body.startsWith("<script>"), true, "stored as the text it is");
    assert.equal(
      saved.headers.get("content-type")?.startsWith("application/json"),
      true,
      "answered as JSON, never HTML"
    );
    const help = await call(`/api/market/help?q=${encodeURIComponent(payload)}`);
    assert.equal(help.headers.get("content-type")?.startsWith("application/json"), true);
    await prisma.marketContactMessage.delete({ where: { id: row.id } });
    summary.xss = true;
  }

  // ── uploads ──────────────────────────────────────────────────────────────
  {
    const disguised = new FormData();
    disguised.append(
      "image",
      new Blob([Buffer.from("<?php system($_GET['c']); ?>")], { type: "image/png" }),
      "shell.png"
    );
    const fake = await call("/api/market/me/avatar", { method: "POST", form: disguised, cookie });
    assert.ok(
      [415, 422].includes(fake.status),
      `a script named .png is refused (${fake.status} ${fake.payload?.error?.code})`
    );
    const huge = new FormData();
    huge.append(
      "image",
      new Blob([Buffer.alloc(12 * 1024 * 1024, 0x89)], { type: "image/png" }),
      "huge.png"
    );
    const big = await call("/api/market/me/avatar", { method: "POST", form: huge, cookie });
    assert.ok(
      [413, 422].includes(big.status),
      `an oversized file is refused (${big.status} ${big.payload?.error?.code})`
    );
    summary.uploads = true;
  }

  // ── prices ───────────────────────────────────────────────────────────────
  {
    const reg = await registerMerchantDirect({
      ownerName: "تاجر",
      businessName: "متجر",
      phone: `+96475${digits}2`.slice(0, 14),
      email: `${runId}@codiq.test`,
      password: "SecurityPass!2026",
    });
    const store = await prisma.store.create({
      data: {
        merchantId: reg.payload.account.id,
        name: `متجر ${runId}`,
        slug: `${runId}-a`,
        defaultSubdomain: `${runId}-a`,
        marketStatus: "listed",
        marketStatusAt: new Date(),
        marketListedAt: new Date(),
      },
    });
    storeIds.push(store.id);
    await prisma.deliveryRate.create({
      data: { storeId: store.id, governorate: "Baghdad", amountIqd: 3000, isEnabled: true },
    });
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        sku: `${runId}-p`,
        name: "منتج",
        priceIqd: 50000,
        stockQuantity: 10,
      },
    });
    const added = await call("/api/market/cart/items", {
      method: "POST",
      body: {
        productId: product.id,
        quantity: 1,
        priceIqd: 1,
        unitPriceIqd: 1,
        priceSnapshotIqd: 1,
      },
      cookie,
    });
    assert.ok([200, 422].includes(added.status));
    const line = (await call("/api/market/cart", { cookie })).payload.stores[0].lines[0];
    assert.equal(line.unitPriceIqd, 50000, "the browser's price is ignored");
    const shopper = await prisma.shopper.findUniqueOrThrow({
      where: { phoneNormalized: `+964${phone.slice(1)}` },
    });
    const district = await prisma.district.findFirstOrThrow({
      where: { governorateKey: "Baghdad" },
    });
    const address = await prisma.shopperAddress.create({
      data: {
        shopperId: shopper.id,
        label: "البيت",
        recipientName: "سارة",
        phoneNormalized: shopper.phoneNormalized,
        phoneVerifiedAt: new Date(),
        governorateKey: "Baghdad",
        districtId: district.id,
        addressLine: "شارع ٦٢، بناية ١٤",
        isDefault: true,
      },
    });
    const placed = await call(`/api/market/checkout/${store.slug}`, {
      method: "POST",
      body: {
        addressId: address.id,
        totalIqd: 1,
        subtotalIqd: 1,
        deliveryFeeIqd: 0,
        discountIqd: 49999,
      },
      headers: { "idempotency-key": `${runId}-price-tamper-key` },
      cookie,
    });
    assert.equal(placed.status, 201, placed.text);
    const order = await prisma.storeOrder.findUniqueOrThrow({
      where: { id: placed.payload.order.id },
    });
    assert.deepEqual(
      [order.subtotalIqd, order.discountIqd, order.totalIqd],
      [50000, 0, 53000],
      "the server prices the order"
    );
    summary.prices = true;

    // ── admin ──────────────────────────────────────────────────────────────
    const merchantToken = (
      await call("/api/auth/merchant/login", {
        method: "POST",
        body: { identifier: `${runId}@codiq.test`, password: "SecurityPass!2026" },
      })
    ).payload.accessToken;
    for (const path of [
      "/api/platform/market/coupons",
      "/api/platform/market/wheels",
      "/api/platform/market/support-tickets",
      "/api/platform/market/contact-messages",
      "/api/platform/orders",
    ]) {
      assert.ok(
        [401, 403].includes((await call(path, { cookie })).status),
        `a shopper is not the owner: ${path}`
      );
      assert.ok(
        [401, 403].includes(
          (await call(path, { headers: { authorization: `Bearer ${merchantToken}` } })).status
        ),
        `a merchant is not the owner: ${path}`
      );
      assert.equal((await call(path)).status, 401, `nobody is not the owner: ${path}`);
    }
    const forged = await call("/api/platform/market/coupons", {
      headers: { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0." },
    });
    assert.equal(forged.status, 401, "an unsigned token is not a session");
    summary.admin = true;

    // ── coupons ────────────────────────────────────────────────────────────
    await prisma.marketCartItem.deleteMany({ where: { cart: { shopperId: shopper.id } } });
    await call("/api/market/cart/items", {
      method: "POST",
      body: { productId: product.id, quantity: 1 },
      cookie,
    });
    let limited = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const guess = await call(
        `/api/market/checkout/${store.slug}?addressId=${address.id}&coupon=GUESS${attempt}`,
        { cookie }
      );
      if (guess.status === 429) {
        limited = attempt;
        break;
      }
    }
    assert.equal(limited, 30, "the thirty-first coupon guess is refused");
    summary.coupons = true;
  }

  // ── hashing ──────────────────────────────────────────────────────────────
  {
    const merchant = await prisma.merchant.findFirstOrThrow({
      where: { email: `${runId}@codiq.test` },
    });
    assert.match(merchant.passwordHash, /^(v2\$)?\$2[aby]\$12\$/, "bcrypt, cost 12");
    assert.ok(!merchant.passwordHash.includes("SecurityPass"), "never in clear");
    summary.hashing = true;
  }

  // ── database ─────────────────────────────────────────────────────────────
  {
    assert.equal(
      databaseTlsWeakness({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" }),
      null,
      "this machine needs no TLS"
    );
    assert.deepEqual(
      databaseTlsWeakness({ DATABASE_URL: "postgresql://u:p@db.example.com:5432/db" })?.names,
      ["DATABASE_URL"],
      "a remote host without sslmode fails the preflight"
    );
    assert.equal(
      databaseTlsWeakness({
        DATABASE_URL: "postgresql://u:p@db.example.com:5432/db?sslmode=require",
      }),
      null
    );
    assert.deepEqual(
      databaseTlsWeakness({
        DATABASE_URL: "postgresql://u:p@db.example.com/db?sslmode=verify-full",
        CODIQ_POSTGRES_URL_UNPOOLED: "postgresql://u:p@db.example.com/db?sslmode=prefer",
      })?.names,
      ["CODIQ_POSTGRES_URL_UNPOOLED"],
      "prefer is not require"
    );
    assert.equal(
      databaseTlsWeakness({
        DATABASE_URL: "postgresql://u:p@db:5432/db",
        CODIQ_DATABASE_PLAINTEXT_OK: "true",
      }),
      null,
      "a private network says so explicitly"
    );
    summary.database = true;
  }

  console.log(JSON.stringify({ suite: "security-pass", status: "passed", summary }, null, 2));
} finally {
  await prisma.store
    .updateMany({
      where: { id: { in: storeIds } },
      data: { marketStatus: "unlisted", marketStatusAt: new Date() },
    })
    .catch(() => undefined);
  await prisma.storefrontRateLimit
    .deleteMany({ where: { scope: { startsWith: "market_coupon" } } })
    .catch(() => undefined);
  await killTree(web);
  await prisma.$disconnect();
}
